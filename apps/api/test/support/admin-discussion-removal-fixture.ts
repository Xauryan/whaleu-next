/** Ordinary AppModule/HTTP with synthetic source and real Review/Media owners. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  readyDiscussionBatch,
  sealDiscussionBatch,
} from './media/discussion-batch-fixture.js';
import { discussionApprovalEnvelope } from './community-runtime-fixtures.js';
import { approveEnvelope } from './community-approval-fixtures.js';
import { profileAvatarModerationFixture } from './profile-avatar-moderation-fixture.js';
import { profileOk } from './media/profile-runtime-fixture.js';
import {
  MEDIA_ATTACHMENT,
  type MediaAttachmentPort,
} from '../../src/community/community-policy.js';
import {
  adminDiscussionRemovalManagementSchema,
  adminDiscussionRemovalReceiptSchema,
} from '../../src/community/admin-discussion-removal/contracts.js';
import type {
  AdminDiscussionRemovalCommand,
  AdminDiscussionRemovalTarget,
} from '../../src/community/admin-discussion-removal/contracts.js';
export async function adminDiscussionRemovalFixture(mediaTargets = false) {
  const f = await profileAvatarModerationFixture(mediaTargets);
  if (mediaTargets) {
    // Test-only read leaf: canonical descriptor proofs from the genuine Media
    // fixture, without enabling ordinary uploads, publication or provider writes.
    const real = f.app.get<MediaAttachmentPort>(MEDIA_ATTACHMENT);
    const ordinary = f.moderationApp.get<MediaAttachmentPort>(MEDIA_ATTACHMENT);
    ordinary.display = real.display.bind(real);
  }
  type Actor = Awaited<ReturnType<typeof f.actor>>;
  // Publication uses the genuine native batch/review path, including anonymous
  // and image-only children and reply references. No fabricated author identity.
  const discussion = async (
    actor: Actor,
    postId: string,
    options: {
      rootId?: string;
      targetReplyId?: string | null;
      images?: boolean;
      authorMode?: 'named' | 'anonymous';
      text?: string;
    } = {},
  ) => {
    const authorMode = options.authorMode ?? 'named';
    const target = options.rootId
      ? {
          kind: 'reply' as const,
          rootCommentId: options.rootId,
          targetReplyId: options.targetReplyId ?? null,
        }
      : { kind: 'comment' as const, postId };
    let body: {
      clientRequestId: string;
      text: string;
      imageAssetIds: string[];
      authorMode: 'named' | 'anonymous';
      targetReplyId?: string | null;
    };
    let path: string;
    if (options.images) {
      const batch = await readyDiscussionBatch(f, actor, target, 1, [
        { mime: 'image/png', bytes: f.bytes },
      ]);
      const sealed = await sealDiscussionBatch(
        f,
        actor,
        batch.status,
        options.text ?? 'Synthetic discussion target',
        authorMode,
      );
      body = sealed.body;
      path = sealed.path;
    } else {
      body = {
        clientRequestId: randomUUID(),
        text: options.text ?? 'Synthetic discussion target',
        imageAssetIds: [],
        authorMode,
        ...(options.rootId
          ? { targetReplyId: options.targetReplyId ?? null }
          : {}),
      };
      await approveEnvelope(
        f.pool,
        await discussionApprovalEnvelope(
          f.app,
          f.pool,
          actor.accountId,
          postId,
          body,
          options.rootId ?? null,
        ),
      );
      path = options.rootId
        ? `/v1/community/comments/${options.rootId}/replies`
        : `/v1/community/posts/${postId}/comments`;
    }
    const response = await request(f.app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${actor.accessToken}`)
      .send(body);
    profileOk(response, 201);
    assert.equal(response.body.outcome, 'created');
    return { kind: target.kind, id: response.body.resourceId as string, body };
  };
  const removalManagement = async (
    target: AdminDiscussionRemovalTarget,
    actor: Actor,
  ) => {
    const response = await request(f.http)
      .get('/v1/community/admin-discussion-removal/management')
      .set('Authorization', `Bearer ${actor.accessToken}`)
      .query({ kind: target.kind, id: target.id });
    profileOk(response);
    return adminDiscussionRemovalManagementSchema.parse(response.body);
  };
  const removalCommand = (
    target: AdminDiscussionRemovalTarget,
    expectedTargetVersion: string,
  ): AdminDiscussionRemovalCommand => ({
    clientRequestId: randomUUID(),
    target: { kind: target.kind, id: target.id },
    expectedTargetVersion,
    action: 'remove_discussion',
  });
  const removalSend = (
    actor: Actor,
    body: AdminDiscussionRemovalCommand,
    cancel = false,
  ) =>
    request(f.http)
      .post(
        `/v1/community/admin-discussion-removal/commands${cancel ? '/cancel' : ''}`,
      )
      .set('Authorization', `Bearer ${actor.accessToken}`)
      .send(body);
  const removalApply = async (
    target: AdminDiscussionRemovalTarget,
    actor: Actor,
  ) => {
    const view = await removalManagement(target, actor);
    const body = removalCommand(target, view.targetVersion);
    const response = await removalSend(actor, body);
    profileOk(response);
    const receipt = adminDiscussionRemovalReceiptSchema.parse(response.body);
    assert.equal(receipt.outcome, 'applied', JSON.stringify(receipt));
    return { body, receipt };
  };
  const removalRecovery = (actor: Actor, id: string) =>
    request(f.http)
      .get(`/v1/community/admin-discussion-removal/requests/${id}`)
      .set('Authorization', `Bearer ${actor.accessToken}`);
  return {
    ...f,
    discussion,
    removalManagement,
    removalCommand,
    removalSend,
    removalApply,
    removalRecovery,
  };
}
export type AdminDiscussionRemovalFixture = Awaited<
  ReturnType<typeof adminDiscussionRemovalFixture>
>;
