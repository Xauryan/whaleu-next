import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import sharp from 'sharp';
import request from 'supertest';
import {
  privateMessageMediaFixture,
  readyPrivateMessageImage,
  approvePrivateMessageImage,
  privateMessageMediaOk as ok,
  privateMessageMediaPrefix as prefix,
} from '../support/media/private-message-runtime-fixture.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { dmDigest } from '../../src/messaging/repository.js';
import { setDmReviewState } from '../support/dm-owner-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';

test(
  'PM3 exact image command shares Messaging collision, lifetime, negative authority and relational rollback boundaries',
  { timeout: 300000 },
  async (t) => {
    const bytes = await sharp({
      create: { width: 24, height: 32, channels: 3, background: '#427691' },
    })
      .png()
      .toBuffer();
    const f = await privateMessageMediaFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    const pair = async () => {
      const a = await f.actor(),
        b = await f.actor(),
        id = (await f.open(a, { kind: 'profile', profileId: b.profileId }))
          .conversationId;
      return { a, b, id };
    };
    await t.test(
      'raw stale-snapshot command namespace writes fail closed',
      async () => {
        const { a, id } = await pair();
        const context = (
          await f.pool.query<{ context_digest: string }>(
            'SELECT context_digest FROM whaleu_messaging.conversations WHERE id=$1',
            [id],
          )
        ).rows[0]!.context_digest;
        for (const isolation of ['REPEATABLE READ', 'SERIALIZABLE']) {
          for (const target of [
            'requests',
            'image_command_reservations',
            'image_command_fences',
          ]) {
            const tx = await f.pool.connect();
            try {
              await tx.query(`BEGIN ISOLATION LEVEL ${isolation}`);
              await tx.query(
                'SELECT count(*) FROM whaleu_messaging.image_command_reservations',
              );
              await assert.rejects(
                tx.query(
                  target === 'requests'
                    ? "INSERT INTO whaleu_messaging.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,'send',$3)"
                    : target === 'image_command_reservations'
                      ? 'INSERT INTO whaleu_messaging.image_command_reservations(account_id,request_id,conversation_id,context_digest) VALUES($1,$2,$3,$4)'
                      : 'INSERT INTO whaleu_messaging.image_command_fences(account_id,request_id,conversation_id) VALUES($1,$2,$3)',
                  target === 'requests'
                    ? [a.accountId, randomUUID(), '0'.repeat(64)]
                    : target === 'image_command_reservations'
                      ? [a.accountId, randomUUID(), id, context]
                      : [a.accountId, randomUUID(), id],
                ),
                (e: unknown) =>
                  e instanceof Error &&
                  'code' in e &&
                  e.code === '23514' &&
                  /requires read committed/.test(e.message),
              );
            } finally {
              await tx.query('ROLLBACK');
              tx.release();
            }
          }
        }
      },
    );
    await t.test(
      'image Review expiry after deferred constraints rolls back binding, counters, event, outbox and receipt together',
      async () => {
        const { a, b, id } = await pair(),
          key = randomUUID(),
          ready = await readyPrivateMessageImage(f, a, id, key, bytes);
        await approvePrivateMessageImage(f, a, id, key, ready.fact, {
          consumeUntil: new Date(Date.now() + 2500),
        });
        await f.pool.query('CREATE SCHEMA pm3_expiry_fixture');
        await f.pool.query(
          `CREATE FUNCTION pm3_expiry_fixture.pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id='${key}'::uuid THEN PERFORM pg_advisory_xact_lock(192701,315);END IF;RETURN NULL;END $$`,
        );
        await f.pool.query(
          'CREATE CONSTRAINT TRIGGER z_pm3_expiry_pause AFTER INSERT OR UPDATE ON whaleu_messaging.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pm3_expiry_fixture.pause()',
        );
        const gate = await f.pool.connect();
        await gate.query('SELECT pg_advisory_lock(192701,315)');
        try {
          const pending = f
            .post(a, `conversations/${id}/images`, {
              clientRequestId: key,
              image: ready.fact,
            })
            .then((r) => r);
          const deadline = Date.now() + 5000;
          while (
            !(
              await f.pool.query(
                "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SET CONSTRAINTS%' ",
              )
            ).rowCount
          ) {
            assert.ok(
              Date.now() < deadline,
              'image publication must actually wait at deferred constraints',
            );
            await sleep(10);
          }
          await sleep(2600);
          await gate.query('SELECT pg_advisory_unlock(192701,315)');
          const response = await pending;
          assert.equal(response.status, 503, JSON.stringify(response.body));
          for (const table of ['messages', 'events'])
            assert.equal(
              (
                await f.pool.query(
                  `SELECT 1 FROM whaleu_messaging.${table} WHERE conversation_id=$1`,
                  [id],
                )
              ).rowCount,
              0,
            );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=$1',
                [ready.fact.assetId],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_media.private_message_appearances WHERE asset_id=$1',
                [ready.fact.assetId],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT lifetime_sent::text FROM whaleu_messaging.participants WHERE conversation_id=$1 AND account_id=$2',
                [id, a.accountId],
              )
            ).rows[0].lifetime_sent,
            '0',
          );
          assert.equal((await f.get(b, 'unread')).body.count, 0);
          assert.equal((await f.get(a, `requests/${key}`)).status, 404);
        } finally {
          await gate.query('SELECT pg_advisory_unlock(192701,315)');
          gate.release();
          await f.pool.query('DROP SCHEMA pm3_expiry_fixture CASCADE');
        }
        await approvePrivateMessageImage(f, a, id, key, ready.fact);
        const sent = await f.post(a, `conversations/${id}/images`, {
          clientRequestId: key,
          image: ready.fact,
        });
        ok(sent);
        assert.equal(sent.body.outcome, 'applied');
      },
    );
    await t.test(
      'wrong context, owner, manifest, original command and double binding cannot spend another asset',
      async () => {
        const { a, b, id } = await pair(),
          c = await f.actor(),
          other = (await f.open(a, { kind: 'profile', profileId: c.profileId }))
            .conversationId,
          key = randomUUID(),
          ready = await readyPrivateMessageImage(f, a, id, key, bytes);
        const stolenKey = await f.post(a, `conversations/${id}/messages`, {
          clientRequestId: key,
          text: 'Prepared image key cannot become text',
        });
        assert.equal(stolenKey.body.error?.code, 'REQUEST_CONFLICT');
        for (const [actor, conversationId, requestId, image] of [
          [a, other, key, ready.fact],
          [b, id, key, ready.fact],
          [a, id, randomUUID(), ready.fact],
          [a, id, key, { ...ready.fact, manifestDigest: '0'.repeat(64) }],
        ] as const) {
          const bad = await f.post(
            actor,
            `conversations/${conversationId}/images`,
            { clientRequestId: requestId, image },
          );
          assert.notEqual(bad.status, 200, JSON.stringify(bad.body));
        }
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=$1',
              [ready.fact.assetId],
            )
          ).rowCount,
          0,
        );
        await approvePrivateMessageImage(f, a, id, key, ready.fact);
        const body = { clientRequestId: key, image: ready.fact },
          sent = await f.post(a, `conversations/${id}/images`, body);
        ok(sent);
        assert.equal(sent.body.outcome, 'applied');
        const replay = await f.post(a, `conversations/${id}/images`, body);
        assert.deepEqual(replay.body, sent.body);
        const text = await f.post(a, `conversations/${id}/messages`, {
          clientRequestId: key,
          text: '[图片]',
        });
        assert.equal(text.body.error?.code, 'REQUEST_CONFLICT');
        const changed = await f.post(a, `conversations/${id}/images`, {
          ...body,
          image: { ...ready.fact, manifestDigest: 'f'.repeat(64) },
        });
        assert.equal(changed.body.error?.code, 'REQUEST_CONFLICT');
        const recall = await f.post(
          a,
          `conversations/${id}/messages/${sent.body.messageId}/recall`,
          { clientRequestId: randomUUID() },
        );
        ok(recall);
        const second = await f.post(a, `conversations/${id}/images`, {
          clientRequestId: randomUUID(),
          image: ready.fact,
        });
        ok(second);
        assert.equal(second.body.code, 'DM_FIRST_CONTACT_LIMIT');
        assert.equal(
          (
            await f.pool.query(
              'SELECT lifetime_sent FROM whaleu_messaging.participants WHERE conversation_id=$1 AND account_id=$2',
              [id, a.accountId],
            )
          ).rows[0].lifetime_sent,
          '1',
        );
      },
    );
    await t.test(
      'concurrent image/text first contacts have one accepted message and shared counters/events/outbox',
      async () => {
        const { a, b, id } = await pair(),
          key = randomUUID(),
          ready = await readyPrivateMessageImage(f, a, id, key, bytes),
          text = {
            clientRequestId: randomUUID(),
            text: 'Competing first text',
          };
        await approvePrivateMessageImage(f, a, id, key, ready.fact);
        await f.approval(a, id, text);
        const replies = await Promise.all([
          f.post(a, `conversations/${id}/images`, {
            clientRequestId: key,
            image: ready.fact,
          }),
          f.post(a, `conversations/${id}/messages`, text),
        ]);
        for (const r of replies) ok(r);
        assert.deepEqual(replies.map((r) => r.body.outcome).sort(), [
          'applied',
          'rejected',
        ]);
        assert.equal(
          replies.find((r) => r.body.outcome === 'rejected')!.body.code,
          'DM_FIRST_CONTACT_LIMIT',
        );
        for (const table of ['messages', 'events'])
          assert.equal(
            (
              await f.pool.query(
                `SELECT count(*) n FROM whaleu_messaging.${table} WHERE conversation_id=$1`,
                [id],
              )
            ).rows[0].n,
            '1',
          );
        assert.equal((await f.get(b, 'unread')).body.count, 1);
      },
    );
    await t.test(
      'missing/pending Review is recoverable; exact rejection is terminal and never masquerades as image text',
      async () => {
        const { a, id } = await pair(),
          key = randomUUID(),
          ready = await readyPrivateMessageImage(f, a, id, key, bytes),
          body = { clientRequestId: key, image: ready.fact };
        const missing = await f.post(a, `conversations/${id}/images`, body);
        assert.equal(missing.status, 503);
        assert.equal((await f.get(a, `requests/${key}`)).status, 404);
        await approvePrivateMessageImage(f, a, id, key, ready.fact, {
          result: 'pending',
        });
        assert.equal(
          (await f.post(a, `conversations/${id}/images`, body)).status,
          503,
        );
        await approvePrivateMessageImage(f, a, id, key, ready.fact, {
          result: 'reject',
        });
        const rejected = await f.post(a, `conversations/${id}/images`, body);
        ok(rejected);
        assert.equal(rejected.body.code, 'CONTENT_REJECTED');
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=$1',
              [ready.fact.assetId],
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_messaging.messages WHERE conversation_id=$1',
              [id],
            )
          ).rowCount,
          0,
        );
        await approvePrivateMessageImage(f, a, id, key, ready.fact);
        assert.deepEqual(
          (await f.post(a, `conversations/${id}/images`, body)).body,
          rejected.body,
        );
      },
    );
    await t.test(
      'image cancellation and send compete under the same original command fence',
      async () => {
        const { a, id } = await pair(),
          key = randomUUID(),
          ready = await readyPrivateMessageImage(f, a, id, key, bytes),
          body = { clientRequestId: key, image: ready.fact };
        await approvePrivateMessageImage(f, a, id, key, ready.fact);
        const [send, cancel] = await Promise.all([
          f.post(a, `conversations/${id}/images`, body),
          f.post(a, `requests/${key}/cancel`, {
            operation: 'send_image',
            intentHash: dmDigest({
              operation: 'send_image',
              intent: { conversationId: id, ...body },
            }),
          }),
        ]);
        ok(send);
        ok(cancel);
        assert.deepEqual(send.body, cancel.body.receipt);
        const applied = send.body.outcome === 'applied';
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*) n FROM whaleu_messaging.messages WHERE conversation_id=$1',
              [id],
            )
          ).rows[0].n,
          applied ? '1' : '0',
        );
      },
    );
    await t.test(
      'held/revoked message Review suppresses both image projections and byte access, unknown remains unavailable',
      async () => {
        const { a, b, id } = await pair(),
          key = randomUUID(),
          ready = await readyPrivateMessageImage(f, a, id, key, bytes),
          review = await approvePrivateMessageImage(f, a, id, key, ready.fact);
        const sent = await f.post(a, `conversations/${id}/images`, {
          clientRequestId: key,
          image: ready.fact,
        });
        ok(sent);
        for (const state of ['held', 'revoked'] as const) {
          await setDmReviewState(f.pool, review.decisionId, state);
          for (const actor of [a, b]) {
            const h = await f.get(actor, `conversations/${id}/messages`);
            ok(h);
            assert.equal(h.body.items[0].state, 'unavailable');
            assert.equal('image' in h.body.items[0], false);
            assert.notEqual(
              (
                await request(f.http)
                  .get(
                    `${prefix}/conversations/${id}/messages/${sent.body.messageId}`,
                  )
                  .set('Authorization', `Bearer ${actor.accessToken}`)
              ).status,
              200,
            );
          }
        }
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            "UPDATE whaleu_community.dm_review_issuers SET coverage='missing' WHERE policy_revision_id=$1",
            [review.policyRevisionId],
          ),
        );
        assert.equal(
          (await f.get(a, `conversations/${id}/messages`)).status,
          503,
        );
      },
    );
  },
);

