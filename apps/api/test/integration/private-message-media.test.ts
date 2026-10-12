import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { finished } from 'node:stream/promises';
import type {
  PrivateMessageMediaFixture,
  PrivateMessageMediaActor,
} from '../support/media/private-message-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import sharp from 'sharp';
import request from 'supertest';
import {
  privateMessageMediaFixture,
  readyPrivateMessageImage,
  approvePrivateMessageImage,
  privateMessageMediaPrefix as prefix,
  privateMessageMediaOk as ok,
} from '../support/media/private-message-runtime-fixture.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { privateMessageMediaRequestHash } from '../../src/media/contracts-private-message.js';
import { SyntheticMediaCleanup } from '../support/media/synthetic-cleanup.js';
import { setDmReviewState } from '../support/dm-owner-fixture.js';
async function heldDelivery(
  f: PrivateMessageMediaFixture,
  actor: PrivateMessageMediaActor,
  path: string,
) {
  const original = f.storage.openExact.bind(f.storage);
  let release!: () => void,
    entered!: () => void,
    bytes = 0,
    quiet = Promise.resolve();
  const reached = new Promise<void>((r) => {
      entered = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  f.storage.openExact = async (...args) => {
    const value = await original(...args);
    quiet = finished(value.stream).catch(() => undefined);
    value.stream.on('data', (b: Buffer) => {
      bytes += b.length;
    });
    value.stream.pause();
    entered();
    await gate;
    return value;
  };
  const response = request(f.http)
    .get(path)
    .set('Authorization', `Bearer ${actor.accessToken}`)
    .then((v) => v);
  await Promise.race([
    reached,
    response.then(() => assert.fail('Expected storage open gate')),
  ]);
  return {
    response,
    bytes: () => bytes,
    release: async () => {
      release();
      f.storage.openExact = original;
      const result = await response;
      await quiet;
      return result;
    },
  };
}
async function imageSafety(
  f: PrivateMessageMediaFixture,
  assetId: string,
  state: 'allow' | 'revoked',
) {
  await withCommunityScopeWriter(f.pool, async (tx) => {
    const id = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_media.asset_safety_events(id,asset_id,revision,state,manifest_digest,policy_revision,issuer,source_reference,provenance,effective_at,valid_until) SELECT $1::uuid,a.id,h.revision+1,$3,a.manifest_digest,a.policy_revision,'private-message-media-test',$1::text,'{}'::jsonb,clock_timestamp(),clock_timestamp()+interval '30 minutes' FROM whaleu_media.assets a JOIN whaleu_media.asset_safety_heads h ON h.asset_id=a.id WHERE a.id=$2`,
      [id, assetId, state],
    );
    await tx.query(
      'UPDATE whaleu_media.asset_safety_heads SET revision=revision+1,event_id=$2 WHERE asset_id=$1',
      [assetId, id],
    );
  });
}
test(
  'PM15 upload, exact private delivery, retained blocked history and recall retirement remain fail-closed',
  { timeout: 180000 },
  async (t) => {
    const bytes = await sharp({
        create: { width: 32, height: 32, channels: 3, background: '#39775d' },
      })
        .png()
        .toBuffer(),
      f = await privateMessageMediaFixture([
        { sha256: sha256(bytes), verdict: 'allow' },
      ]);
    t.after(() => f.close());
    const sender = await f.actor(),
      peer = await f.actor(),
      outsider = await f.actor(),
      opened = await f.open(sender, {
        kind: 'profile',
        profileId: peer.profileId,
      }),
      conversationId = opened.conversationId,
      messageRequestId = randomUUID();
    const ready = await readyPrivateMessageImage(
        f,
        sender,
        conversationId,
        messageRequestId,
        bytes,
      ),
      review = await approvePrivateMessageImage(
        f,
        sender,
        conversationId,
        messageRequestId,
        ready.fact,
      );
    const sent = await f.post(
      sender,
      `conversations/${conversationId}/images`,
      {
        clientRequestId: messageRequestId,
        image: ready.fact,
      },
    );
    ok(sent);
    assert.equal(sent.body.outcome, 'applied', JSON.stringify(sent.body));
    const messageId = sent.body.messageId as string,
      descriptorPath = `${prefix}/conversations/${conversationId}/messages/${messageId}`;
    const descriptor = await request(f.http)
      .get(descriptorPath)
      .set('Authorization', `Bearer ${peer.accessToken}`);
    ok(descriptor);
    assert.equal(descriptor.body.kind, 'private-message-media');
    assert.equal('url' in descriptor.body, false);
    const binaryPath = `${descriptorPath}/bindings/${descriptor.body.bindingId}/display-v1`;
    const downloaded = await request(f.http)
      .get(binaryPath)
      .set('Authorization', `Bearer ${peer.accessToken}`);
    ok(downloaded);
    assert.equal(downloaded.headers['cache-control'], 'private, no-store');
    assert.match(String(downloaded.headers['content-type']), /^image\/png/);
    const denied = await request(f.http)
      .get(binaryPath)
      .set('Authorization', `Bearer ${outsider.accessToken}`);
    assert.notEqual(denied.status, 200);
    for (const mutate of [
      () => setDmReviewState(f.pool, review.decisionId, 'revoked'),
      () => imageSafety(f, ready.fact.assetId, 'revoked'),
    ]) {
      const held = await heldDelivery(f, peer, binaryPath);
      assert.equal(held.bytes(), 0);
      await mutate();
      const response = await held.release();
      assert.notEqual(response.status, 200);
      assert.equal(held.bytes(), 0);
      await setDmReviewState(f.pool, review.decisionId, 'allow');
      await imageSafety(f, ready.fact.assetId, 'allow');
    }
    const blocked = await f.post(
      peer,
      `conversations/${conversationId}/block`,
      {
        clientRequestId: randomUUID(),
      },
    );
    ok(blocked);
    assert.equal(blocked.body.outcome, 'applied');
    ok(
      await request(f.http)
        .get(binaryPath)
        .set('Authorization', `Bearer ${peer.accessToken}`),
    );
    const newPrepare = await request(f.http)
      .post(`${prefix}/upload-intents`)
      .set('Authorization', `Bearer ${sender.accessToken}`)
      .send({
        ...ready.input,
        clientRequestId: randomUUID(),
        messageRequestId: randomUUID(),
      });
    assert.notEqual(newPrepare.status, 200);
    // Recovery is historical metadata even after block; cancellation of a bound
    // image returns the same history and cannot retire an already committed send.
    const cancelled = await request(f.http)
      .post(`${prefix}/upload-intents/${ready.status.intentId}/cancel`)
      .set('Authorization', `Bearer ${sender.accessToken}`)
      .send({});
    ok(cancelled);
    assert.equal(cancelled.body.status, 'bound_history');
    assert.equal(cancelled.body.attachmentState, 'active');
    await setDmReviewState(f.pool, review.decisionId, 'revoked');
    assert.notEqual(
      (
        await request(f.http)
          .get(binaryPath)
          .set('Authorization', `Bearer ${peer.accessToken}`)
      ).status,
      200,
    );
    await setDmReviewState(f.pool, review.decisionId, 'allow');
    const held = await heldDelivery(f, peer, binaryPath);
    t.after(async () => {
      await held.release();
    });
    const recall = await f.post(
      sender,
      `conversations/${conversationId}/messages/${messageId}/recall`,
      { clientRequestId: randomUUID() },
    );
    ok(recall);
    assert.equal(recall.body.outcome, 'applied', JSON.stringify(recall.body));
    assert.notEqual(
      (
        await request(f.http)
          .get(binaryPath)
          .set('Authorization', `Bearer ${peer.accessToken}`)
      ).status,
      200,
    );
    const rows = (
      await f.pool.query(
        `SELECT r.message_id,i.state FROM whaleu_media.private_message_retirements r JOIN whaleu_media.bindings b ON b.id=r.binding_id JOIN whaleu_media.assets a ON a.id=b.asset_id JOIN whaleu_media.upload_intents i ON i.id=a.intent_id WHERE r.message_id=$1`,
        [messageId],
      )
    ).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.state, 'cleanup_pending');
    for (const isolation of ['REPEATABLE READ', 'SERIALIZABLE']) {
      const tx = await f.pool.connect();
      try {
        await tx.query(`BEGIN ISOLATION LEVEL ${isolation}`);
        await assert.rejects(
          tx.query(
            "UPDATE whaleu_media.cleanup_obligations SET state='deleting',lease_token=$2,lease_until=clock_timestamp()+interval '1 minute' WHERE id=(SELECT c.id FROM whaleu_media.cleanup_obligations c LEFT JOIN whaleu_media.object_attempts o ON o.id=c.object_attempt_id LEFT JOIN whaleu_media.assets a ON a.id=c.asset_id LEFT JOIN whaleu_media.derived_object_attempts d ON d.id=c.derived_attempt_id LEFT JOIN whaleu_media.upload_ingress_writers w ON w.writer_token=c.ingress_writer_id LEFT JOIN whaleu_media.object_attempts wa ON wa.id=w.object_attempt_id WHERE coalesce(o.intent_id,a.intent_id,d.intent_id,wa.intent_id)=$1 LIMIT 1)",
            [ready.status.intentId, randomUUID()],
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
    const cleanup = new SyntheticMediaCleanup(f.pool, f.storage);
    assert.equal(
      await new SyntheticMediaCleanup(f.pool, f.storage).runOne(),
      'idle',
      'No configured real retention policy means no physical deletion',
    );
    const policyId = randomUUID(),
      policyRevision = sha256(
        Buffer.from('synthetic-private-retention-policy'),
      );
    await withCommunityScopeWriter(f.pool, async (tx) => {
      await tx.query(
        `INSERT INTO whaleu_media.private_message_retention_policies(id,revision,policy_reference,active,valid_from,valid_until) VALUES($1,$2,'isolated-synthetic-test-only',true,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')`,
        [policyId, policyRevision],
      );
      await tx.query(
        `INSERT INTO whaleu_media.private_message_cleanup_authorizations(intent_id,policy_id,policy_revision,not_before,valid_until) VALUES($1,$2,$3,clock_timestamp(),clock_timestamp()+interval '1 hour')`,
        [ready.status.intentId, policyId, policyRevision],
      );
    });
    // Preserve the real shared collector cutoff. There is no test-only shortened
    // lease, fake delete result, raw quiet flag, or bypass of the SQL guard.
    const due = (
      await f.pool.query<{ due: Date }>(
        `SELECT max(c.not_before) due FROM whaleu_media.cleanup_obligations c LEFT JOIN whaleu_media.object_attempts o ON o.id=c.object_attempt_id LEFT JOIN whaleu_media.assets a ON a.id=c.asset_id LEFT JOIN whaleu_media.derived_object_attempts d ON d.id=c.derived_attempt_id LEFT JOIN whaleu_media.upload_ingress_writers w ON w.writer_token=c.ingress_writer_id LEFT JOIN whaleu_media.object_attempts wa ON wa.id=w.object_attempt_id WHERE coalesce(o.intent_id,a.intent_id,d.intent_id,wa.intent_id)=$1`,
        [ready.status.intentId],
      )
    ).rows[0]!.due;
    for (;;) {
      const remaining = (
        await f.pool.query<{ ms: number }>(
          'SELECT (extract(epoch FROM ($1::timestamptz-clock_timestamp()))*1000)::double precision ms',
          [due],
        )
      ).rows[0]!.ms;
      if (remaining < -5) break;
      await sleep(Math.min(1000, Math.max(1, remaining + 10)));
    }
    assert.notEqual(
      (await held.response).status,
      200,
      'Caller timeout is not physical provider quiet',
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_media.private_message_delivery_holds WHERE binding_id=$1 AND closed_at IS NULL',
          [descriptor.body.bindingId],
        )
      ).rowCount,
      1,
    );
    assert.equal(
      await cleanup.runOne(),
      'idle',
      'Approved retention still cannot delete while a provider effect is pending',
    );
    await held.release();
    assert.equal(held.bytes(), 0);
    const closeDeadline = Date.now() + 5000;
    while (
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_media.private_message_delivery_holds WHERE binding_id=$1 AND closed_at IS NULL',
          [descriptor.body.bindingId],
        )
      ).rowCount
    ) {
      assert.ok(
        Date.now() < closeDeadline,
        'Physical quiet should durably close the hold',
      );
      await sleep(10);
    }
    assert.equal(
      (
        await f.pool.query<{ allowed: boolean }>(
          'SELECT whaleu_media.private_message_cleanup_allowed($1) allowed',
          [ready.status.intentId],
        )
      ).rows[0]!.allowed,
      true,
    );
    let deleted = 0;
    for (let n = 0; n < 20; n++) {
      const result = await cleanup.runOne();
      if (result === 'idle') break;
      assert.equal(result, 'deleted');
      deleted++;
    }
    assert.ok(
      deleted >= 3,
      'Exact original and transformed objects are really deleted after policy and quiet',
    );
  },
);
test('PM15 cancellation before prepare fences the original image command and cannot be retargeted', async (t) => {
  const f = await privateMessageMediaFixture([
    {
      sha256: sha256(Buffer.from('synthetic-unprocessed-cancellation-fixture')),
      verdict: 'held',
    },
  ]);
  t.after(() => f.close());
  const actor = await f.actor(),
    peer = await f.actor(),
    c = await f.open(actor, { kind: 'profile', profileId: peer.profileId });
  const input = {
      protocol: 'private-message-media-v1' as const,
      clientRequestId: randomUUID(),
      conversationId: c.conversationId,
      messageRequestId: randomUUID(),
      declaration: {
        mime: 'image/png' as const,
        bytes: 12,
        sha256: 'a'.repeat(64),
      },
    },
    body = {
      protocol: input.protocol,
      requestHash: privateMessageMediaRequestHash(actor.accountId, input),
      conversationId: input.conversationId,
      messageRequestId: input.messageRequestId,
    };
  const path = `${prefix}/upload-requests/${input.clientRequestId}/cancel`;
  const cancelled = await request(f.http)
    .post(path)
    .set('Authorization', `Bearer ${actor.accessToken}`)
    .send(body);
  ok(cancelled);
  assert.equal(cancelled.body.state, 'cancelled_before_prepare');
  const retarget = await request(f.http)
    .post(path)
    .set('Authorization', `Bearer ${actor.accessToken}`)
    .send({ ...body, messageRequestId: randomUUID() });
  assert.notEqual(retarget.status, 200);
  const prepared = await request(f.http)
    .post(`${prefix}/upload-intents`)
    .set('Authorization', `Bearer ${actor.accessToken}`)
    .send(input);
  assert.notEqual(prepared.status, 200);
  const fence = await f.pool.query(
    'SELECT 1 FROM whaleu_messaging.image_command_fences WHERE account_id=$1 AND request_id=$2',
    [actor.accountId, input.messageRequestId],
  );
  assert.equal(fence.rowCount, 1);
});
