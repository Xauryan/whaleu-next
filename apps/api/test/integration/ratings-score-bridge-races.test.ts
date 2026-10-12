import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { Pool, QueryResultRow } from 'pg';
import request from 'supertest';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import { ratingRuntimeFixture } from '../support/rating-runtime-fixture.js';
import { ratingScopedFixture } from '../support/rating-scoped-fixture.js';
import {
  prepareSyntheticOpaqueAdoption,
  writeSyntheticOpaqueAdoption,
} from '../support/rating-scoped-adoption-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';

const gateNamespace = 73129;
async function waitForRow<T extends QueryResultRow>(
  pool: Pool,
  sql: string,
  values: unknown[],
  message: string,
): Promise<T> {
  const deadline = Date.now() + 5000;
  do {
    const row = (await pool.query<T>(sql, values)).rows[0];
    if (row) return row;
    await sleep(10);
  } while (Date.now() < deadline);
  assert.fail(message);
}

/** Only adds a scheduling barrier before the unmodified production guard. The
 * real SQL function has already captured scoreBefore here. No proof, result,
 * target lock, epoch or timeout is mocked or disabled by this fixture. */
async function installBridgeBarriers(pool: Pool) {
  await pool.query(`
    CREATE TABLE whaleu_ratings.synthetic_score_bridge_gates(request_id uuid PRIMARY KEY,gate integer NOT NULL);
    CREATE FUNCTION whaleu_ratings.synthetic_score_bridge_wait() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE gate integer;
    BEGIN
      SELECT g.gate INTO gate FROM whaleu_ratings.synthetic_score_bridge_gates g WHERE g.request_id=NEW.request_id;
      IF gate IS NOT NULL THEN PERFORM pg_advisory_xact_lock(${gateNamespace},gate); END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER a00_synthetic_score_bridge_wait BEFORE INSERT ON whaleu_ratings.scoped_command_causes
      FOR EACH ROW WHEN (NEW.proof->>'operation'='set_score') EXECUTE FUNCTION whaleu_ratings.synthetic_score_bridge_wait();
  `);
}

async function orderedRace(
  pool: Pool,
  keys: readonly [string, string],
  first: () => Promise<request.Response>,
  second: () => Promise<request.Response>,
) {
  const gate = await pool.connect();
  const pending: Promise<request.Response>[] = [];
  try {
    const gatePid = (
      await gate.query<{ pid: number }>('SELECT pg_backend_pid() pid')
    ).rows[0]!.pid;
    await gate.query('SELECT pg_advisory_lock($1,1),pg_advisory_lock($1,2)', [
      gateNamespace,
    ]);
    await gate.query(
      'INSERT INTO whaleu_ratings.synthetic_score_bridge_gates VALUES($1,1),($2,2)',
      [...keys],
    );
    const track = (result: Promise<request.Response>) => {
      pending.push(result);
      void result.catch(() => undefined);
      return result;
    };
    const firstResult = track(first());
    const firstWait = await waitForRow<{ pid: number }>(
      pool,
      `SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=$1 AND objid=1 AND NOT granted AND $2=ANY(pg_blocking_pids(pid))`,
      [gateNamespace, gatePid],
      'First real bridge must reach its pre-guard SQL barrier',
    );
    const secondResult = track(second());
    // Fixed code waits on the first request's target lock. On the unfixed code
    // it reaches barrier 2 with the same stale predecessor instead. Release the
    // first writer in either case so the HTTP receipt assertions detect the bug.
    const secondWait = await waitForRow<{ pid: number; query: string }>(
      pool,
      `SELECT pid,query FROM pg_stat_activity WHERE datname=current_database() AND pid<>$1 AND wait_event_type='Lock'
       AND ($1=ANY(pg_blocking_pids(pid)) OR $2=ANY(pg_blocking_pids(pid)))`,
      [firstWait.pid, gatePid],
      'Second request must exhibit a real PostgreSQL lock wait',
    );
    await gate.query('SELECT pg_advisory_unlock($1,1)', [gateNamespace]);
    const a = await firstResult;
    await waitForRow(
      pool,
      `SELECT pid FROM pg_locks WHERE pid=$3 AND locktype='advisory' AND classid=$1 AND objid=2 AND NOT granted AND $2=ANY(pg_blocking_pids(pid))`,
      [gateNamespace, gatePid, secondWait.pid],
      'Second real bridge must reach its pre-guard SQL barrier after the first commit',
    );
    await gate.query('SELECT pg_advisory_unlock($1,2)', [gateNamespace]);
    const b = await secondResult;
    return { a, b, secondQuery: secondWait.query };
  } finally {
    await gate.query('SELECT pg_advisory_unlock_all()');
    await Promise.allSettled(pending);
    await gate.query('DELETE FROM whaleu_ratings.synthetic_score_bridge_gates');
    gate.release();
  }
}

