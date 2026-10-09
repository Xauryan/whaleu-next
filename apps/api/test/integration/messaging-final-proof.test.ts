import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { messagingRuntimeFixture } from '../support/messaging-runtime-fixture.js';
import type { MessagingFixture } from '../support/messaging-runtime-fixture.js';
async function barrier(f: MessagingFixture, key: string) {
  await f.pool.query('CREATE SCHEMA dm_proof_fixture');
  await f.pool.query(
    `CREATE FUNCTION dm_proof_fixture.pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id='${key}'::uuid THEN PERFORM pg_advisory_xact_lock(192701,17); END IF;RETURN NULL;END $$`,
  );
  await f.pool.query(
    'CREATE CONSTRAINT TRIGGER z_dm_proof_pause AFTER INSERT OR UPDATE ON whaleu_messaging.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dm_proof_fixture.pause()',
  );
  const lock = await f.pool.connect();
  await lock.query('SELECT pg_advisory_lock(192701,17)');
  return {
    async release() {
      await lock.query('SELECT pg_advisory_unlock(192701,17)');
    },
    async close() {
      await lock.query('SELECT pg_advisory_unlock(192701,17)');
      lock.release();
      await f.pool.query('DROP SCHEMA dm_proof_fixture CASCADE');
    },
  };
}
test('PM012 required proof after deferred constraint waits cannot freeze stale allow or denial', async (t) => {
  const f = await messagingRuntimeFixture();
  t.after(async () => {
    await f.pool.query('DROP SCHEMA IF EXISTS dm_proof_fixture CASCADE');
    await f.close();
  });
  await t.test(
    'Review expiry after deferred wait rolls back every send side effect',
    async () => {
      const a = await f.actor(),
        b = await f.actor(),
        id = (await f.open(a, { kind: 'profile', profileId: b.profileId }))
          .conversationId,
        key = randomUUID(),
        body = { clientRequestId: key, text: 'Expires while waiting' };
      await f.approval(a, id, body, {
        consumeUntil: new Date(Date.now() + 2500),
      });
      const gate = await barrier(f, key);
      try {
        const pending = f
          .post(a, `conversations/${id}/messages`, body)
          .then((r) => r);
        await f.waitForLock('SET CONSTRAINTS');
        await f.pool.query('SELECT pg_sleep(2.6)');
        await gate.release();
        const response = await pending;
        assert.equal(response.status, 503, JSON.stringify(response.body));
        assert.equal(
          (
            await f.pool.query(
              'SELECT * FROM whaleu_messaging.messages WHERE conversation_id=$1',
              [id],
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT * FROM whaleu_messaging.events WHERE conversation_id=$1',
              [id],
            )
          ).rowCount,
          0,
        );
        assert.equal((await f.get(b, 'unread')).body.count, 0);
        assert.equal((await f.get(a, `requests/${key}`)).status, 404);
      } finally {
        await gate.close();
      }
    },
  );
  await t.test(
    'peer reply during deferred rejected receipt wait invalidates obsolete first-contact denial',
    async () => {
      const a = await f.actor(),
        b = await f.actor(),
        id = (await f.open(a, { kind: 'profile', profileId: b.profileId }))
          .conversationId;
      assert.equal(
        (await f.send(a, id, 'first')).response.body.outcome,
        'applied',
      );
      const reply = {
        clientRequestId: randomUUID(),
        text: 'reply changes first-contact state',
      };
      await f.approval(b, id, reply);
      const key = randomUUID(),
        gate = await barrier(f, key);
      try {
        const pending = f
          .post(a, `conversations/${id}/messages`, {
            clientRequestId: key,
            text: 'was denied',
          })
          .then((r) => r);
        await f.waitForLock('SET CONSTRAINTS');
        const response = await f.post(b, `conversations/${id}/messages`, reply);
        assert.equal(
          response.body.outcome,
          'applied',
          JSON.stringify(response.body),
        );
        await gate.release();
        const obsolete = await pending;
        assert.equal(obsolete.status, 503, JSON.stringify(obsolete.body));
        assert.equal((await f.get(a, `requests/${key}`)).status, 404);
        assert.equal(
          (
            await f.pool.query(
              'SELECT * FROM whaleu_messaging.messages WHERE conversation_id=$1',
              [id],
            )
          ).rowCount,
          2,
        );
      } finally {
        await gate.close();
      }
    },
  );
});