test(
  'PM3 recall during immutable storage open releases zero pixels after second owner authorization',
  { timeout: 300000 },
  async (t) => {
    const bytes = await sharp({
      create: { width: 24, height: 24, channels: 3, background: '#628392' },
    })
      .png()
      .toBuffer();
    const f = await privateMessageMediaFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    const a = await f.actor(),
      b = await f.actor(),
      id = (await f.open(a, { kind: 'profile', profileId: b.profileId }))
        .conversationId,
      key = randomUUID(),
      ready = await readyPrivateMessageImage(f, a, id, key, bytes);
    await approvePrivateMessageImage(f, a, id, key, ready.fact);
    const sent = await f.post(a, `conversations/${id}/images`, {
      clientRequestId: key,
      image: ready.fact,
    });
    ok(sent);
    const messageId = sent.body.messageId as string,
      descriptor = await f.media.descriptor(b.accessToken, {
        conversationId: id,
        messageId,
      });
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>((r) => (entered = r)),
      blocked = new Promise<void>((r) => (release = r)),
      original = f.storage.openExact.bind(f.storage);
    f.storage.openExact = async (...args) => {
      entered();
      await blocked;
      return original(...args);
    };
    const pending = f.media
      .open(
        b.accessToken,
        { conversationId: id, messageId },
        descriptor.bindingId,
        'display-v1',
        'synthetic',
      )
      .then(
        () => assert.fail('Revoked storage open must not return stream'),
        (e) => e,
      );
    await reached;
    const recalled = await f.post(
      a,
      `conversations/${id}/messages/${messageId}/recall`,
      { clientRequestId: randomUUID() },
    );
    ok(recalled);
    assert.equal(recalled.body.outcome, 'applied');
    release();
    assert.ok(await pending);
    f.storage.openExact = original;
    for (const actor of [a, b]) {
      const h = await f.get(actor, `conversations/${id}/messages`);
      ok(h);
      assert.equal(h.body.items[0].state, 'recalled');
      assert.equal('image' in h.body.items[0], false);
    }
    assert.equal(
      (
        await f.pool.query(
          'SELECT state FROM whaleu_messaging.outbox WHERE message_id=$1',
          [messageId],
        )
      ).rows[0].state,
      'suppressed',
    );
  },
);
