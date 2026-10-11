import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { syntheticMediaRuntimeFixture } from './runtime-fixture.js';
import { sha256 } from '../../../src/media/processing/protocol.js';
import {
  mediaBatchStatusSchema,
  mediaBatchRecoverySchema,
  mediaMemberStatusSchema,
} from '../../../src/media/contracts-v4.js';
import type {
  MediaBatchIdentity,
  MediaBatchStatus,
} from '../../../src/media/contracts-v4.js';
import { replyIntent } from '../../../src/community/discussion/publication.service.js';
import { publicationHash } from '../../../src/community/publication.repository.js';
import {
  discussionApprovalEnvelope,
  postApprovalEnvelope,
} from '../community-runtime-fixtures.js';
import { approveEnvelope } from '../community-approval-fixtures.js';
export type BatchFixture = Awaited<
  ReturnType<typeof syntheticMediaRuntimeFixture>
>;
export type BatchActor = Awaited<ReturnType<BatchFixture['actor']>>;
export const responseOk = (
  response: { status: number; body: unknown },
  status = 200,
) => assert.equal(response.status, status, JSON.stringify(response.body));
export async function readyDiscussionBatch(
  f: BatchFixture,
  actor: BatchActor,
  target: import('../../../src/community/discussion/publication-target.js').DiscussionPublicationTarget,
  size: number,
  files: readonly { mime: string; bytes: Buffer }[],
) {
  const http = f.app.getHttpServer(),
    auth = `Bearer ${actor.accessToken}`;
  const identity: MediaBatchIdentity =
    target.kind === 'comment'
      ? {
          version: 2,
          batchRequestId: randomUUID(),
          draftId: randomUUID(),
          spaceId: f.scope.home.spaceId,
          purpose: 'community-comment-images',
          target,
        }
      : {
          version: 2,
          batchRequestId: randomUUID(),
          draftId: randomUUID(),
          spaceId: f.scope.home.spaceId,
          purpose: 'community-reply-images',
          target,
        };
  const prepared = await request(http)
    .post('/v4/media/batches/prepare')
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
      .post(`/v4/media/batches/${status.batchId}/members/prepare`)
      .set('Authorization', auth)
      .send(input);
    responseOk(selected);
    const member = mediaMemberStatusSchema.parse(selected.body);
    const grant = await request(http)
      .post(`/v4/media/upload-intents/${member.intentId}/grant`)
      .set('Authorization', auth)
      .send({});
    responseOk(grant);
    const uploaded = await request(http)
      .post(
        `/v4/media/upload-intents/${member.intentId}/uploads/${grant.body.grantId}`,
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
        .post(`/v4/media/upload-intents/${member.intentId}/finalize`)
        .set('Authorization', auth)
        .send({}),
    );
    for (const stage of ['seal', 'process', 'review'] as const)
      assert.equal(await f.worker.runOne(stage), true);
    const ready = await request(http)
      .get(`/v4/media/upload-intents/${member.intentId}`)
      .set('Authorization', auth);
    responseOk(ready);
    const current = mediaMemberStatusSchema.parse(ready.body);
    assert.equal(current.observation.status, 'ready_unbound');
    members.push(current);
    const recovered = await request(http)
      .get(`/v4/media/batches/requests/${identity.batchRequestId}`)
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

export async function publishDiscussionPost(
  f: BatchFixture,
  actor: BatchActor,
  authorMode: 'named' | 'anonymous' = 'named',
) {
  const body = {
    clientRequestId: randomUUID(),
    spaceId: f.scope.home.spaceId,
    category: 'discussion' as const,
    text: 'Discussion media parent',
    imageAssetIds: [],
    authorMode,
    commentsPolicy: 'open' as const,
  };
  await approveEnvelope(
    f.pool,
    await postApprovalEnvelope(f.app, f.pool, actor.accountId, body),
  );
  const response = await request(f.app.getHttpServer())
    .post('/v1/community/posts')
    .set('Authorization', `Bearer ${actor.accessToken}`)
    .send(body);
  responseOk(response, 201);
  return response.body.resourceId as string;
}
export async function sealDiscussionBatch(
  f: BatchFixture,
  actor: BatchActor,
  status: MediaBatchStatus,
  text: string,
  authorMode: 'named' | 'anonymous' = 'named',
) {
  if (
    status.status !== 'ready_unbound' ||
    !status.batchId ||
    !status.batchIdentity
  )
    throw new Error('Discussion batch not ready');
  const target = status.batchIdentity.target;
  const common = {
    clientRequestId: randomUUID(),
    text,
    imageAssetIds: status.orderedAssets.map((image) => image.assetId),
    authorMode,
  };
  const body =
    target.kind === 'comment'
      ? common
      : { ...common, targetReplyId: target.targetReplyId };
  const publication =
    target.kind === 'comment'
      ? {
          clientRequestId: body.clientRequestId,
          operation: 'publish_comment' as const,
          intentHash: publicationHash('publish_comment', {
            postId: target.postId,
            text,
            imageAssetIds: body.imageAssetIds,
            authorMode,
          }),
        }
      : {
          clientRequestId: body.clientRequestId,
          operation: 'publish_reply' as const,
          intentHash: publicationHash(
            'publish_reply',
            replyIntent(target.rootCommentId, {
              ...common,
              targetReplyId: target.targetReplyId,
            }),
          ),
        };
  const command = {
    commandId: randomUUID(),
    expectedRevision: status.revision,
    orderedMemberIds: status.orderedMemberIds,
    publication,
  };
  const sealed = await request(f.app.getHttpServer())
    .post(`/v4/media/batches/${status.batchId}/seal`)
    .set('Authorization', `Bearer ${actor.accessToken}`)
    .send(command);
  responseOk(sealed);
  const postId =
    target.kind === 'comment'
      ? target.postId
      : (
          await f.pool.query<{ post_id: string }>(
            'SELECT post_id FROM whaleu_community.root_comments WHERE id=$1',
            [target.rootCommentId],
          )
        ).rows[0]!.post_id;
  const envelope = await discussionApprovalEnvelope(
    f.app,
    f.pool,
    actor.accountId,
    postId,
    body,
    target.kind === 'reply' ? target.rootCommentId : null,
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
    target,
    path:
      target.kind === 'comment'
        ? `/v1/community/posts/${target.postId}/comments`
        : `/v1/community/comments/${target.rootCommentId}/replies`,
    status: mediaBatchStatusSchema.parse(sealed.body),
  };
}
