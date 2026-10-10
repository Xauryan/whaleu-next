import {
  seedExactContent,
  observeExactQueries,
} from '../support/exact-discovery-counts.js';
import {
  MediaContentSnapshotFacade,
  mediaContentKey,
} from '../../src/media/content-snapshot.facade.js';
import { SnapshotReadBudget } from '../../src/community/content-review/count-snapshot.repository.js';
import { validateCurrentMedia } from '../../src/media/current-facts.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { syntheticMediaRuntimeFixture } from '../support/media/runtime-fixture.js';
import { verifyImageAwareCountProof } from '../support/media/image-aware-count-proof.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import {
  approveEnvelope,
  seedReviewPolicy,
} from '../support/community-approval-fixtures.js';
import {
  postApprovalEnvelope,
  postApprovalEnvelopeV1,
  discussionApprovalEnvelope,
} from '../support/community-runtime-fixtures.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { UpdatesWorker } from '../../src/notifications/worker.js';
import { NotificationsRepository } from '../../src/notifications/repository.js';
import { CommunityUpdatesFacade } from '../../src/community/updates.facade.js';
import { DatabaseService } from '../../src/database/database.js';
import { APP_CONFIG } from '../../src/config/config.js';
import type { RuntimeConfig } from '../../src/config/config.js';

interface FixtureSharp {
  png(): FixtureSharp;
  toBuffer(): Promise<Buffer>;
}
type FixtureFactory = (input: {
  create: {
    width: number;
    height: number;
    channels: 3;
    background: { r: number; g: number; b: number };
  };
}) => FixtureSharp;

