import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import {
  ratingCategoryFixture,
  ratingFixtureUuid,
  ratingCategoryPrefix,
} from '../support/rating-category-fixture.js';
import {
  approveRating,
  setRatingReviewState,
} from '../support/rating-runtime-fixture.js';
import {
  appendTopologyRevision,
  withCommunityScopeWriter,
} from '../support/community-scope-fixtures.js';
import { observeDirectoryQueries } from '../support/directory-query-observer.js';
import { canonicalRatingEnvelope } from '../../src/community/content-review/rating-contracts.js';
import { canonicalRatingCategoryBase } from '../../src/community/content-review/rating-category-contracts.js';
import { RatingCategoryContentReviewFacade } from '../../src/community/content-review/rating-category-content-review.facade.js';
import { DatabaseService } from '../../src/database/database.js';
import { RatingUpdatesWorker } from '../../src/notifications/ratings/worker.js';
import { RatingUpdatesRepository } from '../../src/notifications/ratings/repository.js';
import { RatingsUpdatesSourceFacade } from '../../src/ratings/updates-source/facade.js';
import { RatingUpdatesProjectionFacade } from '../../src/ratings/updates-source/projection.js';
import { APP_CONFIG } from '../../src/config/config.js';
import type { RuntimeConfig } from '../../src/config/config.js';
import { ratingEditPrefix } from '../support/rating-edit-fixture.js';
import {
  ratingTargetCreationReceiptSchema,
  ratingTargetPreparationSchema,
} from '../../src/ratings/management/contracts.js';

type Fixture = Awaited<ReturnType<typeof ratingCategoryFixture>>;
type Actor = Awaited<ReturnType<Fixture['actor']>>;
async function nativeTarget(
  f: Fixture,
  actor: Actor,
  category: { id: string; revision: string },
) {
  const current = (
    await f.pool.query<{ catalog_id: string }>(
      "SELECT catalog_id FROM whaleu_ratings.catalog_heads WHERE scope_key='global'",
    )
  ).rows[0]!;
  const input = {
    clientRequestId: randomUUID(),
    regionId: null,
    categoryId: category.id,
    expectedCategoryRevision: category.revision,
    expectedCatalogRevision: current.catalog_id,
    name: 'Native category target',
    description: 'Target remains reviewed independently',
    assetIds: [] as [],
  };
  const preparedResponse = await f
    .auth(request(f.http).post('/v1/ratings/management/prepare'), actor)
    .send(input);
  assert.equal(
    preparedResponse.status,
    200,
    JSON.stringify(preparedResponse.body),
  );
  const prepared = ratingTargetPreparationSchema.parse(preparedResponse.body);
  const stored = (
    await f.pool.query<{ envelope: unknown }>(
      'SELECT envelope FROM whaleu_ratings.target_preparations WHERE account_id=$1 AND request_id=$2',
      [actor.accountId, input.clientRequestId],
    )
  ).rows[0]!;
  const approval = await approveRating(
    f.pool,
    canonicalRatingEnvelope(stored.envelope),
  );
  const response = await f
    .auth(request(f.http).post('/v1/ratings/management/targets'), actor)
    .send({ ...input, expectedContextRevision: prepared.contextRevision });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const receipt = ratingTargetCreationReceiptSchema.parse(response.body);
  if (receipt.outcome !== 'applied') assert.fail(JSON.stringify(receipt));
  const target = {
    id: ratingFixtureUuid(receipt.targetId),
    revision: ratingFixtureUuid(receipt.revision),
    approval,
  };
  const catalog = {
    catalogId: ratingFixtureUuid(receipt.catalogRevision),
    categoryId: category.id,
    categoryRevision: ratingFixtureUuid(category.revision),
    rootId: category.id,
    categoryIds: [category.id],
    categoryRevisions: [ratingFixtureUuid(category.revision)],
    regionId: null,
    targets: [target],
  };
  return { target, catalog, input, prepared, receipt };
}
async function installNativePolicy(f: Fixture) {
  await withCommunityScopeWriter(f.pool, async (tx) => {
    const id = randomUUID();
    await tx.query(
      "INSERT INTO whaleu_ratings.native_create_policies(id,region_id,generic_kind,source_reference,policy_reference,issuer,revision,enabled,coverage,provenance,effective_at,valid_until) VALUES($1,NULL,'general','synthetic-category-native-source','synthetic-category-native-policy','synthetic-category-issuer',1,true,'complete','accepted',clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 hour')",
      [id],
    );
    await tx.query(
      "INSERT INTO whaleu_ratings.native_create_policy_heads VALUES('global','general',$1)",
      [id],
    );
  });
}
async function unknownReview(f: Fixture, decision: string) {
  await withCommunityScopeWriter(f.pool, async (tx) => {
    const id = randomUUID();
    await tx.query(
      "INSERT INTO whaleu_community.rating_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at) VALUES($1,$2,'allow','missing','accepted','synthetic-category-review','synthetic-incomplete-category-state',clock_timestamp())",
      [id, decision],
    );
    await tx.query(
      'UPDATE whaleu_community.rating_approval_heads SET event_id=$2 WHERE decision_id=$1',
      [decision, id],
    );
  });
}