test(
  'legacy score bridge captures its predecessor under the ordinary target lock',
  { timeout: 240000 },
  async (t) => {
    const f = await ratingScopedFixture();
    t.after(() => f.close());
    const owner = f.creator,
      other = await f.actor();
    const catalog = await f.catalog(owner, { count: 6 });
    await installBridgeBarriers(f.pool);
    type Actor = typeof owner;
    type Target = (typeof catalog.targets)[number];
    const input = (
      target: Target,
      score: number,
      expectedRevision: string | null = null,
    ) => ({
      clientRequestId: randomUUID(),
      regionId: null,
      expectedTargetRevision: target.revision,
      expectedRevision,
      score,
    });
    const score = async (
      actor: Actor,
      target: Target,
      body: ReturnType<typeof input>,
    ) =>
      f
        .auth(
          request(f.http).put(`/v1/ratings/targets/${target.id}/my-score`),
          actor,
        )
        .send(body);
    const receipt = async (actor: Actor, key: string) =>
      f.auth(request(f.http).get(`/v1/ratings/requests/${key}`), actor);
    const scoreState = async (target: Target) =>
      (
        await f.pool.query(
          `SELECT jsonb_build_object(
      'scores',(SELECT jsonb_agg(to_jsonb(s) ORDER BY account_id) FROM whaleu_ratings.scores s WHERE target_id=$1),
      'summary',(SELECT to_jsonb(s) FROM whaleu_ratings.score_summaries s WHERE target_id=$1),
      'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY sequence) FROM whaleu_ratings.score_transitions e WHERE target_id=$1)) state`,
          [target.id],
        )
      ).rows[0]!.state;
    const cause = async (actor: Actor, key: string) =>
      (
        await f.pool.query(
          'SELECT cause_kind,proof FROM whaleu_ratings.scoped_command_causes WHERE account_id=$1 AND request_id=$2',
          [actor.accountId, key],
        )
      ).rows;
    const assertStored = async (
      actor: Actor,
      target: Target,
      body: ReturnType<typeof input>,
      result: request.Response,
    ) => {
      assert.equal(result.status, 200, JSON.stringify(result.body));
      const stored = await receipt(actor, body.clientRequestId);
      assert.equal(stored.status, 200, JSON.stringify(stored.body));
      assert.deepEqual(stored.body, result.body);
      const before = await scoreState(target);
      const replay = await score(actor, target, body);
      assert.equal(replay.status, 200, JSON.stringify(replay.body));
      assert.deepEqual(replay.body, result.body);
      assert.deepEqual(await scoreState(target), before);
      const conflict = await score(actor, target, {
        ...body,
        score: body.score === 5 ? 1 : 5,
      });
      assert.equal(conflict.body.error?.code, 'REQUEST_CONFLICT');
      assert.deepEqual(await scoreState(target), before);
      const row = (
        await f.pool.query(
          'SELECT intent_hash,receipt FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
          [actor.accountId, body.clientRequestId],
        )
      ).rows[0]!;
      const original = { targetId: target.id, ...body };
      assert.equal(
        row.intent_hash,
        createHash('sha256')
          .update(
            'whaleu:rating-command:v1\n' +
              canonicalJson({ operation: 'set_score', intent: original }),
          )
          .digest('hex'),
      );
      assert.deepEqual(row.receipt, result.body);
    };
    const assertSummary = async (
      target: Target,
      values: number[],
      transitions: number,
    ) => {
      const summary = await f.auth(
        request(f.http).get(`/v1/ratings/targets/${target.id}/score-summary`),
        owner,
      );
      assert.equal(summary.status, 200, JSON.stringify(summary.body));
      const sum = values.reduce((a, b) => a + b, 0);
      assert.equal(summary.body.count, values.length);
      assert.equal(summary.body.sum, sum);
      assert.equal(
        summary.body.average,
        Math.round((sum * 10) / values.length) / 10,
      );
      assert.deepEqual(
        summary.body.distribution,
        Object.fromEntries(
          [1, 2, 3, 4, 5].map((n) => [n, values.filter((v) => v === n).length]),
        ),
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT count(*)::int n FROM whaleu_ratings.score_transitions WHERE target_id=$1',
            [target.id],
          )
        ).rows[0]!.n,
        transitions,
      );
    };
    let targetIndex = 0;
    for (const adopted of [false, true]) {
      if (adopted) {
        const adoption = await prepareSyntheticOpaqueAdoption(
          f,
          catalog.catalogId,
          catalog.categoryId,
          ['global'],
        );
        await f.declareAll();
        await f.declareScope('global', {
          categoryIds: [catalog.categoryId],
          targetIds: catalog.targets.map((target) => target.id).sort(),
          legacyCatalogIds: [catalog.catalogId],
        });
        await f.capability();
        await withCommunityScopeWriter(f.pool, async (tx) => {
          await writeSyntheticOpaqueAdoption(tx, adoption);
          await f.publish(
            { activate: true, domain: { kind: 'global_compat' } },
            tx,
          );
        });
        await t.test(
          'adoption still rejects fresh legacy score without exact write policy and recovers earlier receipts',
          async () => {
            const target = catalog.targets[0]!;
            const before = await scoreState(target);
            const fresh = input(target, 1);
            const denied = await score(owner, target, fresh);
            assert.equal(denied.status, 403, JSON.stringify(denied.body));
            assert.equal(denied.body.error?.code, 'RATING_SCOPE_UNAVAILABLE');
            assert.equal(
              (await receipt(owner, fresh.clientRequestId)).status,
              404,
            );
            assert.deepEqual(await scoreState(target), before);
            const historical = (
              await f.pool.query(
                "SELECT proof->'intent' intent FROM whaleu_ratings.scoped_command_causes WHERE cause_kind='legacy_boundary' AND proof->>'operation'='set_score' AND proof->'intent'->>'targetId'=$1 ORDER BY request_id LIMIT 1",
                [target.id],
              )
            ).rows[0]!.intent as ReturnType<typeof input> & {
              targetId: string;
            };
            const { targetId: historicalTarget, ...original } = historical;
            assert.equal(historicalTarget, target.id);
            const stored = await receipt(owner, original.clientRequestId);
            assert.equal(stored.status, 200);
            assert.deepEqual(
              (await score(owner, target, original)).body,
              stored.body,
            );
            assert.deepEqual(await scoreState(target), before);
          },
        );
        await f.atomicChange(
          (tx) =>
            f.issueSource(
              {
                kind: 'native_v1_compat_write',
                key: 'global',
                scopeKeys: ['global'],
                payload: {
                  policyVersion: 'native-v1-compat-write-v1',
                  enabled: true,
                  logicalScopeKey: 'global',
                  scopeKeys: ['global'],
                  operations: ['set_score'],
                  placementPolicy: 'exact_legacy_domain',
                  categoryPolicy: 'append_native_only',
                },
              },
              tx,
            ),
          { domain: { kind: 'global_compat' } },
        );
      }
      const kind = adopted ? 'legacy_bridge' : 'legacy_boundary';
      for (const existing of [false, true]) {
        await t.test(
          `${kind}: competing ${existing ? 'updates' : 'first scores'} commit one applied and one durable CAS rejection`,
          async () => {
            const target = catalog.targets[targetIndex++]!;
            let revision: string | null = null;
            if (existing) {
              const seeded = await score(owner, target, input(target, 5));
              assert.equal(seeded.status, 200, JSON.stringify(seeded.body));
              assert.equal(seeded.body.outcome, 'applied');
              revision = seeded.body.revision as string;
            }
            const first = input(target, 2, revision),
              second = input(target, 4, revision);
            const result = await orderedRace(
              f.pool,
              [first.clientRequestId, second.clientRequestId],
              () => score(owner, target, first),
              () => score(owner, target, second),
            );
            assert.equal(result.a.status, 200, JSON.stringify(result.a.body));
            assert.equal(result.a.body.outcome, 'applied');
            assert.equal(result.b.status, 200, JSON.stringify(result.b.body));
            assert.equal(result.b.body.outcome, 'rejected');
            assert.equal(result.b.body.code, 'RATING_REVISION_CONFLICT');
            assert.match(result.secondQuery, /FROM whaleu_ratings\.targets t/);
            assert.match(result.secondQuery, /FOR UPDATE OF t/);
            await assertStored(owner, target, first, result.a);
            await assertStored(owner, target, second, result.b);
            const proof = await cause(owner, first.clientRequestId);
            assert.equal(proof.length, 1);
            assert.equal(proof[0]!.cause_kind, kind);
            assert.deepEqual(proof[0]!.proof.intent, {
              targetId: target.id,
              ...first,
            });
            assert.deepEqual(
              proof[0]!.proof.scoreBefore,
              existing ? { score: 5, revision } : null,
            );
            assert.deepEqual(await cause(owner, second.clientRequestId), []);
            await assertSummary(target, [2], existing ? 2 : 1);
            const beforeNoop = await scoreState(target);
            const noop = await score(
              owner,
              target,
              input(target, 2, result.a.body.revision as string),
            );
            assert.equal(noop.status, 200, JSON.stringify(noop.body));
            assert.equal(noop.body.outcome, 'noop');
            assert.equal(noop.body.revision, result.a.body.revision);
            assert.deepEqual(await scoreState(target), beforeNoop);
          },
        );
      }
      await t.test(
        `${kind}: different actors serialize with exact independent summary and replay`,
        async () => {
          const target = catalog.targets[targetIndex++]!;
          const first = input(target, 2),
            second = input(target, 4);
          const result = await orderedRace(
            f.pool,
            [first.clientRequestId, second.clientRequestId],
            () => score(owner, target, first),
            () => score(other, target, second),
          );
          for (const response of [result.a, result.b]) {
            assert.equal(response.status, 200, JSON.stringify(response.body));
            assert.equal(response.body.outcome, 'applied');
          }
          assert.match(result.secondQuery, /FOR UPDATE OF t/);
          await assertStored(owner, target, first, result.a);
          await assertStored(other, target, second, result.b);
          for (const [actor, body] of [
            [owner, first],
            [other, second],
          ] as const) {
            const proof = await cause(actor, body.clientRequestId);
            assert.equal(proof.length, 1);
            assert.equal(proof[0]!.cause_kind, kind);
            assert.equal(proof[0]!.proof.scoreBefore, null);
          }
          await assertSummary(target, [2, 4], 2);
        },
      );
    }
  },
);

