import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import {
  ratingEditFixture,
  ratingEditPrefix,
} from '../support/rating-edit-fixture.js';
import { setRatingReviewState } from '../support/rating-runtime-fixture.js';
import { APP_CONFIG } from '../../src/config/config.js';
import type { RuntimeConfig } from '../../src/config/config.js';
import { DatabaseService } from '../../src/database/database.js';
import { RatingUpdatesWorker } from '../../src/notifications/ratings/worker.js';
import { RatingUpdatesRepository } from '../../src/notifications/ratings/repository.js';
import { RatingsUpdatesSourceFacade } from '../../src/ratings/updates-source/facade.js';
import { RatingUpdatesProjectionFacade } from '../../src/ratings/updates-source/projection.js';
import { RatingSubscriptionUpdatesWorker } from '../../src/notifications/ratings/subscription-worker.js';
import { RatingSubscriptionUpdatesRepository } from '../../src/notifications/ratings/subscription-repository.js';
import { RatingsSubscriptionUpdatesSourceFacade } from '../../src/ratings/updates-source/subscription-facade.js';
import { RatingSubscriptionUpdatesProjectionFacade } from '../../src/ratings/updates-source/subscription-projection.js';
import { ExperienceWorker } from '../../src/experience/worker.js';

test('M2B current definitions replace every public projection while immutable history, materialized notices and captured rewards remain independent', async (t) => {
  const f = await ratingEditFixture();
  t.after(() => f.close());
  const creator = await f.actor(),
    author = await f.actor(),
    replier = await f.actor(),
    watcher = await f.actor();
  const catalog = await f.catalog(creator),
    target = catalog.targets[0]!,
    creationRevision = target.revision;
  const get = (path: string, actor = author) =>
    f.auth(request(f.http).get(path), actor);
  const put = (path: string, body: object, actor = author) =>
    f.auth(request(f.http).put(path), actor).send(body);
  const subscriptionPath = `/v1/ratings/targets/${target.id}/subscription`;
  const subscriptionState = await get(subscriptionPath, watcher);
  assert.equal(
    subscriptionState.body.status,
    'known',
    JSON.stringify(subscriptionState.body),
  );
  const subscriptionInput = {
    clientRequestId: randomUUID(),
    regionId: null,
    expectedTargetRevision: target.revision,
    expectedSubscriptionRevision: subscriptionState.body.revision,
    subscribed: true,
  };
  const subscribed = await put(subscriptionPath, subscriptionInput, watcher);
  assert.equal(
    subscribed.body.outcome,
    'applied',
    JSON.stringify(subscribed.body),
  );
  const scoreInput = {
    clientRequestId: randomUUID(),
    regionId: null,
    expectedTargetRevision: target.revision,
    expectedRevision: null,
    score: 4,
  };
  const scored = await put(
    `/v1/ratings/targets/${target.id}/my-score`,
    scoreInput,
  );
  assert.equal(scored.body.outcome, 'applied', JSON.stringify(scored.body));
  const root = await f.publish(author, catalog, target);
  const reply = await f.publishReply(replier, catalog, target, root);
  const secondReply = await f.publishReply(replier, catalog, target, root);
  const likePath = `/v1/ratings/comments/${root.id}/like`;
  const likeState = await get(likePath, replier);
  assert.equal(likeState.body.status, 'known', JSON.stringify(likeState.body));
  const likeInput = {
    clientRequestId: randomUUID(),
    regionId: null,
    targetId: target.id,
    expectedTargetRevision: target.revision,
    expectedRevision: root.revision,
    expectedLikeRevision: likeState.body.revision,
    liked: true,
  };
  const liked = await put(likePath, likeInput, replier);
  assert.equal(liked.body.outcome, 'applied', JSON.stringify(liked.body));
  const replyLikePath = `/v1/ratings/replies/${reply.id}/like`;
  const replyLikeState = await get(replyLikePath);
  const replyLikeInput = {
    ...likeInput,
    clientRequestId: randomUUID(),
    rootId: root.id,
    expectedRootRevision: root.revision,
    expectedRevision: reply.revision,
    expectedLikeRevision: replyLikeState.body.revision,
  };
  const replyLiked = await put(replyLikePath, replyLikeInput);
  assert.equal(
    replyLiked.body.outcome,
    'applied',
    JSON.stringify(replyLiked.body),
  );
  const event = async (actor: typeof creator, requestId: string) => {
    const row = (
      await f.pool.query<{ id: string }>(
        'SELECT id FROM whaleu_ratings.effect_events WHERE actor_account_id=$1 AND request_id=$2',
        [actor.accountId, requestId],
      )
    ).rows[0];
    assert.ok(row);
    return row.id;
  };
  const rootEvent = await event(author, root.input.clientRequestId),
    replyEvent = await event(replier, reply.input.clientRequestId),
    secondReplyEvent = await event(replier, secondReply.input.clientRequestId),
    likeEvent = await event(replier, likeInput.clientRequestId),
    replyLikeEvent = await event(author, replyLikeInput.clientRequestId);
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
  const direct = await directWorker.run({
    mode: 'apply',
    eventIds: [replyEvent, secondReplyEvent, likeEvent, replyLikeEvent],
  });
  assert.equal(direct.failed, 0, JSON.stringify(direct));
  assert.equal(direct.materialized, 4, JSON.stringify(direct));
  const subscriptionWorker = new RatingSubscriptionUpdatesWorker(
    f.app.get(DatabaseService),
    config,
    f.app.get(RatingsSubscriptionUpdatesSourceFacade),
    f.app.get(RatingSubscriptionUpdatesProjectionFacade),
    f.app.get(RatingSubscriptionUpdatesRepository),
  );
  const fanout = await subscriptionWorker.run({
    mode: 'apply',
    eventIds: [rootEvent, replyEvent, secondReplyEvent],
    maxPages: 3,
  });
  assert.equal(fanout.failed, 0, JSON.stringify(fanout));
  assert.equal(fanout.materialized, 3, JSON.stringify(fanout));
  const feeds = [
    { actor: author, kind: 'updates', expected: 2 },
    { actor: author, kind: 'like-updates', expected: 1 },
    { actor: replier, kind: 'like-updates', expected: 1 },
    { actor: watcher, kind: 'subscription-updates', expected: 3 },
  ];
  interface NoticePage {
    items: {
      noticeId: string;
      createdAt: string;
      readAt: string | null;
      status: string;
    }[];
    unreadCount: number;
  }
  const pages = new Map<string, NoticePage>();
  for (const [index, feed] of feeds.entries()) {
    const path = `/v1/me/ratings/${feed.kind}`;
    const before = await get(path, feed.actor);
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.equal(before.body.items.length, feed.expected);
    assert.ok(
      before.body.items.every(
        (item: { status: string }) => item.status === 'available',
      ),
    );
    if (index !== 2)
      assert.equal(
        (
          await put(
            `${path}/${before.body.items[0].noticeId}/read`,
            {},
            feed.actor,
          )
        ).status,
        200,
      );
    pages.set(
      `${feed.actor.accountId}:${feed.kind}`,
      (await get(path, feed.actor)).body,
    );
  }
  const units = (
    await f.pool.query<{ id: string }>(
      'SELECT id FROM whaleu_ratings.reward_units ORDER BY enrollment_order,id',
    )
  ).rows.map((row) => row.id);
  assert.ok(
    units.length > 1,
    'Real pending captured Experience units are required',
  );
  const experience = f.app.get(ExperienceWorker);
  const settledBefore = await experience.run({
    mode: 'apply',
    unitIds: [units[0]!],
  });
  assert.equal(settledBefore.failed, 0, JSON.stringify(settledBefore));
  assert.equal(settledBefore.settled, 1);

  const creationIdentity = (
    await f.pool.query(
      "SELECT to_jsonb(t)-'revision' row FROM whaleu_ratings.targets t WHERE id=$1",
      [target.id],
    )
  ).rows;
  const legacyRequests = (
    await f.pool.query(
      'SELECT * FROM whaleu_ratings.requests ORDER BY account_id,request_id',
    )
  ).rows;
  const legacyDecisions = (
    await f.pool.query<{ id: string }>(
      'SELECT id FROM whaleu_community.rating_approval_decisions ORDER BY id',
    )
  ).rows.map((row) => row.id);
  const legacyReview = async () => {
    const rows: Record<string, unknown> = {};
    for (const [table, column] of [
      ['rating_approval_decisions', 'id'],
      ['rating_approval_events', 'decision_id'],
      ['rating_approval_heads', 'decision_id'],
      ['rating_approval_bindings', 'decision_id'],
    ] as const)
      rows[table] = (
        await f.pool.query(
          `SELECT to_jsonb(r) row FROM whaleu_community.${table} r WHERE ${column}=ANY($1::uuid[]) ORDER BY to_jsonb(r)::text`,
          [legacyDecisions],
        )
      ).rows;
    return rows;
  };
  const beforeReview = await legacyReview();
  const historyTables = (
    await f.pool.query<{ table_schema: string; table_name: string }>(
      `SELECT table_schema,table_name FROM information_schema.tables WHERE table_type='BASE TABLE' AND (
       table_schema='whaleu_experience' OR
       (table_schema='whaleu_notifications' AND table_name LIKE 'rating_%') OR
       (table_schema='whaleu_ratings' AND table_name NOT IN
         ('targets','target_state_revisions','navigation_epoch','random_pool_epoch','requests','command_claims')
         AND table_name NOT LIKE 'target_definition_%' AND table_name NOT LIKE 'target_edit_%')
     ) ORDER BY table_schema,table_name`,
    )
  ).rows;
  const history = async () => {
    const hashes: Record<string, { n: number; digest: string }> = {};
    for (const table of historyTables) {
      assert.match(table.table_schema, /^[a-z_]+$/);
      assert.match(table.table_name, /^[a-z_]+$/);
      const value = (
        await f.pool.query<{ n: number; digest: string }>(
          `SELECT count(*)::integer n,
         encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb)::text,'UTF8')),'hex') digest
         FROM ${table.table_schema}.${table.table_name} r`,
        )
      ).rows[0]!;
      assert.match(value.digest, /^[a-f0-9]{64}$/);
      hashes[`${table.table_schema}.${table.table_name}`] = value;
    }
    return hashes;
  };
  const beforeHistory = await history();
  assert.ok(beforeHistory['whaleu_ratings.score_baselines']);
  assert.ok(beforeHistory['whaleu_ratings.effect_events']);
  assert.ok(beforeHistory['whaleu_ratings.subscription_epochs']);
  const v1 = (
    await f.pool.query(
      'SELECT * FROM whaleu_ratings.target_definition_versions WHERE target_id=$1 AND content_version=1',
      [target.id],
    )
  ).rows;
  const originalLifecycle = (
    await f.pool.query(
      'SELECT * FROM whaleu_ratings.target_definition_lifecycles WHERE target_id=$1 AND target_revision=$2',
      [target.id, creationRevision],
    )
  ).rows;

  const assertCurrentPublic = async (name: string, description: string) => {
    const detail = await get(`/v1/ratings/targets/${target.id}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.name, name);
    assert.equal(detail.body.description, description);
    assert.equal(detail.body.revision, target.revision);
    assert.deepEqual(Object.keys(detail.body).sort(), [
      'allowedActions',
      'categoryId',
      'description',
      'id',
      'name',
      'revision',
    ]);
    const list = await get('/v1/ratings/targets').query({
      categoryId: catalog.categoryId,
    });
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].name, name);
    assert.equal(list.body.items[0].description, description);
    const summary = await get(`/v1/ratings/targets/${target.id}/score-summary`);
    assert.equal(summary.body.status, 'known', JSON.stringify(summary.body));
    assert.equal(summary.body.count, 1);
    assert.equal(summary.body.sum, 4);
    assert.equal(summary.body.average, 4);
    assert.equal(
      (await get(`/v1/ratings/targets/${target.id}/my-score`)).body.myScore
        .score,
      4,
    );
    const rootPage = await get(`/v1/ratings/targets/${target.id}/comments`);
    assert.equal(rootPage.status, 200, JSON.stringify(rootPage.body));
    assert.equal(rootPage.body.items[0].body, root.input.body);
    assert.equal(
      (await get(`/v1/ratings/comments/${root.id}`)).body.body,
      root.input.body,
    );
    const discussion = await get(`/v1/ratings/comments/${root.id}/discussion`);
    assert.equal(discussion.status, 200, JSON.stringify(discussion.body));
    assert.equal(discussion.body.root.body, root.input.body);
    const replyPage = await get(`/v1/ratings/comments/${root.id}/replies`);
    assert.equal(replyPage.status, 200, JSON.stringify(replyPage.body));
    assert.equal(replyPage.body.items.length, 2);
    assert.equal(
      (await get(`/v1/ratings/replies/${reply.id}`)).body.body,
      reply.input.body,
    );
    assert.equal(
      (await get(`/v1/ratings/replies/${reply.id}/position`)).status,
      200,
    );
    assert.equal((await get(likePath, replier)).body.liked, true);
    assert.equal((await get(replyLikePath)).body.liked, true);
    assert.equal((await get(subscriptionPath, watcher)).body.subscribed, true);
    const batch = await f
      .auth(
        request(f.http).post('/v1/ratings/subscription-states/query'),
        watcher,
      )
      .send({
        regionId: null,
        targets: [
          { targetId: target.id, expectedTargetRevision: target.revision },
        ],
      });
    assert.equal(batch.status, 200, JSON.stringify(batch.body));
    assert.equal(batch.body.items[0].state.subscribed, true);
    const random = await get('/v1/ratings/random-target').query({
      categoryId: catalog.categoryId,
    });
    assert.equal(random.status, 200, JSON.stringify(random.body));
    assert.equal(random.body.candidateCount, 1);
    assert.equal(random.body.item.regionId, null);
    assert.equal(random.body.item.target.name, name);
    assert.equal(random.body.item.target.description, description);
    assert.equal(random.body.item.summary.count, 1);
    for (const feed of feeds) {
      const path = `/v1/me/ratings/${feed.kind}`;
      const previous = pages.get(`${feed.actor.accountId}:${feed.kind}`)!;
      const response = await get(path, feed.actor);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.deepEqual(response.body, previous);
      for (const notice of previous.items)
        assert.equal(
          (await get(`${path}/${notice.noticeId}/target`, feed.actor)).body
            .status,
          'available',
        );
    }
  };

  const edited = [] as Awaited<ReturnType<typeof f.edit>>[];
  for (const version of [2, 3]) {
    await t.test(
      `v${version} changes current text everywhere without changing one historical business table`,
      async () => {
        const changed = await f.edit(creator, target.id, {
          name: `Edited target version ${version}`,
          description: `Current description version ${version}`,
        });
        assert.equal(
          changed.receipt.outcome,
          'applied',
          JSON.stringify(changed.receipt),
        );
        assert.equal(changed.receipt.contentVersion, version);
        assert.notEqual(changed.receipt.revision, target.revision);
        // The fixture's initial randomUUID carries Node's UUID template type;
        // this later receipt has already passed the exact UUID runtime decoder.
        target.revision = changed.receipt.revision as typeof target.revision;
        edited.push(changed);
        assert.deepEqual(await history(), beforeHistory);
        assert.deepEqual(await legacyReview(), beforeReview);
        assert.deepEqual(
          (
            await f.pool.query(
              "SELECT to_jsonb(t)-'revision' row FROM whaleu_ratings.targets t WHERE id=$1",
              [target.id],
            )
          ).rows,
          creationIdentity,
        );
        assert.deepEqual(
          (
            await f.pool.query(
              "SELECT * FROM whaleu_ratings.requests WHERE operation<>'edit_target' ORDER BY account_id,request_id",
            )
          ).rows,
          legacyRequests,
        );
        assert.deepEqual(
          (
            await f.pool.query(
              'SELECT * FROM whaleu_ratings.target_definition_versions WHERE target_id=$1 AND content_version=1',
              [target.id],
            )
          ).rows,
          v1,
        );
        assert.deepEqual(
          (
            await f.pool.query(
              'SELECT * FROM whaleu_ratings.target_definition_lifecycles WHERE target_id=$1 AND target_revision=$2',
              [target.id, creationRevision],
            )
          ).rows,
          originalLifecycle,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.effect_events WHERE request_id=$1',
              [changed.input.clientRequestId],
            )
          ).rowCount,
          0,
        );
        await assertCurrentPublic(
          changed.input.name,
          changed.input.description,
        );
        assert.deepEqual(
          await history(),
          beforeHistory,
          'Public reads do not rewrite retained history',
        );
      },
    );
  }

  await t.test(
    'old lifecycle map and old command receipts remain exact while definition history advances strictly',
    async () => {
      const versions = (
        await f.pool.query<{
          content_version: number;
          definition_revision: string;
          applied_target_revision: string;
          name: string;
        }>(
          'SELECT content_version,definition_revision,applied_target_revision,name FROM whaleu_ratings.target_definition_versions WHERE target_id=$1 ORDER BY content_version',
          [target.id],
        )
      ).rows;
      assert.deepEqual(
        versions.map((row) => row.content_version),
        [1, 2, 3],
      );
      assert.equal(versions[0]!.applied_target_revision, creationRevision);
      assert.equal(versions[0]!.name, 'Synthetic target 1');
      for (const [index, changed] of edited.entries()) {
        const receipt = changed.receipt;
        assert.equal(
          versions[index + 1]!.definition_revision,
          receipt.definitionRevision,
        );
        assert.equal(
          versions[index + 1]!.applied_target_revision,
          receipt.revision,
        );
      }
      const ancestry = (
        await f.pool.query<{ content_version: number; exact: boolean }>(
          `SELECT l.content_version,(c.envelope->>'targetRevision')::uuid=l.target_revision exact
       FROM whaleu_ratings.comments c JOIN whaleu_ratings.target_definition_lifecycles l
         ON l.target_id=c.target_id AND l.target_revision=(c.envelope->>'targetRevision')::uuid WHERE c.id=$1
       UNION ALL
       SELECT l.content_version,(r.envelope->>'targetRevision')::uuid=l.target_revision exact
       FROM whaleu_ratings.replies r JOIN whaleu_ratings.target_definition_lifecycles l
         ON l.target_id=r.target_id AND l.target_revision=(r.envelope->>'targetRevision')::uuid WHERE r.id=ANY($2::uuid[])`,
          [root.id, [reply.id, secondReply.id]],
        )
      ).rows;
      assert.equal(ancestry.length, 3);
      assert.ok(
        ancestry.every((row) => row.content_version === 1 && row.exact),
      );
      for (const [actor, path, receipt] of [
        [
          author,
          `/v1/ratings/requests/${scoreInput.clientRequestId}`,
          scored.body,
        ],
        [
          author,
          `/v1/ratings/requests/${root.input.clientRequestId}`,
          root.receipt,
        ],
        [
          replier,
          `/v1/ratings/reply-requests/${reply.input.clientRequestId}`,
          reply.receipt,
        ],
        [
          replier,
          `/v1/ratings/like-requests/${likeInput.clientRequestId}`,
          liked.body,
        ],
        [
          watcher,
          `/v1/ratings/subscription-requests/${subscriptionInput.clientRequestId}`,
          subscribed.body,
        ],
      ] as const)
        assert.deepEqual((await get(path, actor)).body, receipt);
    },
  );

  await t.test(
    'revoking creation and superseded edit approvals does not replace current v3 approval',
    async () => {
      assert.ok(edited[0]!.reviewed);
      await setRatingReviewState(f.pool, target.approval.decisionId, 'revoked');
      await setRatingReviewState(
        f.pool,
        edited[0]!.reviewed.decisionId,
        'revoked',
      );
      await assertCurrentPublic(
        edited[1]!.input.name,
        edited[1]!.input.description,
      );
      assert.deepEqual(await history(), beforeHistory);
      // Restore older approvals to make the no-fallback assertion independent.
      await setRatingReviewState(f.pool, target.approval.decisionId, 'allow');
      await setRatingReviewState(
        f.pool,
        edited[0]!.reviewed.decisionId,
        'allow',
      );
    },
  );

  await t.test(
    'current v3 withdrawal closes every public path and every old materialized notice without returning v1 or v2',
    async () => {
      assert.ok(edited[1]!.reviewed);
      await setRatingReviewState(
        f.pool,
        edited[1]!.reviewed.decisionId,
        'revoked',
      );
      for (const path of [
        `targets/${target.id}`,
        `targets/${target.id}/score-summary`,
        `targets/${target.id}/my-score`,
        `targets/${target.id}/comments`,
        `targets/${target.id}/subscription`,
        `comments/${root.id}`,
        `comments/${root.id}/discussion`,
        `comments/${root.id}/replies`,
        `comments/${root.id}/like`,
        `replies/${reply.id}`,
        `replies/${reply.id}/position`,
        `replies/${reply.id}/like`,
      ]) {
        const response = await get(`/v1/ratings/${path}`);
        assert.equal(
          response.body.error?.code,
          'RATING_NOT_FOUND',
          `${path}: ${JSON.stringify(response.body)}`,
        );
        for (const text of [
          'Synthetic target 1',
          ...edited.map((edit) => edit.input.name),
          root.input.body,
          reply.input.body,
        ])
          assert.equal(JSON.stringify(response.body).includes(text), false);
      }
      const list = await get('/v1/ratings/targets').query({
        categoryId: catalog.categoryId,
      });
      assert.equal(list.status, 200, JSON.stringify(list.body));
      assert.deepEqual(list.body.items, []);
      const random = await get('/v1/ratings/random-target').query({
        categoryId: catalog.categoryId,
      });
      assert.equal(random.status, 200, JSON.stringify(random.body));
      assert.equal(random.body.candidateCount, 0);
      assert.equal(random.body.item, null);
      const head = (
        await f.pool.query<{ content_version: number }>(
          'SELECT content_version FROM whaleu_ratings.target_definition_heads WHERE target_id=$1',
          [target.id],
        )
      ).rows[0]!;
      assert.equal(head.content_version, 3);
      for (const feed of feeds) {
        const path = `/v1/me/ratings/${feed.kind}`;
        const previous = pages.get(`${feed.actor.accountId}:${feed.kind}`)!;
        const response = await get(path, feed.actor);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(response.body.unreadCount, previous.unreadCount);
        assert.equal(
          (await get(`${path}/unread-count`, feed.actor)).body.unreadCount,
          previous.unreadCount,
        );
        assert.deepEqual(
          response.body.items,
          previous.items.map((notice) => ({
            noticeId: notice.noticeId,
            createdAt: notice.createdAt,
            readAt: notice.readAt,
            status: 'unavailable',
          })),
        );
        for (const notice of previous.items)
          assert.deepEqual(
            (await get(`${path}/${notice.noticeId}/target`, feed.actor)).body,
            {
              noticeId: notice.noticeId,
              status: 'unavailable',
            },
          );
      }
      for (const changed of edited)
        assert.deepEqual(
          (
            await get(
              `${ratingEditPrefix}/requests/${changed.input.clientRequestId}`,
              creator,
            )
          ).body,
          changed.receipt,
        );
      assert.deepEqual(await history(), beforeHistory);
    },
  );

  await t.test(
    'withdrawn current definition rejects fresh interactions without changing existing scores, likes or subscription epochs',
    async () => {
      const actions = [
        put(`/v1/ratings/targets/${target.id}/my-score`, {
          ...scoreInput,
          clientRequestId: randomUUID(),
          expectedTargetRevision: target.revision,
          expectedRevision: scored.body.revision,
          score: 5,
        }),
        f
          .auth(
            request(f.http).post(`/v1/ratings/targets/${target.id}/comments`),
            author,
          )
          .send(f.body(catalog, target)),
        f
          .auth(
            request(f.http).post(`/v1/ratings/comments/${root.id}/replies`),
            replier,
          )
          .send(f.replyBody(catalog, target, root)),
        put(
          likePath,
          {
            ...likeInput,
            clientRequestId: randomUUID(),
            expectedTargetRevision: target.revision,
            expectedLikeRevision: liked.body.revision,
            liked: false,
          },
          replier,
        ),
        put(
          subscriptionPath,
          {
            ...subscriptionInput,
            clientRequestId: randomUUID(),
            expectedTargetRevision: target.revision,
            expectedSubscriptionRevision: subscribed.body.revision,
            subscribed: false,
          },
          watcher,
        ),
      ];
      for (const action of actions) {
        const response = await action;
        assert.equal(
          response.body.code,
          'RATING_NOT_FOUND',
          JSON.stringify(response.body),
        );
      }
      assert.deepEqual(await history(), beforeHistory);
    },
  );

  await t.test(
    'captured pending Experience still settles after text replacement and current Review withdrawal',
    async () => {
      const existing = (
        await f.pool.query(
          'SELECT * FROM whaleu_experience.settlements ORDER BY id',
        )
      ).rows;
      const settled = await experience.run({
        mode: 'apply',
        unitIds: units.slice(1),
      });
      assert.equal(settled.failed, 0, JSON.stringify(settled));
      assert.equal(settled.sourceUnavailable, 0, JSON.stringify(settled));
      assert.equal(settled.settled, units.length - 1, JSON.stringify(settled));
      assert.deepEqual(
        (
          await f.pool.query(
            'SELECT * FROM whaleu_experience.settlements WHERE unit_id=$1 ORDER BY id',
            [units[0]],
          )
        ).rows,
        existing,
      );
      const ledger = (
        await f.pool.query<{ state: string; exact_time: boolean }>(
          `SELECT w.state,r.occurred_at=g.occurred_at exact_time
       FROM whaleu_experience.settlements s JOIN whaleu_experience.work w ON w.unit_id=s.unit_id
       JOIN whaleu_experience.records r ON r.settlement_id=s.id
       JOIN whaleu_ratings.reward_units u ON u.id=s.unit_id JOIN whaleu_ratings.reward_groups g ON g.id=u.group_id
       WHERE s.unit_id=ANY($1::uuid[]) ORDER BY s.unit_id`,
          [units],
        )
      ).rows;
      assert.equal(ledger.length, units.length);
      assert.ok(
        ledger.every((row) => row.state === 'completed' && row.exact_time),
      );
    },
  );

  await t.test(
    'subcontent cleanup metadata remains usable beneath an unavailable current definition',
    async () => {
      const rootContext = await get(
        `/v1/ratings/comments/${root.id}/deletion-context`,
      );
      assert.equal(rootContext.status, 200, JSON.stringify(rootContext.body));
      assert.equal(rootContext.body.targetRevision, target.revision);
      const removedRoot = await f.deleteRoot(author, catalog, target, root);
      assert.equal(removedRoot.outcome, 'applied', JSON.stringify(removedRoot));
      root.revision = removedRoot.revision;
      const replyContext = await get(
        `/v1/ratings/replies/${reply.id}/deletion-context`,
        replier,
      );
      assert.equal(replyContext.status, 200, JSON.stringify(replyContext.body));
      assert.equal(replyContext.body.targetRevision, target.revision);
      assert.equal(replyContext.body.rootRevision, root.revision);
      assert.equal(
        (await f.deleteReply(replier, catalog, target, root, reply)).outcome,
        'applied',
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT deleted_at FROM whaleu_ratings.replies WHERE id=$1',
            [secondReply.id],
          )
        ).rows[0]!.deleted_at,
        null,
      );
    },
  );
});
