import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { ratingSubscriptionUpdatesFixture } from '../support/rating-subscription-updates-fixture.js';
import { setRatingReviewState } from '../support/rating-runtime-fixture.js';
import { APP_CONFIG } from '../../src/config/config.js';
import type { RuntimeConfig } from '../../src/config/config.js';
import { DatabaseService } from '../../src/database/database.js';
import { RatingUpdatesWorker } from '../../src/notifications/ratings/worker.js';
import { RatingUpdatesRepository } from '../../src/notifications/ratings/repository.js';
import { RatingsUpdatesSourceFacade } from '../../src/ratings/updates-source/facade.js';
import { RatingUpdatesProjectionFacade } from '../../src/ratings/updates-source/projection.js';
import { ExperienceWorker } from '../../src/experience/worker.js';

test('M2A preserves independent history and captured rewards while every public projection closes', async (t) => {
  const f = await ratingSubscriptionUpdatesFixture();
  t.after(() => f.close());
  const creator = await f.actor(),
    author = await f.actor(),
    replier = await f.actor(),
    watcher = await f.actor();
  const catalog = await f.catalog(creator),
    target = catalog.targets[0]!;
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
  assert.equal(
    (await put(replyLikePath, replyLikeInput)).body.outcome,
    'applied',
  );
  const rootEvent = await f.event(author, root.input.clientRequestId);
  const replyEvent = await f.event(replier, reply.input.clientRequestId);
  const secondReplyEvent = await f.event(
    replier,
    secondReply.input.clientRequestId,
  );
  const likeEvent = await f.event(replier, likeInput.clientRequestId);
  const replyLikeEvent = await f.event(author, replyLikeInput.clientRequestId);
  const directWorker = new RatingUpdatesWorker(
    f.app.get(DatabaseService),
    {
      ...f.app.get<RuntimeConfig>(APP_CONFIG),
      RATINGS_UPDATES_PROCESSING: 'manual',
    },
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
  const fanout = await f.worker().run({
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
  const pages = new Map<
    string,
    {
      items: {
        noticeId: string;
        createdAt: string;
        readAt: string | null;
        status: string;
      }[];
      unreadCount: number;
    }
  >();
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
    // Preserve both read and unread rows across the deletion boundary.
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
    'The fixture must have real pending Experience obligations',
  );
  const experience = f.app.get(ExperienceWorker);
  const settledBefore = await experience.run({
    mode: 'apply',
    unitIds: [units[0]!],
  });
  assert.equal(settledBefore.failed, 0, JSON.stringify(settledBefore));
  assert.equal(settledBefore.settled, 1);
  const legacyRequests = (
    await f.pool.query(
      'SELECT * FROM whaleu_ratings.requests ORDER BY account_id,request_id',
    )
  ).rows;
  const definition = (
    await f.pool.query(
      "SELECT to_jsonb(t)-ARRAY['revision','active'] row FROM whaleu_ratings.targets t WHERE id=$1",
      [target.id],
    )
  ).rows;
  const historyTables = (
    await f.pool.query<{
      table_schema: string;
      table_name: string;
    }>(`SELECT table_schema,table_name FROM information_schema.tables WHERE table_type='BASE TABLE' AND (
    table_schema='whaleu_experience' OR
    (table_schema='whaleu_notifications' AND table_name LIKE 'rating_%') OR
    (table_schema='whaleu_community' AND table_name LIKE 'rating_approval_%') OR
    (table_schema='whaleu_ratings' AND table_name NOT IN ('targets','target_state_revisions','navigation_epoch','random_pool_epoch','requests','command_claims','target_owner_delete_audits','target_owner_tombstones','target_owner_delete_closures'))
  ) ORDER BY table_schema,table_name`)
  ).rows;
  const snapshot = async () => {
    const rows: Record<string, unknown> = {};
    for (const table of historyTables) {
      assert.match(table.table_schema, /^[a-z_]+$/);
      assert.match(table.table_name, /^[a-z_]+$/);
      rows[`${table.table_schema}.${table.table_name}`] = (
        await f.pool.query(
          `SELECT to_jsonb(r) row FROM ${table.table_schema}.${table.table_name} r ORDER BY to_jsonb(r)::text`,
        )
      ).rows;
    }
    return rows;
  };
  const before = await snapshot();
  const deleteInput = {
    clientRequestId: randomUUID(),
    expectedTargetRevision: target.revision,
  };
  const deleted = await f
    .auth(
      request(f.http).post(
        `/v1/ratings/management/owner-deletion/targets/${target.id}`,
      ),
      creator,
    )
    .send(deleteInput);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(deleted.body.outcome, 'applied', JSON.stringify(deleted.body));
  target.revision = deleted.body.revision;

  await t.test(
    'soft deletion changes only owner lifecycle evidence, never historical content or side effects',
    async () => {
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual(
        (
          await f.pool.query(
            "SELECT to_jsonb(t)-ARRAY['revision','active'] row FROM whaleu_ratings.targets t WHERE id=$1",
            [target.id],
          )
        ).rows,
        definition,
      );
      assert.deepEqual(
        (
          await f.pool.query(
            "SELECT * FROM whaleu_ratings.requests WHERE operation<>'delete_target' ORDER BY account_id,request_id",
          )
        ).rows,
        legacyRequests,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_ratings.effect_events WHERE request_id=$1',
            [deleteInput.clientRequestId],
          )
        ).rowCount,
        0,
      );
      // Old publication/interaction keys still recover their original receipts.
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
    'already materialized reply, like and subscription notices become metadata-only on each read',
    async () => {
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
        for (const notice of previous.items) {
          const resolved = await get(
            `${path}/${notice.noticeId}/target`,
            feed.actor,
          );
          assert.deepEqual(resolved.body, {
            noticeId: notice.noticeId,
            status: 'unavailable',
          });
          const projected = response.body.items.find(
            (row: { noticeId: string }) => row.noticeId === notice.noticeId,
          );
          assert.deepEqual(Object.keys(projected).sort(), [
            'createdAt',
            'noticeId',
            'readAt',
            'status',
          ]);
        }
      }
      assert.deepEqual(
        await snapshot(),
        before,
        'Read-time unavailable projections must not rewrite stored notices, receipts, read-state or rewards',
      );
    },
  );

  await t.test(
    'all public target/root/reply, score, like, subscription and random/list reads close',
    async () => {
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
          'Synthetic target',
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
    },
  );

  await t.test(
    'fresh public writes are refused and stale historic keys remain separate from target deletion',
    async () => {
      const oldKeys = [
        [author, scoreInput.clientRequestId],
        [author, root.input.clientRequestId],
        [replier, reply.input.clientRequestId],
        [replier, likeInput.clientRequestId],
        [watcher, subscriptionInput.clientRequestId],
      ] as const;
      for (const [actor, key] of oldKeys) {
        const response = await f
          .auth(
            request(f.http).post(
              `/v1/ratings/management/owner-deletion/targets/${target.id}`,
            ),
            actor,
          )
          .send({ ...deleteInput, clientRequestId: key });
        assert.equal(
          response.body.error?.code,
          'REQUEST_CONFLICT',
          JSON.stringify(response.body),
        );
      }
      const requests = [
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
      for (const operation of requests) {
        const response = await operation;
        assert.equal(
          response.body.code,
          'RATING_NOT_FOUND',
          JSON.stringify(response.body),
        );
      }
      assert.deepEqual(
        await snapshot(),
        before,
        'Failed writes may add rejected receipts but cannot alter preserved content, interactions, rewards or notices',
      );
    },
  );

  await t.test(
    'captured but unsettled Experience remains eligible after target deletion',
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
        await f.pool.query<{
          unit_id: string;
          state: string;
          exact_time: boolean;
        }>(
          `SELECT s.unit_id,w.state,r.occurred_at=g.occurred_at exact_time
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
    'subcontent authors retain cleanup beneath an owner tombstone without affiliation or Review visibility',
    async () => {
      await setRatingReviewState(f.pool, root.approval.decisionId, 'revoked');
      await setRatingReviewState(f.pool, reply.approval.decisionId, 'revoked');
      await f.certify(author.accountId, {
        affiliation: 'unavailable',
        identity: false,
      });
      await f.certify(replier.accountId, {
        affiliation: 'unavailable',
        identity: false,
      });
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
      assert.equal(
        (
          await f.pool.query(
            'SELECT count(*)::int n FROM whaleu_ratings.target_owner_tombstones WHERE target_id=$1',
            [target.id],
          )
        ).rows[0]!.n,
        1,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT revision FROM whaleu_ratings.targets WHERE id=$1',
            [target.id],
          )
        ).rows[0]!.revision,
        target.revision,
      );
      assert.deepEqual(
        (
          await get(
            `/v1/ratings/management/owner-deletion/requests/${deleteInput.clientRequestId}`,
            creator,
          )
        ).body,
        deleted.body,
      );
    },
  );
});
