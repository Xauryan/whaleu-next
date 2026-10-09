import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { ratingCategoryFixture } from '../support/rating-category-fixture.js';
import { approveRating } from '../support/rating-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { canonicalRatingEnvelope } from '../../src/community/content-review/rating-contracts.js';
import {
  ratingTargetPreparationSchema,
  ratingTargetCreationReceiptSchema,
} from '../../src/ratings/management/contracts.js';

// The legacy M1 protocol is deliberately unmodified. SQL attaches exact source
// lineage to its real create_target transition after it seals/moves the head.
test('M3A native global category supports old M1 exact copy and later global release preserves every membership', async (t) => {
  const f = await ratingCategoryFixture();
  t.after(() => f.close());
  const actor = await f.actor();
  await f.grant(actor, 'developer');
  const initial = await f.createCategories(actor);
  const root = initial.receipt.categories[0]!;
  const before = initial.receipt.catalogs.find(
    (row) => row.regionId === null,
  )!.catalogRevision;
  const staleIntent = f.categoryIntent(await f.categoryContext(actor), {
    nodes: [
      {
        key: 'stale',
        parentKey: null,
        name: 'Concurrent category',
        description: '',
      },
    ],
  });
  const stalePreparation = await f.prepareCategories(actor, staleIntent);
  await f.approveCategories(actor, staleIntent);
  const policy = randomUUID();
  await withCommunityScopeWriter(f.pool, async (tx) => {
    await tx.query(
      `INSERT INTO whaleu_ratings.native_create_policies(id,region_id,generic_kind,source_reference,policy_reference,issuer,revision,enabled,coverage,provenance,effective_at,valid_until)
      VALUES($1,NULL,'general','synthetic-category-target-source','synthetic-category-target-policy','synthetic-owning-issuer',1,true,'complete','accepted',clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 hour')`,
      [policy],
    );
    await tx.query(
      "INSERT INTO whaleu_ratings.native_create_policy_heads VALUES('global','general',$1)",
      [policy],
    );
  });
  const intent = {
    clientRequestId: randomUUID(),
    regionId: null,
    categoryId: root.id,
    expectedCategoryRevision: root.revision,
    expectedCatalogRevision: before,
    name: 'Native-category target',
    description: 'Original M1 protocol',
    assetIds: [],
  };
  const post = (route: string, body: object) =>
    f
      .auth(request(f.http).post(`/v1/ratings/management/${route}`), actor)
      .send(body);
  const prepare = await post('prepare', intent);
  assert.equal(prepare.status, 200, JSON.stringify(prepare.body));
  const prepared = ratingTargetPreparationSchema.parse(prepare.body);
  const persisted = (
    await f.pool.query<{ envelope: unknown }>(
      'SELECT envelope FROM whaleu_ratings.target_preparations WHERE account_id=$1 AND request_id=$2',
      [actor.accountId, intent.clientRequestId],
    )
  ).rows[0]!;
  await approveRating(f.pool, canonicalRatingEnvelope(persisted.envelope));
  const applied = await post('targets', {
    ...intent,
    expectedContextRevision: prepared.contextRevision,
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  const receipt = ratingTargetCreationReceiptSchema.parse(applied.body);
  if (receipt.outcome !== 'applied') assert.fail(JSON.stringify(receipt));
  const exact = (
    await f.pool.query<{ exact: boolean }>(
      `SELECT
    m.source_kind='target_create' AND m.before_catalog_id=$1 AND m.target_id=$3
    AND t.before_catalog_id=$1 AND t.after_catalog_id=$2
    AND NOT EXISTS((SELECT to_jsonb(l)-'catalog_id' FROM whaleu_ratings.catalog_category_lineage l WHERE catalog_id=$1
      EXCEPT SELECT to_jsonb(l)-'catalog_id' FROM whaleu_ratings.catalog_category_lineage l WHERE catalog_id=$2)
      UNION ALL (SELECT to_jsonb(l)-'catalog_id' FROM whaleu_ratings.catalog_category_lineage l WHERE catalog_id=$2
      EXCEPT SELECT to_jsonb(l)-'catalog_id' FROM whaleu_ratings.catalog_category_lineage l WHERE catalog_id=$1))
    AND whaleu_ratings.category_catalog_compat_current($2) exact
    FROM whaleu_ratings.catalog_materializations m JOIN whaleu_ratings.target_create_transitions t ON t.target_id=m.target_id WHERE m.catalog_id=$2`,
      [before, receipt.catalogRevision, receipt.targetId],
    )
  ).rows[0];
  assert.equal(
    exact?.exact,
    true,
    'M1 must copy the exact lineage tuple, not recreate it from current base heads',
  );
  const stale = await f.commitCategories(
    actor,
    staleIntent,
    stalePreparation.contextRevision,
  );
  assert.deepEqual(stale.body, {
    requestId: staleIntent.clientRequestId,
    operation: 'create_categories',
    outcome: 'rejected',
    code: 'RATING_CATEGORY_CONTEXT_CHANGED',
  });
  const membership = (
    await f.pool.query(
      "SELECT to_jsonb(m)-'catalog_id' row FROM whaleu_ratings.target_memberships m WHERE catalog_id=$1 ORDER BY ordinal",
      [receipt.catalogRevision],
    )
  ).rows;
  const next = await f.createCategories(actor, null, {
    nodes: [
      {
        key: 'second',
        parentKey: null,
        name: 'Second native root',
        description: '',
      },
    ],
  });
  const after = next.receipt.catalogs.find(
    (row) => row.regionId === null,
  )!.catalogRevision;
  assert.deepEqual(
    (
      await f.pool.query(
        "SELECT to_jsonb(m)-'catalog_id' row FROM whaleu_ratings.target_memberships m WHERE catalog_id=$1 ORDER BY ordinal",
        [after],
      )
    ).rows,
    membership,
    'Category publication must preserve a concurrent M1 addition after renewed CAS',
  );
  const summary = await f.auth(
    request(f.http).get(
      `/v1/ratings/targets/${receipt.targetId}/score-summary`,
    ),
    actor,
  );
  assert.equal(summary.status, 200, JSON.stringify(summary.body));
  assert.equal(summary.body.status, 'known');
  const scored = await f
    .auth(
      request(f.http).put(`/v1/ratings/targets/${receipt.targetId}/my-score`),
      actor,
    )
    .send({
      clientRequestId: randomUUID(),
      regionId: null,
      expectedTargetRevision: receipt.revision,
      expectedRevision: null,
      score: 4,
    });
  assert.equal(scored.body.outcome, 'applied', JSON.stringify(scored.body));
  assert.deepEqual(
    (
      await post('targets', {
        ...intent,
        expectedContextRevision: prepared.contextRevision,
      })
    ).body,
    receipt,
    'Original M1 history wins before new category/catalog eligibility',
  );
  await assert.rejects(
    withCommunityScopeWriter(f.pool, async (tx) => {
      const forged = randomUUID();
      await tx.query(
        `INSERT INTO whaleu_ratings.catalogs(id,region_id,coverage,provenance,source_reference,policy_reference,effective_at)
      VALUES($1,NULL,'complete','accepted','rating-create:forged-copy','synthetic-policy',clock_timestamp())`,
        [forged],
      );
      await tx.query(
        'INSERT INTO whaleu_ratings.categories SELECT $2,id,revision,parent_id,level,origin_kind,kind,system_key,name,description,active,hidden,ordinal FROM whaleu_ratings.categories WHERE catalog_id=$1 ORDER BY level,ordinal',
        [after, forged],
      );
      await tx.query(
        'INSERT INTO whaleu_ratings.catalog_category_lineage SELECT $2,category_id,effective_revision,source_kind,base_revision,scope_version_id,topology_snapshot_id FROM whaleu_ratings.catalog_category_lineage WHERE catalog_id=$1',
        [after, forged],
      );
      await tx.query(
        `INSERT INTO whaleu_ratings.catalog_materializations(catalog_id,source_kind,before_catalog_id,target_id,topology_snapshot_id,campus_ids)
      SELECT $2,'target_create',$1,$3,topology_snapshot_id,campus_ids FROM whaleu_ratings.catalog_materializations WHERE catalog_id=$1`,
        [after, forged, receipt.targetId],
      );
      await tx.query(
        'UPDATE whaleu_ratings.catalogs SET sealed=true WHERE id=$1',
        [forged],
      );
    }),
    'A copied lineage sidecar cannot borrow a retained unrelated create_target transition',
  );
});

test('M3A opaque historical sources are preserved but cannot become canonical parents or erase native sources', async (t) => {
  const f = await ratingCategoryFixture();
  t.after(() => f.close());
  const actor = await f.actor();
  await f.grant(actor, 'super_admin');
  const opaque = await f.catalog(actor, { count: 1 });
  const oldCategories = (
    await f.pool.query(
      "SELECT to_jsonb(c)-'catalog_id' row FROM whaleu_ratings.categories c WHERE catalog_id=$1 ORDER BY ordinal",
      [opaque.catalogId],
    )
  ).rows;
  assert.deepEqual((await f.categoryContext(actor)).parents, []);
  const created = await f.createCategories(actor);
  const current = created.receipt.catalogs.find(
    (row) => row.regionId === null,
  )!.catalogRevision;
  assert.deepEqual(
    (
      await f.pool.query(
        "SELECT to_jsonb(c)-'catalog_id' row FROM whaleu_ratings.categories c WHERE catalog_id=$1 AND id=$2 ORDER BY ordinal",
        [current, opaque.categoryId],
      )
    ).rows,
    oldCategories,
  );
  assert.equal(
    (
      await f.pool.query(
        'SELECT 1 FROM whaleu_ratings.category_identities WHERE id=$1',
        [opaque.categoryId],
      )
    ).rowCount,
    0,
    'Opaque effective rows are never silently adopted as native bases',
  );
  const native = created.receipt.categories[0]!;
  await assert.rejects(
    withCommunityScopeWriter(f.pool, async (tx) => {
      const empty = randomUUID();
      await tx.query(
        `INSERT INTO whaleu_ratings.catalogs(id,region_id,coverage,provenance,source_reference,policy_reference,effective_at) VALUES($1,NULL,'complete','accepted','synthetic-empty-replacement','synthetic-policy',clock_timestamp())`,
        [empty],
      );
      await tx.query(
        'UPDATE whaleu_ratings.catalogs SET sealed=true WHERE id=$1',
        [empty],
      );
      await tx.query(
        "UPDATE whaleu_ratings.catalog_heads SET catalog_id=$1 WHERE scope_key='global'",
        [empty],
      );
    }),
    'An opaque replacement cannot erase a native canonical source',
  );
  const child = await f.createCategories(actor, null, {
    parentId: native.id,
    expectedParentRevision: native.revision,
    nodes: [
      {
        key: 'child',
        parentKey: null,
        name: 'Canonical child',
        description: '',
      },
    ],
  });
  assert.equal(child.receipt.categories[0]?.parentId, native.id);
  assert.equal(child.receipt.categories[0]?.level, 2);
});

test('M3A compatibility is invalidated by exact Campus topology inventory and zero-row source writers fence both Ratings epochs', async (t) => {
  const f = await ratingCategoryFixture();
  t.after(() => f.close());
  const actor = await f.actor();
  await f.grant(actor, 'developer');
  const created = await f.createCategories(actor);
  const catalogs = created.receipt.catalogs.map((row) => row.catalogRevision);
  const epochs = async () =>
    (
      await f.pool.query<{ pool: string; navigation: string }>(`SELECT
    (SELECT epoch::text FROM whaleu_ratings.random_pool_epoch WHERE singleton) pool,
    (SELECT epoch::text FROM whaleu_ratings.navigation_epoch WHERE singleton) navigation`)
    ).rows[0]!;
  const before = await epochs();
  await withCommunityScopeWriter(f.pool, (tx) =>
    tx.query(
      'UPDATE whaleu_campus.campus_region_assignments SET operating_region_id=operating_region_id WHERE false',
    ),
  );
  const after = await epochs();
  assert.ok(BigInt(after.pool) > BigInt(before.pool));
  assert.ok(BigInt(after.navigation) > BigInt(before.navigation));
  assert.equal(
    (
      await f.pool.query<{ n: number }>(
        'SELECT count(*)::integer n FROM unnest($1::uuid[]) id WHERE whaleu_ratings.category_catalog_compat_current(id)',
        [catalogs],
      )
    ).rows[0]?.n,
    catalogs.length,
  );
  await withCommunityScopeWriter(f.pool, (tx) =>
    tx.query('UPDATE whaleu_campus.campuses SET is_active=false WHERE id=$1', [
      f.scope.home.campusId,
    ]),
  );
  assert.equal(
    (
      await f.pool.query<{ current: boolean }>(
        'SELECT whaleu_ratings.category_catalog_compat_current($1) current',
        [
          created.receipt.catalogs.find((row) => row.regionId === null)!
            .catalogRevision,
        ],
      )
    ).rows[0]?.current,
    false,
    'Grant authority cannot fill a missing/conflicting physical campus mapping',
  );
  const context = await f.auth(
    request(f.http).get('/v1/ratings/category-management/context'),
    actor,
  );
  assert.equal(context.status, 503, JSON.stringify(context.body));
  const recovered = await f.auth(
    request(f.http).get(
      `/v1/ratings/category-management/requests/${created.input.clientRequestId}`,
    ),
    actor,
  );
  assert.deepEqual(
    recovered.body,
    created.receipt,
    'Current compatibility changes never erase old receipts',
  );
});
