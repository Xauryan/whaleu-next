import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { messagingRuntimeFixture } from '../support/messaging-runtime-fixture.js';
import { dmHistorySchema } from '../../src/messaging/contracts.js';
import { inTransaction } from '../../src/database/database.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import { DmSafetyFacade } from '../../src/safety/dm.facade.js';
import { dmDigest } from '../../src/messaging/repository.js';
test('PM012 genuine concurrent state invariants and SQL retention', async (t) => {
  const f = await messagingRuntimeFixture();
  t.after(() => f.close());
  await t.test(
    'simultaneous first sends accept one lifetime contact and one durable rejection',
    async () => {
      const a = await f.actor(),
        b = await f.actor(),
        id = (await f.open(a, { kind: 'profile', profileId: b.profileId }))
          .conversationId;
      const one = { clientRequestId: randomUUID(), text: 'one' },
        two = { clientRequestId: randomUUID(), text: 'two' };
      await f.approval(a, id, one);
      await f.approval(a, id, two);
      const replies = await Promise.all([
        f.post(a, `conversations/${id}/messages`, one),
        f.post(a, `conversations/${id}/messages`, two),
      ]);
      assert.deepEqual(replies.map((r) => r.body.outcome).sort(), [
        'applied',
        'rejected',
      ]);
      assert.equal(
        replies.find((r) => r.body.outcome === 'rejected')!.body.code,
        'DM_FIRST_CONTACT_LIMIT',
      );
      assert.equal((await f.get(b, 'unread')).body.count, 1);
    },
  );
  await t.test(
    'reciprocal first sends both commit and each owner has exactly one unread',
    async () => {
      const a = await f.actor(),
        b = await f.actor(),
        id = (await f.open(a, { kind: 'profile', profileId: b.profileId }))
          .conversationId;
      const one = { clientRequestId: randomUUID(), text: 'one' },
        two = { clientRequestId: randomUUID(), text: 'two' };
      await f.approval(a, id, one);
      await f.approval(b, id, two);
      const replies = await Promise.all([
        f.post(a, `conversations/${id}/messages`, one),
        f.post(b, `conversations/${id}/messages`, two),
      ]);
      for (const r of replies)
        assert.equal(r.body.outcome, 'applied', JSON.stringify(r.body));
      for (const actor of [a, b])
        assert.equal((await f.get(actor, 'unread')).body.count, 1);
    },
  );
  await t.test(
    'same original key concurrent retry commits one message, event, unread and obligation',
    async () => {
      const a = await f.actor(),
        b = await f.actor(),
        id = (await f.open(a, { kind: 'profile', profileId: b.profileId }))
          .conversationId,
        body = { clientRequestId: randomUUID(), text: 'exact original' };
      await f.approval(a, id, body);
      const replies = await Promise.all([
        f.post(a, `conversations/${id}/messages`, body),
        f.post(a, `conversations/${id}/messages`, body),
      ]);
      assert.deepEqual(replies[0]!.body, replies[1]!.body);
      assert.equal(replies[0]!.body.outcome, 'applied');
      for (const table of ['messages', 'events'])
        assert.equal(
          (
            await f.pool.query(
              `SELECT * FROM whaleu_messaging.${table} WHERE conversation_id=$1`,
              [id],
            )
          ).rowCount,
          1,
        );
      assert.equal((await f.get(b, 'unread')).body.count, 1);
    },
  );
  await t.test(
    'concurrent recall/read preserve coherent count and no recalled payload',
    async () => {
      const a = await f.actor(),
        b = await f.actor(),
        id = (await f.open(a, { kind: 'profile', profileId: b.profileId }))
          .conversationId,
        sent = await f.send(a, id, 'unseen'),
        messageId = sent.response.body.messageId,
        history = dmHistorySchema.parse(
          (await f.get(b, `conversations/${id}/messages`)).body,
        );
      const replies = await Promise.all([
        f.post(a, `conversations/${id}/messages/${messageId}/recall`, {
          clientRequestId: randomUUID(),
        }),
        f.post(b, `conversations/${id}/read`, {
          clientRequestId: randomUUID(),
          observationId: history.observationId,
        }),
      ]);
      for (const r of replies)
        assert.equal(r.body.outcome, 'applied', JSON.stringify(r.body));
      assert.equal((await f.get(b, 'unread')).body.count, 0);
      assert.equal(
        (await f.get(b, `conversations/${id}/messages`)).body.items[0].text,
        null,
      );
    },
  );
  await t.test(
    'SQL rejects context/receipt/message identity mutation and inconsistent counters',
    async () => {
      const a = await f.actor(),
        b = await f.actor(),
        opened = await f.open(a, { kind: 'profile', profileId: b.profileId }),
        id = opened.conversationId,
        sent = await f.send(a, id, 'immutable');
      for (const [sql, values] of [
        [
          "UPDATE whaleu_messaging.conversations SET mode0='anonymous' WHERE id=$1",
          [id],
        ],
        [
          'UPDATE whaleu_messaging.participants SET unread_count=999 WHERE conversation_id=$1',
          [id],
        ],
        [
          "UPDATE whaleu_messaging.messages SET body='changed' WHERE id=$1",
          [sent.response.body.messageId],
        ],
        [
          'DELETE FROM whaleu_messaging.messages WHERE id=$1',
          [sent.response.body.messageId],
        ],
        [
          'DELETE FROM whaleu_messaging.outbox WHERE message_id=$1',
          [sent.response.body.messageId],
        ],
        [
          'UPDATE whaleu_messaging.outbox SET recipient_id=$2 WHERE message_id=$1',
          [sent.response.body.messageId, a.accountId],
        ],
        [
          "UPDATE whaleu_messaging.requests SET receipt='{}'::jsonb WHERE account_id=$1 AND request_id=$2",
          [a.accountId, sent.body.clientRequestId],
        ],
      ] as [string, string[]][])
        await assert.rejects(
          inTransaction(
            f.pool,
            async (tx) => {
              await tx.query(sql, values);
            },
            { isolationLevel: 'read committed' },
          ),
        );
    },
  );
  await t.test(
    'SQL rejects successful block receipts without every mode-specific effect',
    async () => {
      const namedActor = await f.actor(),
        namedPeer = await f.actor(),
        anonymousActor = await f.actor(),
        anonymousPeer = await f.actor(),
        mixedAnonymous = await f.actor(),
        mixedNamed = await f.actor();
      const namedId = (
          await f.open(namedActor, {
            kind: 'profile',
            profileId: namedPeer.profileId,
          })
        ).conversationId,
        anonymousPost = await f.publish(anonymousPeer, 'anonymous'),
        anonymousId = (
          await f.open(
            anonymousActor,
            { kind: 'post', postId: anonymousPost },
            'anonymous',
          )
        ).conversationId,
        mixedPost = await f.publish(mixedNamed, 'named', true),
        mixedId = (
          await f.open(
            mixedAnonymous,
            { kind: 'post', postId: mixedPost },
            'anonymous',
          )
        ).conversationId;
      const cases = [
        {
          name: 'named without Safety binding',
          actor: namedActor,
          peer: namedPeer,
          id: namedId,
          effect: 'none',
          error: 'DM block receipt has no named peer binding',
        },
        {
          name: 'anonymous without local latch',
          actor: anonymousActor,
          peer: anonymousPeer,
          id: anonymousId,
          effect: 'none',
          error: 'DM block receipt has no conversation latch',
        },
        {
          name: 'mixed anonymous actor without either effect',
          actor: mixedAnonymous,
          peer: mixedNamed,
          id: mixedId,
          effect: 'none',
          error: 'DM block receipt has no conversation latch',
        },
        {
          name: 'mixed anonymous actor with local latch only',
          actor: mixedAnonymous,
          peer: mixedNamed,
          id: mixedId,
          effect: 'local',
          error: 'DM block receipt has no named peer binding',
        },
        {
          name: 'mixed anonymous actor with Safety binding only',
          actor: mixedAnonymous,
          peer: mixedNamed,
          id: mixedId,
          effect: 'named',
          error: 'DM block receipt has no conversation latch',
        },
        {
          name: 'mixed named actor without local latch',
          actor: mixedNamed,
          peer: mixedAnonymous,
          id: mixedId,
          effect: 'none',
          error: 'DM block receipt has no conversation latch',
        },
      ] as const;
      for (const scenario of cases) {
        for (const outcome of ['applied', 'noop'] as const) {
          const key = randomUUID(),
            receipt = {
              requestId: key,
              operation: 'block',
              outcome,
              conversationId: scenario.id,
              messageId: null,
              occurredAt: new Date().toISOString(),
            };
          await assert.rejects(
            inTransaction(
              f.pool,
              async (tx) => {
                await lockSafetyPolicy(tx, true);
                await tx.query(
                  "INSERT INTO whaleu_messaging.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,'block',$3)",
                  [
                    scenario.actor.accountId,
                    key,
                    dmDigest({
                      operation: 'block',
                      intent: {
                        conversationId: scenario.id,
                        clientRequestId: key,
                      },
                    }),
                  ],
                );
                if (scenario.effect === 'local')
                  await tx.query(
                    'UPDATE whaleu_messaging.participants SET blocked_at=clock_timestamp(),blocked_request_id=$3 WHERE conversation_id=$1 AND account_id=$2',
                    [scenario.id, scenario.actor.accountId, key],
                  );
                if (scenario.effect === 'named')
                  await f.app
                    .get(DmSafetyFacade)
                    .blockNamed(
                      scenario.actor.accountId,
                      scenario.peer.accountId,
                      key,
                      tx,
                    );
                await tx.query(
                  'INSERT INTO whaleu_messaging.transitions(account_id,request_id,conversation_id,message_id,receipt) VALUES($1,$2,$3,NULL,$4::jsonb)',
                  [
                    scenario.actor.accountId,
                    key,
                    scenario.id,
                    JSON.stringify(receipt),
                  ],
                );
                await tx.query(
                  'UPDATE whaleu_messaging.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2',
                  [scenario.actor.accountId, key, JSON.stringify(receipt)],
                );
                await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
              },
              { isolationLevel: 'read committed' },
            ),
            {
              code: '23514',
              message:
                scenario.effect === 'local' && outcome === 'noop'
                  ? 'DM local block lacks exact originating command'
                  : scenario.error,
            },
            `${scenario.name}: ${outcome}`,
          );
          for (const table of ['requests', 'transitions'])
            assert.equal(
              (
                await f.pool.query(
                  `SELECT * FROM whaleu_messaging.${table} WHERE account_id=$1 AND request_id=$2`,
                  [scenario.actor.accountId, key],
                )
              ).rowCount,
              0,
            );
          assert.equal(
            (
              await f.pool.query(
                'SELECT * FROM whaleu_messaging.participants WHERE conversation_id=$1 AND blocked_at IS NOT NULL',
                [scenario.id],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT * FROM whaleu_safety.dm_block_bindings WHERE account_id=$1 AND request_id=$2',
                [scenario.actor.accountId, key],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT * FROM whaleu_safety.blocks WHERE blocker_id=$1 AND blocked_id=$2',
                [scenario.actor.accountId, scenario.peer.accountId],
              )
            ).rowCount,
            0,
          );
        }
      }
      for (const scenario of [
        { actor: anonymousActor, id: anonymousId },
        { actor: mixedNamed, id: mixedId },
      ]) {
        const origin = randomUUID(),
          blocked = await f.post(
            scenario.actor,
            `conversations/${scenario.id}/block`,
            { clientRequestId: origin },
          );
        assert.equal(
          blocked.body.outcome,
          'applied',
          JSON.stringify(blocked.body),
        );
        const forgedKey = randomUUID(),
          forgedReceipt = {
            requestId: forgedKey,
            operation: 'block',
            outcome: 'applied',
            conversationId: scenario.id,
            messageId: null,
            occurredAt: new Date().toISOString(),
          };
        await assert.rejects(
          inTransaction(
            f.pool,
            async (tx) => {
              await lockSafetyPolicy(tx, true);
              await tx.query(
                "INSERT INTO whaleu_messaging.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,'block',$3)",
                [
                  scenario.actor.accountId,
                  forgedKey,
                  dmDigest({
                    operation: 'block',
                    intent: {
                      conversationId: scenario.id,
                      clientRequestId: forgedKey,
                    },
                  }),
                ],
              );
              await tx.query(
                'INSERT INTO whaleu_messaging.transitions(account_id,request_id,conversation_id,message_id,receipt) VALUES($1,$2,$3,NULL,$4::jsonb)',
                [
                  scenario.actor.accountId,
                  forgedKey,
                  scenario.id,
                  JSON.stringify(forgedReceipt),
                ],
              );
              await tx.query(
                'UPDATE whaleu_messaging.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2',
                [
                  scenario.actor.accountId,
                  forgedKey,
                  JSON.stringify(forgedReceipt),
                ],
              );
              await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
            },
            { isolationLevel: 'read committed' },
          ),
          {
            code: '23514',
            message: 'DM block receipt does not match local latch transition',
          },
        );
        assert.equal(
          (await f.get(scenario.actor, `requests/${forgedKey}`)).status,
          404,
        );
        const repeat = randomUUID(),
          noop = await f.post(
            scenario.actor,
            `conversations/${scenario.id}/block`,
            { clientRequestId: repeat },
          );
        assert.equal(noop.body.outcome, 'noop', JSON.stringify(noop.body));
        await assert.rejects(
          f.pool.query(
            'UPDATE whaleu_messaging.participants SET blocked_request_id=$3 WHERE conversation_id=$1 AND account_id=$2',
            [scenario.id, scenario.actor.accountId, repeat],
          ),
          { code: '23514', message: 'Participant history changed' },
        );
        assert.equal(
          (
            await f.pool.query<{ blocked_request_id: string }>(
              'SELECT blocked_request_id FROM whaleu_messaging.participants WHERE conversation_id=$1 AND account_id=$2',
              [scenario.id, scenario.actor.accountId],
            )
          ).rows[0]!.blocked_request_id,
          origin,
        );
      }
    },
  );
  await t.test(
    'inbox cursor preserves microsecond ordering without equal-ms gaps',
    async () => {
      const a = await f.actor(),
        b = await f.actor(),
        c = await f.actor();
      const one = (await f.open(a, { kind: 'profile', profileId: b.profileId }))
          .conversationId,
        two = (await f.open(a, { kind: 'profile', profileId: c.profileId }))
          .conversationId;
      assert.equal(
        (await f.send(a, one, 'one')).response.body.outcome,
        'applied',
      );
      assert.equal(
        (await f.send(a, two, 'two')).response.body.outcome,
        'applied',
      );
      await f.pool.query(
        "UPDATE whaleu_messaging.conversations SET updated_at=CASE WHEN id=$1 THEN '2026-01-01T00:00:00.123789Z'::timestamptz ELSE '2026-01-01T00:00:00.123456Z'::timestamptz END WHERE id=ANY($2::uuid[])",
        [one, [one, two]],
      );
      const page = await f.get(a, 'conversations', { limit: 1 });
      assert.equal(page.status, 200, JSON.stringify(page.body));
      assert.equal(page.body.items[0].conversation.id, one);
      const next = await f.get(a, 'conversations', {
        limit: 1,
        cursor: page.body.nextCursor,
      });
      assert.equal(next.status, 200, JSON.stringify(next.body));
      assert.equal(next.body.items[0].conversation.id, two);
      assert.equal(next.body.nextCursor, null);
    },
  );
  await t.test(
    'inclusive recall predicate preserves DB sub-millisecond distinction',
    async () => {
      const row = (
        await f.pool.query<{ before: boolean; exact: boolean; after: boolean }>(
          `WITH x AS (SELECT '2026-01-01T00:00:00Z'::timestamptz created) SELECT whaleu_messaging.recall_allowed(created,created+interval '119.999 seconds') AS before,whaleu_messaging.recall_allowed(created,created+interval '120 seconds') AS exact,whaleu_messaging.recall_allowed(created,created+interval '120.000001 seconds') AS after FROM x`,
        )
      ).rows[0]!;
      assert.deepEqual(row, { before: true, exact: true, after: false });
    },
  );
  await t.test(
    'exclusive policy transition is observed before sender can resolve any context',
    async () => {
      const a = await f.actor(),
        b = await f.actor(),
        id = (await f.open(a, { kind: 'profile', profileId: b.profileId }))
          .conversationId,
        body = { clientRequestId: randomUUID(), text: 'blocked while waiting' };
      await f.approval(a, id, body);
      const lock = await f.pool.connect();
      await lock.query('BEGIN');
      await lockSafetyPolicy(lock, true);
      try {
        const pending = f
          .post(a, `conversations/${id}/messages`, body)
          .then((r) => r);
        await f.waitForLock('whaleu:named-block-policy:v1');
        await lock.query(
          'UPDATE whaleu_safety.account_heads SET actions_allowed=false WHERE account_id=$1',
          [a.accountId],
        );
        await lock.query('COMMIT');
        const response = await pending;
        assert.equal(
          response.body.code,
          'SAFETY_ACTION_RESTRICTED',
          JSON.stringify(response.body),
        );
      } finally {
        await lock.query('ROLLBACK');
        lock.release();
      }
    },
  );
});
