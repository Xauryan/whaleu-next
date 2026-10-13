import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { inTransaction } from '../../src/database/database.js';
import { CommunityDmEntryFacade } from '../../src/community/dm-entry.facade.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { publishPostSchema } from '../../src/community/contracts.js';
import { postIntent } from '../../src/community/publication-intent.js';
import { publicationHash } from '../../src/community/publication.repository.js';
import { relatedSyncRuntimeFixture } from '../support/related-sync-fixtures.js';
import {
  appendIdentitySelection,
  appendTopologyRevision,
  setRegionPolicy,
  withCommunityScopeWriter,
} from '../support/community-scope-fixtures.js';

/** Real AppModule/HTTP/Review, accepted synthetic A/B/C facts, one canonical graph. */
test(
  'related publication root and own-actor descendants retain exact Review, recovery and historical origin',
  { timeout: 180000 },
  async (t) => {
    const f = await relatedSyncRuntimeFixture();
    try {
      await setRegionPolicy(f.pool, f.scope.home.regionId, {
        relatedSyncEnabled: true,
        unverifiedCommentEnabled: true,
      });
      const publisher = await f.actor(),
        child = await f.actor({ campusId: f.scope.related.campusId }),
        outsider = await f.actor({ campusId: f.scope.foreign.campusId });
      const auth = `Bearer ${publisher.accessToken}`,
        childAuth = `Bearer ${child.accessToken}`;
      const body = {
        clientRequestId: randomUUID(),
        spaceId: f.scope.home.spaceId,
        category: 'discussion',
        text: 'Synthetic anonymous related poll',
        authorMode: 'anonymous',
        commentsPolicy: 'open',
        imageAssetIds: [],
        syncToRelatedCampuses: true,
        component: {
          kind: 'poll',
          question: 'One canonical question?',
          selectionMode: 'single',
          options: ['Yes', 'Always one'],
        },
      };
      const submit = (input = body, authorization = auth) =>
        request(f.app.getHttpServer())
          .post('/v1/community/reviews/posts')
          .set('Authorization', authorization)
          .send(input);
      const publish = (input = body) =>
        request(f.app.getHttpServer())
          .post('/v1/community/posts')
          .set('Authorization', auth)
          .send(input);
      let postId: string,
        rootReceipt: Record<string, unknown>,
        commentId: string;
      await t.test(
        'sync requires exact original identity, not permission in a related region',
        async () => {
          const wrong = await submit(
            { ...body, clientRequestId: randomUUID() },
            childAuth,
          );
          assert.notEqual(wrong.status, 200);
          assert.notEqual(
            (
              await submit(
                { ...body, clientRequestId: randomUUID() },
                `Bearer ${outsider.accessToken}`,
              )
            ).status,
            200,
          );
        },
      );
      await t.test(
        'explicit anonymous component Review publishes one root and native binding atomically',
        async () => {
          const pending = await submit();
          assert.equal(pending.status, 200, JSON.stringify(pending.body));
          assert.equal(pending.body.status, 'pending');
          const queued = (
            await f.pool.query(
              'SELECT envelope FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
              [publisher.accountId, body.clientRequestId],
            )
          ).rows[0]!.envelope;
          assert.equal(queued.version, 4);
          assert.equal(queued.scope.sync, 'related');
          assert.equal(queued.authorMode, 'anonymous');
          assert.equal(queued.component.kind, 'poll');
          await f.decide(publisher.accountId, body.clientRequestId);
          const created = await publish();
          assert.equal(created.status, 201, JSON.stringify(created.body));
          assert.equal(created.body.outcome, 'created');
          postId = created.body.resourceId;
          rootReceipt = created.body;
          assert.deepEqual((await publish()).body, rootReceipt);
          const binding = (
            await f.pool.query(
              'SELECT * FROM whaleu_community.post_distribution_bindings WHERE post_id=$1',
              [postId],
            )
          ).rows;
          assert.equal(binding.length, 1);
          assert.equal(binding[0].original_space_id, f.scope.home.spaceId);
          assert.equal(binding[0].client_request_id, body.clientRequestId);
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_community.posts WHERE id=$1',
                [postId],
              )
            ).rows[0].n,
            1,
          );
          const conflict = await publish({
            ...body,
            syncToRelatedCampuses: false,
          });
          assert.equal(
            conflict.body.error?.code ?? conflict.body.code,
            'REQUEST_CONFLICT',
          );
        },
      );
      await t.test(
        'B child uses its own identity and canonical root reference, including replies',
        async () => {
          const comment = {
            clientRequestId: randomUUID(),
            text: 'B actor, shared canonical discussion',
            imageAssetIds: [],
            authorMode: 'named',
          };
          const queued = await request(f.app.getHttpServer())
            .post(`/v1/community/reviews/posts/${postId}/comments`)
            .set('Authorization', childAuth)
            .send(comment);
          assert.equal(queued.status, 200, JSON.stringify(queued.body));
          await f.decide(child.accountId, comment.clientRequestId);
          const result = await request(f.app.getHttpServer())
            .post(`/v1/community/posts/${postId}/comments`)
            .set('Authorization', childAuth)
            .send(comment);
          assert.equal(result.status, 201, JSON.stringify(result.body));
          commentId = result.body.resourceId;
          const binding = (
            await f.pool.query(
              "SELECT envelope FROM whaleu_community.content_approval_bindings WHERE content_kind='comment' AND content_id=$1",
              [commentId],
            )
          ).rows[0]!.envelope;
          assert.equal(binding.version, 4);
          assert.equal(binding.scope.sync, 'inherited_related');
          assert.equal(
            binding.scope.identityRegionId,
            f.scope.related.regionId,
          );
          assert.equal(
            binding.scope.identityCampusId,
            f.scope.related.campusId,
          );
          assert.equal(binding.scope.parentDistribution.postId, postId);
          const reply = {
            ...comment,
            clientRequestId: randomUUID(),
            targetReplyId: null,
            text: 'One shared reply',
          };
          assert.equal(
            (
              await request(f.app.getHttpServer())
                .post(`/v1/community/reviews/comments/${commentId}/replies`)
                .set('Authorization', childAuth)
                .send(reply)
            ).status,
            200,
          );
          await f.decide(child.accountId, reply.clientRequestId);
          const replied = await request(f.app.getHttpServer())
            .post(`/v1/community/comments/${commentId}/replies`)
            .set('Authorization', childAuth)
            .send(reply);
          assert.equal(replied.status, 201, JSON.stringify(replied.body));
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_community.post_distribution_bindings WHERE post_id=$1',
                [postId],
              )
            ).rows[0].n,
            1,
          );
        },
      );
      await t.test(
        'raw writer cannot omit inherited child binding or mutate immutable root evidence',
        async () => {
          await assert.rejects(
            withCommunityScopeWriter(f.pool, (tx) =>
              tx.query(
                "INSERT INTO whaleu_community.root_comments(id,post_id,account_id,text,author_mode) VALUES($1,$2,$3,'raw omitted binding','named')",
                [randomUUID(), postId, child.accountId],
              ),
            ),
          );
          await assert.rejects(
            f.pool.query(
              'UPDATE whaleu_community.post_distribution_bindings SET digest=digest WHERE post_id=$1',
              [postId],
            ),
          );
          await assert.rejects(
            f.pool.query(
              'DELETE FROM whaleu_community.post_distribution_bindings WHERE post_id=$1',
              [postId],
            ),
          );
        },
      );
      await t.test(
        'named v4 DM consent stays explicit; absent and false never become opt-in',
        async () => {
          for (const allowAnonymousDm of [true, false, null]) {
            const input = {
              clientRequestId: randomUUID(),
              spaceId: f.scope.home.spaceId,
              category: 'discussion',
              text: 'Synthetic exact named DM consent',
              authorMode: 'named',
              commentsPolicy: 'open',
              imageAssetIds: [],
              syncToRelatedCampuses: true,
              ...(allowAnonymousDm === null ? {} : { allowAnonymousDm }),
            };
            const pending = await request(f.app.getHttpServer())
              .post('/v1/community/reviews/posts')
              .set('Authorization', auth)
              .send(input);
            assert.equal(pending.status, 200, JSON.stringify(pending.body));
            await f.decide(publisher.accountId, input.clientRequestId);
            const result = await request(f.app.getHttpServer())
              .post('/v1/community/posts')
              .set('Authorization', auth)
              .send(input);
            assert.equal(
              result.body.outcome,
              'created',
              JSON.stringify(result.body),
            );
            const resolve = () =>
              inTransaction(f.pool, (tx) =>
                f.app
                  .get(CommunityDmEntryFacade)
                  .resolve(
                    child.accountId,
                    { kind: 'post', postId: result.body.resourceId },
                    'anonymous',
                    tx,
                  ),
              );
            if (allowAnonymousDm === true) {
              const entry = await resolve();
              assert.equal(entry.actorMode, 'anonymous');
              assert.equal(entry.peerMode, 'named');
            } else
              await assert.rejects(
                resolve(),
                (error: unknown) =>
                  error instanceof ApplicationError &&
                  error.code === 'DM_ENTRY_UNAVAILABLE',
              );
          }
        },
      );
      await t.test(
        'new-origin toggle does not invalidate inherited canonical discussion or exact receipt',
        async () => {
          await setRegionPolicy(f.pool, f.scope.home.regionId, {
            relatedSyncEnabled: false,
          });
          const next = {
            clientRequestId: randomUUID(),
            text: 'Historical root remains discussable',
            imageAssetIds: [],
            authorMode: 'named',
          };
          const queued = await request(f.app.getHttpServer())
            .post(`/v1/community/reviews/posts/${postId}/comments`)
            .set('Authorization', childAuth)
            .send(next);
          assert.equal(queued.status, 200, JSON.stringify(queued.body));
          await f.decide(child.accountId, next.clientRequestId);
          assert.equal(
            (
              await request(f.app.getHttpServer())
                .post(`/v1/community/posts/${postId}/comments`)
                .set('Authorization', childAuth)
                .send(next)
            ).body.outcome,
            'created',
          );
          assert.notEqual(
            (await submit({ ...body, clientRequestId: randomUUID() })).status,
            200,
          );
          assert.deepEqual((await publish()).body, rootReceipt);
        },
      );
      await t.test(
        'changed actor selection after approval cannot consume frozen Review',
        async () => {
          await setRegionPolicy(f.pool, f.scope.home.regionId, {
            relatedSyncEnabled: true,
          });
          const stale = { ...body, clientRequestId: randomUUID() };
          assert.equal((await submit(stale)).status, 200);
          await f.decide(publisher.accountId, stale.clientRequestId);
          await appendIdentitySelection(
            f.pool,
            publisher.accountId,
            publisher.facts,
            f.scope,
            f.scope.home.campusId,
          );
          const result = await publish(stale);
          assert.notEqual(result.body.outcome, 'created');
          assert.deepEqual((await publish()).body, rootReceipt);
        },
      );
      await t.test(
        'exact sync cancellation survives lost response and changed flag conflicts',
        async () => {
          const cancelled = { ...body, clientRequestId: randomUUID() };
          const intentHash = publicationHash(
            'publish_post',
            postIntent(publishPostSchema.parse(cancelled)),
          );
          const result = await request(f.app.getHttpServer())
            .post(
              `/v1/community/reviews/requests/${cancelled.clientRequestId}/cancel`,
            )
            .set('Authorization', auth)
            .send({ operation: 'publish_post', intentHash });
          assert.equal(result.body.outcome, 'cancelled');
          const attempt = await publish(cancelled);
          assert.equal(
            attempt.body.error?.code ?? attempt.body.code,
            'MEDIA_REQUEST_CANCELLED',
          );
          const conflict = await publish({
            ...cancelled,
            syncToRelatedCampuses: false,
          });
          assert.equal(
            conflict.body.error?.code ?? conflict.body.code,
            'REQUEST_CONFLICT',
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_community.post_distribution_bindings WHERE post_id=$1',
                [postId],
              )
            ).rows[0].n,
            1,
          );
        },
      );
      await t.test(
        'withdrawing B projection does not require root historical identity to read canonical A',
        async () => {
          const topology = structuredClone(f.scope.topology);
          topology.regions.find(
            (r) => r.regionId === f.scope.related.regionId,
          )!.groupId = topology.regions.find(
            (r) => r.regionId === f.scope.foreign.regionId,
          )!.groupId;
          await appendTopologyRevision(f.pool, topology);
          const detail = await request(f.app.getHttpServer())
            .get(`/v1/community/posts/${postId}`)
            .set('Authorization', childAuth);
          assert.equal(detail.status, 200, JSON.stringify(detail.body));
          assert.deepEqual((await publish()).body, rootReceipt);
        },
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'restricted related roots expose actual original-space comment authority through HTTP hints and exact Review',
  { timeout: 180000 },
  async () => {
    const f = await relatedSyncRuntimeFixture();
    try {
      await setRegionPolicy(f.pool, f.scope.home.regionId, {
        relatedSyncEnabled: true,
      });
      const author = await f.actor(),
        originalAdmin = await f.actor(),
        developer = await f.actor(),
        superAdmin = await f.actor(),
        remoteAdmin = await f.actor({ campusId: f.scope.related.campusId }),
        ordinary = await f.actor();
      type Actor = typeof author;
      const grant = async (
        actor: Actor,
        role: string,
        region: string | null,
      ) => {
        const id = randomUUID();
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            `INSERT INTO whaleu_authorization.role_grants
             (id,account_id,role,operating_region_id,approved_by_account_id,approval_reference)
             VALUES($1,$2,$3,$4,$2,'synthetic-restricted-related-discussion')`,
            [id, actor.accountId, role, region],
          ),
        );
        return id;
      };
      const authorGrant = await grant(
        author,
        'school_admin',
        f.scope.home.regionId,
      );
      await grant(originalAdmin, 'school_admin', f.scope.home.regionId);
      await grant(developer, 'developer', null);
      await grant(superAdmin, 'super_admin', null);
      await grant(remoteAdmin, 'school_admin', f.scope.related.regionId);
      const root = {
        clientRequestId: randomUUID(),
        spaceId: f.scope.home.spaceId,
        category: 'discussion',
        text: 'Synthetic restricted related root',
        authorMode: 'named',
        commentsPolicy: 'restricted',
        imageAssetIds: [],
        syncToRelatedCampuses: true,
      };
      const queue = await request(f.app.getHttpServer())
        .post('/v1/community/reviews/posts')
        .set('Authorization', `Bearer ${author.accessToken}`)
        .send(root);
      assert.equal(queue.status, 200, JSON.stringify(queue.body));
      await f.decide(author.accountId, root.clientRequestId);
      const published = await request(f.app.getHttpServer())
        .post('/v1/community/posts')
        .set('Authorization', `Bearer ${author.accessToken}`)
        .send(root);
      assert.equal(published.status, 201, JSON.stringify(published.body));
      const id = published.body.resourceId as string;
      // Historical author access is not contingent on retaining the creation grant.
      await withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE id=$1',
          [authorGrant],
        ),
      );
      for (const [actor, allowed] of [
        [author, true],
        [originalAdmin, true],
        [developer, true],
        [superAdmin, true],
        [remoteAdmin, false],
        [ordinary, false],
      ] as const) {
        const auth = `Bearer ${actor.accessToken}`;
        const caps = await request(f.app.getHttpServer())
          .get(`/v1/community/posts/${id}/comment-capabilities`)
          .set('Authorization', auth);
        assert.equal(caps.status, 200, JSON.stringify(caps.body));
        assert.equal(caps.body.inheritsRelatedCampusSync, true);
        assert.equal(caps.body.availability, allowed ? 'allowed' : 'denied');
        assert.equal(caps.body.reason, allowed ? null : 'COMMENTS_DISABLED');
        assert.deepEqual(
          caps.body.authorModes,
          allowed ? ['named', 'anonymous'] : [],
        );
        for (const viewSpaceId of [
          f.scope.home.spaceId,
          f.scope.related.spaceId,
        ]) {
          const detail = await request(f.app.getHttpServer())
            .get(`/v1/community/posts/${id}`)
            .query({ viewSpaceId })
            .set('Authorization', auth);
          assert.equal(detail.status, 200, JSON.stringify(detail.body));
          assert.equal(detail.body.viewer.canComment, allowed);
          assert.equal(detail.body.space.id, f.scope.home.spaceId);
        }
        const comment = {
          clientRequestId: randomUUID(),
          text: 'Exact permitted restricted discussion',
          imageAssetIds: [],
          authorMode: 'named',
        };
        const pending = await request(f.app.getHttpServer())
          .post(`/v1/community/reviews/posts/${id}/comments`)
          .set('Authorization', auth)
          .send(comment);
        if (!allowed) {
          assert.equal(pending.status, 403, JSON.stringify(pending.body));
          assert.equal(
            pending.body.error?.code ?? pending.body.code,
            'COMMENTS_DISABLED',
          );
          const rejected = await request(f.app.getHttpServer())
            .post(`/v1/community/posts/${id}/comments`)
            .set('Authorization', auth)
            .send(comment);
          // Mutation denial is an immutable terminal receipt; the Review-only
          // endpoint above rejects directly without creating content.
          assert.equal(rejected.status, 201, JSON.stringify(rejected.body));
          assert.deepEqual(rejected.body, {
            requestId: comment.clientRequestId,
            operation: 'publish_comment',
            outcome: 'rejected',
            code: 'COMMENTS_DISABLED',
          });
          const replay = await request(f.app.getHttpServer())
            .post(`/v1/community/posts/${id}/comments`)
            .set('Authorization', auth)
            .send(comment);
          assert.equal(replay.status, 201, JSON.stringify(replay.body));
          assert.deepEqual(replay.body, rejected.body);
          assert.equal(
            (
              await f.pool.query<{ n: number }>(
                'SELECT count(*)::integer n FROM whaleu_community.root_comments WHERE post_id=$1 AND account_id=$2',
                [id, actor.accountId],
              )
            ).rows[0]!.n,
            0,
          );
          continue;
        }
        assert.equal(pending.status, 200, JSON.stringify(pending.body));
        assert.equal(pending.body.status, 'pending');
        await f.decide(actor.accountId, comment.clientRequestId);
        const created = await request(f.app.getHttpServer())
          .post(`/v1/community/posts/${id}/comments`)
          .set('Authorization', auth)
          .send(comment);
        assert.equal(created.status, 201, JSON.stringify(created.body));
        const reply = {
          ...comment,
          clientRequestId: randomUUID(),
          targetReplyId: null,
        };
        const reviewedReply = await request(f.app.getHttpServer())
          .post(
            `/v1/community/reviews/comments/${created.body.resourceId}/replies`,
          )
          .set('Authorization', auth)
          .send(reply);
        assert.equal(
          reviewedReply.status,
          200,
          JSON.stringify(reviewedReply.body),
        );
        await f.decide(actor.accountId, reply.clientRequestId);
        const replied = await request(f.app.getHttpServer())
          .post(`/v1/community/comments/${created.body.resourceId}/replies`)
          .set('Authorization', auth)
          .send(reply);
        assert.equal(replied.status, 201, JSON.stringify(replied.body));
      }
    } finally {
      await f.close();
    }
  },
);
