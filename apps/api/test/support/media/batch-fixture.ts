import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { syntheticMediaRuntimeFixture } from './runtime-fixture.js';
import { sha256 } from '../../../src/media/processing/protocol.js';
import {
  mediaBatchStatusSchema,
  mediaBatchRecoverySchema,
  mediaMemberStatusSchema,
} from '../../../src/media/contracts-v3.js';
import type {
  MediaBatchIdentity,
  MediaBatchStatus,
} from '../../../src/media/contracts-v3.js';
import { postIntent } from '../../../src/community/publication-intent.js';
import { publicationHash } from '../../../src/community/publication.repository.js';
import { postApprovalEnvelope } from '../community-runtime-fixtures.js';
import { approveEnvelope } from '../community-approval-fixtures.js';
export type BatchFixture = Awaited<
  ReturnType<typeof syntheticMediaRuntimeFixture>
>;
export type BatchActor = Awaited<ReturnType<BatchFixture['actor']>>;
export const responseOk = (
  response: { status: number; body: unknown },
  status = 200,
) => assert.equal(response.status, status, JSON.stringify(response.body));
export async function readyBatch(
  f: BatchFixture,
  actor: BatchActor,
  size: number,
  files: readonly { mime: string; bytes: Buffer }[],
) {
  const http = f.app.getHttpServer(),
    auth = `Bearer ${actor.accessToken}`;
  const identity: MediaBatchIdentity = {
    version: 1,
    batchRequestId: randomUUID(),
    draftId: randomUUID(),
    spaceId: f.scope.home.spaceId,
    purpose: 'community-post-images',
  };
  const prepared = await request(http)
    .post('/v3/media/batches/prepare')
    .set('Authorization', auth)
    .send(identity);
  responseOk(prepared);
  let status: MediaBatchStatus = mediaBatchStatusSchema.parse(prepared.body);
  assert.ok(status.batchId);
  const members = [];
  for (let sourceSlot = 0; sourceSlot < size; sourceSlot++) {
    const file = files[sourceSlot % files.length]!;
    const input = {
      clientRequestId: randomUUID(),
      memberId: randomUUID(),
      sourceSlot,
      declaration: {
        mime: file.mime,
        bytes: file.bytes.length,
        sha256: sha256(file.bytes),
      },
    };
    const selected = await request(http)
      .post(`/v3/media/batches/${status.batchId}/members/prepare`)
      .set('Authorization', auth)
      .send(input);
    responseOk(selected);
    const member = mediaMemberStatusSchema.parse(selected.body);
    const grant = await request(http)
      .post(`/v3/media/upload-intents/${member.intentId}/grant`)
      .set('Authorization', auth)
      .send({});
    responseOk(grant);
    const uploaded = await request(http)
      .post(
        `/v3/media/upload-intents/${member.intentId}/uploads/${grant.body.grantId}`,
      )
      .set('Authorization', auth)
      .attach('file', file.bytes, {
        filename: 'ignored',
        contentType: file.mime,
      });
    responseOk(uploaded);
    assert.equal(uploaded.body.sha256, sha256(file.bytes));
    responseOk(
      await request(http)
        .post(`/v3/media/upload-intents/${member.intentId}/finalize`)
        .set('Authorization', auth)
        .send({}),
    );
    for (const stage of ['seal', 'process', 'review'] as const)
      assert.equal(await f.worker.runOne(stage), true);
    const ready = await request(http)
      .get(`/v3/media/upload-intents/${member.intentId}`)
      .set('Authorization', auth);
    responseOk(ready);
    const current = mediaMemberStatusSchema.parse(ready.body);
    assert.equal(current.observation.status, 'ready_unbound');
    members.push(current);
    const recovered = await request(http)
      .get(`/v3/media/batches/requests/${identity.batchRequestId}`)
      .set('Authorization', auth);
    responseOk(recovered);
    const recovery = mediaBatchRecoverySchema.parse(recovered.body);
    assert.equal(recovery.state, 'recorded');
    if (recovery.state !== 'recorded') throw new Error('Missing batch');
    status = recovery.status;
    assert.equal(
      status.members.length,
      sourceSlot + 1,
      'Ready identities are retained as new members are added',
    );
  }
  return { identity, status, members };
}
export async function sealBatchPost(
  f: BatchFixture,
  actor: BatchActor,
  status: MediaBatchStatus,
  text = 'Nine image exact ordered publication',
) {
  assert.equal(status.status, 'ready_unbound');
  if (status.status !== 'ready_unbound' || !status.batchId)
    throw new Error('Batch is not ready');
  const body = {
    clientRequestId: randomUUID(),
    spaceId: f.scope.home.spaceId,
    category: 'discussion' as const,
    text,
    imageAssetIds: status.orderedAssets.map((image) => image.assetId),
    authorMode: 'named' as const,
    commentsPolicy: 'open' as const,
  };
  const publication = {
    clientRequestId: body.clientRequestId,
    operation: 'publish_post' as const,
    intentHash: publicationHash('publish_post', postIntent(body)),
  };
  const command = {
    commandId: randomUUID(),
    expectedRevision: status.revision,
    orderedMemberIds: status.orderedMemberIds,
    publication,
  };
  const sealed = await request(f.app.getHttpServer())
    .post(`/v3/media/batches/${status.batchId}/seal`)
    .set('Authorization', `Bearer ${actor.accessToken}`)
    .send(command);
  responseOk(sealed);
  const envelope = await postApprovalEnvelope(
    f.app,
    f.pool,
    actor.accountId,
    body,
  );
  await approveEnvelope(f.pool, {
    ...envelope,
    images: status.orderedAssets.map(({ assetId, manifestDigest }) => ({
      assetId,
      digest: manifestDigest,
    })),
  });
  return {
    body,
    publication,
    command,
    status: mediaBatchStatusSchema.parse(sealed.body),
  };
}