test(
  'M3A category Review is current on ancestors, target paths, new writes, random and already materialized notices',
  { timeout: 120000 },
  async (t) => {
    const f = await ratingCategoryFixture();
    t.after(() => f.close());
    const owner = await f.actor(),
      author = await f.actor(),
      replier = await f.actor();
    await f.grant(owner, 'developer');
    await installNativePolicy(f);
    const rootRelease = await f.createCategories(owner),
      rootCategory = rootRelease.receipt.categories[0]!;
    const childRelease = await f.createCategories(owner, null, {
      parentId: rootCategory.id,
      expectedParentRevision: rootCategory.revision,
      nodes: [
        {
          key: 'child',
          parentKey: null,
          name: 'Independent child Review',
          description: '',
        },
      ],
    });
    const childCategory = childRelease.receipt.categories[0]!;
    const { target, catalog, input } = await nativeTarget(
      f,
      owner,
      childCategory,
    );
    const get = (path: string, actor = author) =>
      f.auth(request(f.http).get(path), actor);
    const root = await f.publish(author, catalog, target),
      reply = await f.publishReply(replier, catalog, target, root);
    const event = (
      await f.pool.query<{ id: string }>(
        'SELECT id FROM whaleu_ratings.effect_events WHERE actor_account_id=$1 AND request_id=$2',
        [replier.accountId, reply.input.clientRequestId],
      )
    ).rows[0]!;
    const worker = new RatingUpdatesWorker(
      f.app.get(DatabaseService),
      {
        ...f.app.get<RuntimeConfig>(APP_CONFIG),
        RATINGS_UPDATES_PROCESSING: 'manual',
      },
      f.app.get(RatingsUpdatesSourceFacade),
      f.app.get(RatingUpdatesProjectionFacade),
      f.app.get(RatingUpdatesRepository),
    );
    const processed = await worker.run({ mode: 'apply', eventIds: [event.id] });
    assert.equal(processed.failed, 0, JSON.stringify(processed));
    assert.equal(processed.materialized, 1);
    const beforeNotice = await get('/v1/me/ratings/updates');
    assert.equal(beforeNotice.status, 200, JSON.stringify(beforeNotice.body));
    assert.equal(beforeNotice.body.items[0].status, 'available');
    const noticeId = beforeNotice.body.items[0].noticeId;
    const publicPaths = [
      `/v1/ratings/categories?parentId=${rootCategory.id}`,
      `/v1/ratings/targets?categoryId=${childCategory.id}`,
      `/v1/ratings/targets/${target.id}`,
      `/v1/ratings/targets/${target.id}/score-summary`,
      `/v1/ratings/targets/${target.id}/my-score`,
      `/v1/ratings/targets/${target.id}/comments`,
      `/v1/ratings/comments/${root.id}`,
      `/v1/ratings/comments/${root.id}/replies`,
      `/v1/ratings/replies/${reply.id}`,
      `/v1/ratings/comments/${root.id}/like`,
      `/v1/ratings/targets/${target.id}/subscription`,
      `/v1/ratings/random-target?categoryId=${childCategory.id}`,
    ];
    for (const path of publicPaths) {
      const response = await get(path);
      assert.equal(
        response.status,
        200,
        `${path}: ${JSON.stringify(response.body)}`,
      );
    }
    await setRatingReviewState(
      f.pool,
      rootRelease.reviewed.decisionId,
      'revoked',
    );
    const roots = await get('/v1/ratings/categories');
    assert.equal(roots.status, 200, JSON.stringify(roots.body));
    assert.ok(
      !roots.body.items.some(
        (item: { id: string }) => item.id === rootCategory.id,
      ),
    );
    for (const path of publicPaths) {
      const response = await get(path);
      assert.equal(
        response.status,
        404,
        `${path}: ${JSON.stringify(response.body)}`,
      );
    }
    const editContext = await get(
      `${ratingEditPrefix}/targets/${target.id}/context`,
      owner,
    );
    assert.equal(editContext.status, 404, JSON.stringify(editContext.body));
    const staleCreate = await f
      .auth(request(f.http).post('/v1/ratings/management/prepare'), owner)
      .send({
        ...input,
        clientRequestId: randomUUID(),
        expectedCatalogRevision: catalog.catalogId,
      });
    assert.equal(staleCreate.status, 404, JSON.stringify(staleCreate.body));
    const notices = await get('/v1/me/ratings/updates');
    assert.equal(notices.status, 200, JSON.stringify(notices.body));
    assert.equal(notices.body.items[0].noticeId, noticeId);
    assert.equal(notices.body.items[0].status, 'unavailable');
    assert.equal(notices.body.items[0].preview, undefined);
    // Durable recovery and author cleanup remain independent of category denial.
    assert.equal(
      (
        await get(
          `/v1/ratings/management/requests/${input.clientRequestId}`,
          owner,
        )
      ).body.outcome,
      'applied',
    );
    assert.equal(
      (
        await get(
          `${ratingCategoryPrefix}/requests/${rootRelease.input.clientRequestId}`,
          owner,
        )
      ).body.outcome,
      'applied',
    );
    const childReview = await f.app.get(DatabaseService).transaction(
      (tx) =>
        f.app.get(RatingCategoryContentReviewFacade).current(
          canonicalRatingCategoryBase({
            categoryId: childCategory.id,
            baseRevision: childCategory.revision,
            envelope: childRelease.reviewed.envelope,
          }),
          tx,
        ),
      { isolationLevel: 'read committed' },
    );
    assert.equal(
      childReview.kind,
      'allow',
      'Only the ancestor is denied; child approval cannot bypass it',
    );
    await unknownReview(f, rootRelease.reviewed.decisionId);
    const unknownList = await get('/v1/ratings/categories');
    assert.equal(unknownList.status, 503, JSON.stringify(unknownList.body));
    const unknownTarget = await get(`/v1/ratings/targets/${target.id}`);
    assert.equal(unknownTarget.status, 503, JSON.stringify(unknownTarget.body));
    const unknownRandom = await get(
      `/v1/ratings/random-target?categoryId=${childCategory.id}`,
    );
    assert.equal(unknownRandom.status, 503, JSON.stringify(unknownRandom.body));
    const unknownNotices = await get('/v1/me/ratings/updates');
    assert.equal(
      unknownNotices.status,
      200,
      JSON.stringify(unknownNotices.body),
    );
    assert.equal(unknownNotices.body.items[0].status, 'unavailable');
    const deleted = await f.deleteRoot(author, catalog, target, root);
    assert.equal(deleted.outcome, 'applied', JSON.stringify(deleted));
  },
);

