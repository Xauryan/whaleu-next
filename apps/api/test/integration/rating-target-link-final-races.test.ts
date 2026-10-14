import type { PoolClient } from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { ratingTargetLinkFixture } from '../support/rating-target-link-fixture.js';
import { appendTopologyRevision } from '../support/community-scope-fixtures.js';
import { canonicalJson } from '../../src/community/content-review/contracts.js';

const sqlCode = (value: unknown) =>
  typeof value === 'object' && value && 'code' in value
    ? String(value.code)
    : '';
test(
  'v5 final SQL proof closes topology movement, zero-row in-flight topology writer, and source expiry during a real deferred lock wait',
  { timeout: 240000 },
  async (t) => {
    const f = await ratingTargetLinkFixture();
    const leased = new Set<PoolClient>();
    const connect = async () => {
      const client = await f.pool.connect();
      leased.add(client);
      const release = client.release.bind(client);
      client.release = (error?: Error | boolean) => {
        leased.delete(client);
        release(error);
      };
      return client;
    };
    t.after(async () => {
      for (const client of [...leased]) {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
      await f.close();
    });
    const category = await f.createLinkCategory('course'),
      target = await f.createLinkTarget(category),
      body = await f.card(target.id);
    const prepared = await f.linkCall(
      f.creator,
      '/v1/community/reviews/posts',
      body,
    );
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    const exact = (
      await f.pool.query(
        'SELECT envelope,digest,intent_hash FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
        [f.creator.accountId, body.clientRequestId],
      )
    ).rows[0]!;
    const begin = async () => {
      const tx = await connect(),
        requestId = randomUUID();
      await tx.query('BEGIN');
      try {
        await tx.query("SET LOCAL lock_timeout='1000ms'");
        await tx.query("SET LOCAL statement_timeout='5000ms'");
        await tx.query(
          "INSERT INTO whaleu_community.publication_requests(account_id,client_request_id,operation,payload_hash,review_submission_transaction) VALUES($1,$2,'publish_post',$3,pg_current_xact_id())",
          [f.creator.accountId, requestId, exact.intent_hash],
        );
        await tx.query(
          "INSERT INTO whaleu_community.text_review_requests(account_id,client_request_id,operation,intent_hash,envelope,digest) VALUES($1,$2,'publish_post',$3,$4::jsonb,$5)",
          [
            f.creator.accountId,
            requestId,
            exact.intent_hash,
            canonicalJson(exact.envelope),
            exact.digest,
          ],
        );
        return { tx, requestId };
      } catch (error) {
        await tx.query('ROLLBACK');
        tx.release();
        throw error;
      }
    };
    const absent = async (id: string) =>
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_community.publication_requests WHERE account_id=$1 AND client_request_id=$2',
            [f.creator.accountId, id],
          )
        ).rowCount,
        0,
      );
    // A zero-row statement still takes the precise source lock required by the
    // final SQL checker. No sleep race and no synthetic boolean proof is used.
    const locked = await begin(),
      writer = await connect();
    try {
      await writer.query('BEGIN');
      await writer.query("SET LOCAL lock_timeout='1000ms'");
      await writer.query("SET LOCAL statement_timeout='5000ms'");
      await writer.query(
        'UPDATE whaleu_campus.community_topology_heads SET revision=revision WHERE false',
      );
      assert.equal(
        (
          await writer.query(
            "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND relation='whaleu_campus.community_topology_heads'::regclass AND mode='RowExclusiveLock' AND granted) held",
          )
        ).rows[0].held,
        true,
      );
      await assert.rejects(
        locked.tx.query('COMMIT'),
        (error) => sqlCode(error) === '55P03',
      );
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
      await locked.tx.query('ROLLBACK');
      locked.tx.release();
    }
    await absent(locked.requestId);
    // The second transaction commits a real accepted topology successor after
    // initial admission. The original identity/scope snapshot cannot follow it.
    const changed = await begin();
    try {
      await appendTopologyRevision(f.pool, structuredClone(f.scope.topology));
      await assert.rejects(
        changed.tx.query('COMMIT'),
        (error) => sqlCode(error) === '23514',
      );
    } finally {
      await changed.tx.query('ROLLBACK');
      changed.tx.release();
    }
    await absent(changed.requestId);
    // Resolve a fresh ordinary selected identity and resubmit an exact new intent.
    const request = (await import('supertest')).default;
    const identity = await f.auth(
      request(f.http).get('/v1/me/identity-campus'),
      f.creator,
    );
    assert.equal(identity.status, 200);
    const selected = await f
      .auth(request(f.http).put('/v1/me/identity-campus'), f.creator)
      .send({
        requestId: randomUUID(),
        campusId: f.campusA,
        expectedStateRevision: identity.body.expectedStateRevision,
      });
    assert.equal(selected.status, 200, JSON.stringify(selected.body));
    // Issue a genuinely expiring immutable policy through the existing trusted
    // Review issuer. Never rewrite an already issued policy to manufacture time.
    const expiring = await f.createLinkTarget(
      category,
      'Expiring course',
      f.creator,
      {
        policyUntil: new Date(Date.now() + 15000),
      },
    );
    const fresh = await f.card(expiring.id);
    assert.equal(
      (await f.linkCall(f.creator, '/v1/community/reviews/posts', fresh))
        .status,
      200,
    );
    Object.assign(
      exact,
      (
        await f.pool.query(
          'SELECT envelope,digest,intent_hash FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
          [f.creator.accountId, fresh.clientRequestId],
        )
      ).rows[0],
    );
    const barrier = await connect(),
      key = '740148149';
    await barrier.query('SELECT pg_advisory_lock($1::bigint)', [key]);
    let delayed: Awaited<ReturnType<typeof begin>> | undefined;
    let completion: Promise<void> | undefined;
    try {
      await f.pool
        .query(`CREATE FUNCTION whaleu_community.synthetic_card_final_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${key}); RETURN NULL; END $$;
      CREATE CONSTRAINT TRIGGER a_card_final_wait AFTER INSERT ON whaleu_community.text_review_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.synthetic_card_final_wait()`);
      const deadline = (
        await f.pool.query<{ valid_until: Date }>(
          'SELECT valid_until FROM whaleu_community.content_approval_policies WHERE id=$1',
          [expiring.approval.policyRevisionId],
        )
      ).rows[0]!.valid_until;
      while (
        (
          await f.pool.query(
            "SELECT clock_timestamp()<$1::timestamptz-interval '2 seconds' early",
            [deadline],
          )
        ).rows[0].early === true
      )
        await sleep(10);
      delayed = await begin();
      // This test deliberately waits two seconds; still below the original
      // runtime transaction ceiling, with an independently bounded statement.
      await delayed.tx.query("SET LOCAL lock_timeout='4000ms'");
      const pid = (await delayed.tx.query('SELECT pg_backend_pid() pid'))
        .rows[0].pid;
      completion = assert.rejects(
        delayed.tx.query('COMMIT'),
        (error) => sqlCode(error) === '23514',
      );
      const stop = Date.now() + 4000;
      let waiting = false;
      while (Date.now() < stop) {
        waiting = (
          await f.pool.query(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock' AND query='COMMIT') waiting",
            [pid],
          )
        ).rows[0].waiting;
        if (waiting) break;
        await sleep(10);
      }
      assert.equal(waiting, true, 'Final deferred proof must actually wait');
      while (
        (
          await f.pool.query(
            'SELECT clock_timestamp()>$1::timestamptz expired',
            [deadline],
          )
        ).rows[0].expired !== true
      )
        await sleep(10);
      await barrier.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
      await completion;
      await absent(delayed.requestId);
    } finally {
      await barrier.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
      barrier.release();
      try {
        await completion;
      } finally {
        if (delayed) {
          try {
            await delayed.tx.query('ROLLBACK');
          } finally {
            delayed.tx.release();
          }
        }
        await f.pool.query(
          'DROP TRIGGER IF EXISTS a_card_final_wait ON whaleu_community.text_review_requests; DROP FUNCTION IF EXISTS whaleu_community.synthetic_card_final_wait()',
        );
      }
    }
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_community.post_rating_target_links',
        )
      ).rows[0].n,
      0,
    );
  },
);
