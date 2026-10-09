import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { messagingRuntimeFixture } from '../support/messaging-runtime-fixture.js';
import {
  dmReceiptSchema,
  dmHistorySchema,
  dmEventsSchema,
  dmListSchema,
} from '../../src/messaging/contracts.js';
import { setDmReviewState } from '../support/dm-owner-fixture.js';
test('PM012 ordinary AppModule named text, recovery, watermarks, hide, recall and review', async (t) => {
  const f = await messagingRuntimeFixture();
  t.after(() => f.close());
  const a = await f.actor(),
    b = await f.actor(),
    stranger = await f.actor();
  const opened = await f.open(a, { kind: 'profile', profileId: b.profileId }),
    id = opened.conversationId;
  await t.test(
    'empty open is not a recipient conversation or unread notification',
    async () => {
      assert.deepEqual(
        dmListSchema.parse((await f.get(b, 'conversations')).body).items,
        [],
      );
      assert.equal((await f.get(b, 'unread')).body.count, 0);
    },
  );
  let firstId = '',
    firstKey = '',
    firstBody = { clientRequestId: '', text: '' },
    firstDecision = '';
  await t.test(
    'missing Review remains unavailable with no domain or receipt side effect',
    async () => {
      const key = randomUUID();
      const response = await f.post(a, `conversations/${id}/messages`, {
        clientRequestId: key,
        text: 'No issuer',
      });
      assert.equal(response.status, 503, JSON.stringify(response.body));
      assert.equal((await f.get(a, `requests/${key}`)).status, 404);
      assert.equal(
        (await f.pool.query('SELECT * FROM whaleu_messaging.messages'))
          .rowCount,
        0,
      );
    },
  );
  await t.test(
    'one exact reviewed text commits one event/unread/outbox and replay recovers',
    async () => {
      const sent = await f.send(a, id, 'first\r\nline');
      assert.equal(
        sent.response.status,
        200,
        JSON.stringify(sent.response.body),
      );
      const receipt = dmReceiptSchema.parse(sent.response.body);
      assert.equal(receipt.outcome, 'applied');
      firstId = receipt.messageId!;
      firstKey = sent.body.clientRequestId;
      firstBody = sent.body;
      firstDecision = sent.review.decisionId;
      assert.deepEqual(
        (await f.post(a, `conversations/${id}/messages`, firstBody)).body,
        receipt,
      );
      assert.deepEqual((await f.get(a, `requests/${firstKey}`)).body, receipt);
      assert.equal((await f.get(b, 'unread')).body.count, 1);
      for (const table of ['messages', 'events', 'outbox'])
        assert.equal(
          (await f.pool.query(`SELECT * FROM whaleu_messaging.${table}`))
            .rowCount,
          1,
        );
    },
  );
  await t.test(
    'same key changed intent conflicts and recovery is account-owned',
    async () => {
      assert.equal(
        (
          await f.post(a, `conversations/${id}/messages`, {
            ...firstBody,
            text: 'changed',
          })
        ).status,
        409,
      );
      assert.equal((await f.get(b, `requests/${firstKey}`)).status, 404);
      assert.equal((await f.get(stranger, `conversations/${id}`)).status, 404);
      assert.equal(
        (await f.get(stranger, `conversations/${randomUUID()}`)).status,
        404,
      );
    },
  );
  await t.test(
    'GET does not mark read and only observed watermark can acknowledge',
    async () => {
      const history = dmHistorySchema.parse(
        (await f.get(b, `conversations/${id}/messages`)).body,
      );
      assert.equal(history.items[0]!.text, 'first\nline');
      assert.equal((await f.get(b, 'unread')).body.count, 1);
      const forged = await f.post(b, `conversations/${id}/read`, {
        clientRequestId: randomUUID(),
        observationId: randomUUID(),
      });
      assert.equal(forged.body.code, 'DM_OBSERVATION_UNAVAILABLE');
      const read = await f.post(b, `conversations/${id}/read`, {
        clientRequestId: randomUUID(),
        observationId: history.observationId,
      });
      assert.equal(read.body.outcome, 'applied');
      assert.equal((await f.get(b, 'unread')).body.count, 0);
    },
  );
  await t.test(
    'lifetime first contact cannot be repeated, including after recall',
    async () => {
      const denied = await f.send(a, id, 'second unanswered');
      assert.equal(denied.response.body.code, 'DM_FIRST_CONTACT_LIMIT');
      const recall = await f.post(
        a,
        `conversations/${id}/messages/${firstId}/recall`,
        { clientRequestId: randomUUID() },
      );
      assert.equal(recall.body.outcome, 'applied', JSON.stringify(recall.body));
      assert.equal(
        (await f.send(a, id, 'recall must not reset')).response.body.code,
        'DM_FIRST_CONTACT_LIMIT',
      );
      const history = dmHistorySchema.parse(
        (await f.get(b, `conversations/${id}/messages`)).body,
      );
      assert.equal(history.items[0]!.state, 'recalled');
      assert.equal(history.items[0]!.text, null);
      assert.equal((await f.get(b, 'unread')).body.count, 0);
    },
  );
  await t.test(
    'peer reply unlocks text dialogue and late reads preserve subsequent unread',
    async () => {
      assert.equal(
        (await f.send(b, id, 'reply')).response.body.outcome,
        'applied',
      );
      const observed = dmHistorySchema.parse(
        (await f.get(b, `conversations/${id}/messages`)).body,
      );
      assert.equal(
        (await f.send(a, id, 'later')).response.body.outcome,
        'applied',
      );
      await f.post(b, `conversations/${id}/read`, {
        clientRequestId: randomUUID(),
        observationId: observed.observationId,
      });
      assert.equal((await f.get(b, 'unread')).body.count, 1);
    },
  );
  await t.test(
    'hide only cleans owner inbox; reopen keeps history; incoming restores recipient',
    async () => {
      const hidden = await f.post(b, `conversations/${id}/hide`, {
        clientRequestId: randomUUID(),
      });
      assert.equal(hidden.body.outcome, 'applied');
      assert.equal((await f.get(b, 'unread')).body.count, 0);
      assert.equal((await f.get(b, 'conversations')).body.items.length, 0);
      assert.equal((await f.get(a, 'conversations')).body.items.length, 1);
      const history = dmHistorySchema.parse(
        (await f.get(b, `conversations/${id}/messages`)).body,
      );
      assert.equal(history.items.length, 3);
      await f.post(b, `conversations/${id}/reopen`, {
        clientRequestId: randomUUID(),
      });
      assert.equal((await f.get(b, 'unread')).body.count, 0);
      await f.post(b, `conversations/${id}/hide`, {
        clientRequestId: randomUUID(),
      });
      assert.equal(
        (await f.send(a, id, 'new inbound')).response.body.outcome,
        'applied',
      );
      assert.equal((await f.get(b, 'conversations')).body.items.length, 1);
      assert.equal((await f.get(b, 'unread')).body.count, 1);
    },
  );
  await t.test(
    'forward cursor drains oldest unseen and old recall is an event',
    async () => {
      const history = dmHistorySchema.parse(
        (await f.get(b, `conversations/${id}/messages`, { limit: 1 })).body,
      );
      const one = await f.send(a, id, 'batch one'),
        two = await f.send(a, id, 'batch two');
      assert.equal(one.response.body.outcome, 'applied');
      assert.equal(two.response.body.outcome, 'applied');
      const first = dmEventsSchema.parse(
        (
          await f.get(b, `conversations/${id}/events`, {
            cursor: history.eventCursor,
            limit: 1,
          })
        ).body,
      );
      assert.equal(first.items[0]!.message.text, 'batch one');
      assert.equal(first.hasMore, true);
      const second = dmEventsSchema.parse(
        (
          await f.get(b, `conversations/${id}/events`, {
            cursor: first.nextCursor,
            limit: 1,
          })
        ).body,
      );
      assert.equal(second.items[0]!.message.text, 'batch two');
      assert.equal(second.hasMore, false);
      const old = one.response.body.messageId;
      await f.post(a, `conversations/${id}/messages/${old}/recall`, {
        clientRequestId: randomUUID(),
      });
      const recall = dmEventsSchema.parse(
        (
          await f.get(b, `conversations/${id}/events`, {
            cursor: second.nextCursor,
            limit: 1,
          })
        ).body,
      );
      assert.equal(recall.items[0]!.kind, 'recalled');
      assert.equal(recall.items[0]!.message.text, null);
    },
  );
  await t.test(
    'current Review hold suppresses previously accepted payload and cannot revive recalled text',
    async () => {
      await setDmReviewState(f.pool, firstDecision, 'held');
      const history = dmHistorySchema.parse(
        (await f.get(b, `conversations/${id}/messages`)).body,
      );
      assert.equal(history.items.find((m) => m.id === firstId)!.text, null);
      const latest = (
        await f.pool.query<{ decision_id: string }>(
          `SELECT b.decision_id FROM whaleu_community.dm_approval_bindings b JOIN whaleu_messaging.messages m ON m.id=b.message_id WHERE m.conversation_id=$1 ORDER BY m.message_seq DESC LIMIT 1`,
          [id],
        )
      ).rows[0]!;
      await setDmReviewState(f.pool, latest.decision_id, 'held');
      const updated = dmHistorySchema.parse(
        (await f.get(b, `conversations/${id}/messages`)).body,
      );
      assert.equal(updated.items.at(-1)!.state, 'unavailable');
      assert.equal(updated.items.at(-1)!.text, null);
    },
  );
  await t.test(
    'named block denies both directions without reverse identity explanation',
    async () => {
      const response = await f.post(b, `conversations/${id}/block`, {
        clientRequestId: randomUUID(),
      });
      assert.equal(
        response.body.outcome,
        'applied',
        JSON.stringify(response.body),
      );
      for (const actor of [a, b]) {
        const denied = await f.post(actor, `conversations/${id}/messages`, {
          clientRequestId: randomUUID(),
          text: 'blocked',
        });
        assert.equal(denied.body.code, 'DM_SEND_UNAVAILABLE');
      }
      const aView = (await f.get(a, `conversations/${id}`)).body;
      assert.equal(aView.sendAvailability, 'unavailable');
      assert.equal(aView.blockedByYou, false);
      assert.equal(JSON.stringify(aView).includes(b.accountId), false);
    },
  );
});