test(
  'M3A category Review fixed proof crosses 520 reads and retains a post-deferred visibility deadline',
  { timeout: 120000 },
  async (t) => {
    const f = await ratingCategoryFixture();
    t.after(() => f.close());
    const owner = await f.actor();
    await f.grant(owner, 'developer');
    const created = await f.createCategories(owner),
      category = created.receipt.categories[0]!;
    const descriptor = canonicalRatingCategoryBase({
      categoryId: category.id,
      baseRevision: category.revision,
      envelope: created.reviewed.envelope,
    });
    const observer = observeDirectoryQueries(f.app);
    t.after(() => observer.restore());
    const fences: string[] = [];
    observer.setHook(async ({ sql }) => {
      if (sql.startsWith('LOCK TABLE whaleu_community.rating_review_epoch'))
        fences.push(sql);
    });
    await f.app.get(DatabaseService).transaction(
      async (tx) => {
        for (let count = 0; count < 640; count += 128) {
          const decisions = await f.app
            .get(RatingCategoryContentReviewFacade)
            .currentBatch(
              Array.from({ length: 128 }, () => descriptor),
              tx,
            );
          assert.ok(decisions.every((decision) => decision.kind === 'allow'));
        }
      },
      { isolationLevel: 'read committed' },
    );
    assert.equal(
      fences.length,
      1,
      'All category reads share one fixed final Review fence',
    );
    observer.setHook(null);
    const before = await f.categoryContext(owner),
      input = f.categoryIntent(before),
      prepared = await f.prepareCategories(owner, input);
    const until = new Date(Date.now() + 8000);
    await f.approveCategories(owner, input, { visibilityUntil: until });
    const committed = await f.commitCategories(
      owner,
      input,
      prepared.contextRevision,
    );
    assert.equal(committed.status, 200, JSON.stringify(committed.body));
    let held = false;
    observer.setHook(async ({ sql }, tx) => {
      if (!held && sql === 'SET CONSTRAINTS ALL IMMEDIATE') {
        held = true;
        await tx.query(
          'SELECT pg_sleep(greatest(0,extract(epoch from ($1::timestamptz-clock_timestamp())))+0.02)',
          [until],
        );
      }
    });
    const response = await f.auth(
      request(f.http).get('/v1/ratings/categories'),
      owner,
    );
    assert.ok(held, 'The real deferred boundary was reached');
    assert.equal(response.status, 503, JSON.stringify(response.body));
    observer.setHook(null);
  },
);

