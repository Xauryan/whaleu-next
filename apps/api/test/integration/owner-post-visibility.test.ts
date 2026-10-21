/** Real AppModule/PostgreSQL owner overlay composition. Only the already shared
 * synthetic Media provider is opted in; no content/authorization owner is faked. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import sharp from 'sharp';
import { APP_CONFIG, type RuntimeConfig } from '../../src/config/config.js';
import { DatabaseService, inTransaction } from '../../src/database/database.js';
import { HotScoreMaterializer } from '../../src/community/hot-score/materializer.js';
import { SubscriptionComponentSettlement } from '../../src/community/subscription-component/settlement.js';
import { LikeComponentSettlement } from '../../src/community/like-component/settlement.js';
import { CommentComponentSettlement } from '../../src/community/comment-component/settlement.js';
import { CommunityUpdatesFacade } from '../../src/community/updates.facade.js';
import { NotificationsRepository } from '../../src/notifications/repository.js';
import { UpdatesWorker } from '../../src/notifications/worker.js';
import { MediaDeliveryBudgetPool } from '../../src/media/delivery-budget.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { syntheticMediaRuntimeFixture } from '../support/media/runtime-fixture.js';
import { observeMediaDeliveryBudget } from '../support/media/delivery-budget-observer.js';
import {
  readyDiscussionBatch,
  sealDiscussionBatch,
} from '../support/media/discussion-batch-fixture.js';
import {
  approveEnvelope,
  seedReviewPolicy,
  setReviewState,
} from '../support/community-approval-fixtures.js';
import {
  discussionApprovalEnvelope,
  postApprovalEnvelope,
} from '../support/community-runtime-fixtures.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import {
  assertReceipt,
  epochPath,
  reportIntent,
  reportPath,
} from '../support/view-component-fixture.js';
import { approveDm } from '../support/dm-owner-fixture.js';
import { canonicalDmEnvelope } from '../../src/community/content-review/dm-contracts.js';
import type { DmEntry } from '../../src/messaging/contracts.js';

const ok = (response: { status: number; body: unknown }, status = 200) =>
  assert.equal(response.status, status, JSON.stringify(response.body));
const denied = (response: {
  status: number;
  body: unknown;
  headers: Record<string, unknown>;
}) => {
  assert.ok(
    [403, 404, 409, 503].includes(response.status),
    JSON.stringify(response.body),
  );
  assert.ok(!String(response.headers['content-type']).startsWith('image/'));
};

test(
  'owner-hidden posts retain private ownership and immutable publication/media while every public descendant projection closes',
  { timeout: 360000 },
  async (t) => {
    const bytes = await sharp({
      create: { width: 80, height: 60, channels: 3, background: '#243759' },
    })
      .png()
      .toBuffer();
    const f = await syntheticMediaRuntimeFixture(
      [{ sha256: sha256(bytes), verdict: 'allow' }],
      {
        configureTestModule(builder, { runtimeConfig }) {
          builder
            .overrideProvider(APP_CONFIG)
            .useValue({ ...runtimeConfig, HOT_FEED_PROCESSING: 'manual_only' });
        },
      },
    );
    const mediaPool = f.app.get(MediaDeliveryBudgetPool);
    const mediaBudget = observeMediaDeliveryBudget(mediaPool);
    t.after(async () => {
      try {
        await f.close();
      } finally {
        mediaBudget.restore();
      }
    });
    await seedReviewPolicy(f.pool);
    const owner = await f.actor(),
      reader = await f.actor(),
      admin = await f.actor();
    const http = f.app.getHttpServer();
    const auth = (actor = reader) => `Bearer ${actor.accessToken}`;
    const get = (path: string, actor = reader) =>
      request(http).get(path).set('Authorization', auth(actor));
    const commandPath = '/v1/me/community/owner-visibility-commands';
    const management = (id: string, actor = owner) =>
      get(`/v1/me/community/posts/${id}/owner-visibility`, actor);
    const setHidden = async (id: string, hidden: boolean) => {
      const state = await management(id);
      ok(state);
      const result = await request(http)
        .post(commandPath)
        .set('Authorization', auth(owner))
        .send({
          clientRequestId: randomUUID(),
          postId: id,
          ownerHidden: hidden,
          expectedVersion: state.body.version,
        });
      ok(result);
      assert.equal(result.body.outcome, 'applied', JSON.stringify(result.body));
      assert.equal(result.body.ownerHidden, hidden);
      assert.equal(result.body.version, state.body.version + 1);
      return result.body;
    };
    const prepared = await request(http)
      .post('/v1/media/upload-intents')
      .set('Authorization', auth(owner))
      .send({
        clientRequestId: randomUUID(),
        purpose: 'community-post-image',
        draftId: randomUUID(),
        spaceId: f.scope.home.spaceId,
        slot: 'images',
        ordinal: 0,
        declaration: { mime: 'image/png', bytes: bytes.length },
      });
    ok(prepared);
    await f.worker.upload(owner.accountId, prepared.body.intentId, bytes);
    for (const stage of ['seal', 'process', 'review'] as const)
      assert.equal(await f.worker.runOne(stage), true);
    const ready = await get(
      `/v1/media/upload-intents/${prepared.body.intentId}`,
      owner,
    );
    ok(ready);
    assert.equal(ready.body.status, 'ready');
    const assetId = ready.body.assetId as string;
    const digest = (
      await f.pool.query<{ manifest_digest: string }>(
        'SELECT manifest_digest FROM whaleu_media.assets WHERE id=$1',
        [assetId],
      )
    ).rows[0]!.manifest_digest;
    const publish = async (
      text: string,
      options: { image?: boolean; anonymous?: boolean; trading?: boolean } = {},
    ) => {
      const body = {
        clientRequestId: randomUUID(),
        spaceId: f.scope.home.spaceId,
        category: options.trading
          ? ('trading' as const)
          : ('discussion' as const),
        text,
        authorMode: options.anonymous
          ? ('anonymous' as const)
          : ('named' as const),
        imageAssetIds: options.image ? [assetId] : [],
        commentsPolicy: 'open' as const,
        ...(options.trading
          ? {
              trading: {
                subtype: 'shuma' as const,
                price: '12.50',
                urgency: 'urgent' as const,
                location: 'Synthetic pickup',
                contacts: { wechat: 'fixture', qq: '', phone: '' },
              },
            }
          : {}),
      };
      const envelope = await postApprovalEnvelope(
        f.app,
        f.pool,
        owner.accountId,
        body,
      );
      const approval = await approveEnvelope(
        f.pool,
        options.image
          ? { ...envelope, images: [{ assetId, digest }] }
          : envelope,
      );
      const response = await request(http)
        .post('/v1/community/posts')
        .set('Authorization', auth(owner))
        .send(body);
      ok(response, 201);
      assert.equal(response.body.outcome, 'created');
      return { id: response.body.resourceId as string, approval, input: body };
    };
    const post = await publish('concealneedle retained image parent', {
      image: true,
    });
    const anonymous = await publish('concealneedle anonymous parent', {
      anonymous: true,
    });
    const trade = await publish('concealneedle trading parent', {
      trading: true,
    });
    const commentBatch = await readyDiscussionBatch(
      f,
      reader,
      { kind: 'comment', postId: post.id },
      1,
      [{ mime: 'image/png', bytes }],
    );
    const commentBody = await sealDiscussionBatch(
      f,
      reader,
      commentBatch.status,
      'concealneedle image comment',
    );
    const commentResponse = await request(http)
      .post(commentBody.path)
      .set('Authorization', auth())
      .send(commentBody.body);
    ok(commentResponse, 201);
    const commentId = commentResponse.body.resourceId as string;
    const replyBody = {
      clientRequestId: randomUUID(),
      text: 'concealneedle reply',
      imageAssetIds: [],
      authorMode: 'named' as const,
      targetReplyId: null,
    };
    await approveEnvelope(
      f.pool,
      await discussionApprovalEnvelope(
        f.app,
        f.pool,
        owner.accountId,
        post.id,
        replyBody,
        commentId,
      ),
    );
    const replyResponse = await request(http)
      .post(`/v1/community/comments/${commentId}/replies`)
      .set('Authorization', auth(owner))
      .send(replyBody);
    ok(replyResponse, 201);
    const replyId = replyResponse.body.resourceId as string;
    for (const actor of [owner, reader]) {
      ok(
        await request(http)
          .put(`/v1/community/posts/${post.id}/save`)
          .set('Authorization', auth(actor))
          .send({ clientRequestId: randomUUID() }),
      );
      ok(
        await request(http)
          .put(`/v1/community/posts/${post.id}/like`)
          .set('Authorization', auth(actor))
          .send({ requestId: randomUUID(), liked: true }),
      );
      ok(
        await request(http)
          .put(`/v1/community/comments/${commentId}/like`)
          .set('Authorization', auth(actor))
          .send({ clientRequestId: randomUUID() }),
      );
    }
    const ref = await get('/v1/me/public-profile-ref', owner);
    ok(ref);
    const profileId = ref.body.profileId as string;
    // Explicit independent local pin source and grant; no source acceptance or role
    // is inferred from owner visibility, current campus, or historical production.
    await withCommunityScopeWriter(f.pool, async (tx) => {
      const scopeId = randomUUID();
      await tx.query(
        "INSERT INTO whaleu_community.post_pin_scopes(id,space_id,kind,operating_region_id,source_reference,provenance,accepted_at,valid_until) VALUES($1,$2,'regional',$3,'synthetic:owner-visibility-pin','accepted',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')",
        [scopeId, f.scope.home.spaceId, f.scope.home.regionId],
      );
      await tx.query(
        "INSERT INTO whaleu_community.post_pin_history(scope_id,coverage,source_reference,accepted_at,valid_until) VALUES($1,'accepted_empty','synthetic:owner-visibility-empty-pins',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')",
        [scopeId],
      );
      await tx.query(
        "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,'school_admin',$3,$2,'synthetic:owner-visibility-pin')",
        [randomUUID(), admin.accountId, f.scope.home.regionId],
      );
    });
    const pinned = await request(http)
      .post('/v1/community/post-pin-commands')
      .set('Authorization', auth(admin))
      .send({
        clientRequestId: randomUUID(),
        operation: 'pin',
        postId: post.id,
      });
    ok(pinned);
    assert.equal(pinned.body.outcome, 'applied');
    ok(
      await request(http)
        .post('/v1/community/post-pin-commands')
        .set('Authorization', auth())
        .send({
          clientRequestId: randomUUID(),
          operation: 'read',
          postId: post.id,
          pinId: pinned.body.pinId,
        }),
    );
    const pinBefore = (await get(`/v1/community/posts/${post.id}/pin`)).body
      .pin;
    assert.equal(pinBefore.readState, 'read');
    const events = (
      await f.pool.query<{ id: string }>(
        "SELECT id FROM whaleu_community.outbox WHERE resource_id=ANY($1::uuid[]) AND event_type IN ('comment_created','reply_created')",
        [[commentId, replyId]],
      )
    ).rows.map((row) => row.id);
    const worker = new UpdatesWorker(
      f.app.get(DatabaseService),
      {
        ...f.app.get<RuntimeConfig>(APP_CONFIG),
        COMMUNITY_UPDATES_PROCESSING: 'manual_only',
      },
      f.app.get(CommunityUpdatesFacade),
      f.app.get(NotificationsRepository),
    );
    assert.ok(
      (await worker.run({ mode: 'apply', eventIds: events })).materialized >= 2,
    );
    const noticeBefore = await get('/v1/me/community/updates', owner);
    ok(noticeBefore);
    assert.ok(
      noticeBefore.body.items.some(
        (item: { status: string }) => item.status === 'available',
      ),
    );
    const bindings = (
      await f.pool.query<{ id: string; resource_id: string }>(
        'SELECT id,resource_id FROM whaleu_media.bindings WHERE resource_id=ANY($1::uuid[]) ORDER BY id',
        [[post.id, commentId]],
      )
    ).rows;
    assert.equal(bindings.length, 2);
    const bytePath = (id: string) => `/v1/media/bindings/${id}/display-v1`;
    const immutable = async () => {
      const rows: Record<string, unknown> = {};
      for (const [name, sql] of Object.entries({
        posts:
          'SELECT to_jsonb(p) row FROM whaleu_community.posts p WHERE id=ANY($1::uuid[]) ORDER BY id',
        approvals:
          "SELECT to_jsonb(a) row FROM whaleu_community.content_approval_decisions a WHERE envelope->>'text' LIKE 'concealneedle%' ORDER BY id",
        receipts:
          'SELECT to_jsonb(r) row FROM whaleu_community.publication_requests r ORDER BY account_id,client_request_id',
        outbox:
          'SELECT to_jsonb(o) row FROM whaleu_community.outbox o ORDER BY id',
        bindings:
          'SELECT to_jsonb(b) row FROM whaleu_media.bindings b ORDER BY id',
        cleanup:
          'SELECT to_jsonb(c) row FROM whaleu_media.cleanup_obligations c ORDER BY id',
      }))
        rows[name] = (
          await f.pool.query(
            sql,
            name === 'posts' ? [[post.id, anonymous.id, trade.id]] : [],
          )
        ).rows;
      return rows;
    };
    const before = await immutable();
    const settleHot = async () => {
      for (const id of [post.id, anonymous.id, trade.id]) {
        const subscription = (
          await f.pool.query<{ id: string }>(
            "SELECT o.id FROM whaleu_community.saved_obligations o JOIN whaleu_community.saved_epochs e ON e.id=o.epoch_id WHERE e.post_id=$1 AND o.action='save_ranking' ORDER BY CASE WHEN o.transition='saved' THEN e.started_sequence ELSE e.ended_sequence END",
            [id],
          )
        ).rows;
        for (const row of subscription)
          await inTransaction(f.pool, (tx) =>
            f.app
              .get(SubscriptionComponentSettlement)
              .process(row.id, tx, true),
          );
        for (const [table, service] of [
          ['like', f.app.get(LikeComponentSettlement)],
          ['comment', f.app.get(CommentComponentSettlement)],
        ] as const) {
          const sources = (
            await f.pool.query<{ id: string }>(
              `SELECT id FROM whaleu_post_hotness.${table}_sources WHERE post_id=$1 ORDER BY source_sequence`,
              [id],
            )
          ).rows;
          for (const row of sources)
            await inTransaction(f.pool, (tx) =>
              service.process(row.id, tx, true),
            );
        }
        assert.ok(
          ['current', 'refreshed'].includes(
            await f.app.get(HotScoreMaterializer).refresh(id),
          ),
        );
      }
    };
    await settleHot();
    const publicPages = async (actor = reader) => [
      await get('/v1/community/posts', actor).query({
        spaceId: f.scope.home.spaceId,
      }),
      await get('/v1/community/hot', actor).query({
        spaceId: f.scope.home.spaceId,
      }),
      await get('/v1/community/search', actor).query({
        spaceId: f.scope.home.spaceId,
        q: 'concealneedle',
        type: 'all',
      }),
      await get(`/v1/profiles/${profileId}/posts`, actor),
      await get(`/v1/profiles/${profileId}/trading`, actor),
      await get('/v1/me/community/saved', actor),
      await get('/v1/me/community/liked', actor),
      await get('/v1/community/post-pins', actor).query({
        spaceId: f.scope.home.spaceId,
      }),
    ];
    await t.test(
      'baseline has public text, descendants, counts, images and an independently read pin',
      async () => {
        for (const response of await publicPages()) {
          ok(response);
          assert.ok(
            response.body.items.length > 0,
            JSON.stringify(response.body),
          );
        }
        for (const binding of bindings) ok(await get(bytePath(binding.id)));
        const summary = await get(`/v1/profiles/${profileId}`);
        ok(summary);
        assert.equal(
          summary.body.postCount,
          1,
          'Anonymous post never joins public author history',
        );
        assert.equal(summary.body.tradeCount, 1);
        assert.equal(
          (await get('/v1/me/community/liked')).body.visibleLikedCount,
          2,
        );
      },
    );
    await t.test(
      'owner hide closes every public projection, including owner-visible pin/notice projections and child bytes',
      async () => {
        for (const id of [post.id, anonymous.id, trade.id])
          await setHidden(id, true);
        const ownDetail = await get(`/v1/community/posts/${post.id}`, owner);
        ok(ownDetail);
        assert.equal(ownDetail.body.id, post.id);
        assert.equal(ownDetail.body.images.length, 1);
        for (const actor of [owner, reader]) {
          for (const response of await publicPages(actor)) {
            ok(response);
            assert.deepEqual(
              response.body.items,
              [],
              JSON.stringify(response.body),
            );
          }
          const summary = await get(`/v1/profiles/${profileId}`, actor);
          ok(summary);
          assert.equal(summary.body.postCountStatus, 'known');
          assert.equal(summary.body.tradeCountStatus, 'known');
          assert.equal(summary.body.postCount, 0);
          assert.equal(summary.body.tradeCount, 0);
          const liked = await get('/v1/me/community/liked', actor);
          assert.equal(liked.body.visibleLikedCountStatus, 'known');
          assert.equal(liked.body.visibleLikedCount, 0);
          const pin = await get(`/v1/community/posts/${post.id}/pin`, actor);
          denied(pin);
          assert.equal(pin.body.error.code, 'POST_NOT_FOUND');
        }
        for (const path of [
          `/v1/community/posts/${post.id}`,
          `/v1/community/posts/${anonymous.id}`,
          `/v1/community/posts/${post.id}/comments`,
          `/v1/community/comments/${commentId}`,
          `/v1/community/comments/${commentId}/replies`,
          `/v1/community/replies/${replyId}`,
          `/v1/community/posts/${post.id}/discussion-context?replyId=${replyId}`,
        ])
          denied(await get(path));
        for (const binding of bindings) denied(await get(bytePath(binding.id)));
        for (const binding of bindings)
          ok(await get(bytePath(binding.id), owner));
        const privateComments = await get(
          `/v1/community/posts/${post.id}/comments`,
          owner,
        );
        ok(privateComments);
        assert.ok(
          privateComments.body.items.some(
            (item: { id: string }) => item.id === commentId,
          ),
        );
        const privateReplies = await get(
          `/v1/community/comments/${commentId}/replies`,
          owner,
        );
        ok(privateReplies);
        assert.ok(
          privateReplies.body.items.some(
            (item: { id: string }) => item.id === replyId,
          ),
        );
        ok(await get(`/v1/community/comments/${commentId}`, owner));
        ok(await get(`/v1/community/replies/${replyId}`, owner));
        const guest = await request(http)
          .get('/v1/community/posts')
          .query({ spaceId: f.scope.home.spaceId });
        ok(guest);
        assert.deepEqual(guest.body.items, []);
        const guestPins = await request(http)
          .get('/v1/community/post-pins')
          .query({ spaceId: f.scope.home.spaceId });
        ok(guestPins);
        assert.deepEqual(guestPins.body.items, []);
        const notices = await get('/v1/me/community/updates', owner);
        ok(notices);
        assert.equal(
          notices.body.unreadCount,
          noticeBefore.body.unreadCount,
          'Concealment does not forge read acknowledgements',
        );
        for (const item of notices.body.items) {
          assert.equal(item.status, 'unavailable');
          assert.deepEqual(Object.keys(item).sort(), [
            'createdAt',
            'noticeId',
            'readAt',
            'status',
          ]);
        }
        const slot = await get('/v1/community/post-pin-slot', admin).query({
          spaceId: f.scope.home.spaceId,
        });
        ok(slot);
        assert.equal(
          slot.body.pin.pinId,
          pinned.body.pinId,
          'Hidden post keeps the existing pin slot reservation',
        );
        const own = await get('/v1/me/community/posts', owner);
        ok(own);
        assert.equal(own.body.items.length, 3);
        for (const item of own.body.items) {
          assert.equal(item.ownerVisibility.ownerHidden, true);
          assert.equal('text' in item, false);
          assert.equal('accountId' in item, false);
          assert.equal('author' in item, false);
        }
        const anonymousState = await management(anonymous.id);
        ok(anonymousState);
        assert.deepEqual(Object.keys(anonymousState.body).sort(), [
          'canChange',
          'ownerHidden',
          'postId',
          'version',
        ]);
        ok(await management(anonymous.id, reader), 404);
        ok(await management(anonymous.id, admin), 404);
        assert.deepEqual(
          await immutable(),
          before,
          'Hide is no publication replay, detach, cleanup, review rewrite or moderation change',
        );
      },
    );
    await t.test(
      'restore preserves IDs, full retained binding set, unread ledger and exact pin/read identity',
      async () => {
        for (const id of [post.id, anonymous.id, trade.id])
          await setHidden(id, false);
        for (const response of await publicPages()) {
          ok(response);
          assert.ok(response.body.items.length > 0);
        }
        for (const binding of bindings) ok(await get(bytePath(binding.id)));
        assert.deepEqual(
          (await get(`/v1/community/posts/${post.id}/pin`)).body.pin,
          pinBefore,
        );
        const notices = await get('/v1/me/community/updates', owner);
        assert.equal(notices.body.unreadCount, noticeBefore.body.unreadCount);
        assert.deepEqual(notices.body.items, noticeBefore.body.items);
        const detail = await get(`/v1/community/posts/${anonymous.id}`);
        ok(detail);
        assert.equal(
          JSON.stringify(detail.body).includes(owner.accountId),
          false,
        );
        assert.deepEqual(await immutable(), before);
      },
    );
    await t.test(
      'owner-private reading never authorizes new positive participation under the concealed parent',
      async () => {
        await setHidden(post.id, true);
        const beforeWrites = await immutable();
        const rejected = (
          response: {
            status: number;
            body: { outcome?: string; code?: string };
          },
          status = 200,
        ) => {
          ok(response, status);
          assert.equal(
            response.body.outcome,
            'rejected',
            JSON.stringify(response.body),
          );
          assert.match(
            response.body.code ?? '',
            /^(POST|COMMENT|REPLY)_NOT_FOUND$/,
          );
        };
        for (const actor of [owner, reader]) {
          rejected(
            await request(http)
              .post(`/v1/community/posts/${post.id}/comments`)
              .set('Authorization', auth(actor))
              .send({
                clientRequestId: randomUUID(),
                text: 'No private-to-public comment escape',
                imageAssetIds: [],
                authorMode: 'named',
              }),
            201,
          );
          rejected(
            await request(http)
              .post(`/v1/community/comments/${commentId}/replies`)
              .set('Authorization', auth(actor))
              .send({
                clientRequestId: randomUUID(),
                text: 'No private-to-public reply escape',
                imageAssetIds: [],
                authorMode: 'named',
                targetReplyId: null,
              }),
            201,
          );
          rejected(
            await request(http)
              .put(`/v1/community/posts/${post.id}/like`)
              .set('Authorization', auth(actor))
              .send({ requestId: randomUUID(), liked: true }),
          );
          rejected(
            await request(http)
              .put(`/v1/community/posts/${post.id}/save`)
              .set('Authorization', auth(actor))
              .send({ clientRequestId: randomUUID() }),
          );
          rejected(
            await request(http)
              .put(`/v1/community/comments/${commentId}/like`)
              .set('Authorization', auth(actor))
              .send({ clientRequestId: randomUUID() }),
          );
        }
        denied(
          await request(http)
            .post('/v1/community/post-pin-commands')
            .set('Authorization', auth(admin))
            .send({
              clientRequestId: randomUUID(),
              operation: 'pin',
              postId: post.id,
            }),
        );
        const afterWrites = await immutable();
        for (const key of [
          'posts',
          'approvals',
          'outbox',
          'bindings',
          'cleanup',
        ])
          assert.deepEqual(afterWrites[key], beforeWrites[key], key);
        await setHidden(post.id, false);
      },
    );
    const appendMediaSafety = async (state: 'held' | 'allow') =>
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
          "INSERT INTO whaleu_media.asset_safety_events(id,asset_id,revision,state,manifest_digest,policy_revision,issuer,source_reference,provenance,effective_at,valid_until) VALUES($1,$2,$3,$4,$5,'media-static-v1','registered-synthetic-media',$6,'{}',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')",
          [
            event,
            assetId,
            revision,
            state,
            digest,
            `owner-visibility:${event}`,
          ],
        );
        await tx.query(
          'UPDATE whaleu_media.asset_safety_heads SET revision=$2,event_id=$3 WHERE asset_id=$1',
          [assetId, revision, event],
        );
      });
    await t.test(
      'owner management remains minimal and unhide cannot override current Review, moderation, source, block or Media gates',
      async () => {
        const cases = [
          {
            name: 'Review hold',
            hold: () =>
              setReviewState(f.pool, post.approval.decisionId, 'held'),
            release: () =>
              setReviewState(f.pool, post.approval.decisionId, 'allow'),
          },
          {
            name: 'moderation hidden',
            hold: () =>
              withCommunityScopeWriter(f.pool, (tx) =>
                tx.query(
                  "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
                  [post.id],
                ),
              ),
            release: () =>
              withCommunityScopeWriter(f.pool, (tx) =>
                tx.query(
                  "UPDATE whaleu_community.posts SET visibility='approved' WHERE id=$1",
                  [post.id],
                ),
              ),
          },
          {
            name: 'source withdrawal',
            hold: () =>
              withCommunityScopeWriter(f.pool, (tx) =>
                tx.query(
                  'UPDATE whaleu_community.spaces SET is_active=false WHERE id=$1',
                  [f.scope.home.spaceId],
                ),
              ),
            release: () =>
              withCommunityScopeWriter(f.pool, (tx) =>
                tx.query(
                  'UPDATE whaleu_community.spaces SET is_active=true WHERE id=$1',
                  [f.scope.home.spaceId],
                ),
              ),
          },
          {
            name: 'Media held',
            hold: () => appendMediaSafety('held'),
            release: () => appendMediaSafety('allow'),
          },
        ];
        for (const condition of cases) {
          await setHidden(post.id, true);
          await condition.hold();
          try {
            const state = await management(post.id);
            ok(state);
            assert.deepEqual(
              Object.keys(state.body).sort(),
              ['canChange', 'ownerHidden', 'postId', 'version'],
              condition.name,
            );
            await setHidden(post.id, false);
            denied(await get(`/v1/community/posts/${post.id}`));
            denied(await get(`/v1/community/posts/${post.id}`, owner));
            for (const binding of bindings)
              denied(await get(bytePath(binding.id)));
            denied(
              await get(
                bytePath(
                  bindings.find((binding) => binding.resource_id === post.id)!
                    .id,
                ),
                owner,
              ),
            );
          } finally {
            await condition.release();
          }
          ok(await get(`/v1/community/posts/${post.id}`));
        }
        const block = await request(http)
          .put('/v1/me/safety/blocks')
          .set('Authorization', auth())
          .send({
            clientRequestId: randomUUID(),
            source: { kind: 'post', id: post.id },
            blocked: true,
          });
        ok(block);
        await setHidden(post.id, true);
        await setHidden(post.id, false);
        denied(await get(`/v1/community/posts/${post.id}`));
        for (const binding of bindings) denied(await get(bytePath(binding.id)));
        const relationshipId = block.body.receipt.relationshipId as string;
        ok(
          await request(http)
            .put(`/v1/me/safety/blocks/${relationshipId}`)
            .set('Authorization', auth())
            .send({
              clientRequestId: randomUUID(),
              expectedRevision: block.body.current.revision,
              blocked: false,
            }),
        );
        ok(await get(`/v1/community/posts/${post.id}`));
      },
    );
    await t.test(
      'hide committed during exact storage open defeats final delivery and releases the same App Media pool',
      async () => {
        const original = f.storage.openExact.bind(f.storage);
        let intercepted = false;
        f.storage.openExact = async (...args) => {
          const opened = await original(...args);
          if (!intercepted) {
            intercepted = true;
            await setHidden(post.id, true);
          }
          return opened;
        };
        try {
          const response = await get(
            bytePath(
              bindings.find((binding) => binding.resource_id === post.id)!.id,
            ),
          );
          assert.equal(intercepted, true);
          denied(response);
        } finally {
          f.storage.openExact = original;
        }
        await setHidden(post.id, false);
        for (const binding of bindings) ok(await get(bytePath(binding.id)));
        const pool = f.app.get(MediaDeliveryBudgetPool);
        assert.equal(pool, mediaPool);
        // A received image does not prove the native file descriptor has closed.
        // Include earlier subtests and both restored reads, without changing the
        // real pool's release decisions, per-account limit or 64-credit bound.
        await mediaBudget.waitForQuiet();
        const leases: (() => void)[] = [];
        try {
          for (let i = 0; i < 64; i++)
            leases.push(pool.acquire(`owner-visibility:verified-quiet:${i}`));
        } finally {
          for (const release of leases) release();
        }
      },
    );
    await t.test(
      'deletion is independently terminal and recovery DTO cannot disclose deleted content',
      async () => {
        await setHidden(anonymous.id, true);
        const state = await management(anonymous.id);
        ok(state);
        ok(
          await request(http)
            .delete(`/v1/community/posts/${anonymous.id}`)
            .set('Authorization', auth(owner)),
          204,
        );
        const result = await request(http)
          .post(commandPath)
          .set('Authorization', auth(owner))
          .send({
            clientRequestId: randomUUID(),
            postId: anonymous.id,
            ownerHidden: false,
            expectedVersion: state.body.version,
          });
        if (result.status === 200) {
          assert.equal(result.body.outcome, 'rejected');
          assert.equal(result.body.code, 'POST_OWNER_VISIBILITY_UNAVAILABLE');
        } else denied(result);
        denied(await get(`/v1/community/posts/${anonymous.id}`, owner));
        const current = await management(anonymous.id);
        if (current.status === 200) {
          assert.equal(current.body.canChange, false);
          assert.equal('text' in current.body, false);
        } else ok(current, 404);
      },
    );
    await t.test(
      'hidden author detail cannot create view heat or consume detail cooldown, but original batches replay and a fresh restored visit counts',
      async () => {
        const epochs = new Map<string, string>();
        for (const actor of [owner, reader]) {
          const response = await request(http)
            .post(epochPath)
            .set('Authorization', auth(actor))
            .send({ version: 1 });
          ok(response);
          epochs.set(actor.accountId, response.body.epochId);
        }
        const report = (
          actor: typeof owner,
          body: ReturnType<typeof reportIntent>,
        ) =>
          request(http)
            .post(reportPath)
            .set('Authorization', auth(actor))
            .send(body);
        const originalList = reportIntent(epochs.get(owner.accountId)!, [
          post.id,
        ]);
        const originalDetail = reportIntent(
          epochs.get(reader.accountId)!,
          [post.id],
          'detail_visit',
        );
        const listReceipt = await report(owner, originalList),
          detailReceipt = await report(reader, originalDetail);
        ok(listReceipt);
        assertReceipt(listReceipt.body, originalList, 1);
        ok(detailReceipt);
        assertReceipt(detailReceipt.body, originalDetail, 1);
        const viewState = async () => ({
          count: (
            await f.pool.query<{ count: string }>(
              'SELECT count::text FROM whaleu_post_hotness.view_states WHERE post_id=$1',
              [post.id],
            )
          ).rows[0]!.count,
          cooldowns: (
            await f.pool.query(
              'SELECT account_id,post_id,next_allowed_at FROM whaleu_post_hotness.view_detail_cooldowns WHERE post_id=$1 ORDER BY account_id',
              [post.id],
            )
          ).rows,
        });
        const beforeHidden = await viewState();
        assert.equal(
          beforeHidden.cooldowns.some(
            (row) => row.account_id === owner.accountId,
          ),
          false,
        );
        await setHidden(post.id, true);
        ok(await get(`/v1/community/posts/${post.id}`, owner));
        for (const actor of [owner, reader]) {
          for (const kind of ['detail_visit', 'list_exposure'] as const) {
            const body = reportIntent(
              epochs.get(actor.accountId)!,
              [post.id],
              kind,
            );
            const response = await report(actor, body);
            ok(response);
            assertReceipt(response.body, body, 0);
            assert.deepEqual(
              await viewState(),
              beforeHidden,
              `${kind} cannot mutate hidden heat or cooldown`,
            );
          }
        }
        assert.deepEqual(
          (await report(owner, originalList)).body,
          listReceipt.body,
        );
        assert.deepEqual(
          (await report(reader, originalDetail)).body,
          detailReceipt.body,
        );
        assert.deepEqual(
          await viewState(),
          beforeHidden,
          'Original pre-hide replay does not apply its count again',
        );
        await setHidden(post.id, false);
        const restored = reportIntent(
          epochs.get(owner.accountId)!,
          [post.id],
          'detail_visit',
        );
        const fresh = await report(owner, restored);
        ok(fresh);
        assertReceipt(fresh.body, restored, 1);
        const afterRestore = await viewState();
        assert.equal(
          BigInt(afterRestore.count),
          BigInt(beforeHidden.count) + 1n,
        );
        assert.equal(
          afterRestore.cooldowns.some(
            (row) => row.account_id === owner.accountId,
          ),
          true,
        );
        assert.deepEqual(
          (await report(owner, originalList)).body,
          listReceipt.body,
        );
        assert.deepEqual(
          (await report(reader, originalDetail)).body,
          detailReceipt.body,
        );
        assert.deepEqual(await viewState(), afterRestore);
      },
    );
    await t.test(
      'hidden trading may resolve as negative cleanup but cannot freshly reopen; original close/open receipts never reapply',
      async () => {
        const path = `/v1/community/posts/${trade.id}/trading/resolution`;
        const change = (body: {
          clientRequestId: string;
          resolution: 'open' | 'resolved';
        }) =>
          request(http).post(path).set('Authorization', auth(owner)).send(body);
        const resolution = async () =>
          (
            await f.pool.query<{ resolution: string }>(
              'SELECT resolution FROM whaleu_community.trading_listings WHERE post_id=$1',
              [trade.id],
            )
          ).rows[0]!.resolution;
        const closeCommand = {
          clientRequestId: randomUUID(),
          resolution: 'resolved' as const,
        };
        const openCommand = {
          clientRequestId: randomUUID(),
          resolution: 'open' as const,
        };
        const closed = await change(closeCommand),
          opened = await change(openCommand);
        ok(closed, 201);
        assert.equal(closed.body.outcome, 'applied');
        ok(opened, 201);
        assert.equal(opened.body.outcome, 'applied');
        assert.equal(await resolution(), 'open');
        await setHidden(trade.id, true);
        const hiddenOpenDetail = await get(
          `/v1/community/posts/${trade.id}`,
          owner,
        );
        ok(hiddenOpenDetail);
        assert.equal(
          hiddenOpenDetail.body.trading.viewer.canSetResolution,
          true,
          'Private open listing still advertises permitted negative close',
        );
        assert.deepEqual((await change(closeCommand)).body, closed.body);
        assert.deepEqual((await change(openCommand)).body, opened.body);
        assert.equal(
          await resolution(),
          'open',
          'Replayed old close cannot alter the newer state',
        );
        const hiddenClose = {
          clientRequestId: randomUUID(),
          resolution: 'resolved' as const,
        };
        const cleanup = await change(hiddenClose);
        ok(cleanup, 201);
        assert.equal(cleanup.body.outcome, 'applied');
        assert.equal(await resolution(), 'resolved');
        const hiddenClosedDetail = await get(
          `/v1/community/posts/${trade.id}`,
          owner,
        );
        ok(hiddenClosedDetail);
        assert.equal(
          hiddenClosedDetail.body.trading.viewer.canSetResolution,
          false,
          'Private resolved listing cannot advertise a forbidden positive reopen',
        );
        const deniedOpen = {
          clientRequestId: randomUUID(),
          resolution: 'open' as const,
        };
        const rejected = await change(deniedOpen);
        ok(rejected, 201);
        assert.equal(rejected.body.outcome, 'rejected');
        assert.equal(rejected.body.code, 'POST_NOT_FOUND');
        assert.equal(await resolution(), 'resolved');
        for (const [command, receipt] of [
          [closeCommand, closed.body],
          [openCommand, opened.body],
          [hiddenClose, cleanup.body],
        ] as const) {
          assert.deepEqual((await change(command)).body, receipt);
          const recovery = await get(
            '/v1/me/community/trading-requests/' + command.clientRequestId,
            owner,
          );
          ok(recovery);
          assert.deepEqual(recovery.body, receipt);
          assert.equal(await resolution(), 'resolved');
        }
        await setHidden(trade.id, false);
        assert.deepEqual(
          (await change(deniedOpen)).body,
          rejected.body,
          'Restoration cannot rewrite an original terminal denial',
        );
        const fresh = await change({
          clientRequestId: randomUUID(),
          resolution: 'open',
        });
        ok(fresh, 201);
        assert.equal(fresh.body.outcome, 'applied');
        assert.equal(await resolution(), 'open');
        assert.deepEqual((await change(closeCommand)).body, closed.body);
        assert.equal(await resolution(), 'open');
      },
    );
    await t.test(
      'private hidden descendants cannot open fresh named/anonymous DMs, while original open receipts and existing PM bytes remain readable',
      async () => {
        // Same explicit synthetic local-inception facts as messagingRuntimeFixture.
        // No production coverage, peer grant, or historical population is inferred.
        await withCommunityScopeWriter(f.pool, async (tx) => {
          for (const actor of [owner, reader, admin]) {
            await tx.query(
              'INSERT INTO whaleu_profile.profiles(account_id) VALUES($1) ON CONFLICT DO NOTHING',
              [actor.accountId],
            );
            await tx.query(
              "INSERT INTO whaleu_messaging.coverage_heads(account_id,coverage,provenance,issuer,source_reference,policy_reference,effective_at,valid_until,revision) VALUES($1,'local','accepted','synthetic-dm-local','isolated-owner-visibility-inception','isolated-test-policy',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour',$2)",
              [actor.accountId, randomUUID()],
            );
          }
        });
        const publishPeerReply = async (
          actor: typeof owner,
          mode: 'named' | 'anonymous',
        ) => {
          const body = {
            clientRequestId: randomUUID(),
            text: `Owner visibility ${mode} peer reply`,
            imageAssetIds: [],
            authorMode: mode,
            targetReplyId: null,
          };
          await approveEnvelope(
            f.pool,
            await discussionApprovalEnvelope(
              f.app,
              f.pool,
              actor.accountId,
              post.id,
              body,
              commentId,
            ),
          );
          const response = await request(http)
            .post(`/v1/community/comments/${commentId}/replies`)
            .set('Authorization', auth(actor))
            .send(body);
          ok(response, 201);
          assert.equal(response.body.outcome, 'created');
          return response.body.resourceId as string;
        };
        const namedReply = await publishPeerReply(reader, 'named');
        const anonymousReply = await publishPeerReply(admin, 'anonymous');
        const commentEntry: DmEntry = {
          kind: 'comment',
          postId: post.id,
          commentId,
        };
        const namedEntry: DmEntry = {
          kind: 'reply',
          postId: post.id,
          rootCommentId: commentId,
          replyId: namedReply,
        };
        const anonymousEntry: DmEntry = {
          kind: 'reply',
          postId: post.id,
          rootCommentId: commentId,
          replyId: anonymousReply,
        };
        const dmOpen = (body: {
          clientRequestId: string;
          entry: DmEntry;
          initiationMode: 'named' | 'anonymous';
        }) =>
          request(http)
            .post('/v1/private-messages/conversations')
            .set('Authorization', auth(owner))
            .send(body);
        const originalOpen = {
          clientRequestId: randomUUID(),
          entry: commentEntry,
          initiationMode: 'named' as const,
        };
        const opened = await dmOpen(originalOpen);
        ok(opened);
        assert.equal(opened.body.outcome, 'applied');
        const conversationId = opened.body.conversationId as string;
        const conversation = (
          await f.pool.query<{
            account0: string;
            mode0: 'named' | 'anonymous';
            mode1: 'named' | 'anonymous';
            context_digest: string;
          }>(
            'SELECT account0,mode0,mode1,context_digest FROM whaleu_messaging.conversations WHERE id=$1',
            [conversationId],
          )
        ).rows[0]!;
        const message = {
          clientRequestId: randomUUID(),
          text: 'Existing private conversation survives parent concealment',
        };
        await approveDm(
          f.pool,
          canonicalDmEnvelope({
            version: 1,
            purpose: 'send_private_message',
            accountId: owner.accountId,
            clientRequestId: message.clientRequestId,
            conversationId,
            contextDigest: conversation.context_digest,
            senderSlot: conversation.account0 === owner.accountId ? 0 : 1,
            participantModes: [conversation.mode0, conversation.mode1],
            text: message.text,
            assetIds: [],
          }),
        );
        const sent = await request(http)
          .post(`/v1/private-messages/conversations/${conversationId}/messages`)
          .set('Authorization', auth(owner))
          .send(message);
        ok(sent);
        assert.equal(sent.body.outcome, 'applied');
        const snapshots = async () => ({
          conversations: (
            await f.pool.query(
              'SELECT to_jsonb(c) value FROM whaleu_messaging.conversations c ORDER BY id',
            )
          ).rows,
          personas: (
            await f.pool.query(
              'SELECT to_jsonb(p) value FROM whaleu_community.thread_personas p WHERE post_id=$1 ORDER BY account_id',
              [post.id],
            )
          ).rows,
        });
        const beforeHidden = await snapshots();
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_community.thread_personas WHERE post_id=$1 AND account_id=$2',
              [post.id, owner.accountId],
            )
          ).rowCount,
          0,
        );
        await setHidden(post.id, true);
        for (const id of [namedReply, anonymousReply])
          ok(await get(`/v1/community/replies/${id}`, owner));
        for (const [entry, initiationMode] of [
          [commentEntry, 'named'],
          [namedEntry, 'named'],
          [anonymousEntry, 'anonymous'],
        ] as const) {
          const response = await dmOpen({
            clientRequestId: randomUUID(),
            entry,
            initiationMode,
          });
          ok(response);
          assert.equal(response.body.outcome, 'rejected');
          assert.equal(response.body.code, 'DM_ENTRY_UNAVAILABLE');
          assert.deepEqual(
            await snapshots(),
            beforeHidden,
            'Fresh hidden-source open cannot materialize conversation or actor persona',
          );
        }
        assert.deepEqual((await dmOpen(originalOpen)).body, opened.body);
        const recovered = await get(
          '/v1/private-messages/requests/' + originalOpen.clientRequestId,
          owner,
        );
        ok(recovered);
        assert.deepEqual(recovered.body, opened.body);
        for (const actor of [owner, reader]) {
          ok(
            await get(
              `/v1/private-messages/conversations/${conversationId}`,
              actor,
            ),
          );
          const history = await get(
            `/v1/private-messages/conversations/${conversationId}/messages`,
            actor,
          );
          ok(history);
          assert.ok(
            history.body.items.some(
              (item: { id: string; state: string; text: string | null }) =>
                item.id === sent.body.messageId &&
                item.state === 'text' &&
                item.text === message.text,
            ),
          );
        }
        assert.deepEqual(await snapshots(), beforeHidden);
        await setHidden(post.id, false);
        const restoredAnonymous = await dmOpen({
          clientRequestId: randomUUID(),
          entry: anonymousEntry,
          initiationMode: 'anonymous',
        });
        ok(restoredAnonymous);
        assert.equal(restoredAnonymous.body.outcome, 'applied');
        assert.notEqual(restoredAnonymous.body.conversationId, conversationId);
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_community.thread_personas WHERE post_id=$1 AND account_id=$2',
              [post.id, owner.accountId],
            )
          ).rowCount,
          1,
          'The same independently eligible anonymous source can materialize a persona only after restore',
        );
      },
    );
  },
);
