import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { messagingRuntimeFixture } from '../support/messaging-runtime-fixture.js';
/** Deliberately uses the real 120-second wall-clock window. No timestamp rewrite,
 * client now parameter, controllable production clock or mocked finalizer. */
test(
  'PM012 recall real DB publication time, exact predicate and deferred cross-window rollback',
  { timeout: 180000 },
  async (t) => {
    const f = await messagingRuntimeFixture();
    t.after(async () => {
      await f.pool.query('DROP SCHEMA IF EXISTS dm_recall_fixture CASCADE');
      await f.close();
    });
    const a = await f.actor(),
      b = await f.actor(),
      id = (await f.open(a, { kind: 'profile', profileId: b.profileId }))
        .conversationId;
    const first = await f.send(a, id, 'recall succeeds before cutoff');
    assert.equal(first.response.body.outcome, 'applied');
    const firstRecall = await f.post(
      a,
      `conversations/${id}/messages/${first.response.body.messageId}/recall`,
      { clientRequestId: randomUUID() },
    );
    assert.equal(firstRecall.body.outcome, 'applied');
    assert.equal(
      (await f.send(b, id, 'reply establishes dialogue')).response.body.outcome,
      'applied',
    );
    const crossing = await f.send(a, id, 'must roll back after final wait'),
      expired = await f.send(a, id, 'must reject a fresh expired request');
    assert.equal(crossing.response.body.outcome, 'applied');
    assert.equal(expired.response.body.outcome, 'applied');
    const messageId = crossing.response.body.messageId as string;
    const created = (
      await f.pool.query<{ created_at: string }>(
        'SELECT created_at::text FROM whaleu_messaging.messages WHERE id=$1',
        [messageId],
      )
    ).rows[0]!.created_at;
    const boundaries = (
      await f.pool.query<{ before: boolean; exact: boolean; after: boolean }>(
        `SELECT whaleu_messaging.recall_allowed(created_at,created_at+interval '119.999 seconds') AS before,whaleu_messaging.recall_allowed(created_at,created_at+interval '120 seconds') AS exact,whaleu_messaging.recall_allowed(created_at,created_at+interval '120.000001 seconds') AS after FROM whaleu_messaging.messages WHERE id=$1`,
        [messageId],
      )
    ).rows[0]!;
    assert.deepEqual(boundaries, { before: true, exact: true, after: false });
    const waitUntil = async (id: string, seconds: number) => {
      for (;;) {
        const remaining = Number(
          (
            await f.pool.query<{ remaining: string }>(
              'SELECT (extract(epoch FROM created_at+make_interval(secs=>$2::double precision)-clock_timestamp())*1000)::text AS remaining FROM whaleu_messaging.messages WHERE id=$1',
              [id, seconds],
            )
          ).rows[0]!.remaining,
        );
        if (remaining <= 0) return;
        await sleep(Math.min(remaining, 5000));
      }
    };
    const key = randomUUID();
    await f.pool.query('CREATE SCHEMA dm_recall_fixture');
    await f.pool.query(
      `CREATE FUNCTION dm_recall_fixture.pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id='${key}'::uuid THEN PERFORM pg_advisory_xact_lock(192701,18);END IF;RETURN NULL;END $$`,
    );
    await f.pool.query(
      'CREATE CONSTRAINT TRIGGER z_dm_recall_pause AFTER INSERT OR UPDATE ON whaleu_messaging.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dm_recall_fixture.pause()',
    );
    const lock = await f.pool.connect();
    await lock.query('SELECT pg_advisory_lock(192701,18)');
    try {
      await waitUntil(messageId, 118);
      const pending = f
        .post(a, `conversations/${id}/messages/${messageId}/recall`, {
          clientRequestId: key,
        })
        .then((r) => r);
      await f.waitForLock('SET CONSTRAINTS');
      await waitUntil(messageId, 120.05);
      await lock.query('SELECT pg_advisory_unlock(192701,18)');
      const response = await pending;
      assert.equal(response.status, 409, JSON.stringify(response.body));
      assert.equal(response.body.error.code, 'DM_RECALL_EXPIRED');
      assert.equal((await f.get(a, `requests/${key}`)).status, 404);
      const unchanged = (
        await f.pool.query<{ created_at: string; recalled_at: Date | null }>(
          'SELECT created_at::text,recalled_at FROM whaleu_messaging.messages WHERE id=$1',
          [messageId],
        )
      ).rows[0]!;
      assert.equal(unchanged.created_at, created);
      assert.equal(unchanged.recalled_at, null);
      assert.equal(
        (
          await f.pool.query(
            "SELECT * FROM whaleu_messaging.events WHERE message_id=$1 AND kind='recalled'",
            [messageId],
          )
        ).rowCount,
        0,
      );
      await waitUntil(expired.response.body.messageId, 120.05);
      const rejection = await f.post(
        a,
        `conversations/${id}/messages/${expired.response.body.messageId}/recall`,
        { clientRequestId: randomUUID() },
      );
      assert.equal(rejection.body.outcome, 'rejected');
      assert.equal(rejection.body.code, 'DM_RECALL_EXPIRED');
      assert.deepEqual(
        (await f.get(a, `requests/${firstRecall.body.requestId}`)).body,
        firstRecall.body,
      );
    } finally {
      await lock.query('SELECT pg_advisory_unlock(192701,18)');
      lock.release();
      await f.pool.query('DROP SCHEMA dm_recall_fixture CASCADE');
    }
  },
);
