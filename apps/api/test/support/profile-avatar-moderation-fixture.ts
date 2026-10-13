import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { APP_CONFIG } from '../../src/config/config.js';
import { configureHttp } from '../../src/http/http.js';
import {
  CONTENT_MEDIA_PROOF,
  CurrentContentMediaProof,
} from '../../src/community/content-review/media-proof.js';
/** Synthetic exact upload/process/Review with ordinary AppModule for moderation. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  syntheticProfileRuntimeFixture,
  readyProfileAvatar,
  selectProfileAvatar,
  profileOk,
} from './media/profile-runtime-fixture.js';
import type { ProfileActor } from './media/profile-runtime-fixture.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { withCommunityScopeWriter } from './community-scope-fixtures.js';
import { publishPostSchema } from '../../src/community/contracts.js';
import type { PublishPost } from '../../src/community/contracts.js';
import { approveEnvelope } from './community-approval-fixtures.js';
import {
  postApprovalEnvelope,
  discussionApprovalEnvelope,
} from './community-runtime-fixtures.js';
import { readyBatch, sealBatchPost } from './media/batch-fixture.js';
import {
  readyDiscussionBatch,
  sealDiscussionBatch,
} from './media/discussion-batch-fixture.js';
import type {
  AvatarModerationCommand,
  AvatarModerationTarget,
} from '../../src/profile/avatar-moderation/contracts.js';
import { avatarModerationManagementSchema } from '../../src/profile/avatar-moderation/contracts.js';

export async function profileAvatarModerationFixture(
  mediaTargets = false,
  maximumMigration?: number,
) {
  const sharp = (await import('sharp')).default;
  const bytes = await sharp({
    create: { width: 24, height: 18, channels: 3, background: '#167ba5' },
  })
    .png()
    .toBuffer();
  const f = await syntheticProfileRuntimeFixture(
    [{ sha256: sha256(bytes), verdict: 'allow' }],
    maximumMigration,
  );
  try {
    const ordinary = await f.startOrdinaryRuntime();
    // Explicit synthetic read-only Community Media leaf. Profile avatar runtime
    // stays null, and no provider/storage/upload application is enabled here.
    const moderationApp = mediaTargets
      ? (
          await Test.createTestingModule({
            imports: [AppModule.register(f.app.get(APP_CONFIG))],
          })
            .overrideProvider(CONTENT_MEDIA_PROOF)
            .useClass(CurrentContentMediaProof)
            .compile()
        ).createNestApplication({ logger: false })
      : ordinary;
    if (mediaTargets) {
      configureHttp(moderationApp);
      await moderationApp.listen(0, '127.0.0.1');
    }
    const http = moderationApp.getHttpServer();
    const grant = async (
      actor: ProfileActor,
      role: 'school_admin' | 'super_admin' | 'developer' = 'school_admin',
      region: string | null = f.scope.home.regionId,
    ) =>
      withCommunityScopeWriter(f.pool, async (tx) => {
        const id = randomUUID();
        await tx.query(
          `INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,$3,$4,$2,'synthetic:scoped-avatar-clear')`,
          [id, actor.accountId, role, region],
        );
        return id;
      });
    const custom = async (actor: ProfileActor) => {
      const ready = await readyProfileAvatar(f, actor, bytes);
      const body = {
        protocol: 'profile-media-v1' as const,
        clientRequestId: randomUUID(),
        expectedRevision: ready.input.expectedRevision,
        source: {
          kind: 'custom' as const,
          editId: ready.status.editId,
          assetId: ready.status.assetId,
        },
      };
      const selected = await selectProfileAvatar(f, actor, body);
      assert.ok(selected.current.avatar.appearanceId);
      return {
        ...selected,
        body,
        ready,
        appearanceId: selected.current.avatar.appearanceId,
      };
    };
    const publish = async (
      actor: ProfileActor,
      patch: Partial<PublishPost> = {},
      images = false,
    ) => {
      let input: PublishPost;
      if (images) {
        const ready = await readyBatch(f, actor, 1, [
          { mime: 'image/png', bytes },
        ]);
        const sealed = await sealBatchPost(f, actor, ready.status);
        input = sealed.body;
        assert.equal(
          Object.keys(patch).length,
          0,
          'image publication fixture does not override its exact sealed intent',
        );
      } else {
        input = publishPostSchema.parse({
          clientRequestId: randomUUID(),
          spaceId: f.scope.home.spaceId,
          category: 'discussion',
          text: 'Synthetic scoped avatar clear',
          imageAssetIds: [],
          authorMode: 'named',
          commentsPolicy: 'open',
          ...patch,
        });
        await approveEnvelope(
          f.pool,
          await postApprovalEnvelope(f.app, f.pool, actor.accountId, input),
        );
      }
      const response = await request(f.app.getHttpServer())
        .post('/v1/community/posts')
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .send(input);
      profileOk(response, 201);
      assert.equal(response.body.outcome, 'created');
      return {
        kind: 'post' as const,
        id: response.body.resourceId as string,
        input,
      };
    };
    const child = async (
      actor: ProfileActor,
      postId: string,
      rootId: string | null = null,
      images = false,
      authorMode: 'named' | 'anonymous' = 'named',
    ) => {
      let path: string, body: object;
      if (images) {
        assert.equal(authorMode, 'named');
        const target = rootId
          ? {
              kind: 'reply' as const,
              rootCommentId: rootId,
              targetReplyId: null,
            }
          : { kind: 'comment' as const, postId };
        const ready = await readyDiscussionBatch(f, actor, target, 1, [
          { mime: 'image/png', bytes },
        ]);
        const sealed = await sealDiscussionBatch(
          f,
          actor,
          ready.status,
          'Synthetic target image',
        );
        path = sealed.path;
        body = sealed.body;
      } else {
        body = {
          clientRequestId: randomUUID(),
          text: 'Synthetic avatar child',
          imageAssetIds: [],
          authorMode,
          ...(rootId ? { targetReplyId: null } : {}),
        };
        await approveEnvelope(
          f.pool,
          await discussionApprovalEnvelope(
            f.app,
            f.pool,
            actor.accountId,
            postId,
            body as Parameters<typeof discussionApprovalEnvelope>[4],
            rootId,
          ),
        );
        path = rootId
          ? `/v1/community/comments/${rootId}/replies`
          : `/v1/community/posts/${postId}/comments`;
      }
      const response = await request(f.app.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .send(body);
      profileOk(response, 201);
      assert.equal(response.body.outcome, 'created');
      return {
        kind: rootId ? ('reply' as const) : ('comment' as const),
        id: response.body.resourceId as string,
      };
    };
    const management = async (
      target: AvatarModerationTarget,
      admin: ProfileActor,
    ) => {
      const response = await request(http)
        .get('/v1/community/profile-avatar-moderation/management')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .query({ kind: target.kind, id: target.id });
      profileOk(response);
      return avatarModerationManagementSchema.parse(response.body);
    };
    const command = (
      target: AvatarModerationTarget,
      expectedProfileRevision: number,
      expectedAppearanceId: string,
    ): AvatarModerationCommand => ({
      clientRequestId: randomUUID(),
      target: { kind: target.kind, id: target.id },
      expectedProfileRevision,
      expectedAppearanceId,
      action: 'clear_custom_avatar',
    });
    const send = (
      admin: ProfileActor,
      body: AvatarModerationCommand,
      cancel = false,
    ) =>
      request(http)
        .post(
          `/v1/community/profile-avatar-moderation/commands${cancel ? '/cancel' : ''}`,
        )
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(body);
    const apply = async (
      target: AvatarModerationTarget,
      admin: ProfileActor,
    ) => {
      const view = await management(target, admin);
      assert.equal(view.canClearCustomAvatar, true);
      assert.ok(view.expectedAppearanceId);
      const body = command(target, view.revision, view.expectedAppearanceId);
      const response = await send(admin, body);
      profileOk(response);
      assert.equal(
        response.body.outcome,
        'applied',
        JSON.stringify(response.body),
      );
      return { body, receipt: response.body };
    };
    return {
      ...f,
      bytes,
      ordinary,
      http,
      moderationApp,
      close: async () => {
        if (moderationApp !== ordinary) await moderationApp.close();
        await f.close();
      },
      grant,
      custom,
      publish,
      child,
      management,
      command,
      send,
      apply,
    };
  } catch (error) {
    await f.close();
    throw error;
  }
}
export type AvatarModerationFixture = Awaited<
  ReturnType<typeof profileAvatarModerationFixture>
>;
