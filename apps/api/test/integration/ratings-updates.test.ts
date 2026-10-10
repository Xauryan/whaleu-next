import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import type { PoolClient } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import { APP_CONFIG } from '../../src/config/config.js';
import type { RuntimeConfig } from '../../src/config/config.js';
import { DatabaseService } from '../../src/database/database.js';
import { RatingsUpdatesSourceFacade } from '../../src/ratings/updates-source/facade.js';
import { RatingUpdatesProjectionFacade } from '../../src/ratings/updates-source/projection.js';
import { createRatingReplySchema } from '../../src/ratings/discussion-contracts.js';
import { RatingsRepository } from '../../src/ratings/repository.js';
import { RatingUpdatesRepository } from '../../src/notifications/ratings/repository.js';
import { RatingUpdatesWorker } from '../../src/notifications/ratings/worker.js';
import {
  ratingUpdatesPageSchema,
  ratingNoticeTargetSchema,
  ratingNoticeReadSchema,
} from '../../src/notifications/ratings/contracts.js';
import {
  approveRating,
  ratingRuntimeFixture,
  setRatingReviewState,
} from '../support/rating-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { observeRatingsCiQueries } from '../support/ratings-ci-diagnostics.js';
import type { RatingsCiStage } from '../support/ratings-ci-diagnostics.js';

/** Synthetic facts, real AppModule HTTP, canonical review and actual local
 * materializer. The only selected configuration is explicit manual processing. */
