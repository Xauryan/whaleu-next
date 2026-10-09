import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { messagingRuntimeFixture } from '../support/messaging-runtime-fixture.js';
import { setDmReviewState } from '../support/dm-owner-fixture.js';
test('PM012 exact Review issuance and original terminal intent remain independent', async (t) => {
  const f = await messagingRuntimeFixture();
  t.after(() => f.close());
  const a = await f.actor(),
    b = await f.actor(),
    id = (await f.open(a, { kind: 'profile', profileId: b.profileId }))
      .conversationId;
  await t.test(
    'untrusted, pending, failed and expired allow never become send permission',
    async () => {
      for (const options of [
        { trusted: false },
        { result: 'pending' as const },
        { result: 'failed' as const },
        { consumeUntil: new Date(Date.now() - 1000) },
      ]) {
        const body = { clientRequestId: randomUUID(), text: 'must not allow' };
        await f.approval(a, id, body, options);
        const response = await f.post(a, `conversations/${id}/messages`, body);
        assert.equal(response.status, 503, JSON.stringify(response.body));
        assert.equal(
          (await f.get(a, `requests/${body.clientRequestId}`)).status,
          404,
        );
      }
      assert.equal(
        (
          await f.pool.query(
            'SELECT * FROM whaleu_messaging.messages WHERE conversation_id=$1',
            [id],
          )
        ).rowCount,
        0,
      );
    },
  );
  await t.test(
    'content rejection receipt is immutable after a later issuer changes its decision',
    async () => {
      const body = {
        clientRequestId: randomUUID(),
        text: 'exact terminal intent',
      };
      await f.approval(a, id, body, {
        result: 'reject',
        consumeUntil: new Date(Date.now() - 1000),
      });
      const rejected = await f.post(a, `conversations/${id}/messages`, body);
      assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
      assert.equal(rejected.body.code, 'CONTENT_REJECTED');
      await f.approval(a, id, body);
      assert.deepEqual(
        (await f.post(a, `conversations/${id}/messages`, body)).body,
        rejected.body,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT * FROM whaleu_messaging.messages WHERE conversation_id=$1',
            [id],
          )
        ).rowCount,
        0,
      );
    },
  );
  await t.test(
    'body, sender and conversation cannot borrow an exact decision',
    async () => {
      const body = { clientRequestId: randomUUID(), text: 'frozen body' };
      await f.approval(a, id, body);
      assert.equal(
        (
          await f.post(a, `conversations/${id}/messages`, {
            ...body,
            text: 'changed body',
          })
        ).status,
        503,
      );
      assert.equal(
        (await f.post(b, `conversations/${id}/messages`, body)).status,
        503,
      );
      const postId = await f.publish(b, 'named', false),
        second = (await f.open(a, { kind: 'post', postId })).conversationId;
      assert.equal(
        (await f.post(a, `conversations/${second}/messages`, body)).status,
        503,
      );
      assert.equal((await f.get(b, 'unread')).body.count, 0);
    },
  );
  await t.test(
    'strict request denies media and approval-ID injection without consuming Review',
    async () => {
      const body = { clientRequestId: randomUUID(), text: 'only text' };
      await f.approval(a, id, body);
      for (const extra of [
        { assetIds: [] },
        { imageUrl: 'https://example.invalid/private.png' },
        { approvalId: randomUUID() },
        { senderId: a.accountId },
      ])
        assert.equal(
          (
            await f.post(a, `conversations/${id}/messages`, {
              ...body,
              ...extra,
            })
          ).status,
          400,
        );
      assert.equal(
        (await f.post(a, `conversations/${id}/messages`, body)).body.outcome,
        'applied',
      );
    },
  );
  await t.test(
    'current revoked payload cannot survive history, list or events',
    async () => {
      const row = (
        await f.pool.query<{ decision_id: string; message_id: string }>(
          'SELECT b.decision_id,b.message_id FROM whaleu_community.dm_approval_bindings b JOIN whaleu_messaging.messages m ON m.id=b.message_id WHERE m.conversation_id=$1',
          [id],
        )
      ).rows[0]!;
      await setDmReviewState(f.pool, row.decision_id, 'revoked');
      const history = await f.get(b, `conversations/${id}/messages`);
      assert.equal(history.status, 200, JSON.stringify(history.body));
      assert.equal(history.body.items[0].state, 'unavailable');
      assert.equal(history.body.items[0].text, null);
      const list = await f.get(b, 'conversations');
      assert.equal(list.body.items[0].latest.text, null);
    },
  );
  await t.test(
    'verification loss denies content but preserves own minimal successful receipt',
    async () => {
      const receipt = (
        await f.pool.query<{ receipt: unknown }>(
          "SELECT receipt FROM whaleu_messaging.requests WHERE account_id=$1 AND operation='send' AND receipt->>'outcome'='applied'",
          [a.accountId],
        )
      ).rows[0]!.receipt as { requestId: string };
      await f.certify(a.accountId, { phone: 'unverified' });
      assert.equal(
        (await f.get(a, `conversations/${id}/messages`)).status,
        403,
      );
      const recovered = await f.get(a, `requests/${receipt.requestId}`);
      assert.equal(recovered.status, 200);
      assert.deepEqual(recovered.body, receipt);
      assert.equal('text' in recovered.body, false);
      assert.equal('peer' in recovered.body, false);
    },
  );
});