test(
  'M3A empty global random pool retains native topology expiry through the real deferred boundary',
  { timeout: 120000 },
  async (t) => {
    const f = await ratingCategoryFixture();
    t.after(() => f.close());
    const until = Date.now() + 10000;
    f.scope.topologySnapshotId = await appendTopologyRevision(
      f.pool,
      f.scope.topology,
      { validUntil: until },
    );
    const owner = await f.actor();
    await f.grant(owner, 'developer');
    const created = await f.createCategories(owner),
      category = created.receipt.categories[0]!;
    const before = await f
      .auth(request(f.http).get('/v1/ratings/random-target'), owner)
      .query({ categoryId: category.id });
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.equal(before.body.candidateCount, 0);
    assert.equal(before.body.item, null);
    const observer = observeDirectoryQueries(f.app);
    t.after(() => observer.restore());
    let held = false,
      capturedDeadline = false;
    observer.setHook(async ({ sql }, tx) => {
      if (
        sql.includes('WITH ORDINALITY s(region_id,ordinal)') &&
        sql.includes('category_catalog_compat_until')
      )
        capturedDeadline = true;
      if (!held && sql === 'SET CONSTRAINTS ALL IMMEDIATE') {
        held = true;
        await tx.query(
          'SELECT pg_sleep(greatest(0,extract(epoch from ($1::timestamptz-clock_timestamp())))+0.02)',
          [new Date(until)],
        );
      }
    });
    const expired = await f
      .auth(request(f.http).get('/v1/ratings/random-target'), owner)
      .query({ categoryId: category.id });
    assert.ok(
      capturedDeadline && held,
      'The empty pool must capture the topology deadline before its deferred boundary',
    );
    assert.equal(expired.status, 503, JSON.stringify(expired.body));
    assert.equal(expired.body.error.code, 'RATING_UNAVAILABLE');
    observer.setHook(null);
  },
);