test(
  'single-image real discovery preserves child search, optional counts, cursors and notice unread ledger',
  { timeout: 240000 },
  async (t) => {
    const name = 'sharp';
    const sharp = ((await import(name)) as { default: FixtureFactory }).default;
    const bytes = await sharp({
      create: {
        width: 80,
        height: 60,
        channels: 3,
        background: { r: 20, g: 100, b: 160 },
      },
    })
      .png()
      .toBuffer();
    const f = await syntheticMediaRuntimeFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    try {
      const author = await f.actor(),
        reader = await f.actor(),
        saver = await f.actor();
      const http = f.app.getHttpServer();
      const auth = (actor = reader) => `Bearer ${actor.accessToken}`;
      const get = (url: string, actor = reader) =>
        request(http).get(url).set('Authorization', auth(actor));
      const expectOk = (response: { status: number; body: unknown }) =>
        assert.equal(response.status, 200, JSON.stringify(response.body));
      const policy = await seedReviewPolicy(f.pool);
      const prepared = await request(http)
        .post('/v1/media/upload-intents')
        .set('Authorization', auth(author))
        .send({
          clientRequestId: randomUUID(),
          purpose: 'community-post-image',
          draftId: randomUUID(),
          spaceId: f.scope.home.spaceId,
          slot: 'images',
          ordinal: 0,
          declaration: { mime: 'image/png', bytes: bytes.length },
        });
      expectOk(prepared);
      await f.worker.upload(
        author.accountId,
        prepared.body.intentId as string,
        bytes,
      );
      for (const stage of ['seal', 'process', 'review'] as const)
        assert.equal(await f.worker.runOne(stage), true);
      const ready = await get(
        `/v1/media/upload-intents/${prepared.body.intentId}`,
        author,
      );
      expectOk(ready);
      assert.equal(ready.body.status, 'ready');
      const assetId = ready.body.assetId as string;
      const digest = (
        await f.pool.query<{ manifest_digest: string }>(
          'SELECT manifest_digest FROM whaleu_media.assets WHERE id=$1',
          [assetId],
        )
      ).rows[0]!.manifest_digest;
      const publish = async (image: boolean, text: string) => {
        const body = {
          clientRequestId: randomUUID(),
          spaceId: f.scope.home.spaceId,
          category: 'discussion' as const,
          text,
          imageAssetIds: image ? [assetId] : [],
          authorMode: 'named' as const,
          commentsPolicy: 'open' as const,
        };
        const envelope = await postApprovalEnvelope(
          f.app,
          f.pool,
          author.accountId,
          body,
        );
        await approveEnvelope(
          f.pool,
          image ? { ...envelope, images: [{ assetId, digest }] } : envelope,
        );
        const response = await request(http)
          .post('/v1/community/posts')
          .set('Authorization', auth(author))
          .send(body);
        assert.equal(response.status, 201, JSON.stringify(response.body));
        return response.body.resourceId as string;
      };
      const imagePost = await publish(true, 'needle image post');
      const save = await request(http)
        .put(`/v1/community/posts/${imagePost}/save`)
        .set('Authorization', auth(saver))
        .send({ clientRequestId: randomUUID() });
      expectOk(save);
      const preference = await request(http)
        .put(`/v1/community/posts/${imagePost}/update-preferences`)
        .set('Authorization', auth(saver))
        .send({
          clientRequestId: randomUUID(),
          channel: 'saved',
          enabled: true,
        });
      expectOk(preference);
      const commentBody = {
        clientRequestId: randomUUID(),
        text: 'needle image ancestor comment',
        imageAssetIds: [],
        authorMode: 'named' as const,
      };
      await approveEnvelope(
        f.pool,
        await discussionApprovalEnvelope(
          f.app,
          f.pool,
          reader.accountId,
          imagePost,
          commentBody,
        ),
      );
      const comment = await request(http)
        .post(`/v1/community/posts/${imagePost}/comments`)
        .set('Authorization', auth())
        .send(commentBody);
      assert.equal(comment.status, 201, JSON.stringify(comment.body));
      const commentId = comment.body.resourceId as string;
      const replyBody = {
        ...commentBody,
        clientRequestId: randomUUID(),
        text: 'needle image ancestor reply',
        targetReplyId: null,
      };
      await approveEnvelope(
        f.pool,
        await discussionApprovalEnvelope(
          f.app,
          f.pool,
          author.accountId,
          imagePost,
          replyBody,
          commentId,
        ),
      );
      const reply = await request(http)
        .post(`/v1/community/comments/${commentId}/replies`)
        .set('Authorization', auth(author))
        .send(replyBody);
      assert.equal(reply.status, 201, JSON.stringify(reply.body));
      const replyId = reply.body.resourceId as string;
      const like = await request(http)
        .put(`/v1/community/posts/${imagePost}/like`)
        .set('Authorization', auth())
        .send({ requestId: randomUUID(), liked: true });
      expectOk(like);
      const childLike = await request(http)
        .put(`/v1/community/comments/${commentId}/like`)
        .set('Authorization', auth())
        .send({ clientRequestId: randomUUID() });
      expectOk(childLike);
      const profileRef = await get('/v1/me/public-profile-ref', author);
      expectOk(profileRef);
      const profileId = profileRef.body.profileId as string;
      const search = (query: Record<string, unknown> = {}) =>
        get('/v1/community/search').query({
          spaceId: f.scope.home.spaceId,
          q: 'needle',
          type: 'all',
          ...query,
        });
      const profile = () => get(`/v1/profiles/${profileId}`);
      const profilePosts = (query: Record<string, unknown> = {}) =>
        get(`/v1/profiles/${profileId}/posts`).query(query);
      const feed = () =>
        get('/v1/community/posts').query({ spaceId: f.scope.home.spaceId });
      const liked = () => get('/v1/me/community/liked');
      const saved = () => get('/v1/me/community/saved', saver);
      const events = (
        await f.pool.query<{ id: string }>(
          "SELECT id FROM whaleu_community.outbox WHERE resource_id=ANY($1::uuid[]) AND event_type IN ('comment_created','reply_created')",
          [[commentId, replyId]],
        )
      ).rows.map((r) => r.id);
      const worker = new UpdatesWorker(
        f.app.get(DatabaseService),
        {
          ...f.app.get<RuntimeConfig>(APP_CONFIG),
          COMMUNITY_UPDATES_PROCESSING: 'manual_only',
        },
        f.app.get(CommunityUpdatesFacade),
        f.app.get(NotificationsRepository),
      );
      const materialized = await worker.run({
        mode: 'apply',
        eventIds: events,
      });
      assert.ok(materialized.materialized >= 2);
      const notices = await get('/v1/me/community/updates', author);
      expectOk(notices);
      const notice = notices.body.items.find(
        (item: { status: string }) => item.status === 'available',
      );
      assert.ok(notice);
      const unread = notices.body.unreadCount as number;
      assert.ok(unread > 0);
      const appendSafety = async (
        state: 'allow' | 'held' | 'revoked',
        lifetime = 3600,
      ) =>
        withCommunityScopeWriter(f.pool, async (tx) => {
          const revision =
            Number(
              (
                await tx.query<{ revision: string }>(
                  'SELECT revision FROM whaleu_media.asset_safety_heads WHERE asset_id=$1 FOR UPDATE',
                  [assetId],
                )
              ).rows[0]!.revision,
            ) + 1;
          const event = randomUUID();
          await tx.query(
            `INSERT INTO whaleu_media.asset_safety_events(id,asset_id,revision,state,manifest_digest,policy_revision,issuer,source_reference,provenance,effective_at,valid_until)
        VALUES($1,$2,$3,$4,$5,'media-static-v1','registered-synthetic-media',$6,'{}',clock_timestamp()-interval '2 hours',clock_timestamp()+$7::double precision*interval '1 second')`,
            [
              event,
              assetId,
              revision,
              state,
              digest,
              `${state}:${event}`,
              lifetime,
            ],
          );
          await tx.query(
            'UPDATE whaleu_media.asset_safety_heads SET revision=$2,event_id=$3 WHERE asset_id=$1',
            [assetId, revision, event],
          );
        });

      await verifyImageAwareCountProof(t, f.pool, {
        postId: imagePost,
        accountId: author.accountId,
      });

      await t.test(
        'real PostgreSQL conditional batch has bounded cardinality and exact microsecond time',
        async () => {
          const client = await f.pool.connect();
          try {
            const facade = new MediaContentSnapshotFacade();
            const reference = {
              parent: {
                ownerKind: 'community' as const,
                resourceKind: 'post' as const,
                resourceId: imagePost,
                contentVersion: 1 as const,
              },
              expected: [{ assetId, digest }],
            };
            for (const size of [0, 1, 255, 256]) {
              const references = Array.from({ length: size }, (_, index) =>
                index === 0
                  ? reference
                  : {
                      ...reference,
                      parent: { ...reference.parent, resourceId: randomUUID() },
                    },
              );
              const facts = await facade.readBatch(
                references,
                client,
                new SnapshotReadBudget(),
              );
              assert.equal(facts.size, size);
              if (size)
                assert.equal(
                  facts.get(mediaContentKey(reference.parent))!.decision,
                  'allow',
                );
              assert.equal(
                [...facts.values()].filter(
                  (fact) => fact.decision === 'unknown',
                ).length,
                Math.max(0, size - 1),
              );
            }
            await assert.rejects(
              facade.readBatch(
                Array.from({ length: 257 }, () => ({
                  ...reference,
                  parent: { ...reference.parent, resourceId: randomUUID() },
                })),
                client,
                new SnapshotReadBudget(),
              ),
            );
            const nearLimit = new SnapshotReadBudget();
            await nearLimit.rows(
              client,
              "SELECT repeat('x',$1::integer) AS payload",
              [4 * 1024 * 1024 - 64],
              1,
            );
            await assert.rejects(
              facade.readBatch([reference], client, nearLimit),
            );
            const exact = (
              await client.query<{
                effective_at: Date;
                valid_until: Date;
                now: Date;
                exact_time_valid: boolean;
              }>(
                `SELECT '2026-01-01T00:00:00.000001Z'::timestamptz effective_at,
           '2026-01-01T00:01:00Z'::timestamptz valid_until,
           '2026-01-01T00:00:00.000000Z'::timestamptz now,
           '2026-01-01T00:00:00.000001Z'::timestamptz<='2026-01-01T00:00:00.000000Z'::timestamptz exact_time_valid`,
              )
            ).rows[0]!;
            assert.equal(exact.effective_at.getTime(), exact.now.getTime());
            assert.equal(exact.exact_time_valid, false);
            const asset = (
              await client.query<{
                manifest: unknown;
                manifest_digest: string;
                policy_revision: string;
              }>(
                'SELECT manifest,manifest_digest,policy_revision FROM whaleu_media.assets WHERE id=$1',
                [assetId],
              )
            ).rows[0]!;
            assert.equal(
              validateCurrentMedia(
                asset,
                'ready',
                {
                  ...exact,
                  state: 'allow',
                  manifest_digest: digest,
                  policy_revision: asset.policy_revision,
                },
                exact.now.getTime(),
                exact.exact_time_valid,
              ).decision,
              'unknown',
            );
          } finally {
            client.release();
          }
        },
      );

      await t.test(
        'allow covers post text, plain comment/reply, Profile, feed, liked and saved',
        async () => {
          const found = await search();
          expectOk(found);
          assert.deepEqual(
            new Set(
              found.body.items.map((i: { contentId: string }) => i.contentId),
            ),
            new Set([imagePost, commentId, replyId]),
          );
          assert.equal(JSON.stringify(found.body).includes(assetId), false);
          const p = await profile();
          expectOk(p);
          assert.equal(p.body.postCountStatus, 'known');
          assert.equal(p.body.postCount, 1);
          const l = await liked();
          expectOk(l);
          assert.equal(l.body.visibleLikedCountStatus, 'known');
          assert.equal(l.body.visibleLikedCount, 2);
          for (const response of [
            await feed(),
            await profilePosts(),
            await saved(),
          ]) {
            expectOk(response);
            assert.equal(response.body.items.length, 1);
          }
        },
      );
      const pendingBody = {
        ...commentBody,
        clientRequestId: randomUUID(),
        text: 'needle pending image-parent notice',
      };
      await approveEnvelope(
        f.pool,
        await discussionApprovalEnvelope(
          f.app,
          f.pool,
          reader.accountId,
          imagePost,
          pendingBody,
        ),
      );
      const pendingComment = await request(http)
        .post(`/v1/community/posts/${imagePost}/comments`)
        .set('Authorization', auth())
        .send(pendingBody);
      assert.equal(
        pendingComment.status,
        201,
        JSON.stringify(pendingComment.body),
      );
      const pendingEvent = (
        await f.pool.query<{ id: string }>(
          "SELECT id FROM whaleu_community.outbox WHERE resource_id=$1 AND event_type='comment_created'",
          [pendingComment.body.resourceId],
        )
      ).rows[0]!.id;
      const textPost = await publish(false, 'needle newer plain post');
      const page = await profilePosts({ limit: 1 });
      expectOk(page);
      assert.equal(page.body.items[0].id, textPost);
      assert.ok(page.body.nextCursor);
      const searchPage = await search({ limit: 1 });
      expectOk(searchPage);
      assert.ok(searchPage.body.nextCursor);
      await t.test(
        'unknown only off-page total preserves proved text page and independent count',
        async () => {
          await appendSafety('held', -1);
          const pendingAttempt = await worker.run({
            mode: 'apply',
            eventIds: [pendingEvent],
          });
          assert.equal(pendingAttempt.materialized, 0);
          assert.ok(pendingAttempt.retryable > 0);
          const p = await profilePosts({ limit: 1 });
          expectOk(p);
          assert.equal(p.body.items[0].id, textPost);
          assert.equal(p.body.total, null);
          assert.equal(p.body.totalStatus, 'unavailable');
          assert.ok(p.body.nextCursor);
          const summary = await profile();
          expectOk(summary);
          assert.equal(summary.body.postCount, null);
          assert.equal(summary.body.postCountStatus, 'unavailable');
          assert.equal(summary.body.tradeCountStatus, 'known');
          assert.equal(summary.body.tradeCount, 0);
          const required = await search({ postId: imagePost });
          assert.equal(required.status, 503);
          const existing = await get('/v1/me/community/updates', author);
          expectOk(existing);
          assert.equal(existing.body.unreadCount, unread);
          const unavailable = existing.body.items.find(
            (item: { noticeId: string }) => item.noticeId === notice.noticeId,
          );
          assert.deepEqual(Object.keys(unavailable).sort(), [
            'createdAt',
            'noticeId',
            'readAt',
            'status',
          ]);
          assert.equal(unavailable.readAt, null);
        },
      );
      await t.test(
        'current known denial excludes complete ancestry without clearing unread ledger',
        async () => {
          await appendSafety('revoked');
          const found = await search();
          expectOk(found);
          assert.deepEqual(
            found.body.items.map((i: { contentId: string }) => i.contentId),
            [textPost],
          );
          const p = await profile();
          expectOk(p);
          assert.equal(p.body.postCountStatus, 'known');
          assert.equal(p.body.postCount, 1);
          const l = await liked();
          expectOk(l);
          assert.equal(l.body.visibleLikedCountStatus, 'known');
          assert.equal(l.body.visibleLikedCount, 0);
          const s = await saved();
          expectOk(s);
          assert.equal(s.body.items.length, 0);
          const n = await get('/v1/me/community/updates', author);
          expectOk(n);
          assert.equal(n.body.unreadCount, unread);
          assert.equal(
            n.body.items.find(
              (i: { noticeId: string }) => i.noticeId === notice.noticeId,
            ).status,
            'unavailable',
          );
          const continued = await search({
            limit: 1,
            cursor: searchPage.body.nextCursor,
          });
          expectOk(continued);
          assert.equal(continued.body.items.length, 0);
        },
      );
      await t.test(
        'fresh allow restores projections and old unmodified cursors; mark-read changes only ledger',
        async () => {
          await appendSafety('allow');
          const continued = await profilePosts({
            limit: 1,
            cursor: page.body.nextCursor,
          });
          expectOk(continued);
          assert.equal(continued.body.items[0].id, imagePost);
          const n = await get('/v1/me/community/updates', author);
          expectOk(n);
          assert.equal(n.body.unreadCount, unread);
          assert.equal(
            n.body.items.find(
              (i: { noticeId: string }) => i.noticeId === notice.noticeId,
            ).status,
            'available',
          );
          const read = await request(http)
            .put(`/v1/me/community/updates/${notice.noticeId}/read`)
            .set('Authorization', auth(author))
            .send({});
          expectOk(read);
          const count = await get(
            '/v1/me/community/updates/unread-count',
            author,
          );
          expectOk(count);
          assert.equal(count.body.unreadCount, unread - 1);
          const p = await profile();
          expectOk(p);
          assert.equal(p.body.postCount, 2);
          const retried = await worker.run({
            mode: 'apply',
            eventIds: [pendingEvent],
          });
          assert.ok(retried.materialized > 0);
          const restoredCount = await get(
            '/v1/me/community/updates/unread-count',
            author,
          );
          expectOk(restoredCount);
          assert.equal(restoredCount.body.unreadCount, unread);
        },
      );
      await t.test(
        'ordinary runtime retains disabled Media authority while text pages still work',
        async () => {
          const ordinary = await f.startOrdinaryRuntime();
          const summary = await request(ordinary.getHttpServer())
            .get(`/v1/profiles/${profileId}`)
            .set('Authorization', auth());
          expectOk(summary);
          assert.equal(summary.body.postCountStatus, 'unavailable');
          assert.equal(summary.body.postCount, null);
          const plain = await request(ordinary.getHttpServer())
            .get(`/v1/profiles/${profileId}/posts`)
            .query({ limit: 1 })
            .set('Authorization', auth());
          expectOk(plain);
          assert.equal(plain.body.items[0].id, textPost);
          assert.equal(plain.body.totalStatus, 'unavailable');
          const image = await request(ordinary.getHttpServer())
            .get(`/v1/community/posts/${imagePost}`)
            .set('Authorization', auth());
          assert.equal(image.status, 503);
        },
      );
      await t.test(
        'real 4097-post count retains one current image dependency within unchanged scan and batch budgets',
        async () => {
          const envelope = await postApprovalEnvelopeV1(
            f.app,
            f.pool,
            author.accountId,
            {
              clientRequestId: randomUUID(),
              spaceId: f.scope.home.spaceId,
              category: 'discussion',
              text: 'Synthetic discovery scale text',
              imageAssetIds: [],
              authorMode: 'named',
              commentsPolicy: 'open',
            },
          );
          await seedExactContent(f.pool, policy, 'post', 4095, () => envelope);
          const observer = observeExactQueries(f.app);
          try {
            const { value, measurement } = await observer.measure(
              'image-aware-4097',
              profile,
            );
            expectOk(value);
            assert.equal(value.body.postCountStatus, 'known');
            assert.equal(value.body.postCount, 4097);
            assert.ok(measurement.maxCountBatchBytes <= 4 * 1024 * 1024);
            assert.ok(measurement.maxBindArray <= 768);
            assert.ok(
              measurement.countQueries <= 20,
              JSON.stringify(measurement),
            );
            t.diagnostic(
              JSON.stringify({
                label: measurement.label,
                durationMs: measurement.durationMs,
                queries: measurement.queries,
                countQueries: measurement.countQueries,
                maxCountBatchBytes: measurement.maxCountBatchBytes,
                maxBindArray: measurement.maxBindArray,
              }),
            );
          } finally {
            observer.restore();
          }
        },
      );
    } finally {
      await f.close();
    }
  },
);
