/** Real PostgreSQL acceptance source. Run only under the parent's exclusive
 * database lease. C1 sources/Review8/releases and all 2,048 target chains are
 * genuine; only external acceptance, object storage and entropy are synthetic. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import request from 'supertest';
import {
  categoryIconScaleFixture,
  setCategoryScaleAssetState,
} from '../support/category-icon-scale-fixture.js';
import { categoryIconHttpOk } from '../support/category-icon-management-fixtures.js';
import { assertCategoryDigestAcceptance } from '../support/category-digest-acceptance.js';
import {
  scopedCommandContext,
  scopedCommandRoute,
  scopedSuccess,
} from '../support/rating-scoped-command-fixture.js';
import { setRatingReviewState } from '../support/rating-runtime-fixture.js';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import { canonicalRatingScopedEnvelope } from '../../src/community/content-review/rating-scoped-contracts.js';
import { RatingRandomDraw } from '../../src/ratings/random/draw.js';
import { RatingScopedRepository } from '../../src/ratings/scoped/repository.js';
import { RatingScopedCommands } from '../../src/ratings/scoped/commands.service.js';
import {
  ratingScopedContextSchema,
  ratingScopedIntentSchema,
  ratingScopedPreparationSchema,
  type RatingScopedContext,
  type RatingScopedIntent,
} from '../../src/ratings/scoped/contracts.js';
import { APP_CONFIG, type RuntimeConfig } from '../../src/config/config.js';
import { DatabaseService } from '../../src/database/database.js';
import { RatingsUpdatesSourceFacade } from '../../src/ratings/updates-source/facade.js';
import { RatingUpdatesProjectionFacade } from '../../src/ratings/updates-source/projection.js';
import { RatingUpdatesRepository } from '../../src/notifications/ratings/repository.js';
import { RatingUpdatesWorker } from '../../src/notifications/ratings/worker.js';
import { RatingsSubscriptionUpdatesSourceFacade } from '../../src/ratings/updates-source/subscription-facade.js';
import { RatingSubscriptionUpdatesProjectionFacade } from '../../src/ratings/updates-source/subscription-projection.js';
import { RatingSubscriptionUpdatesRepository } from '../../src/notifications/ratings/subscription-repository.js';
import { RatingSubscriptionUpdatesWorker } from '../../src/notifications/ratings/subscription-worker.js';
import {
  ratingScopedNoticePageSchema,
  type RatingScopedNoticeKind,
} from '../../src/ratings/scoped/notice.service.js';

function unavailable(response: {
  status: number;
  body: Record<string, unknown>;
}) {
  if (response.status === 200) {
    assert.ok(
      response.body['status'] === 'unavailable' ||
        response.body['outcome'] === 'closed',
      JSON.stringify(response.body),
    );
  } else {
    const error = response.body['error'] as { code?: string } | undefined;
    assert.ok(
      [
        'RATING_UNAVAILABLE',
        'RATING_SCOPE_UNAVAILABLE',
        'RATING_SCOPED_CONTEXT_CHANGED',
        'RATING_SCOPE_DENIED',
        'RATING_NOT_FOUND',
        'CONTENT_REVIEW_UNAVAILABLE',
        'MEDIA_UNAVAILABLE',
      ].includes(error?.code ?? ''),
      JSON.stringify(response.body),
    );
  }
  assert.equal(
    response.body['candidateCount'],
    undefined,
    'An unknown complete pool cannot become zero or a smaller pool',
  );
  assert.equal(
    response.body['count'],
    undefined,
    'Unknown optional count cannot be represented as zero',
  );
  assert.equal(response.body['item'], undefined);
}

test(
  'C1 1001/2048 real multi-campus random pools and original auxiliary intents qualify every current ancestor icon',
  { timeout: 900000 },
  async (t) => {
    const fixtureStarted = performance.now();
    const f = await categoryIconScaleFixture();
    t.after(() => f.close());
    const digestFacts = await assertCategoryDigestAcceptance(f.pool);
    assert.equal(digestFacts.largest_membership, 2048);
    t.diagnostic(
      `Real 1001/2048 fixture and original C1 publications: ${Math.round(performance.now() - fixtureStarted)} ms; unchanged 15s SQL limit`,
    );
    const owner = f.creator,
      reader = await f.actor(),
      target = f.targets.find((row) => row.categoryId === f.childId)!;
    type Actor = typeof owner;
    const query = (context: RatingScopedContext) => ({
      contextId: context.id,
      contextToken: context.token,
    });
    const context = (
      actor: Actor = reader,
      purpose: 'read' | 'interact' = 'read',
    ) => f.scopedContext(actor, f.selector, purpose);
    const read = async (
      path: string,
      actor: Actor = reader,
      current?: RatingScopedContext,
    ) =>
      f
        .auth(request(f.http).get(path), actor)
        .query(query(current ?? (await context(actor))));
    const path = `/v2/ratings/targets/${target.id}`;
    const sourceCounts = (
      await f.pool.query(`SELECT
        (SELECT count(*)::int FROM whaleu_ratings.targets) targets,
        (SELECT count(*)::int FROM whaleu_ratings.target_sources WHERE origin='new_native' AND coverage='complete') sources,
        (SELECT count(*)::int FROM whaleu_ratings.score_baselines) baselines,
        (SELECT count(*)::int FROM whaleu_ratings.target_definition_heads WHERE content_version=1) definitions,
        (SELECT count(*)::int FROM whaleu_community.rating_approval_bindings WHERE kind='target' AND envelope_version=1) reviews,
        (SELECT count(*)::int FROM whaleu_ratings.scoped_target_memberships m JOIN whaleu_ratings.scoped_catalog_heads h ON h.catalog_id=m.catalog_id) paths,
        (SELECT count(*)::int FROM whaleu_ratings.scoped_source_attestations WHERE source_kind='legacy_adoption') legacy_adoptions,
        (SELECT count(*)::int FROM whaleu_ratings.category_icon_review_bindings) icon_reviews`)
    ).rows[0];
    assert.deepEqual(sourceCounts, {
      targets: 2048,
      sources: 2048,
      baselines: 2048,
      definitions: 2048,
      reviews: 2048,
      paths: 4096,
      legacy_adoptions: 0,
      icon_reviews: 8,
    });
    const carry = (
      await f.pool.query<{
        category_id: string;
        scope_key: string;
        appearance_id: string | null;
        review_binding_id: string;
        decision_id: string;
        release_id: string;
        original_release: string;
      }>(
        `SELECT p.category_id,h.scope_key,p.appearance_id,p.review_binding_id,b.decision_id,
           p.release_id,c.release_id original_release
         FROM whaleu_ratings.scoped_catalog_heads h JOIN whaleu_ratings.scoped_catalogs c ON c.id=h.catalog_id
         JOIN whaleu_ratings.category_icon_projections p ON(p.catalog_id,p.release_id)=(c.id,c.release_id)
         JOIN whaleu_ratings.category_icon_review_bindings b ON b.id=p.review_binding_id
         ORDER BY h.scope_key,p.category_id`,
      )
    ).rows;
    assert.equal(carry.length, 6);
    assert.ok(carry.every((row) => row.release_id === row.original_release));
    assert.deepEqual(
      carry.map((row) => row.decision_id).sort(),
      f.iconApprovals.map((approval) => approval.decisionId).sort(),
      'The original source publisher carries all exact current campus Review8 decisions without rebinding',
    );
    assert.notEqual(carry[0]!.release_id, f.beforeCarryReleaseId);
    const rootAppearances = carry
      .filter((row) => row.category_id === f.rootId)
      .map((row) => row.appearance_id);
    assert.equal(rootAppearances.length, 2);
    assert.ok(rootAppearances[0]);
    assert.equal(
      new Set(rootAppearances).size,
      1,
      'Both campuses inherit one genuine base appearance',
    );
    assert.ok(
      carry
        .filter((row) => row.category_id === f.childId)
        .every((row) => row.appearance_id === null),
    );

    t.beforeEach(async () => {
      // Let the real shared request throttle expire, never reset its counters.
      const row = (
        await f.pool.query<{ wait: number }>(
          `SELECT coalesce(max(greatest(0,extract(epoch FROM
          greatest(expires_at,coalesce(blocked_until,expires_at))-clock_timestamp())*1000)),0)::double precision wait
         FROM whaleu_runtime.request_throttle_counters WHERE total_hits>=65`,
        )
      ).rows[0]!;
      if (row.wait > 0) await delay(Math.ceil(row.wait) + 25);
    });

    const randomContext = async (campusId = f.campusA) => {
      const response = await f.requestScopedContext(reader, {
        purpose: 'random',
        mode: 'public',
        selector: { kind: 'institution_with_global', anchorCampusId: campusId },
      });
      categoryIconHttpOk(response);
      return ratingScopedContextSchema.parse(response.body);
    };
    const sample = (current: RatingScopedContext, categoryId = f.rootId) =>
      f
        .auth(request(f.http).get('/v2/ratings/random-target'), reader)
        .query({ ...query(current), categoryId });
    const draw = f.app.get(RatingRandomDraw),
      originalDraw = draw.index;
    let drawCalls = 0;
    draw.index = (size: number) => {
      drawCalls++;
      const ids = f.targets
        .filter((row) => size === 2048 || row.categoryId === f.childId)
        .map((row) => row.id)
        .sort((a, b) => a.localeCompare(b));
      assert.equal(
        ids.length,
        size,
        'Entropy sees the entire distinct target set',
      );
      const index = ids.indexOf(target.id);
      assert.ok(index >= 0);
      return index;
    };
    t.after(() => {
      draw.index = originalDraw;
    });

    await t.test(
      'all 4096 paths are scanned before one draw; child has exactly 1001 and parent exactly 2048 candidates',
      async () => {
        const repository = f.app.get(RatingScopedRepository),
          next = repository.nextPool,
          complete = repository.completePool;
        let paths = 0,
          batches = 0,
          terminal = 0;
        repository.nextPool = async function (
          ...args: Parameters<typeof next>
        ) {
          const result = await next.apply(this, args);
          paths += result.items.length;
          batches++;
          if (result.done) terminal++;
          return result;
        };
        repository.completePool = async function (
          ...args: Parameters<typeof complete>
        ) {
          const result = await complete.apply(this, args);
          assert.deepEqual(result, {
            categoryFound: true,
            pathCount: 4096,
            targetCount: 2048,
          });
          return result;
        };
        try {
          const current = await randomContext();
          drawCalls = 0;
          const result = await sample(current);
          categoryIconHttpOk(result);
          assert.equal(result.body.candidateCount, 2048);
          assert.equal(result.body.item.target.id, target.id);
          assert.deepEqual(result.body.item.locator.selector, f.selector);
          assert.equal(paths, 4096);
          assert.equal(
            batches,
            33,
            'The exact 128-row boundary requires the final empty continuation',
          );
          assert.equal(terminal, 1);
          assert.equal(drawCalls, 1);
        } finally {
          repository.nextPool = next;
          repository.completePool = complete;
        }
        const child = await sample(await randomContext(), f.childId);
        categoryIconHttpOk(child);
        assert.equal(child.body.candidateCount, 1001);
        assert.equal(child.body.item.target.categoryId, f.childId);
        const other = await sample(await randomContext(f.campusB));
        categoryIconHttpOk(other);
        assert.equal(other.body.candidateCount, 2048);
        assert.deepEqual(other.body.item.locator.selector, {
          kind: 'campus',
          campusId: f.campusB,
        });
      },
    );

    await t.test(
      'unknown icon on an unselected sibling aborts the full pool before entropy, never shrinking 2048 to 1001',
      async () => {
        const current = await randomContext();
        await setCategoryScaleAssetState(
          f,
          f.siblingUpload.status.assetId,
          'unknown',
        );
        try {
          drawCalls = 0;
          unavailable(await sample(current));
          assert.equal(
            drawCalls,
            0,
            'A bad unselected category must be checked before drawing',
          );
          const healthyChild = await sample(await randomContext(), f.childId);
          categoryIconHttpOk(healthyChild);
          assert.equal(
            healthyChild.body.candidateCount,
            1001,
            'The sibling failure does not fabricate an ancestor failure',
          );
        } finally {
          await setCategoryScaleAssetState(
            f,
            f.siblingUpload.status.assetId,
            'allow',
          );
        }
        const restored = await sample(await randomContext());
        categoryIconHttpOk(restored);
        assert.equal(restored.body.candidateCount, 2048);
      },
    );

    await t.test(
      'held exact Review8 for an unselected campus path invalidates every full-pool answer',
      async () => {
        const approval = f.iconApprovals.find(
          (item) =>
            item.envelope.content.categoryId === f.siblingId &&
            item.envelope.content.selector.kind === 'campus' &&
            item.envelope.content.selector.campusId === f.campusB,
        );
        assert.ok(approval);
        const current = await randomContext(f.campusA);
        await setRatingReviewState(f.pool, approval.decisionId, 'held');
        try {
          drawCalls = 0;
          unavailable(await sample(current));
          assert.equal(
            drawCalls,
            0,
            'Even the non-anchor campus negative fact must precede entropy',
          );
        } finally {
          await setRatingReviewState(f.pool, approval.decisionId, 'allow');
        }
        const restored = await sample(await randomContext());
        categoryIconHttpOk(restored);
        assert.equal(restored.body.candidateCount, 2048);
      },
    );

    const commands = f.app.get(RatingScopedCommands);
    const intent = async (
      actor: Actor,
      operation: RatingScopedIntent['operation'],
      payload: Record<string, unknown>,
    ) => {
      const current = await context(actor, 'interact');
      const category = (
        await f.pool.query<{ effective_revision: string }>(
          'SELECT effective_revision FROM whaleu_ratings.scoped_categories WHERE catalog_id=$1 AND category_id=$2',
          [current.heads[0]!.catalogRevision, f.childId],
        )
      ).rows[0];
      assert.ok(category);
      return ratingScopedIntentSchema.parse({
        protocolVersion: 2,
        operation,
        context: scopedCommandContext(current),
        payload: {
          clientRequestId: randomUUID(),
          categoryId: f.childId,
          expectedCategoryRevision: category.effective_revision,
          targetId: target.id,
          expectedTargetRevision: target.revision,
          ...payload,
        },
      });
    };
    const send = (actor: Actor, input: RatingScopedIntent) => {
      const route = scopedCommandRoute(input);
      return f
        .auth(request(f.http)[route.method](route.path), actor)
        .send(input);
    };
    const approve = async (actor: Actor, input: RatingScopedIntent) => {
      ratingScopedPreparationSchema.parse(
        await commands.prepare(actor.accessToken, input),
      );
      const row = (
        await f.pool.query<{ envelope: unknown }>(
          'SELECT envelope FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2',
          [actor.accountId, input.payload.clientRequestId],
        )
      ).rows[0];
      assert.ok(
        row?.envelope,
        'Approve only the real persisted auxiliary preparation',
      );
      await f.approveScoped(canonicalRatingScopedEnvelope(row.envelope));
    };
    const execute = async (
      actor: Actor,
      operation: RatingScopedIntent['operation'],
      payload: Record<string, unknown>,
    ) => {
      const input = await intent(actor, operation, payload);
      if (
        operation === 'create_comment_scoped' ||
        operation === 'create_reply_scoped'
      )
        await approve(actor, input);
      const response = await send(actor, input);
      categoryIconHttpOk(response);
      const receipt = scopedSuccess(response.body);
      assert.equal(receipt.protocolVersion, 2);
      assert.doesNotMatch(
        canonicalJson(receipt),
        /"(?:icon|appearanceId|manifest|contextToken|url)"/,
      );
      return { input, response, receipt };
    };

    // Shared prerequisites must succeed before any negative test can use them.
    const score = await execute(reader, 'set_score_scoped', {
      expectedRevision: null,
      score: 4,
    });
    const beforeSubscription = await read(`${path}/subscription`);
    categoryIconHttpOk(beforeSubscription);
    assert.equal(beforeSubscription.body.status, 'known');
    const subscription = await execute(
      reader,
      'set_target_subscription_scoped',
      {
        expectedSubscriptionRevision: beforeSubscription.body.revision,
        subscribed: true,
      },
    );
    const comment = await execute(owner, 'create_comment_scoped', {
      authorMode: 'named',
      body: 'Original protocol2 comment beneath a C1 ancestor icon',
      assetIds: [],
    });
    const rootId = String(comment.receipt.result['subjectId']),
      rootRevision = String(comment.receipt.result['revision']);
    const reply = await execute(reader, 'create_reply_scoped', {
      rootId,
      expectedRootRevision: rootRevision,
      replyTo: null,
      authorMode: 'named',
      body: 'Original protocol2 reply beneath a C1 ancestor icon',
      assetIds: [],
    });
    const replyId = String(reply.receipt.result['replyId']),
      replyRevision = String(reply.receipt.result['revision']);
    const beforeLike = await read(`/v2/ratings/comments/${rootId}/like`);
    categoryIconHttpOk(beforeLike);
    const liked = await execute(reader, 'set_comment_like_scoped', {
      rootId,
      expectedRevision: rootRevision,
      expectedLikeRevision: beforeLike.body.revision,
      liked: true,
    });
    const beforeReplyLike = await read(
      `/v2/ratings/replies/${replyId}/like`,
      owner,
    );
    categoryIconHttpOk(beforeReplyLike);
    const replyLiked = await execute(owner, 'set_reply_like_scoped', {
      rootId,
      replyId,
      expectedRootRevision: rootRevision,
      expectedRevision: replyRevision,
      expectedLikeRevision: beforeReplyLike.body.revision,
      liked: true,
    });
    const auxiliaryPaths = [
      path,
      `${path}/my-score`,
      `${path}/score-summary`,
      `${path}/comments`,
      `${path}/subscription`,
      `/v2/ratings/comments/${rootId}`,
      `/v2/ratings/comments/${rootId}/discussion`,
      `/v2/ratings/comments/${rootId}/replies`,
      `/v2/ratings/comments/${rootId}/like`,
      `/v2/ratings/replies/${replyId}`,
      `/v2/ratings/replies/${replyId}/position`,
      `/v2/ratings/replies/${replyId}/like`,
      '/v2/ratings/subscriptions',
    ];

    const config = {
      ...f.app.get<RuntimeConfig>(APP_CONFIG),
      RATINGS_UPDATES_PROCESSING: 'manual' as const,
    };
    const directWorker = new RatingUpdatesWorker(
      f.app.get(DatabaseService),
      config,
      f.app.get(RatingsUpdatesSourceFacade),
      f.app.get(RatingUpdatesProjectionFacade),
      f.app.get(RatingUpdatesRepository),
    );
    const subscriptionWorker = new RatingSubscriptionUpdatesWorker(
      f.app.get(DatabaseService),
      config,
      f.app.get(RatingsSubscriptionUpdatesSourceFacade),
      f.app.get(RatingSubscriptionUpdatesProjectionFacade),
      f.app.get(RatingSubscriptionUpdatesRepository),
    );
    const event = async (actor: Actor, input: RatingScopedIntent) => {
      const rows = (
        await f.pool.query<{ id: string }>(
          'SELECT id FROM whaleu_ratings.effect_events WHERE actor_account_id=$1 AND request_id=$2',
          [actor.accountId, input.payload.clientRequestId],
        )
      ).rows;
      assert.equal(rows.length, 1);
      return rows[0]!.id;
    };
    const rootEvent = await event(owner, comment.input),
      replyEvent = await event(reader, reply.input),
      likeEvent = await event(reader, liked.input);
    const noticeRows = async () =>
      (
        await f.pool.query<{
          id: string;
          kind: RatingScopedNoticeKind;
          recipient: string;
          read_at: Date | null;
        }>(`SELECT id,CASE kind WHEN 'like' THEN 'like-updates' ELSE 'updates' END kind,
        recipient_account_id recipient,read_at FROM whaleu_notifications.rating_notices
      UNION ALL SELECT id,'subscription-updates',recipient_account_id,read_at
        FROM whaleu_notifications.rating_subscription_notices ORDER BY id`)
      ).rows;

    await t.test(
      'unknown ancestor leaves captured update obligations retryable; the same effects materialize after recovery',
      async () => {
        await setCategoryScaleAssetState(
          f,
          f.rootUpload.status.assetId,
          'unknown',
        );
        try {
          const direct = await directWorker.run({
            mode: 'apply',
            eventIds: [replyEvent, likeEvent],
          });
          const subscriptions = await subscriptionWorker.run({
            mode: 'apply',
            eventIds: [rootEvent],
          });
          assert.equal(direct.materialized, 0, JSON.stringify(direct));
          assert.equal(
            subscriptions.materialized,
            0,
            JSON.stringify(subscriptions),
          );
          assert.equal(direct.retryable, 2, JSON.stringify(direct));
          assert.equal(
            subscriptions.retryable,
            1,
            JSON.stringify(subscriptions),
          );
          assert.deepEqual(await noticeRows(), []);
        } finally {
          await setCategoryScaleAssetState(
            f,
            f.rootUpload.status.assetId,
            'allow',
          );
        }
        const nextAttempt = (
          await f.pool.query<{ remaining: number }>(
            `SELECT coalesce(greatest(0,extract(epoch FROM (max(next_attempt_at)-clock_timestamp()))*1000),0)::double precision remaining
         FROM whaleu_notifications.rating_subscription_recipient_work WHERE event_id=$1 AND status='retry'`,
            [rootEvent],
          )
        ).rows[0]!.remaining;
        assert.ok(
          nextAttempt >= 0 && nextAttempt <= 5000,
          'Use the original persisted five-second retry deadline',
        );
        if (nextAttempt > 0) await delay(Math.ceil(nextAttempt) + 25);
        const direct = await directWorker.run({
          mode: 'apply',
          eventIds: [replyEvent, likeEvent],
        });
        const subscriptions = await subscriptionWorker.run({
          mode: 'apply',
          eventIds: [rootEvent],
        });
        assert.equal(direct.failed, 0, JSON.stringify(direct));
        assert.equal(direct.materialized, 2, JSON.stringify(direct));
        assert.equal(subscriptions.failed, 0, JSON.stringify(subscriptions));
        assert.equal(
          subscriptions.materialized,
          1,
          JSON.stringify(subscriptions),
        );
        assert.equal((await noticeRows()).length, 3);
      },
    );

    await t.test(
      'healthy descendant keeps original target, score/comment/reply/like/subscription and notice contracts',
      async () => {
        const current = await context();
        for (const endpoint of auxiliaryPaths)
          categoryIconHttpOk(await read(endpoint, reader, current));
        const summary = await read(`${path}/score-summary`, reader, current);
        assert.equal(summary.body.status, 'known');
        assert.equal(summary.body.count, 1);
        const subscribed = await read(`${path}/subscription`, reader, current);
        assert.equal(subscribed.body.count, 1);
        assert.equal(subscribed.body.subscribed, true);
        const cards = await read('/v2/ratings/subscriptions', reader, current);
        assert.deepEqual(
          cards.body.items.map((item: { id: string }) => item.id),
          [target.id],
        );
        for (const row of await noticeRows()) {
          const actor = row.recipient === owner.accountId ? owner : reader;
          const response = await read(
            `/v2/me/ratings/${row.kind}/${row.id}/target`,
            actor,
          );
          categoryIconHttpOk(response);
          assert.equal(response.body.status, 'available');
          assert.equal(response.body.target.targetId, target.id);
          assert.deepEqual(response.body.target.selector, f.selector);
        }
      },
    );

    const originalRecovery = async () => {
      const response = await send(reader, score.input);
      categoryIconHttpOk(response);
      assert.equal(
        canonicalJson(response.body),
        canonicalJson(score.response.body),
      );
      const status = await f.auth(
        request(f.http).get(
          `/v2/ratings/requests/${score.input.payload.clientRequestId}`,
        ),
        reader,
      );
      categoryIconHttpOk(status);
      assert.equal(
        canonicalJson(status.body),
        canonicalJson(score.response.body),
      );
    };
    const interactionState = async () =>
      (
        await f.pool.query<{ state: unknown }>(
          `SELECT jsonb_build_object(
        'scores',(SELECT jsonb_agg(to_jsonb(s)) FROM whaleu_ratings.scores s WHERE target_id=$1),
        'comments',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM whaleu_ratings.comments c WHERE target_id=$1),
        'replies',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM whaleu_ratings.replies r WHERE target_id=$1),
        'subscriptions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY account_id) FROM whaleu_ratings.subscription_memberships s WHERE target_id=$1),
        'likes',(SELECT jsonb_agg(to_jsonb(m) ORDER BY subject_id,account_id) FROM whaleu_ratings.like_memberships m
          WHERE subject_id IN (SELECT id FROM whaleu_ratings.comments WHERE target_id=$1
            UNION ALL SELECT id FROM whaleu_ratings.replies WHERE target_id=$1)),
        'effects',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM whaleu_ratings.effect_events e WHERE target_id=$1)) state`,
          [target.id],
        )
      ).rows[0]!.state;
    const fresh = async () => {
      const items = [
        {
          actor: reader,
          input: await intent(reader, 'set_score_scoped', {
            expectedRevision: score.receipt.result['revision'],
            score: 5,
          }),
        },
        {
          actor: reader,
          input: await intent(reader, 'set_score_scoped', {
            expectedRevision: score.receipt.result['revision'],
            score: 4,
          }),
        },
        {
          actor: reader,
          input: await intent(reader, 'set_comment_like_scoped', {
            rootId,
            expectedRevision: rootRevision,
            expectedLikeRevision: liked.receipt.result['revision'],
            liked: false,
          }),
        },
        {
          actor: owner,
          input: await intent(owner, 'set_reply_like_scoped', {
            rootId,
            replyId,
            expectedRootRevision: rootRevision,
            expectedRevision: replyRevision,
            expectedLikeRevision: replyLiked.receipt.result['revision'],
            liked: false,
          }),
        },
        {
          actor: reader,
          input: await intent(reader, 'set_target_subscription_scoped', {
            expectedSubscriptionRevision:
              subscription.receipt.result['revision'],
            subscribed: false,
          }),
        },
        {
          actor: reader,
          input: await intent(reader, 'set_target_subscription_scoped', {
            expectedSubscriptionRevision:
              subscription.receipt.result['revision'],
            subscribed: true,
          }),
        },
        {
          actor: reader,
          input: await intent(reader, 'set_comment_like_scoped', {
            rootId,
            expectedRevision: rootRevision,
            expectedLikeRevision: liked.receipt.result['revision'],
            liked: true,
          }),
        },
        {
          actor: owner,
          input: await intent(owner, 'set_reply_like_scoped', {
            rootId,
            replyId,
            expectedRootRevision: rootRevision,
            expectedRevision: replyRevision,
            expectedLikeRevision: replyLiked.receipt.result['revision'],
            liked: true,
          }),
        },
        {
          actor: owner,
          input: await intent(owner, 'create_comment_scoped', {
            authorMode: 'named',
            body: 'Prepared before ancestor icon became unknown',
            assetIds: [],
          }),
        },
        {
          actor: reader,
          input: await intent(reader, 'create_reply_scoped', {
            rootId,
            expectedRootRevision: rootRevision,
            replyTo: null,
            authorMode: 'named',
            body: 'Prepared reply before ancestor icon became unknown',
            assetIds: [],
          }),
        },
      ];
      for (const item of items) {
        if (
          item.input.operation === 'create_comment_scoped' ||
          item.input.operation === 'create_reply_scoped'
        )
          await approve(item.actor, item.input);
        else
          ratingScopedPreparationSchema.parse(
            await commands.prepare(item.actor.accessToken, item.input),
          );
      }
      assert.equal(
        (
          await f.pool.query<{ count: number }>(
            'SELECT count(*)::int count FROM whaleu_ratings.scoped_command_preparations WHERE request_id=ANY($1::uuid[])',
            [items.map((item) => item.input.payload.clientRequestId)],
          )
        ).rows[0]!.count,
        items.length,
        'Every mutation and noop intent must reuse a real persisted owner preparation',
      );
      return items;
    };

    for (const blockedBy of ['unknown-media', 'held-review8'] as const) {
      await t.test(
        `${blockedBy} on the shared ancestor blocks descendant auxiliary reads and fresh writes, preserving prior intents and receipts`,
        async () => {
          const pending = await fresh(),
            current = await context(),
            ownerContext = await context(owner),
            before = await interactionState(),
            notices = await noticeRows();
          const approval = f.iconApprovals.find(
            (item) =>
              item.envelope.content.categoryId === f.rootId &&
              item.envelope.content.selector.kind === 'campus' &&
              item.envelope.content.selector.campusId === f.campusA,
          );
          assert.ok(approval);
          if (blockedBy === 'unknown-media')
            await setCategoryScaleAssetState(
              f,
              f.rootUpload.status.assetId,
              'unknown',
            );
          else await setRatingReviewState(f.pool, approval.decisionId, 'held');
          try {
            drawCalls = 0;
            unavailable(await sample(await randomContext()));
            assert.equal(
              drawCalls,
              0,
              'A failing ancestor cannot yield zero or select only the other campus path',
            );
            for (const endpoint of auxiliaryPaths)
              unavailable(await read(endpoint, reader, current));
            unavailable(
              await f
                .auth(
                  request(f.http).post('/v2/ratings/subscription-states/query'),
                  reader,
                )
                .send({
                  ...query(current),
                  targets: [
                    {
                      targetId: target.id,
                      expectedTargetRevision: target.revision,
                    },
                  ],
                }),
            );
            for (const item of pending)
              unavailable(await send(item.actor, item.input));
            for (const row of notices) {
              const actor = row.recipient === owner.accountId ? owner : reader;
              unavailable(
                await read(
                  `/v2/me/ratings/${row.kind}/${row.id}/target`,
                  actor,
                  actor === owner ? ownerContext : current,
                ),
              );
              const metadata = await f.auth(
                request(f.http).get(`/v2/me/ratings/${row.kind}`),
                actor,
              );
              categoryIconHttpOk(metadata);
              const page = ratingScopedNoticePageSchema.parse(metadata.body);
              assert.ok(
                page.items.some(
                  (item) => item.noticeId === row.id && item.readAt === null,
                ),
              );
              assert.doesNotMatch(
                canonicalJson(page),
                /"(?:targetId|rootId|replyId|preview|body|icon|appearanceId)"/,
              );
            }
            await originalRecovery();
            assert.deepEqual(
              await interactionState(),
              before,
              'Unknown current media cannot change existing scores, content, likes or membership intent',
            );
            assert.deepEqual(
              await noticeRows(),
              notices,
              'Availability checks do not delete or mark captured notices read',
            );
          } finally {
            if (blockedBy === 'unknown-media')
              await setCategoryScaleAssetState(
                f,
                f.rootUpload.status.assetId,
                'allow',
              );
            else
              await setRatingReviewState(f.pool, approval.decisionId, 'allow');
          }
          const restored = await read(`${path}/subscription`);
          categoryIconHttpOk(restored);
          assert.equal(restored.body.status, 'known');
          assert.equal(restored.body.count, 1);
          assert.equal(restored.body.subscribed, true);
        },
      );
    }
  },
);
