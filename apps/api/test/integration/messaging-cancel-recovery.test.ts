import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { messagingRuntimeFixture } from '../support/messaging-runtime-fixture.js';
import { dmDigest } from '../../src/messaging/repository.js';
test('PM012 logout original-intent recovery and irreversible cancellation race closure', async (t) => {
  const f = await messagingRuntimeFixture();
  t.after(() => f.close());
  const owner = await f.actor(),
    peer = await f.actor(),
    other = await f.actor(),
    id = (await f.open(owner, { kind: 'profile', profileId: peer.profileId }))
      .conversationId;
  await t.test(
    'lost response after committed send survives logout and same-account login without resend',
    async () => {
      const body = {
          clientRequestId: randomUUID(),
          text: 'response may be lost',
        },
        intentHash = dmDigest({
          operation: 'send',
          intent: { conversationId: id, ...body },
        });
      await f.approval(owner, id, body);
      const committed = await f.post(
        owner,
        `conversations/${id}/messages`,
        body,
      );
      assert.equal(committed.body.outcome, 'applied');
      const same = await f.relogin(owner);
      assert.equal(
        (await f.get(owner, `requests/${body.clientRequestId}`)).status,
        401,
      );
      assert.equal(
        (await f.get(other, `requests/${body.clientRequestId}`)).status,
        404,
      );
      const receipt = await f.get(same, `requests/${body.clientRequestId}`);
      assert.deepEqual(receipt.body, committed.body);
      const lateCancel = await f.post(
        same,
        `requests/${body.clientRequestId}/cancel`,
        { operation: 'send', intentHash },
      );
      assert.equal(lateCancel.body.outcome, 'already_terminal');
      assert.deepEqual(lateCancel.body.receipt, committed.body);
      assert.equal(
        (
          await f.pool.query(
            'SELECT * FROM whaleu_messaging.messages WHERE sender_id=$1 AND request_id=$2',
            [owner.accountId, body.clientRequestId],
          )
        ).rowCount,
        1,
      );
      assert.equal((await f.get(peer, 'unread')).body.count, 1);
    },
  );
  await t.test(
    'never-reached-server command can be cancelled body-free after relogin; late original cannot send',
    async () => {
      const a = await f.actor(),
        b = await f.actor(),
        conversationId = (
          await f.open(a, { kind: 'profile', profileId: b.profileId })
        ).conversationId,
        body = { clientRequestId: randomUUID(), text: 'never sent to server' },
        intentHash = dmDigest({
          operation: 'send',
          intent: { conversationId, ...body },
        });
      await f.approval(a, conversationId, body);
      const same = await f.relogin(a);
      assert.equal(
        (await f.get(same, `requests/${body.clientRequestId}`)).status,
        404,
      );
      const cancelled = await f.post(
        same,
        `requests/${body.clientRequestId}/cancel`,
        { operation: 'send', intentHash },
      );
      assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
      assert.equal(cancelled.body.outcome, 'cancelled');
      assert.equal(cancelled.body.receipt.code, 'DM_COMMAND_CANCELLED');
      const late = await f.post(
        same,
        `conversations/${conversationId}/messages`,
        body,
      );
      assert.deepEqual(late.body, cancelled.body.receipt);
      assert.equal(
        (
          await f.pool.query(
            'SELECT * FROM whaleu_messaging.messages WHERE conversation_id=$1',
            [conversationId],
          )
        ).rowCount,
        0,
      );
      assert.equal((await f.get(b, 'unread')).body.count, 0);
      assert.equal(
        (
          await f.post(same, `requests/${body.clientRequestId}/cancel`, {
            operation: 'send',
            intentHash: 'f'.repeat(64),
          })
        ).status,
        409,
      );
    },
  );
  await t.test(
    'racing send and cancel establish exactly one terminal original result',
    async () => {
      const a = await f.actor(),
        b = await f.actor(),
        conversationId = (
          await f.open(a, { kind: 'profile', profileId: b.profileId })
        ).conversationId,
        body = { clientRequestId: randomUUID(), text: 'one winner' },
        intentHash = dmDigest({
          operation: 'send',
          intent: { conversationId, ...body },
        });
      await f.approval(a, conversationId, body);
      // Hold the actual unique request key until both HTTP transactions are waiting
      // in PostgreSQL; Promise.all scheduling alone would not prove overlap.
      const gate = await f.pool.connect();
      await gate.query('BEGIN');
      await gate.query(
        'INSERT INTO whaleu_messaging.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,$3,$4)',
        [a.accountId, body.clientRequestId, 'send', intentHash],
      );
      const competing = Promise.all([
        f.post(a, `conversations/${conversationId}/messages`, body),
        f.post(a, `requests/${body.clientRequestId}/cancel`, {
          operation: 'send',
          intentHash,
        }),
      ]);
      try {
        const deadline = Date.now() + 10000;
        for (;;) {
          const waiting = await f.pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'INSERT INTO whaleu_messaging.requests%' ",
          );
          if (Number(waiting.rows[0]!.count) >= 2) break;
          assert.ok(
            Date.now() < deadline,
            'both HTTP requests must overlap on the original key',
          );
          await sleep(20);
        }
      } finally {
        await gate.query('ROLLBACK');
        gate.release();
      }
      const [send, cancel] = await competing;
      assert.equal(send.status, 200, JSON.stringify(send.body));
      assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
      assert.deepEqual(send.body, cancel.body.receipt);
      assert.equal(
        cancel.body.outcome,
        send.body.outcome === 'rejected' ? 'cancelled' : 'already_terminal',
      );
      const count = (
        await f.pool.query(
          'SELECT * FROM whaleu_messaging.messages WHERE conversation_id=$1',
          [conversationId],
        )
      ).rowCount;
      assert.equal(count, send.body.outcome === 'applied' ? 1 : 0);
      if (send.body.outcome === 'rejected')
        assert.equal(send.body.code, 'DM_COMMAND_CANCELLED');
      assert.deepEqual(
        (await f.get(a, `requests/${body.clientRequestId}`)).body,
        send.body,
      );
    },
  );
  await t.test(
    'minimal cancellation does not require current phone or disclose a body',
    async () => {
      const a = await f.actor({ phone: 'unverified' }),
        key = randomUUID();
      const response = await f.post(a, `requests/${key}/cancel`, {
        operation: 'send',
        intentHash: 'a'.repeat(64),
      });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.outcome, 'cancelled');
      assert.equal(response.body.receipt.code, 'DM_COMMAND_CANCELLED');
      assert.deepEqual(Object.keys(response.body.receipt).sort(), [
        'code',
        'operation',
        'outcome',
        'requestId',
      ]);
    },
  );
});