test('rating direct updates: real obligations, atomic local materialization, owner HTTP and lifecycle', async (t) => {
  const f = await ratingRuntimeFixture();
  t.after(() => f.close());
  const A = await f.actor(),
    R = await f.actor(),
    P = await f.actor();
  const catalog = await f.catalog(R),
    target = catalog.targets[0]!;
  const root = await f.publish(R, catalog, target);
  const config = f.app.get<RuntimeConfig>(APP_CONFIG);
  const worker = new RatingUpdatesWorker(
    f.app.get(DatabaseService),
    { ...config, RATINGS_UPDATES_PROCESSING: 'manual' },
    f.app.get(RatingsUpdatesSourceFacade),
    f.app.get(RatingUpdatesProjectionFacade),
    f.app.get(RatingUpdatesRepository),
  );
  type Actor = typeof A;
  async function publishReply(
    actor: Actor,
    replyTo: { id: string; revision: string } | null,
    anonymous = false,
    chain = { catalog, target, root },
  ) {
    const { catalog, target, root } = chain;
    const input = createRatingReplySchema.parse({
      clientRequestId: randomUUID(),
      regionId: catalog.regionId,
      targetId: target.id,
      expectedTargetRevision: target.revision,
      expectedRootRevision: root.revision,
      replyTo: replyTo
        ? { replyId: replyTo.id, expectedRevision: replyTo.revision }
        : null,
      authorMode: anonymous ? 'anonymous' : 'named',
      body: 'Synthetic rating notification reply',
      assetIds: [],
    });
    const approval = await approveRating(f.pool, {
      version: 2,
      purpose: 'publish_rating_reply',
      accountId: actor.accountId,
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
        actor,
      )
      .send(input);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(
      response.body.outcome,
      'applied',
      JSON.stringify(response.body),
    );
    const event = (
      await f.pool.query<{ id: string }>(
        'SELECT id FROM whaleu_ratings.effect_events WHERE actor_account_id=$1 AND request_id=$2',
        [actor.accountId, input.clientRequestId],
      )
    ).rows[0];
    assert.ok(event);
    return {
      id: response.body.replyId as string,
      revision: response.body.revision as string,
      eventId: event.id,
      input,
      approval,
    };
  }
  const direct = await publishReply(P, null);
  const nested = await publishReply(A, direct, true);
  const get = (actor: Actor, path = '', query: Record<string, unknown> = {}) =>
    f
      .auth(request(f.http).get(`/v1/me/ratings/updates${path}`), actor)
      .query(query);
  const count = async (actor: Actor) => {
    const response = await get(actor, '/unread-count');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.unreadCount as number;
  };
  let rootNotice = '',
    directNotice = '';
  await t.test(
    'captured nested recipient set differs from experience beneficiaries and dry-run has no writes',
    async () => {
      const recipients = (
        await f.pool.query(
          'SELECT recipient_account_id,reason FROM whaleu_ratings.notice_obligations WHERE event_id=$1 ORDER BY reason',
          [nested.eventId],
        )
      ).rows;
      assert.deepEqual(recipients, [
        { recipient_account_id: P.accountId, reason: 'direct_reply' },
        { recipient_account_id: R.accountId, reason: 'direct_root' },
      ]);
      const before = await f.snapshot();
      const result = await worker.run({ eventIds: [nested.eventId] });
      assert.equal(result.materialized, 2);
      assert.equal(result.failed, 0);
      assert.deepEqual(
        await f.snapshot(),
        before,
        'Dry-run changes no owner, attempt, receipt, notice, source or sequence',
      );
      assert.equal(
        await count(R),
        0,
        'Pending obligations are not unread notices',
      );
    },
  );
  await t.test(
    'two simultaneous real workers materialize all recipients once and HTTP shows current anonymous preview',
    async () => {
      const results = await Promise.all([
        worker.run({ mode: 'apply', eventIds: [nested.eventId] }),
        worker.run({ mode: 'apply', eventIds: [nested.eventId] }),
      ]);
      assert.equal(
        results.reduce((n, result) => n + result.materialized, 0),
        2,
      );
      assert.equal(
        results.reduce((n, result) => n + result.alreadyProcessed, 0),
        1,
      );
      assert.equal(
        results.reduce((n, result) => n + result.failed, 0),
        0,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT * FROM whaleu_notifications.rating_processing_receipts WHERE event_id=$1',
            [nested.eventId],
          )
        ).rowCount,
        2,
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT * FROM whaleu_notifications.rating_event_receipts WHERE event_id=$1 AND outcome='processed'",
            [nested.eventId],
          )
        ).rowCount,
        1,
      );
      for (const [actor, reason] of [
        [R, 'direct_root'],
        [P, 'direct_reply'],
      ] as const) {
        const response = await get(actor);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.match(response.headers['cache-control'] ?? '', /no-store/);
        assert.match(response.headers['vary'] ?? '', /Authorization/i);
        const page = ratingUpdatesPageSchema.parse(response.body);
        assert.equal(page.items.length, 1);
        assert.equal(page.unreadCount, 1);
        const item = page.items[0]!;
        assert.equal(item.status, 'available');
        if (item.status !== 'available')
          throw new Error('Expected current reply');
        assert.equal(item.reason, reason);
        assert.equal(item.target.replyId, nested.id);
        assert.equal(item.preview.author.mode, 'anonymous');
        assert.equal(JSON.stringify(item).includes(A.accountId), false);
        assert.equal(JSON.stringify(item).includes(P.accountId), false);
        assert.equal(JSON.stringify(item).includes(R.accountId), false);
        if (actor === R) rootNotice = item.noticeId;
        else directNotice = item.noticeId;
        const resolved = await get(actor, `/${item.noticeId}/target`);
        assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
        assert.equal(
          ratingNoticeTargetSchema.parse(resolved.body).status,
          'available',
        );
        assert.equal(
          await count(actor),
          1,
          'Resolving target does not mark it read',
        );
      }
      assert.equal(await count(A), 0, 'Actor receives no self-notice');
    },
  );
  await t.test(
    'owner-only read state is idempotent and preserves exact SQL microseconds',
    async () => {
      const foreign = await get(A, `/${rootNotice}/target`);
      assert.equal(foreign.status, 404);
      assert.equal(foreign.body.error.code, 'NOTICE_NOT_FOUND');
      assert.equal(
        (
          await f
            .auth(
              request(f.http).put(`/v1/me/ratings/updates/${rootNotice}/read`),
              A,
            )
            .send({})
        ).status,
        404,
      );
      const first = await f
        .auth(
          request(f.http).put(`/v1/me/ratings/updates/${rootNotice}/read`),
          R,
        )
        .send({});
      assert.equal(first.status, 200, JSON.stringify(first.body));
      const read = ratingNoticeReadSchema.parse(first.body);
      const second = await f
        .auth(
          request(f.http).put(`/v1/me/ratings/updates/${rootNotice}/read`),
          R,
        )
        .send({});
      assert.deepEqual(second.body, first.body);
      const stored = (
        await f.pool.query<{ read_at: string }>(
          `SELECT to_char(read_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') read_at FROM whaleu_notifications.rating_notices WHERE id=$1`,
          [rootNotice],
        )
      ).rows[0]!;
      assert.equal(read.readAt, stored.read_at);
      assert.equal(read.unreadCount, 0);
      assert.equal(await count(P), 1);
    },
  );
  await t.test(
    'strict owner transport rejects unknown and duplicate queries, payloads and excessive page limits',
    async () => {
      for (const path of [
        '?limit=21',
        '?limit=1&limit=2',
        '?accountId=' + A.accountId,
        '/unread-count?all=true',
      ])
        assert.equal(
          (
            await f.auth(
              request(f.http).get('/v1/me/ratings/updates' + path),
              R,
            )
          ).status,
          400,
          path,
        );
      assert.equal(
        (
          await f
            .auth(request(f.http).get('/v1/me/ratings/updates'), R)
            .send({ unexpected: true })
        ).status,
        400,
      );
      assert.equal(
        (
          await f
            .auth(
              request(f.http).put(`/v1/me/ratings/updates/${rootNotice}/read`),
              R,
            )
            .send({ all: true })
        ).status,
        400,
      );
    },
  );
  await t.test(
    'all actor/root/direct author overlap cases have the exact local recipient set',
    async () => {
      const rootOwnedParent = await publishReply(R, null);
      const cases = [
        {
          actor: A,
          parent: rootOwnedParent,
          expected: [[R.accountId, 'direct_reply']],
        },
        { actor: P, parent: direct, expected: [[R.accountId, 'direct_root']] },
        { actor: R, parent: direct, expected: [[P.accountId, 'direct_reply']] },
        { actor: R, parent: rootOwnedParent, expected: [] },
        { actor: R, parent: null, expected: [] },
      ];
      for (const entry of cases) {
        const reply = await publishReply(entry.actor, entry.parent);
        const expected = entry.expected.sort((a, b) =>
          a[0]!.localeCompare(b[0]!),
        );
        const obligations = (
          await f.pool.query<{ recipient_account_id: string; reason: string }>(
            'SELECT recipient_account_id,reason FROM whaleu_ratings.notice_obligations WHERE event_id=$1 ORDER BY recipient_account_id',
            [reply.eventId],
          )
        ).rows;
        assert.deepEqual(
          obligations.map((row) => [row.recipient_account_id, row.reason]),
          expected,
        );
        const result = await worker.run({
          mode: 'apply',
          eventIds: [reply.eventId],
        });
        assert.equal(result.failed, 0, JSON.stringify(result));
        assert.equal(result.materialized, expected.length);
        assert.equal(result.processed, 1);
      }
    },
  );
  await t.test(
    'maximum-twenty opaque pages follow exact immutable ordinal and reject cross-owner or limit reuse',
    async () => {
      const selected: string[] = [];
      for (let i = 0; i < 21; i++)
        selected.push((await publishReply(A, null)).eventId);
      const applied = await worker.run({ mode: 'apply', eventIds: selected });
      assert.equal(applied.materialized, 21, JSON.stringify(applied));
      assert.equal(applied.failed, 0);
      const firstResponse = await get(R, '', { limit: 20 });
      assert.equal(
        firstResponse.status,
        200,
        JSON.stringify(firstResponse.body),
      );
      const first = ratingUpdatesPageSchema.parse(firstResponse.body);
      assert.equal(first.items.length, 20);
      assert.match(first.nextCursor!, /^[A-Za-z0-9_-]{43}$/);
      const secondResponse = await get(R, '', {
        limit: 20,
        cursor: first.nextCursor,
      });
      assert.equal(
        secondResponse.status,
        200,
        JSON.stringify(secondResponse.body),
      );
      const second = ratingUpdatesPageSchema.parse(secondResponse.body);
      assert.equal(second.nextCursor, null);
      const expected = (
        await f.pool.query<{ id: string }>(
          'SELECT id FROM whaleu_notifications.rating_notices WHERE recipient_account_id=$1 ORDER BY ordinal DESC',
          [R.accountId],
        )
      ).rows.map((row) => row.id);
      assert.deepEqual(
        [...first.items, ...second.items].map((item) => item.noticeId),
        expected,
      );
      for (const invalid of [
        await get(P, '', { limit: 20, cursor: first.nextCursor }),
        await get(R, '', { limit: 10, cursor: first.nextCursor }),
      ])
        assert.ok(
          [400, 409].includes(invalid.status),
          JSON.stringify(invalid.body),
        );
    },
  );
  await t.test(
    'future current review evidence retries the entire event and current evidence recovery materializes once',
    async () => {
      const pending = await publishReply(A, direct);
      await withCommunityScopeWriter(f.pool, async (tx) => {
        const event = randomUUID();
        await tx.query(
          `INSERT INTO whaleu_community.rating_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at) VALUES($1,$2,'allow','complete','accepted','synthetic-rating-review','synthetic-future-review',clock_timestamp()+interval '1 hour')`,
          [event, pending.approval.decisionId],
        );
        await tx.query(
          'UPDATE whaleu_community.rating_approval_heads SET event_id=$2 WHERE decision_id=$1',
          [pending.approval.decisionId, event],
        );
      });
      const unavailable = await worker.run({
        mode: 'apply',
        eventIds: [pending.eventId],
      });
      assert.equal(unavailable.retryable, 1, JSON.stringify(unavailable));
      assert.equal(unavailable.materialized, 0);
      assert.equal(unavailable.processed, 0);
      assert.equal(
        (
          await f.pool.query(
            'SELECT * FROM whaleu_notifications.rating_processing_receipts WHERE event_id=$1',
            [pending.eventId],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT * FROM whaleu_notifications.rating_event_receipts WHERE event_id=$1',
            [pending.eventId],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT * FROM whaleu_notifications.rating_retry_attempts WHERE event_id=$1',
            [pending.eventId],
          )
        ).rowCount,
        1,
      );
      await setRatingReviewState(f.pool, pending.approval.decisionId, 'allow');
      const recovered = await worker.run({
        mode: 'apply',
        eventIds: [pending.eventId],
      });
      assert.equal(recovered.materialized, 2, JSON.stringify(recovered));
      assert.equal(recovered.processed, 1);
      assert.equal(recovered.failed, 0);
      assert.equal(
        (await worker.run({ mode: 'apply', eventIds: [pending.eventId] }))
          .alreadyProcessed,
        1,
      );
    },
  );
  await t.test(
    'an explicit current regional scope denial is terminal suppression without a notice',
    async () => {
      const regional = await f.catalog(R, { regionId: f.scope.home.regionId });
      const regionalTarget = regional.targets[0]!;
      const regionalRoot = await f.publish(R, regional, regionalTarget);
      const pending = await publishReply(A, null, false, {
        catalog: regional,
        target: regionalTarget,
        root: regionalRoot,
      });
      await withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          `INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,'school_admin',$3,$2,'synthetic-rating-updates-deny')`,
          [randomUUID(), R.accountId, f.scope.foreign.regionId],
        ),
      );
      const result = await worker.run({
        mode: 'apply',
        eventIds: [pending.eventId],
      });
      assert.equal(result.suppressed, 1, JSON.stringify(result));
      assert.equal(result.failed, 0);
      assert.equal(result.retryable, 0);
      assert.equal(result.materialized, 0);
      assert.equal(
        (
          await f.pool.query(
            'SELECT * FROM whaleu_notifications.rating_notices WHERE event_id=$1',
            [pending.eventId],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT * FROM whaleu_notifications.rating_processing_receipts WHERE event_id=$1 AND outcome='suppressed'",
            [pending.eventId],
          )
        ).rowCount,
        1,
      );
    },
  );
  await t.test(
    'deleting the referenced reply retains the later reply notice and navigation',
    async () => {
      const response = await f
        .auth(request(f.http).delete(`/v1/ratings/replies/${direct.id}`), P)
        .send({
          clientRequestId: randomUUID(),
          regionId: catalog.regionId,
          targetId: target.id,
          rootId: root.id,
          expectedTargetRevision: target.revision,
          expectedRootRevision: root.revision,
          expectedRevision: direct.revision,
        });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.outcome, 'applied');
      const resolved = await get(P, `/${directNotice}/target`);
      assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
      assert.equal(resolved.body.status, 'available');
      assert.equal(resolved.body.target.replyId, nested.id);
    },
  );
  await t.test(
    'root deletion makes every materialized preview generic, preserves unread history and suppresses pending source',
    async () => {
      const pending = await publishReply(A, null);
      const materializing = await publishReply(A, null);
      const unread = await count(P);
      const otherUnreadNotice = (
        await f.pool.query<{ id: string }>(
          'SELECT id FROM whaleu_notifications.rating_notices WHERE recipient_account_id=$1 AND read_at IS NULL AND id<>$2 ORDER BY ordinal LIMIT 1',
          [P.accountId, directNotice],
        )
      ).rows[0]!.id;
      let arrived!: () => void, release!: () => void;
      const atOwner = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      class BarrierRepository extends RatingUpdatesRepository {
        override async owner(
          accountId: string,
          tx: PoolClient,
          write = false,
        ): Promise<void> {
          arrived();
          await gate;
          return super.owner(accountId, tx, write);
        }
      }
      // Opt-in red run restores precisely the old unconditional reply assertion.
      // The same deleted-first schedule must then fail with HTTP 500, rather
      // than relying on PostgreSQL's choice of a waiting lock's admission order.
      const reproduceLegacyObserver =
        process.env['WHALEU_RATINGS_REPRODUCE_LEGACY_OBSERVER'] === '1';
      const observer = observeRatingsCiQueries(f.app, {
        syntheticFixture: 'ratings-updates',
        enabled:
          reproduceLegacyObserver ||
          process.env['WHALEU_RATINGS_CI_DIAGNOSTICS'] === '1',
      });
      const traces = new Map<
        number,
        {
          stage: RatingsCiStage;
          rootDeleted: boolean | null;
        }[]
      >();
      let liveTransaction: number | undefined,
        deletedTransaction: number | undefined,
        armed: 'alive' | 'deleted' | null = null;
      const barrier = () => {
        let resolve!: () => void;
        const promise = new Promise<void>((done) => {
          resolve = done;
        });
        return { promise, resolve };
      };
      const liveAtOwner = barrier(),
        liveGate = barrier(),
        deletedAtTarget = barrier(),
        deletedGate = barrier();
      const projectionOrder = (transaction: number, deleted: boolean) => {
        const trace = traces.get(transaction)!;
        assert.equal(trace.at(-1)?.stage, 'notification-owner');
        const projections = trace.slice(0, -1);
        const expected: RatingsCiStage[] = deleted
          ? ['target-lock', 'root-read']
          : ['target-lock', 'root-read', 'reply-read'];
        assert.ok(projections.length > 0, 'List must project real notices');
        assert.equal(projections.length % expected.length, 0);
        for (let i = 0; i < projections.length; i += expected.length) {
          const chain = projections.slice(i, i + expected.length);
          assert.deepEqual(
            chain.map((event) => event.stage),
            expected,
            'Every notification parent chain must finish before its owner read',
          );
          assert.equal(chain[1]!.rootDeleted, deleted);
        }
        if (deleted)
          assert.equal(
            projections.some((event) => event.stage === 'reply-read'),
            false,
            'A tombstoned root must not read reply content',
          );
      };
      observer.setBeforeHook(async (event) => {
        if (event.stage === 'target-lock' && event.lock === 'share' && armed) {
          if (armed === 'alive') liveTransaction = event.transaction;
          else deletedTransaction = event.transaction;
          const schedule = armed;
          armed = null;
          if (schedule === 'deleted') {
            deletedAtTarget.resolve();
            await deletedGate.promise;
          }
        }
        if (
          event.stage === 'notification-owner' &&
          event.lock === 'share' &&
          event.transaction === liveTransaction
        ) {
          liveAtOwner.resolve();
          await liveGate.promise;
        }
      });
      observer.setHook(async (event) => {
        if (
          event.transaction !== liveTransaction &&
          event.transaction !== deletedTransaction
        )
          return;
        if (event.transaction === deletedTransaction)
          assert.equal(
            /\b(?:FROM|JOIN)\s+whaleu_ratings\.replies\b/.test(event.sql),
            false,
            'Deleted-first list must perform zero reply reads, including final proof',
          );
        if (
          event.lock !== 'share' ||
          ![
            'target-lock',
            'root-read',
            'reply-read',
            'notification-owner',
          ].includes(event.stage)
        )
          return;
        const trace = traces.get(event.transaction) ?? [];
        trace.push({ stage: event.stage, rootDeleted: event.rootDeleted });
        traces.set(event.transaction, trace);
        if (event.stage === 'notification-owner') {
          // This opt-in branch is the historical invalid assertion, preserved
          // only as a deterministic red/green verification interface.
          if (reproduceLegacyObserver) {
            assert.ok(
              trace.some((read) => read.stage === 'target-lock'),
              'Owner read must follow target projection',
            );
            assert.ok(
              trace.some((read) => read.stage === 'reply-read'),
              'Owner read must follow reply projection',
            );
          }
          projectionOrder(
            event.transaction,
            event.transaction === deletedTransaction,
          );
        }
      });
      const blockedWorker = new RatingUpdatesWorker(
        f.app.get(DatabaseService),
        { ...config, RATINGS_UPDATES_PROCESSING: 'manual' },
        f.app.get(RatingsUpdatesSourceFacade),
        f.app.get(RatingUpdatesProjectionFacade),
        new BarrierRepository(),
      );
      const processing = blockedWorker.run({
        mode: 'apply',
        eventIds: [materializing.eventId],
      });
      let deleting: Promise<request.Response> | undefined,
        liveListing: Promise<request.Response> | undefined,
        deletedListing: Promise<request.Response> | undefined,
        deletionCompleted = false;
      try {
        await Promise.race([
          atOwner,
          processing.then((result) => {
            throw new Error(
              'Materializer did not reach the owner barrier: ' +
                JSON.stringify(result),
            );
          }),
        ]);
        // Alive-first: complete target/root/reply reads before DELETE even
        // starts, but pause before owner acquisition. Both readers hold parents.
        armed = 'alive';
        liveListing = get(P).then((response) => response);
        await Promise.race([
          liveAtOwner.promise,
          liveListing.then(() => {
            throw new Error('Alive list missed owner barrier');
          }),
        ]);
        deleting = f
          .auth(request(f.http).delete(`/v1/ratings/comments/${root.id}`), R)
          .send({
            clientRequestId: randomUUID(),
            regionId: catalog.regionId,
            targetId: target.id,
            expectedTargetRevision: target.revision,
            expectedRevision: root.revision,
          })
          .then((response) => {
            deletionCompleted = true;
            return response;
          });
        await f.waitForLock('FROM whaleu_ratings.targets');
        assert.equal(
          deletionCompleted,
          false,
          'Deletion must wait for the alive parent-chain readers',
        );
        // Deleted-first: stop before the first parent read, so this transaction
        // cannot observe an alive root or block DELETE on a parent SHARE lock.
        armed = 'deleted';
        deletedListing = get(P).then((response) => response);
        await Promise.race([
          deletedAtTarget.promise,
          deletedListing.then(() => {
            throw new Error('Deleted list missed target barrier');
          }),
        ]);
        const read = await Promise.race([
          f
            .auth(
              request(f.http).put(
                `/v1/me/ratings/updates/${directNotice}/read`,
              ),
              P,
            )
            .send({})
            .then((response) => response),
          delay(1500).then(() => {
            throw new Error(
              'Owner-only markRead waited on a rating parent chain',
            );
          }),
        ]);
        assert.equal(read.status, 200, JSON.stringify(read.body));
        assert.equal(read.body.unreadCount, unread - 1);
        liveGate.resolve();
        const aliveList = await liveListing;
        assert.equal(aliveList.status, 200, JSON.stringify(aliveList.body));
        const alivePage = ratingUpdatesPageSchema.parse(aliveList.body);
        assert.equal(alivePage.unreadCount, unread - 1);
        assert.equal(
          alivePage.items.every((item) => item.status === 'available'),
          true,
        );
        assert.ok(liveTransaction !== undefined);
        projectionOrder(liveTransaction, false);
        assert.equal(
          deletionCompleted,
          false,
          'The materializer still holds the alive parent chain',
        );
        release();
        const [processed, response] = await Promise.all([processing, deleting]);
        assert.equal(processed.failed, 0, JSON.stringify(processed));
        assert.equal(processed.materialized, 1);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(response.body.outcome, 'applied');
        // Only a committed DELETE permits the second list's first parent read.
        deletedGate.resolve();
        const concurrentList = await deletedListing;
        if (reproduceLegacyObserver) {
          assert.equal(
            concurrentList.status,
            500,
            'Legacy observer must produce HTTP 500 on this deleted-first schedule',
          );
          assert.ok(
            observer
              .snapshot()
              .failures.some(
                ({ error }) =>
                  error.transaction === deletedTransaction &&
                  error.stage === 'notification-owner' &&
                  error.boundary === 'after-hook' &&
                  error.exception === 'AssertionError',
              ),
            'The 500 must originate in the obsolete observer assertion',
          );
          assert.fail(
            'Legacy observer regression reproduced: deleted-first owner follows tombstone without a reply read',
          );
        }
        assert.equal(
          concurrentList.status,
          200,
          JSON.stringify(concurrentList.body),
        );
        const deletedPage = ratingUpdatesPageSchema.parse(concurrentList.body);
        assert.equal(deletedPage.unreadCount, unread - 1);
        assert.equal(
          deletedPage.items.every((item) => item.status === 'unavailable'),
          true,
        );
        for (const item of deletedPage.items)
          assert.deepEqual(Object.keys(item).sort(), [
            'createdAt',
            'noticeId',
            'readAt',
            'status',
          ]);
        assert.ok(deletedTransaction !== undefined);
        projectionOrder(deletedTransaction, true);
      } finally {
        release();
        liveGate.resolve();
        deletedGate.resolve();
        // Drain outstanding requests before restoring observation or the fixture.
        await Promise.allSettled([
          processing,
          ...[deleting, liveListing, deletedListing].filter(
            (value) => value !== undefined,
          ),
        ]);
        observer.restore();
        if (observer.enabled) t.diagnostic(JSON.stringify(observer.snapshot()));
      }
      const suppressed = await worker.run({
        mode: 'apply',
        eventIds: [pending.eventId],
      });
      assert.equal(suppressed.failed, 0, JSON.stringify(suppressed));
      assert.equal(suppressed.suppressed, 1);
      assert.equal(suppressed.materialized, 0);
      const targetResponse = await get(P, `/${directNotice}/target`);
      assert.deepEqual(targetResponse.body, {
        noticeId: directNotice,
        status: 'unavailable',
      });
      const list = await get(P);
      assert.equal(list.status, 200, JSON.stringify(list.body));
      const page = ratingUpdatesPageSchema.parse(list.body);
      assert.equal(page.unreadCount, unread - 1);
      assert.equal(
        page.items.every((item) => item.status === 'unavailable'),
        true,
      );
      for (const item of page.items)
        assert.deepEqual(Object.keys(item).sort(), [
          'createdAt',
          'noticeId',
          'readAt',
          'status',
        ]);
      const read = await f
        .auth(
          request(f.http).put(
            `/v1/me/ratings/updates/${otherUnreadNotice}/read`,
          ),
          P,
        )
        .send({});
      assert.equal(read.status, 200, JSON.stringify(read.body));
      assert.equal(read.body.unreadCount, unread - 2);
    },
  );
  await t.test(
    'raw receipt/notice forgery and read-state reversal fail under database causal guards',
    async () => {
      await assert.rejects(() =>
        f.pool.query(
          'UPDATE whaleu_notifications.rating_notices SET read_at=NULL WHERE id=$1',
          [rootNotice],
        ),
      );
      await assert.rejects(() =>
        f.pool.query(
          'UPDATE whaleu_notifications.rating_notices SET recipient_account_id=$2 WHERE id=$1',
          [rootNotice, A.accountId],
        ),
      );
      await assert.rejects(() =>
        f.pool.query(
          "INSERT INTO whaleu_notifications.rating_processing_receipts(event_id,recipient_account_id,reason,outcome,code) VALUES($1,$2,'direct_root','materialized',NULL)",
          [direct.eventId, R.accountId],
        ),
      );
      await assert.rejects(() =>
        f.pool.query(
          "UPDATE whaleu_notifications.rating_event_receipts SET outcome='ignored',code='no_direct_updates' WHERE event_id=$1",
          [nested.eventId],
        ),
      );
    },
  );
  await t.test(
    'twenty distinct target/root/reply previews use sixty-one Ratings and 121 Review facts without quote body reads',
    async () => {
      const many = await f.catalog(R, { count: 20 });
      const selected: { eventId: string; id: string }[] = [];
      const quoteIds: string[] = [];
      for (const target of many.targets) {
        const root = await f.publish(R, many, target);
        const chain = { catalog: many, target, root };
        const parent = await publishReply(P, null, false, chain);
        quoteIds.push(parent.id);
        selected.push(await publishReply(A, parent, false, chain));
      }
      const result = await worker.run({
        mode: 'apply',
        eventIds: selected.map((reply) => reply.eventId),
      });
      assert.equal(result.failed, 0, JSON.stringify(result));
      assert.equal(result.materialized, 40);
      const records = f.app.get(RatingsRepository),
        originalEnable = records.enable.bind(records);
      const restores: (() => void)[] = [],
        seen = new WeakSet<PoolClient>();
      let final = false;
      const counts = {
        catalog: 0,
        target: 0,
        root: 0,
        reply: 0,
        reviewBindings: 0,
        reviewTimes: 0,
        safetySlots: 0,
        safetyFences: 0,
      };
      const bodies: string[] = [],
        finalSql: string[] = [];
      records.enable = (tx) => {
        originalEnable(tx);
        if (seen.has(tx)) return;
        seen.add(tx);
        const query = tx.query.bind(tx);
        tx.query = (async (sql: string, values?: unknown[]) => {
          if (sql === 'SET CONSTRAINTS ALL IMMEDIATE') final = true;
          if (final) {
            finalSql.push(sql);
            if (sql.includes('JOIN whaleu_ratings.catalog_heads'))
              counts.catalog = (values?.[0] as unknown[]).length;
            if (sql.includes('JOIN whaleu_ratings.targets t'))
              counts.target = (values?.[0] as unknown[]).length;
            if (sql.includes('JOIN whaleu_ratings.comments c'))
              counts.root = (values?.[0] as unknown[]).length;
            if (sql.includes('JOIN whaleu_ratings.replies r'))
              counts.reply = (values?.[0] as unknown[]).length;
            if (
              sql.includes(
                'LEFT JOIN whaleu_community.rating_approval_bindings b',
              )
            )
              counts.reviewBindings = (values?.[0] as unknown[]).length;
            if (
              sql.includes('WITH instant AS MATERIALIZED') &&
              sql.includes('wanted AS')
            )
              counts.reviewTimes = (values?.[0] as unknown[]).length;
            if (
              sql ===
              'LOCK TABLE whaleu_safety.discovery_count_epochs IN SHARE MODE NOWAIT'
            )
              counts.safetyFences++;
          } else if (sql.includes('SELECT r.*,r.ordinal::text'))
            bodies.push(String(values?.[0]));
          const result = await query(sql, values);
          if (
            final &&
            sql.includes(
              'SELECT slot,version,epoch::text FROM whaleu_safety.discovery_count_epochs',
            )
          )
            counts.safetySlots = result.rows.length;
          return result;
        }) as typeof tx.query;
        restores.push(() => {
          tx.query = query;
        });
      };
      try {
        const response = await get(R, '', { limit: 20 });
        assert.equal(response.status, 200, JSON.stringify(response.body));
        const page = ratingUpdatesPageSchema.parse(response.body);
        assert.equal(page.items.length, 20);
        assert.equal(
          page.items.every((item) => item.status === 'available'),
          true,
        );
        assert.deepEqual(counts, {
          catalog: 1,
          target: 20,
          root: 20,
          reply: 20,
          reviewBindings: 60,
          reviewTimes: 60,
          safetySlots: 128,
          safetyFences: 1,
        });
        assert.equal(
          counts.catalog + counts.target + counts.root + counts.reply,
          61,
        );
        assert.equal(1 + counts.reviewBindings + counts.reviewTimes, 121);
        assert.deepEqual(
          [...new Set(bodies)].sort(),
          selected.map((reply) => reply.id).sort(),
        );
        assert.equal(
          bodies.some((id) => quoteIds.includes(id)),
          false,
        );
        assert.ok(
          finalSql.every((sql) => !/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)),
        );
      } finally {
        records.enable = originalEnable;
        for (const restore of restores) restore();
      }
    },
  );
});
