/** Ordinary AppModule/HTTP with synthetic source and real Review/Media owners. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { profileAvatarModerationFixture } from './profile-avatar-moderation-fixture.js';
import { profileOk } from './media/profile-runtime-fixture.js';
import {
  MEDIA_ATTACHMENT,
  type MediaAttachmentPort,
} from '../../src/community/community-policy.js';
import {
  adminPostRemovalManagementSchema,
  adminPostRemovalReceiptSchema,
} from '../../src/community/admin-removal/contracts.js';
import type {
  AdminPostRemovalCommand,
  AdminPostRemovalTarget,
} from '../../src/community/admin-removal/contracts.js';
export async function adminPostRemovalFixture(mediaTargets = false) {
  const f = await profileAvatarModerationFixture(mediaTargets);
  if (mediaTargets) {
    // Test-only read leaf: canonical descriptor proofs from the genuine Media
    // fixture, without enabling ordinary uploads, publication or provider writes.
    const real = f.app.get<MediaAttachmentPort>(MEDIA_ATTACHMENT);
    const ordinary = f.moderationApp.get<MediaAttachmentPort>(MEDIA_ATTACHMENT);
    ordinary.display = real.display.bind(real);
  }
  type Actor = Awaited<ReturnType<typeof f.actor>>;
  const removalManagement = async (
    target: AdminPostRemovalTarget,
    actor: Actor,
  ) => {
    const response = await request(f.http)
      .get('/v1/community/admin-post-removal/management')
      .set('Authorization', `Bearer ${actor.accessToken}`)
      .query({ kind: target.kind, id: target.id });
    profileOk(response);
    return adminPostRemovalManagementSchema.parse(response.body);
  };
  const removalCommand = (
    target: AdminPostRemovalTarget,
    expectedTargetVersion: string,
  ): AdminPostRemovalCommand => ({
    clientRequestId: randomUUID(),
    target: { kind: target.kind, id: target.id },
    expectedTargetVersion,
    action: 'remove_post',
  });
  const removalSend = (
    actor: Actor,
    body: AdminPostRemovalCommand,
    cancel = false,
  ) =>
    request(f.http)
      .post(
        `/v1/community/admin-post-removal/commands${cancel ? '/cancel' : ''}`,
      )
      .set('Authorization', `Bearer ${actor.accessToken}`)
      .send(body);
  const removalApply = async (target: AdminPostRemovalTarget, actor: Actor) => {
    const view = await removalManagement(target, actor);
    const body = removalCommand(target, view.targetVersion);
    const response = await removalSend(actor, body);
    profileOk(response);
    const receipt = adminPostRemovalReceiptSchema.parse(response.body);
    assert.equal(receipt.outcome, 'applied', JSON.stringify(receipt));
    return { body, receipt };
  };
  const removalRecovery = (actor: Actor, id: string) =>
    request(f.http)
      .get(`/v1/community/admin-post-removal/requests/${id}`)
      .set('Authorization', `Bearer ${actor.accessToken}`);
  return {
    ...f,
    removalManagement,
    removalCommand,
    removalSend,
    removalApply,
    removalRecovery,
  };
}
export type AdminPostRemovalFixture = Awaited<
  ReturnType<typeof adminPostRemovalFixture>
>;
