/** Uses the established disposable Media ingress/processor/reviewer fixture.
 * Review, Community, binding, and delivery owners remain the real AppModule. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { APP_CONFIG } from '../../src/config/config.js';
import type { RuntimeConfig } from '../../src/config/config.js';
import { inTransaction } from '../../src/database/database.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { MEDIA_ATTACHMENT } from '../../src/community/community-policy.js';
import type { MediaAttachmentPort } from '../../src/community/community-policy.js';
import type { DiscussionPublicationTarget } from '../../src/community/discussion/publication-target.js';
import { replyIntent } from '../../src/community/discussion/publication.service.js';
import { postIntent } from '../../src/community/publication-intent.js';
import { publicationHash } from '../../src/community/publication.repository.js';
import { CommunityRepository } from '../../src/community/community.repository.js';
import { ApprovalRepository } from '../../src/community/content-review/approval.repository.js';
import { ContentDefinitionRepository } from '../../src/community/content-review/content-definition.repository.js';
import type {
  AcceptedApproval,
  EffectiveContentEnvelope,
} from '../../src/community/content-review/contracts.js';
import { TextReviewRuntime } from '../../src/community/text-review/runtime.js';
import { TextReviewOperator } from '../../src/community/text-review/operator.js';
import { syntheticMediaRuntimeFixture } from '../support/media/runtime-fixture.js';
import { readyBatch } from '../support/media/batch-fixture.js';
import { readyDiscussionBatch } from '../support/media/discussion-batch-fixture.js';
import { approveEnvelope } from '../support/community-approval-fixtures.js';
import {
  postApprovalEnvelope,
  discussionApprovalEnvelope,
} from '../support/community-runtime-fixtures.js';
import {
  acceptRelatedSyncPolicy,
  assertRelatedSyncRuntimeWiring,
} from '../support/related-sync-fixtures.js';
import {
  setRegionPolicy,
  withCommunityScopeWriter,
} from '../support/community-scope-fixtures.js';

const sqlActorRejection = (error: unknown) =>
  error instanceof Error &&
  'code' in error &&
  error.code === '23514' &&
  /Original related actor publication proof changed/.test(error.message);

test(
  'related v4 image and formation publication keeps exact native Media root and descendant bindings',
  { timeout: 240000 },
  async (t) => {
    const sharp = (await import('sharp')).default;
    const bytes = await sharp({
      create: { width: 80, height: 60, channels: 3, background: '#315578' },
    })
      .png()
      .toBuffer();
    let patch: Partial<RuntimeConfig> = {};
    const f = await syntheticMediaRuntimeFixture(
      [{ sha256: sha256(bytes), verdict: 'allow' }],
      {
        configureTestModule: (builder, { runtimeConfig }) => {
          builder
            .overrideProvider(APP_CONFIG)
            .useValue(Object.freeze({ ...runtimeConfig, ...patch }));
        },
      },
    );
    try {
      const issuer = 'synthetic:related-media:operator';
      const legacyPolicyId = randomUUID(),
        relatedPolicyId = randomUUID();
      patch = {
        COMMUNITY_TEXT_REVIEW: 'local_manual',
        COMMUNITY_TEXT_REVIEW_POLICY_ID: legacyPolicyId,
        COMMUNITY_RELATED_REVIEW_POLICY_ID: relatedPolicyId,
        COMMUNITY_TEXT_REVIEW_SPACE_ID: f.scope.home.spaceId,
        COMMUNITY_TEXT_REVIEW_REGION_ID: f.scope.home.regionId,
        COMMUNITY_TEXT_REVIEW_OPERATOR: issuer,
      };
      await f.restartApp();
      assertRelatedSyncRuntimeWiring(f.app);
      const operator = new TextReviewOperator(
        f.app.get(TextReviewRuntime),
        issuer,
      );
      await inTransaction(f.pool, async (tx) => {
        await operator.run(
          {
            command: 'init-policy',
            basis: 'Explicit disposable legacy Review',
          },
          tx,
        );
        await operator.run(
          {
            command: 'init-related-policy',
            basis: 'Explicit disposable image and formation Review',
          },
          tx,
        );
      });
      await acceptRelatedSyncPolicy(f.pool, f.scope.home.regionId, {
        reviewPolicyId: relatedPolicyId,
        issuer,
      });
      await setRegionPolicy(f.pool, f.scope.home.regionId, {
        relatedSyncEnabled: true,
      });
      const author = await f.actor(),
        commenter = await f.actor({ campusId: f.scope.related.campusId });
      type Actor = typeof author;
      const send = (path: string, actor: Actor, body: object) =>
        request(f.app.getHttpServer())
          .post(path)
          .set('Authorization', `Bearer ${actor.accessToken}`)
          .send(body);
      const decide = async (
        actor: Actor,
        requestId: string,
      ): Promise<AcceptedApproval> => {
        const before = (
          await f.pool.query<{ digest: string }>(
            'SELECT digest FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
            [actor.accountId, requestId],
          )
        ).rows[0]!;
        await inTransaction(f.pool, (tx) =>
          operator.run(
            {
              command: 'decide',
              accountId: actor.accountId,
              requestId,
              digest: before.digest,
              decision: 'allow',
              basis: 'Exact synthetic Media and related envelope accepted',
            },
            tx,
          ),
        );
        const row = (
          await f.pool.query<{
            envelope: EffectiveContentEnvelope;
            decision_id: string;
            digest: string;
          }>(
            'SELECT envelope,decision_id,digest FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
            [actor.accountId, requestId],
          )
        ).rows[0]!;
        assert.equal(row.envelope.version, 4);
        return {
          decisionId: row.decision_id,
          digest: row.digest,
          version: row.envelope.version,
          envelope: row.envelope,
        };
      };
      const verify = async (
        kind: 'post' | 'comment' | 'reply',
        id: string,
        expected: EffectiveContentEnvelope,
      ) => {
        const rows = (
          await f.pool.query<{
            asset_id: string;
            manifest_digest: string;
            ordinal: number;
            id: string;
            version: number;
          }>(
            `SELECT id,asset_id,manifest_digest,ordinal,(attach_evidence->>'version')::integer AS version FROM whaleu_media.bindings WHERE owner_kind='community' AND resource_kind=$1 AND resource_id=$2 AND detached_at IS NULL ORDER BY ordinal`,
            [kind, id],
          )
        ).rows;
        assert.deepEqual(
          rows.map((row) => ({
            assetId: row.asset_id,
            digest: row.manifest_digest,
          })),
          expected.images,
        );
        assert.deepEqual(
          rows.map((row) => row.ordinal),
          expected.images.map((_, ordinal) => ordinal),
        );
        assert.ok(
          rows.every((row) => row.version === (kind === 'post' ? 2 : 3)),
          'Media3 and Media4 retain attach-evidence versions 2 and 3',
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT whaleu_community.profile_moderation_media_current($1,$2,$3::jsonb) AS valid',
              [kind, id, JSON.stringify(expected.images)],
            )
          ).rows[0].valid,
          true,
        );
        const definition = await inTransaction(f.pool, (tx) =>
          f.app
            .get(ContentDefinitionRepository)
            .current(kind, id, expected.scope, tx),
        );
        assert.equal(definition.kind, 'allow');
        if (definition.kind === 'allow')
          assert.deepEqual(definition.value.envelope, expected);
        const detailPath =
          kind === 'post'
            ? `/v1/community/posts/${id}`
            : `/v1/community/${kind === 'comment' ? 'comments' : 'replies'}/${id}`;
        const detail = await request(f.app.getHttpServer())
          .get(detailPath)
          .set('Authorization', `Bearer ${author.accessToken}`);
        assert.equal(detail.status, 200, JSON.stringify(detail.body));
        assert.equal(detail.body.images.length, expected.images.length);
        for (const row of rows) {
          const image = await request(f.app.getHttpServer())
            .get(`/v1/media/bindings/${row.id}/thumb-v1`)
            .set('Authorization', `Bearer ${author.accessToken}`);
          assert.equal(image.status, 200);
        }
      };
      const ready = await readyBatch(f, author, 1, [
        { bytes, mime: 'image/png' },
      ]);
      assert.equal(ready.status.status, 'ready_unbound');
      if (ready.status.status !== 'ready_unbound')
        throw new Error('Expected real ready root batch');
      const rootBody = {
        clientRequestId: randomUUID(),
        spaceId: f.scope.home.spaceId,
        category: 'discussion' as const,
        text: 'Synthetic image-bearing related formation',
        imageAssetIds: ready.status.orderedAssets.map((image) => image.assetId),
        authorMode: 'named' as const,
        commentsPolicy: 'open' as const,
        syncToRelatedCampuses: true,
        component: {
          kind: 'formation' as const,
          capacity: 3,
          theme: 'Together',
          contacts: { wechat: 'synthetic', qq: '', phone: '' },
          contactSharing: 'members_v1' as const,
        },
      };
      const rootPublication = {
        clientRequestId: rootBody.clientRequestId,
        operation: 'publish_post' as const,
        intentHash: publicationHash('publish_post', postIntent(rootBody)),
      };
      const sealed = await send(
        `/v3/media/batches/${ready.status.batchId}/seal`,
        author,
        {
          commandId: randomUUID(),
          expectedRevision: ready.status.revision,
          orderedMemberIds: ready.status.orderedMemberIds,
          publication: rootPublication,
        },
      );
      assert.equal(sealed.status, 200, JSON.stringify(sealed.body));
      const reviewed = await send(
        '/v1/community/reviews/posts',
        author,
        rootBody,
      );
      assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
      const rootApproval = await decide(author, rootBody.clientRequestId);
      const published = await send('/v1/community/posts', author, rootBody);
      assert.equal(
        published.body.outcome,
        'created',
        JSON.stringify(published.body),
      );
      const postId = published.body.resourceId as string;

      await t.test(
        'one image and native formation reconstruct under the canonical v4 root',
        async () => {
          await verify('post', postId, rootApproval.envelope);
          assert.deepEqual(rootApproval.envelope.component, rootBody.component);
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_community.formations WHERE post_id=$1',
                [postId],
              )
            ).rows[0].n,
            1,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_community.formation_members m JOIN whaleu_community.formations f ON f.id=m.formation_id WHERE f.post_id=$1 AND m.is_creator AND m.account_id=$2',
                [postId, author.accountId],
              )
            ).rows[0].n,
            1,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT whaleu_community.related_sync_binding_valid($1) AS valid',
                [postId],
              )
            ).rows[0].valid,
            true,
          );
          assert.deepEqual(
            (await send('/v1/community/posts', author, rootBody)).body,
            published.body,
          );
          const recovery = await send(
            '/v3/media/batches/recover-publication',
            author,
            { publication: rootPublication, assetIds: rootBody.imageAssetIds },
          );
          assert.equal(recovery.status, 200, JSON.stringify(recovery.body));
          assert.equal(recovery.body.state, 'recorded');
        },
      );

      const prepareChild = async (target: DiscussionPublicationTarget) => {
        const batch = await readyDiscussionBatch(f, commenter, target, 1, [
          { bytes, mime: 'image/png' },
        ]);
        if (batch.status.status !== 'ready_unbound' || !batch.status.batchId)
          throw new Error('Expected real ready child batch');
        const common = {
          clientRequestId: randomUUID(),
          text: `Synthetic related ${target.kind} image`,
          imageAssetIds: batch.status.orderedAssets.map(
            (image) => image.assetId,
          ),
          authorMode: 'named' as const,
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
                  text: common.text,
                  imageAssetIds: common.imageAssetIds,
                  authorMode: common.authorMode,
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
        const sealed = await send(
          `/v4/media/batches/${batch.status.batchId}/seal`,
          commenter,
          {
            commandId: randomUUID(),
            expectedRevision: batch.status.revision,
            orderedMemberIds: batch.status.orderedMemberIds,
            publication,
          },
        );
        assert.equal(sealed.status, 200, JSON.stringify(sealed.body));
        const suffix =
          target.kind === 'comment'
            ? `posts/${target.postId}/comments`
            : `comments/${target.rootCommentId}/replies`;
        const reviewed = await send(
          `/v1/community/reviews/${suffix}`,
          commenter,
          body,
        );
        assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
        const queuedMedia = (
          await f.pool.query<{
            state: string;
            consumed_parent: unknown;
            consumptions: number;
            bindings: number;
          }>(
            `SELECT b.state,b.consumed_parent,
          (SELECT count(*)::integer FROM whaleu_media.scope_consumptions c WHERE c.scope_resource_id=b.server_scope_id) consumptions,
          (SELECT count(*)::integer FROM whaleu_media.bindings m WHERE m.asset_id=ANY($2::uuid[])) bindings
          FROM whaleu_media.publication_batches b WHERE b.id=$1`,
            [batch.status.batchId, body.imageAssetIds],
          )
        ).rows[0];
        assert.deepEqual(
          queuedMedia,
          {
            state: 'sealed',
            consumed_parent: null,
            consumptions: 0,
            bindings: 0,
          },
          'Review preparation finalizes read proofs without consuming the batch or writing attachments',
        );
        const approval = await decide(commenter, body.clientRequestId);
        assert.equal(
          approval.envelope.scope.identityRegionId,
          f.scope.related.regionId,
        );
        return { body, publication, approval, suffix, target, batch };
      };
      let commentId = '';
      await t.test(
        'image-bearing v4 comment and reply use own current actor scope and unchanged Media4 bindings',
        async () => {
          const comment = await prepareChild({ kind: 'comment', postId });
          const created = await send(
            `/v1/community/${comment.suffix}`,
            commenter,
            comment.body,
          );
          assert.equal(
            created.body.outcome,
            'created',
            JSON.stringify(created.body),
          );
          commentId = created.body.resourceId;
          await verify('comment', commentId, comment.approval.envelope);
          const reply = await prepareChild({
            kind: 'reply',
            rootCommentId: commentId,
            targetReplyId: null,
          });
          const replied = await send(
            `/v1/community/${reply.suffix}`,
            commenter,
            reply.body,
          );
          assert.equal(
            replied.body.outcome,
            'created',
            JSON.stringify(replied.body),
          );
          await verify(
            'reply',
            replied.body.resourceId,
            reply.approval.envelope,
          );
          assert.deepEqual(
            (await send(`/v1/community/${reply.suffix}`, commenter, reply.body))
              .body,
            replied.body,
          );
          const recovery = await send(
            '/v4/media/batches/recover-publication',
            commenter,
            {
              publication: reply.publication,
              assetIds: reply.body.imageAssetIds,
              target: reply.target,
            },
          );
          assert.equal(recovery.status, 200, JSON.stringify(recovery.body));
          assert.equal(recovery.body.state, 'recorded');
        },
      );

      await t.test(
        'legacy none image descendants keep the existing explicit Review pipeline and narrow local queue policy',
        async () => {
          const legacyActor = await f.actor();
          const input = {
            clientRequestId: randomUUID(),
            spaceId: f.scope.home.spaceId,
            category: 'discussion' as const,
            text: 'Legacy none parent for Media compatibility',
            imageAssetIds: [],
            authorMode: 'named' as const,
            commentsPolicy: 'open' as const,
          };
          await approveEnvelope(
            f.pool,
            await postApprovalEnvelope(f.app, f.pool, author.accountId, input),
            { policyRevisionId: legacyPolicyId, evaluatedAt: new Date() },
          );
          const publishedNone = await send(
            '/v1/community/posts',
            author,
            input,
          );
          assert.equal(
            publishedNone.body.outcome,
            'created',
            JSON.stringify(publishedNone.body),
          );
          const noneId = publishedNone.body.resourceId as string;
          const createLegacy = async (target: DiscussionPublicationTarget) => {
            const ready = await readyDiscussionBatch(
              f,
              legacyActor,
              target,
              1,
              [{ bytes, mime: 'image/png' }],
            );
            if (
              ready.status.status !== 'ready_unbound' ||
              !ready.status.batchId
            )
              throw new Error('Expected legacy Media4 batch');
            const body = {
              clientRequestId: randomUUID(),
              text: `Legacy none ${target.kind} image`,
              imageAssetIds: ready.status.orderedAssets.map(
                (asset) => asset.assetId,
              ),
              authorMode: 'named' as const,
              ...(target.kind === 'reply'
                ? { targetReplyId: target.targetReplyId }
                : {}),
            };
            const publication =
              target.kind === 'comment'
                ? {
                    clientRequestId: body.clientRequestId,
                    operation: 'publish_comment' as const,
                    intentHash: publicationHash('publish_comment', {
                      postId: target.postId,
                      text: body.text,
                      imageAssetIds: body.imageAssetIds,
                      authorMode: body.authorMode,
                    }),
                  }
                : {
                    clientRequestId: body.clientRequestId,
                    operation: 'publish_reply' as const,
                    intentHash: publicationHash(
                      'publish_reply',
                      replyIntent(target.rootCommentId, {
                        ...body,
                        targetReplyId: target.targetReplyId,
                      }),
                    ),
                  };
            const sealed = await send(
              `/v4/media/batches/${ready.status.batchId}/seal`,
              legacyActor,
              {
                commandId: randomUUID(),
                expectedRevision: ready.status.revision,
                orderedMemberIds: ready.status.orderedMemberIds,
                publication,
              },
            );
            assert.equal(sealed.status, 200, JSON.stringify(sealed.body));
            const suffix =
              target.kind === 'comment'
                ? `posts/${noneId}/comments`
                : `comments/${target.rootCommentId}/replies`;
            const unsupportedQueue = await send(
              `/v1/community/reviews/${suffix}`,
              legacyActor,
              body,
            );
            assert.equal(
              unsupportedQueue.body.error?.code,
              'CONTENT_REVIEW_UNAVAILABLE',
              'The established legacy local-text queue still refuses images',
            );
            const envelope = await discussionApprovalEnvelope(
              f.app,
              f.pool,
              legacyActor.accountId,
              noneId,
              {
                ...body,
                targetReplyId:
                  target.kind === 'reply' ? target.targetReplyId : null,
              },
              target.kind === 'reply' ? target.rootCommentId : null,
            );
            const accepted = await approveEnvelope(
              f.pool,
              {
                ...envelope,
                images: ready.status.orderedAssets.map(
                  ({ assetId, manifestDigest }) => ({
                    assetId,
                    digest: manifestDigest,
                  }),
                ),
              },
              { policyRevisionId: legacyPolicyId, evaluatedAt: new Date() },
            );
            assert.equal(accepted.envelope.version, 1);
            assert.equal(accepted.envelope.scope.sync, 'none');
            const created = await send(
              `/v1/community/${suffix}`,
              legacyActor,
              body,
            );
            assert.equal(
              created.body.outcome,
              'created',
              JSON.stringify(created.body),
            );
            await verify(
              target.kind,
              created.body.resourceId,
              accepted.envelope,
            );
            assert.deepEqual(
              (await send(`/v1/community/${suffix}`, legacyActor, body)).body,
              created.body,
            );
            return created.body.resourceId as string;
          };
          const childId = await createLegacy({
            kind: 'comment',
            postId: noneId,
          });
          await createLegacy({
            kind: 'reply',
            rootCommentId: childId,
            targetReplyId: null,
          });
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::integer n FROM whaleu_community.post_distribution_bindings WHERE post_id=$1',
                [noneId],
              )
            ).rows[0].n,
            0,
          );
        },
      );

      await t.test(
        'raw child cannot omit own Media; a successful captured own binding still rejects a later zero-row source mutation',
        async () => {
          const pending = await prepareChild({ kind: 'comment', postId });
          const media = f.app.get<MediaAttachmentPort>(MEDIA_ATTACHMENT);
          const raw = async (tx: PoolClient, bindMedia: boolean) => {
            const envelope = pending.approval.envelope;
            // Use the same real Media acceptance path as native publication. No raw
            // attachment grant, scope consumption or asset capability is invented.
            const accepted = await media.resolveOwned(
              commenter.accountId,
              'publish_comment',
              pending.body.imageAssetIds,
              tx,
              envelope,
              pending.publication,
            );
            assert.equal(accepted.kind, 'allow');
            if (accepted.kind !== 'allow')
              throw new Error('Real Media acceptance required');
            const id = randomUUID();
            const created = (
              await tx.query<{ created_at: Date }>(
                'INSERT INTO whaleu_community.root_comments(id,post_id,account_id,text,author_mode) VALUES($1,$2,$3,$4,$5) RETURNING created_at',
                [
                  id,
                  postId,
                  commenter.accountId,
                  envelope.text,
                  envelope.authorMode,
                ],
              )
            ).rows[0]!.created_at;
            for (const [position, image] of envelope.images.entries())
              await tx.query(
                'INSERT INTO whaleu_community.comment_images(comment_id,asset_id,digest,position) VALUES($1,$2,$3,$4)',
                [id, image.assetId, image.digest, position],
              );
            await f.app
              .get(ApprovalRepository)
              .bind(pending.approval, 'comment', id, tx);
            if (bindMedia) await media.bind(accepted.value, 'comment', id, tx);
            // Match the native comment publication cause, including the real
            // local-update and Experience enrollment performed by event().
            const eventId = await f.app
              .get(CommunityRepository)
              .event(`comment:${id}:created`, 'comment_created', id, tx, {
                experienceSourceVersion: 1,
                actorAccountId: commenter.accountId,
                actorAuthorMode: envelope.authorMode,
                resourceAuthorMode: envelope.authorMode,
                postId,
                recipientAccountIds:
                  author.accountId === commenter.accountId
                    ? []
                    : [author.accountId],
                obligations: [
                  'post_author_notification',
                  'eligible_saved_subscriber_notification',
                  'comment_actor_reward',
                  'distinct_post_author_reward',
                  'discussion_ranking',
                  'media_audit',
                ],
              });
            assert.ok(eventId, 'Fresh raw child must enqueue its native cause');
            await tx.query(
              "INSERT INTO whaleu_community.report_origins(kind,target_id,owner_account_id,provenance,source_request_id) VALUES('comment',$1,$2,'native_publication',$3)",
              [id, commenter.accountId, pending.body.clientRequestId],
            );
            await tx.query(
              'UPDATE whaleu_community.publication_requests SET receipt=$3::jsonb WHERE account_id=$1 AND client_request_id=$2',
              [
                commenter.accountId,
                pending.body.clientRequestId,
                JSON.stringify({
                  requestId: pending.body.clientRequestId,
                  operation: 'publish_comment',
                  outcome: 'created',
                  resourceId: id,
                  createdAt: created.toISOString(),
                }),
              ],
            );
            return id;
          };
          let omittedReachedFinal = false;
          await assert.rejects(
            withCommunityScopeWriter(f.pool, async (tx) => {
              const id = await raw(tx, false);
              assert.equal(
                (
                  await tx.query(
                    'SELECT whaleu_community.profile_moderation_media_current($1,$2,$3::jsonb) AS valid',
                    [
                      'comment',
                      id,
                      JSON.stringify(pending.approval.envelope.images),
                    ],
                  )
                ).rows[0].valid,
                false,
              );
              omittedReachedFinal = true;
              await tx.query(
                'SET CONSTRAINTS whaleu_community.related_comment_complete IMMEDIATE',
              );
            }),
            sqlActorRejection,
          );
          assert.equal(omittedReachedFinal, true);
          for (const mutation of [
            'DELETE FROM whaleu_media.asset_safety_heads WHERE false',
            'INSERT INTO whaleu_media.bindings SELECT * FROM whaleu_media.bindings WHERE false',
          ]) {
            let flushed = false;
            await assert.rejects(
              withCommunityScopeWriter(f.pool, async (tx) => {
                const id = await raw(tx, true);
                assert.equal(
                  (
                    await tx.query(
                      'SELECT whaleu_community.profile_moderation_media_current($1,$2,$3::jsonb) AS valid',
                      [
                        'comment',
                        id,
                        JSON.stringify(pending.approval.envelope.images),
                      ],
                    )
                  ).rows[0].valid,
                  true,
                );
                await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
                flushed = true;
                await tx.query(mutation);
              }),
              sqlActorRejection,
            );
            assert.equal(
              flushed,
              true,
              'Must finalize an actual complete binding before mutating Media source',
            );
          }
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_media.bindings WHERE asset_id=ANY($1::uuid[])',
                [pending.body.imageAssetIds],
              )
            ).rows[0].n,
            0,
          );
          const created = await send(
            `/v1/community/${pending.suffix}`,
            commenter,
            pending.body,
          );
          assert.equal(
            created.body.outcome,
            'created',
            JSON.stringify(created.body),
          );
          await verify(
            'comment',
            created.body.resourceId,
            pending.approval.envelope,
          );
        },
      );
    } finally {
      await f.close();
    }
  },
);