test('score pre-bridge qualification preserves missing, inactive and owner-deleted rejection recovery', async (t) => {
  const f = await ratingRuntimeFixture();
  t.after(() => f.close());
  const owner = await f.actor();
  const catalog = await f.catalog(owner, { count: 2 });
  const [inactive, deleted] = catalog.targets;
  assert.ok(inactive && deleted);
  await withCommunityScopeWriter(f.pool, (tx) =>
    tx.query(
      'UPDATE whaleu_ratings.targets SET active=false,revision=$2 WHERE id=$1',
      [inactive.id, randomUUID()],
    ),
  );
  const removed = await f
    .auth(
      request(f.http).post(
        `/v1/ratings/management/owner-deletion/targets/${deleted.id}`,
      ),
      owner,
    )
    .send({
      clientRequestId: randomUUID(),
      expectedTargetRevision: deleted.revision,
    });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.outcome, 'applied', JSON.stringify(removed.body));
  for (const target of [inactive, deleted, { ...inactive, id: randomUUID() }]) {
    const body = {
      clientRequestId: randomUUID(),
      regionId: null,
      expectedTargetRevision: target.revision,
      expectedRevision: null,
      score: 3,
    };
    const write = () =>
      f
        .auth(
          request(f.http).put(`/v1/ratings/targets/${target.id}/my-score`),
          owner,
        )
        .send(body);
    const rejected = await write();
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.deepEqual(rejected.body, {
      requestId: body.clientRequestId,
      operation: 'set_score',
      outcome: 'rejected',
      code: 'RATING_NOT_FOUND',
    });
    const receipt = await f.auth(
      request(f.http).get(`/v1/ratings/requests/${body.clientRequestId}`),
      owner,
    );
    assert.equal(receipt.status, 200);
    assert.deepEqual(receipt.body, rejected.body);
    assert.deepEqual((await write()).body, rejected.body);
    for (const table of [
      'scoped_command_causes',
      'scores',
      'score_transitions',
    ]) {
      assert.equal(
        (
          await f.pool.query(
            `SELECT count(*)::int n FROM whaleu_ratings.${table} WHERE account_id=$1 AND request_id=$2`,
            [owner.accountId, body.clientRequestId],
          )
        ).rows[0]!.n,
        0,
        table,
      );
    }
  }
});
