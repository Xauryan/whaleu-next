import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { APP_CONFIG } from '../../src/config/config.js';
import type { RuntimeConfig } from '../../src/config/config.js';
import { DatabaseService } from '../../src/database/database.js';
import { RatingsUpdatesSourceFacade } from '../../src/ratings/updates-source/facade.js';
import { RatingUpdatesProjectionFacade } from '../../src/ratings/updates-source/projection.js';
import { RatingUpdatesRepository } from '../../src/notifications/ratings/repository.js';
import { RatingUpdatesWorker } from '../../src/notifications/ratings/worker.js';
import { ratingLikeUpdatesPageSchema } from '../../src/notifications/ratings/like-contracts.js';
import {
  ratingLikeReceiptSchema,
  ratingLikeStateSchema,
} from '../../src/ratings/likes/contracts.js';
import {
  approveRating,
  ratingRuntimeFixture,
  setRatingReviewState,
} from '../support/rating-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';

test('rating like updates: real captured obligations, once-key receipts, strict HTTP partitions and current private projections', async (t) => {
  const f = await ratingRuntimeFixture();
  t.after(() => f.close());
  const A = await f.actor(),
    R = await f.actor(),
    B = await f.actor();
  const catalog = await f.catalog(R),
    target = catalog.targets[0]!;
  const root = await f.publish(
    R,
    catalog,
    target,
    f.body(catalog, target, { authorMode: 'anonymous' }),
  );
  const config = f.app.get<RuntimeConfig>(APP_CONFIG);
  const worker = new RatingUpdatesWorker(
    f.app.get(DatabaseService),
    { ...config, RATINGS_UPDATES_PROCESSING: 'manual' },
    f.app.get(RatingsUpdatesSourceFacade),
    f.app.get(RatingUpdatesProjectionFacade),
    f.app.get(RatingUpdatesRepository),
  );
  type Actor = typeof A;
  type Subject = { id: string; revision: string };
  const get = (actor: Actor, path = '', kind = 'like-updates') =>
    f.auth(request(f.http).get(`/v1/me/ratings/${kind}${path}`), actor);
  async function page(actor: Actor) {
    const response = await get(actor);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return ratingLikeUpdatesPageSchema.parse(response.body);
  }
  async function set(
    actor: Actor,
    liked: boolean,
    subject: Subject = root,
    parent: Subject | null = null,
  ) {
    const path = `/v1/ratings/${parent ? 'replies' : 'comments'}/${subject.id}/like`;
    const current = await f.auth(request(f.http).get(path), actor);
    assert.equal(current.status, 200, JSON.stringify(current.body));
    const state = ratingLikeStateSchema.parse(current.body);
    assert.equal(state.status, 'known');
    if (state.status !== 'known')
      throw new Error('Missing native like baseline');
    const input = {
      clientRequestId: randomUUID(),
      regionId: catalog.regionId,
      targetId: target.id,
      expectedTargetRevision: target.revision,
      expectedRevision: subject.revision,
      expectedLikeRevision: state.revision,
      liked,
      ...(parent
        ? { rootId: parent.id, expectedRootRevision: parent.revision }
        : {}),
    };
    const response = await f.auth(request(f.http).put(path), actor).send(input);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const receipt = ratingLikeReceiptSchema.parse(response.body);
    assert.equal(receipt.outcome, 'applied', JSON.stringify(receipt));
    const effect = (
      await f.pool.query<{ id: string }>(
        'SELECT id FROM whaleu_ratings.effect_events WHERE actor_account_id=$1 AND request_id=$2',
        [actor.accountId, input.clientRequestId],
      )
    ).rows[0];
    assert.ok(effect);
    return effect.id;
  }
  async function publishReply(
    owner: Actor,
    replyTo: Subject | null,
    anonymous = true,
  ) {
    const input = {
      clientRequestId: randomUUID(),
      regionId: catalog.regionId,
      targetId: target.id,
      expectedTargetRevision: target.revision,
      expectedRootRevision: root.revision,
      replyTo: replyTo
        ? { replyId: replyTo.id, expectedRevision: replyTo.revision }
        : null,
      authorMode: anonymous ? ('anonymous' as const) : ('named' as const),
      body: 'Synthetic like notice reply',
      assetIds: [],
    };
    await approveRating(f.pool, {
      version: 2,
      purpose: 'publish_rating_reply',
      accountId: owner.accountId,
      clientRequestId: input.clientRequestId,
      targetId: target.id,
      targetRevision: target.revision,
      rootId: root.id,
      rootRevision: root.revision,
      replyTo: replyTo
        ? { replyId: replyTo.id, revision: replyTo.revision }
        : null,
      categoryId: catalog.categoryId,
      categoryRevision: catalog.categoryRevision,
      catalogRevision: catalog.catalogId,
      scope: { regionId: catalog.regionId },
      authorMode: input.authorMode,
      body: input.body,
      assetIds: [],
    });
    const response = await f
      .auth(
        request(f.http).post(`/v1/ratings/comments/${root.id}/replies`),
        owner,
      )
      .send(input);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.outcome, 'applied');
    return {
      id: response.body.replyId as string,
      revision: response.body.revision as string,
    };
  }
  const apply = async (...eventIds: string[]) => {
    const result = await worker.run({ mode: 'apply', eventIds });
    assert.equal(result.failed, 0, JSON.stringify(result));
    return result;
  };
  let noticeId = '',
    readAt = '';
  await t.test(
    'anonymous root author receives private notice, self has none, unlike and re-like never reset original read history',
    async () => {
      const first = await set(A, true);
      assert.deepEqual(
        (
          await f.pool.query(
            'SELECT recipient_account_id,reason FROM whaleu_ratings.notice_obligations WHERE event_id=$1',
            [first],
          )
        ).rows,
        [{ recipient_account_id: R.accountId, reason: 'like' }],
      );
      const dry = await worker.run({ eventIds: [first] });
      assert.equal(dry.materialized, 1, JSON.stringify(dry));
      assert.equal(dry.failed, 0);
      assert.equal(
        (
          await f.pool.query(
            'SELECT id FROM whaleu_notifications.rating_notices WHERE event_id=$1',
            [first],
          )
        ).rowCount,
        0,
      );
      assert.equal((await apply(first)).materialized, 1);
      assert.equal((await apply(first)).alreadyProcessed, 1);
      const before = await page(R),
        notice = before.items[0]!;
      assert.equal(notice.status, 'available');
      if (notice.status !== 'available')
        throw new Error('Missing current like notice');
      noticeId = notice.noticeId;
      assert.equal(notice.target.replyId, null);
      assert.equal(notice.preview.text, root.input.body);
      assert.equal(notice.actor.mode, 'named');
      for (const id of [A.accountId, R.accountId, first])
        assert.equal(JSON.stringify(notice).includes(id), false);
      const resolved = await get(R, `/${noticeId}/target`);
      assert.equal(resolved.body.status, 'available');
      assert.equal(resolved.body.target.replyId, null);
      assert.equal(
        (await page(R)).unreadCount,
        1,
        'Resolving a target does not mark read',
      );
      const self = await set(R, true);
      assert.equal((await apply(self)).materialized, 0);
      assert.equal(
        (
          await f.pool.query(
            'SELECT * FROM whaleu_ratings.notice_obligations WHERE event_id=$1',
            [self],
          )
        ).rowCount,
        0,
      );
      assert.equal((await apply(await set(A, false))).ignored, 1);
      assert.equal((await page(R)).items[0]!.noticeId, noticeId);
      const marked = await f
        .auth(
          request(f.http).put(`/v1/me/ratings/like-updates/${noticeId}/read`),
          R,
        )
        .send({});
      assert.equal(marked.status, 200, JSON.stringify(marked.body));
      readAt = marked.body.readAt;
      const retained = (
        await f.pool.query(
          'SELECT event_id,ordinal,created_at::text,read_at::text FROM whaleu_notifications.rating_notices WHERE id=$1',
          [noticeId],
        )
      ).rows[0];
      const second = await set(A, true),
        result = await apply(second);
      assert.equal(result.existing, 1);
      assert.equal(result.materialized, 0);
      assert.deepEqual(
        (
          await f.pool.query(
            'SELECT event_id,ordinal,created_at::text,read_at::text FROM whaleu_notifications.rating_notices WHERE id=$1',
            [noticeId],
          )
        ).rows[0],
        retained,
      );
      assert.deepEqual(
        (
          await f.pool.query(
            'SELECT outcome,notice_id FROM whaleu_notifications.rating_processing_receipts WHERE event_id=$1',
            [second],
          )
        ).rows,
        [{ outcome: 'existing', notice_id: noticeId }],
      );
      const after = await page(R);
      assert.equal(after.unreadCount, 0);
      assert.equal(after.items[0]!.readAt, readAt);
    },
  );
  await t.test(
    'reply and like HTTP routes/count/own/read remain strictly partitioned',
    async () => {
      const legacy = await get(R, '', 'updates');
      assert.equal(legacy.status, 200);
      assert.deepEqual(legacy.body.items, []);
      assert.equal(legacy.body.unreadCount, 0);
      for (const path of [`/${noticeId}/target`, '/unread-count']) {
        const response = await get(R, path, 'updates');
        assert.equal(
          response.status,
          path === '/unread-count' ? 200 : 404,
          JSON.stringify(response.body),
        );
      }
      const wrongRead = await f
        .auth(request(f.http).put(`/v1/me/ratings/updates/${noticeId}/read`), R)
        .send({});
      assert.equal(wrongRead.status, 404, JSON.stringify(wrongRead.body));
      assert.equal((await get(A, `/${noticeId}/target`)).status, 404);
      const reply = await publishReply(A, null, false);
      const replyEvent = (
        await f.pool.query<{ id: string }>(
          "SELECT id FROM whaleu_ratings.effect_events WHERE reply_id=$1 AND event_kind='reply_created'",
          [reply.id],
        )
      ).rows[0]!.id;
      assert.equal((await apply(replyEvent)).materialized, 1);
      const legacyPage = await get(R, '', 'updates');
      assert.equal(legacyPage.body.items.length, 1);
      const replyNoticeId = legacyPage.body.items[0].noticeId as string;
      assert.equal((await get(R, `/${replyNoticeId}/target`)).status, 404);
      assert.equal(
        (
          await f
            .auth(
              request(f.http).put(
                `/v1/me/ratings/like-updates/${replyNoticeId}/read`,
              ),
              R,
            )
            .send({})
        ).status,
        404,
      );
      const secondActor = await set(B, true);
      assert.equal((await apply(secondActor)).materialized, 1);
      assert.equal((await page(R)).items.length, 2);
      assert.equal(
        (await get(R, '/unread-count', 'updates')).body.unreadCount,
        1,
      );
    },
  );
  await t.test(
    'two different positive events racing share exactly one original notice and one existing receipt',
    async () => {
      const subject = await f.publish(R, catalog, target);
      const first = await set(A, true, subject);
      await set(A, false, subject);
      const second = await set(A, true, subject);
      const results = await Promise.all([apply(first), apply(second)]);
      assert.equal(
        results.reduce((n, r) => n + r.materialized, 0),
        1,
      );
      assert.equal(
        results.reduce((n, r) => n + r.existing, 0),
        1,
      );
      assert.deepEqual(
        (
          await f.pool.query(
            'SELECT outcome FROM whaleu_notifications.rating_processing_receipts WHERE event_id=ANY($1::uuid[]) ORDER BY outcome',
            [[first, second]],
          )
        ).rows,
        [{ outcome: 'existing' }, { outcome: 'materialized' }],
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT id FROM whaleu_notifications.rating_notices WHERE root_id=$1 AND kind='like'",
            [subject.id],
          )
        ).rowCount,
        1,
      );
    },
  );
  await t.test(
    'first suppressed event leaves once-key free for a later eligible positive event',
    async () => {
      const subject = await f.publish(R, catalog, target);
      const first = await set(A, true, subject);
      await setRatingReviewState(f.pool, subject.approval.decisionId, 'held');
      const denied = await apply(first);
      assert.equal(denied.suppressed, 1);
      assert.equal(denied.materialized, 0);
      assert.equal(
        (
          await f.pool.query(
            'SELECT id FROM whaleu_notifications.rating_notices WHERE event_id=$1',
            [first],
          )
        ).rowCount,
        0,
      );
      await setRatingReviewState(f.pool, subject.approval.decisionId, 'allow');
      await set(A, false, subject);
      assert.equal((await apply(await set(A, true, subject))).materialized, 1);
    },
  );
  await t.test(
    'unknown current review is retryable without a terminal receipt and recovers after authority does',
    async () => {
      const subject = await f.publish(R, catalog, target);
      const positive = await set(A, true, subject);
      await withCommunityScopeWriter(f.pool, async (tx) => {
        const eventId = randomUUID();
        await tx.query(
          "INSERT INTO whaleu_community.rating_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at) VALUES($1,$2,'allow','complete','accepted','synthetic-rating-review','synthetic-future-like-notice-review',clock_timestamp()+interval '1 hour')",
          [eventId, subject.approval.decisionId],
        );
        await tx.query(
          'UPDATE whaleu_community.rating_approval_heads SET event_id=$2 WHERE decision_id=$1',
          [subject.approval.decisionId, eventId],
        );
      });
      const pending = await apply(positive);
      assert.equal(pending.retryable, 1);
      assert.equal(pending.processed, 0);
      assert.equal(
        (
          await f.pool.query(
            'SELECT * FROM whaleu_notifications.rating_event_receipts WHERE event_id=$1',
            [positive],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT * FROM whaleu_notifications.rating_processing_receipts WHERE event_id=$1',
            [positive],
          )
        ).rowCount,
        0,
      );
      await setRatingReviewState(f.pool, subject.approval.decisionId, 'allow');
      assert.equal((await apply(positive)).materialized, 1);
    },
  );
  await t.test(
    'reply liked subject survives quote deletion and emits a named liker with private anonymous recipient',
    async () => {
      const quote = await publishReply(B, null, false),
        subject = await publishReply(R, quote);
      const positive = await set(A, true, subject, root);
      const deletion = await f
        .auth(request(f.http).delete(`/v1/ratings/replies/${quote.id}`), B)
        .send({
          clientRequestId: randomUUID(),
          regionId: catalog.regionId,
          targetId: target.id,
          rootId: root.id,
          expectedTargetRevision: target.revision,
          expectedRootRevision: root.revision,
          expectedRevision: quote.revision,
        });
      assert.equal(deletion.status, 200, JSON.stringify(deletion.body));
      assert.equal(deletion.body.outcome, 'applied');
      assert.equal((await apply(positive)).materialized, 1);
      const notice = (await page(R)).items.find(
        (item) =>
          item.status === 'available' && item.target.replyId === subject.id,
      );
      assert.ok(notice && notice.status === 'available');
      assert.equal(notice.actor.mode, 'named');
      assert.equal(notice.preview.text, 'Synthetic like notice reply');
      assert.equal(JSON.stringify(notice).includes(R.accountId), false);
      assert.equal(JSON.stringify(notice).includes(quote.id), false);
    },
  );
  await t.test(
    'hostile existing/materialized receipt substitution and read reversal fail exact DB guards',
    async () => {
      const subject = await f.publish(R, catalog, target),
        pending = await set(A, true, subject);
      for (const outcome of ['existing', 'materialized'])
        await assert.rejects(() =>
          f.app.get(DatabaseService).transaction(async (tx) => {
            await f.app
              .get(RatingUpdatesRepository)
              .owner(R.accountId, tx, true);
            await tx.query(
              "INSERT INTO whaleu_notifications.rating_processing_receipts(event_id,recipient_account_id,reason,outcome,notice_id) VALUES($1,$2,'like',$3,$4)",
              [pending, R.accountId, outcome, noticeId],
            );
            await tx.query(
              "INSERT INTO whaleu_notifications.rating_event_receipts(event_id,outcome) VALUES($1,'processed')",
              [pending],
            );
          }),
        );
      await assert.rejects(() =>
        f.pool.query(
          'UPDATE whaleu_notifications.rating_notices SET read_at=NULL WHERE id=$1',
          [noticeId],
        ),
      );
      await assert.rejects(() =>
        f.pool.query(
          'UPDATE whaleu_notifications.rating_notices SET event_id=$2 WHERE id=$1',
          [noticeId, pending],
        ),
      );
      await assert.rejects(() =>
        f.pool.query(
          "INSERT INTO whaleu_notifications.rating_processing_receipts(event_id,recipient_account_id,reason,outcome,code,notice_id) VALUES($1,$2,'like','suppressed','denied',$3)",
          [pending, R.accountId, noticeId],
        ),
      );
      assert.equal(
        (await apply(pending)).materialized,
        1,
        'Failed forged receipts rollback completely',
      );
    },
  );
  await t.test(
    'deleted root retains original read state and current notices become locator-free generic unavailable',
    async () => {
      await set(B, false);
      const pending = await set(B, true);
      const deletion = await f
        .auth(request(f.http).delete(`/v1/ratings/comments/${root.id}`), R)
        .send({
          clientRequestId: randomUUID(),
          regionId: catalog.regionId,
          targetId: target.id,
          expectedTargetRevision: target.revision,
          expectedRevision: root.revision,
        });
      assert.equal(deletion.status, 200, JSON.stringify(deletion.body));
      assert.equal(deletion.body.outcome, 'applied');
      assert.equal((await apply(pending)).suppressed, 1);
      assert.deepEqual((await get(R, `/${noticeId}/target`)).body, {
        noticeId,
        status: 'unavailable',
      });
      const retained = (await page(R)).items.find(
        (item) => item.noticeId === noticeId,
      )!;
      assert.deepEqual(retained, {
        noticeId,
        status: 'unavailable',
        createdAt: retained.createdAt,
        readAt,
      });
      const marked = await f
        .auth(
          request(f.http).put(`/v1/me/ratings/like-updates/${noticeId}/read`),
          R,
        )
        .send({});
      assert.equal(marked.status, 200);
      assert.equal(marked.body.readAt, readAt);
    },
  );
});