test(
  'M3A native category sources remain mandatory for prepared M2B edits and post-deferred finalization',
  { timeout: 120000 },
  async (t) => {
    for (const mode of [
      'head',
      'revoked_ancestor',
      'category_deadline',
    ] as const) {
      await t.test(mode, async (t) => {
        const f = await ratingCategoryFixture();
        t.after(() => f.close());
        const owner = await f.actor();
        await f.grant(owner, 'developer');
        await installNativePolicy(f);
        const categoryInput = f.categoryIntent(await f.categoryContext(owner));
        const categoryPreparation = await f.prepareCategories(
          owner,
          categoryInput,
        );
        const until = new Date(Date.now() + 3000);
        const approval = await f.approveCategories(
          owner,
          categoryInput,
          mode === 'category_deadline' ? { visibilityUntil: until } : {},
        );
        const published = await f.commitCategories(
          owner,
          categoryInput,
          categoryPreparation.contextRevision,
        );
        assert.equal(published.status, 200, JSON.stringify(published.body));
        const category = categoryPreparation.categories[0]!;
        const { target } = await nativeTarget(f, owner, category);
        const before = await f.editContext(owner, target.id);
        const input = f.editIntent(before, {
          name: 'Must keep category proof',
          description: 'Exact reviewed update',
        });
        const prepared = await f.prepareEdit(owner, input);
        await f.approveEdit(owner, input);
        const snapshot = async () =>
          (
            await f.pool.query(
              `SELECT t.revision,h.content_version,h.definition_revision,
            (SELECT count(*)::integer FROM whaleu_ratings.target_definition_versions WHERE target_id=t.id) versions,
            (SELECT count(*)::integer FROM whaleu_ratings.target_edit_transitions WHERE target_id=t.id) transitions
           FROM whaleu_ratings.targets t JOIN whaleu_ratings.target_definition_heads h ON h.target_id=t.id WHERE t.id=$1`,
              [target.id],
            )
          ).rows[0];
        const retained = await snapshot();
        const observer = observeDirectoryQueries(f.app);
        t.after(() => observer.restore());
        let tentative = false,
          waited = false;
        if (mode === 'head') {
          await f.createCategories(owner);
        } else if (mode === 'revoked_ancestor') {
          await setRatingReviewState(f.pool, approval.decisionId, 'revoked');
        } else {
          observer.setHook(async ({ sql }, tx) => {
            if (sql.startsWith('UPDATE whaleu_ratings.target_definition_heads'))
              tentative = true;
            if (!waited && sql === 'SET CONSTRAINTS ALL IMMEDIATE') {
              assert.ok(
                tentative,
                'The real new target definition was tentative before finalization',
              );
              waited = true;
              await tx.query(
                'SELECT pg_sleep(greatest(0,extract(epoch from ($1::timestamptz-clock_timestamp())))+0.02)',
                [until],
              );
            }
          });
        }
        const response = await f.commitEdit(
          owner,
          input,
          prepared.contextRevision,
        );
        observer.restore();
        if (mode === 'category_deadline') {
          assert.ok(waited);
          assert.equal(response.status, 503, JSON.stringify(response.body));
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
                [owner.accountId, input.clientRequestId],
              )
            ).rowCount,
            0,
          );
        } else {
          assert.equal(response.status, 200, JSON.stringify(response.body));
          assert.equal(response.body.outcome, 'rejected');
          assert.equal(
            response.body.code,
            mode === 'head'
              ? 'RATING_EDIT_CONTEXT_CHANGED'
              : 'RATING_NOT_FOUND',
          );
        }
        assert.deepEqual(
          await snapshot(),
          retained,
          'No partial target edit survives a changed native category prerequisite',
        );
      });
    }
  },
);
