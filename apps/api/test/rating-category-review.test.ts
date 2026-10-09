import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../src/http/application-error.js';
import { canonicalJson } from '../src/community/content-review/contracts.js';
import {
  canonicalRatingEnvelope,
  ratingApprovalDigest,
} from '../src/community/content-review/rating-contracts.js';
import {
  canonicalRatingCategoryBase,
  canonicalRatingCategoryEnvelope,
  ratingCategoryApprovalDigest,
} from '../src/community/content-review/rating-category-contracts.js';
import type {
  RatingCategoryEnvelope,
  RatingCategoryBaseDescriptor,
} from '../src/community/content-review/rating-category-contracts.js';
import {
  ratingCategoryBaseBindingMatches,
  validateRatingCategoryApprovalRow,
} from '../src/community/content-review/rating-category-approval-validation.js';
import type { RatingCategoryBaseBinding } from '../src/community/content-review/rating-category-approval-validation.js';
import type { RatingApprovalRow } from '../src/community/content-review/rating-approval-validation.js';
import { RatingCategoryContentReviewFacade } from '../src/community/content-review/rating-category-content-review.facade.js';
import {
  checkTransactionDeadlines,
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
  startTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import {
  RatingsRepository,
  qualifyRatingCategoryRows,
} from '../src/ratings/repository.js';
import type { CategoryRow } from '../src/ratings/repository.js';

const id = (n: number) =>
  `60000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = Date.UTC(2026, 9, 9);
const errorIs = (code: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;
function envelope(n = 0): RatingCategoryEnvelope {
  return canonicalRatingCategoryEnvelope({
    version: 4,
    purpose: 'publish_rating_categories',
    accountId: id(1),
    clientRequestId: id(100 + n),
    releaseId: id(20000 + n),
    intent: {
      clientRequestId: id(100 + n),
      regionId: id(2),
      expectedCatalogRevision: id(3),
      expectedScopeRevision: 'x'.repeat(43),
      parentId: null,
      expectedParentRevision: null,
      nodes: [
        {
          key: 'root',
          parentKey: null,
          name: 'Reviewed category',
          description: '',
        },
      ],
      assetIds: [],
    },
    scope: {
      regionId: id(2),
      topologySnapshotId: id(4),
      campusIds: [id(5)],
      scopeRevision: 'x'.repeat(43),
    },
    categories: [
      {
        key: 'root',
        id: id(10000 + n),
        revision: id(30000 + n),
        parentId: null,
        level: 1,
        name: 'Reviewed category',
        description: '',
        scopeVersionId: id(6),
      },
    ],
    catalogs: [
      {
        regionId: id(2),
        beforeCatalogId: id(3),
        afterCatalogId: id(7),
        campusIds: [id(5)],
      },
    ],
    assetIds: [],
  });
}
const descriptor = (e = envelope()): RatingCategoryBaseDescriptor =>
  canonicalRatingCategoryBase({
    categoryId: e.categories[0]!.id,
    baseRevision: e.categories[0]!.revision,
    envelope: e,
  });
function row(e = envelope()): RatingApprovalRow {
  return {
    id: id(40000 + Number(e.categories[0]!.id.slice(-12))),
    account_id: e.accountId,
    operation: e.purpose,
    envelope_version: 4,
    digest: ratingCategoryApprovalDigest(e),
    envelope: e,
    policy_revision_id: id(8),
    result: 'allow',
    coverage: 'complete',
    provenance: 'accepted',
    issuer: 'synthetic-category-review',
    provenance_ref: 'synthetic-decision',
    evaluated_at: new Date(now - 1000),
    consume_until: new Date(now + 10000),
    visibility_model: 'durable',
    visibility_until: null,
    policy_key: 'local-explicit-v1',
    policy_version: 1,
    policy_coverage: 'complete',
    policy_provenance: 'accepted',
    policy_issuer: 'synthetic-policy',
    policy_provenance_ref: 'synthetic-policy-ref',
    policy_valid_from: new Date(now - 2000),
    policy_valid_until: null,
    state: 'allow',
    event_at: new Date(now - 1000),
    event_coverage: 'complete',
    event_provenance: 'accepted',
    event_issuer: 'synthetic-event',
    event_provenance_ref: 'synthetic-event-ref',
  };
}
function binding(e = envelope(), r = row(e)): RatingCategoryBaseBinding {
  return {
    category_id: e.categories[0]!.id,
    base_revision: e.categories[0]!.revision,
    release_id: e.releaseId,
    decision_id: r.id,
    account_id: e.accountId,
    operation: e.purpose,
    envelope_version: 4,
    digest: r.digest,
    envelope: e,
    scope: e.scope,
  };
}
function fixture(envelopes = [envelope()]) {
  const records = new Map(
    envelopes.map((e) => [
      e.categories[0]!.id,
      { row: row(e), binding: binding(e) as RatingCategoryBaseBinding | null },
    ]),
  );
  const state = {
    epoch: '0',
    exact: true,
    account: true,
    boundTime: true,
    clock: now,
    finalClock: now,
    lockFailure: false,
  };
  const commands: string[] = [];
  const tx = {
    query: async (sql: string, values: unknown[] = []) => {
      commands.push(sql);
      if (sql === 'SET CONSTRAINTS ALL IMMEDIATE' || sql.includes('set_config'))
        return { rows: [] };
      if (sql.includes('current_setting'))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '5s',
              lock_timeout: '1s',
            },
          ],
        };
      if (sql.startsWith('LOCK TABLE')) {
        if (state.lockFailure) throw new Error('Synthetic current writer');
        return { rows: [] };
      }
      if (sql.includes('FROM whaleu_community.rating_review_epoch'))
        return { rows: [{ singleton: true, version: 1, epoch: state.epoch }] };
      if (sql.startsWith('SELECT id FROM whaleu_identity.accounts'))
        return { rows: state.account ? [{ id: id(1) }] : [] };
      if (sql.includes('candidate AS MATERIALIZED')) {
        const found = [...records.values()].find(
          (item) => item.row.digest === values[1],
        );
        return {
          rows: found
            ? [
                {
                  ...found.row,
                  now: new Date(state.clock),
                  exact_time: state.exact,
                },
              ]
            : [],
        };
      }
      if (
        sql.startsWith(
          'SELECT 1 FROM whaleu_community.rating_category_base_bindings',
        )
      )
        return {
          rows: [...records.values()].some(
            (item) => item.binding?.decision_id === values[0],
          )
            ? [{ exists: true }]
            : [],
        };
      if (sql.includes('WITH ORDINALITY w(category_id,base_revision,ordinal)'))
        return {
          rows: (values[0] as string[]).map((category, index) => {
            const item = records.get(category);
            return {
              ...item?.row,
              ordinal: index + 1,
              binding: item?.binding ?? null,
              account_exists: state.account,
              bound_time: state.boundTime,
              now: new Date(state.clock),
              exact_time: state.exact,
            };
          }),
        };
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date(state.finalClock) }] };
      assert.fail(`Unexpected category Review SQL: ${sql}`);
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  return {
    tx,
    state,
    records,
    commands,
    facade: new RatingCategoryContentReviewFacade(),
  };
}

test('category v4 exactly binds original intent, assigned tree, topology and release; legacy envelopes stay distinct', () => {
  const e = envelope();
  assert.equal(
    ratingCategoryApprovalDigest(e),
    createHash('sha256')
      .update(`whaleu-rating-content-approval:v4\n${canonicalJson(e)}`)
      .digest('hex'),
  );
  assert.ok(
    Object.isFrozen(e) &&
      Object.isFrozen(e.intent.nodes) &&
      Object.isFrozen(e.categories[0]) &&
      Object.isFrozen(e.catalogs[0]!.campusIds),
  );
  assert.throws(() => canonicalRatingEnvelope(e));
  for (const change of [
    { ...e, version: 1 },
    { ...e, purpose: 'publish_rating_target' },
    { ...e, targetId: id(99) },
    { ...e, intent: { ...e.intent, expectedScopeRevision: 'y'.repeat(43) } },
    {
      ...e,
      intent: {
        ...e.intent,
        nodes: [{ ...e.intent.nodes[0]!, name: 'Other text' }],
      },
    },
    { ...e, categories: [{ ...e.categories[0]!, name: 'Other text' }] },
    { ...e, categories: [{ ...e.categories[0]!, level: 2 }] },
    { ...e, scope: { ...e.scope, campusIds: [] } },
    { ...e, catalogs: [{ ...e.catalogs[0]!, campusIds: [id(9)] }] },
    { ...e, catalogs: [{ ...e.catalogs[0]!, beforeCatalogId: id(9) }] },
    {
      ...e,
      categories: [{ ...e.categories[0]!, description: ' noncanonical ' }],
    },
  ])
    assert.throws(() => canonicalRatingCategoryEnvelope(change));
  for (const change of [
    { ...e, releaseId: id(99) },
    { ...e, scope: { ...e.scope, topologySnapshotId: id(99) } },
    { ...e, categories: [{ ...e.categories[0]!, revision: id(99) }] },
    { ...e, catalogs: [{ ...e.catalogs[0]!, afterCatalogId: id(99) }] },
  ])
    assert.notEqual(
      ratingCategoryApprovalDigest(canonicalRatingCategoryEnvelope(change)),
      ratingCategoryApprovalDigest(e),
    );
  const legacy = canonicalRatingEnvelope({
    version: 1,
    purpose: 'publish_rating_target',
    accountId: id(1),
    clientRequestId: id(10),
    targetId: id(11),
    targetRevision: id(12),
    categoryId: id(13),
    categoryRevision: id(14),
    catalogRevision: id(15),
    scope: { regionId: null },
    assetIds: [],
    name: 'Legacy target',
    description: '',
  });
  assert.equal(
    ratingApprovalDigest(legacy),
    createHash('sha256')
      .update(`whaleu-rating-content-approval:v1\n${canonicalJson(legacy)}`)
      .digest('hex'),
  );
  assert.throws(() => canonicalRatingCategoryEnvelope(legacy));
});

test('category global scope requires the exact complete disjoint region campus union', () => {
  const e = envelope(),
    global = {
      ...e,
      intent: { ...e.intent, regionId: null },
      scope: { ...e.scope, regionId: null },
      catalogs: [
        { ...e.catalogs[0]!, regionId: null },
        { ...e.catalogs[0]!, beforeCatalogId: id(9), afterCatalogId: id(10) },
      ],
    };
  assert.doesNotThrow(() => canonicalRatingCategoryEnvelope(global));
  assert.throws(() =>
    canonicalRatingCategoryEnvelope({
      ...global,
      catalogs: global.catalogs.slice(0, 1),
    }),
  );
  assert.throws(() =>
    canonicalRatingCategoryEnvelope({
      ...global,
      catalogs: [
        ...global.catalogs,
        { ...global.catalogs[1]!, regionId: id(11), afterCatalogId: id(12) },
      ],
    }),
  );
});

test('category binding and authoritative denial require the exact category/base and whole batch', () => {
  const e = envelope(),
    r = row(e),
    b = binding(e, r),
    d = descriptor(e);
  assert.equal(ratingCategoryBaseBindingMatches(b, d), true);
  for (const patch of [
    { category_id: id(99) },
    { base_revision: id(99) },
    { release_id: id(99) },
    { operation: 'publish_rating_target' },
    { envelope_version: 1 },
    { scope: { regionId: id(2) } },
    { digest: '0'.repeat(64) },
  ])
    assert.equal(
      ratingCategoryBaseBindingMatches({ ...b, ...patch }, d),
      false,
    );
  assert.equal(
    validateRatingCategoryApprovalRow({ ...r, state: 'revoked' }, false, now)
      .decision.kind,
    'deny',
  );
  assert.equal(
    validateRatingCategoryApprovalRow({ ...r, state: 'held' }, false, now)
      .decision.kind,
    'deny',
  );
  assert.equal(
    validateRatingCategoryApprovalRow({ ...r, result: 'reject' }, false, now)
      .decision.kind,
    'deny',
  );
  for (const patch of [
    { digest: '0'.repeat(64) },
    { envelope_version: 1 },
    { coverage: 'missing' },
    { policy_valid_until: new Date(now) },
    { event_at: new Date(now + 1) },
  ])
    assert.equal(
      validateRatingCategoryApprovalRow(
        { ...r, state: 'revoked', ...patch },
        false,
        now,
      ).decision.kind,
      'unavailable',
    );
  assert.equal(
    validateRatingCategoryApprovalRow(
      { ...r, consume_until: new Date(now - 1) },
      false,
      now,
    ).decision.kind,
    'allow',
  );
});

test('current category Review denies revoked text and fails closed on absent, mismatched and unknown binding evidence', async () => {
  const f = fixture(),
    entry = f.records.values().next().value!;
  assert.equal((await f.facade.current(descriptor(), f.tx)).kind, 'allow');
  entry.row.state = 'revoked';
  assert.equal((await f.facade.current(descriptor(), f.tx)).kind, 'deny');
  entry.binding = { ...entry.binding!, base_revision: id(99) };
  assert.equal(
    (await f.facade.current(descriptor(), f.tx)).kind,
    'unavailable',
  );
  entry.binding = null;
  assert.equal(
    (await f.facade.current(descriptor(), f.tx)).kind,
    'unavailable',
  );
});

test('more than 520 category qualifications retain one fixed epoch proof and catch unselected revocation', async () => {
  const envelopes = Array.from({ length: 640 }, (_, index) => envelope(index)),
    f = fixture(envelopes);
  for (let index = 0; index < envelopes.length; index += 128) {
    const decisions = await f.facade.currentBatch(
      envelopes.slice(index, index + 128).map(descriptor),
      f.tx,
    );
    assert.equal(decisions.length, 128);
    assert.ok(decisions.every((decision) => decision.kind === 'allow'));
  }
  await checkTransactionDeadlines(f.tx);
  assert.equal(
    f.commands.filter((sql) =>
      sql.startsWith('LOCK TABLE whaleu_community.rating_review_epoch'),
    ).length,
    1,
  );
  f.state.epoch = '1';
  await assert.rejects(
    checkTransactionDeadlines(f.tx),
    errorIs('CONTENT_REVIEW_UNAVAILABLE'),
  );
});

test('category allow and deny both retain expiry through final deferred waits; busy fence fails closed', async () => {
  for (const state of ['allow', 'revoked'] as const) {
    const f = fixture(),
      entry = f.records.values().next().value!;
    entry.row.state = state;
    entry.row.visibility_model = 'until';
    entry.row.visibility_until = new Date(now + 5);
    assert.equal(
      (await f.facade.current(descriptor(), f.tx)).kind,
      state === 'allow' ? 'allow' : 'deny',
    );
    f.state.finalClock = now + 5;
    await assert.rejects(
      checkTransactionDeadlines(f.tx),
      errorIs('CONTENT_REVIEW_UNAVAILABLE'),
    );
  }
  const f = fixture();
  await f.facade.current(descriptor(), f.tx);
  f.state.lockFailure = true;
  await assert.rejects(
    checkTransactionDeadlines(f.tx),
    errorIs('CONTENT_REVIEW_UNAVAILABLE'),
  );
});

function categorySource(e = envelope()) {
  const node = e.categories[0]!;
  const category: CategoryRow = {
    id: node.id,
    revision: node.revision,
    parent_id: node.parentId,
    level: node.level,
    kind: 'general',
    system_key: null,
    name: node.name,
    description: node.description,
    ordinal: '0',
    active: true,
    hidden: false,
  };
  return {
    category,
    source: {
      ordinal: 1,
      lineage: {
        source_kind: 'native',
        effective_revision: node.revision,
        base_revision: node.revision,
        scope_version_id: node.scopeVersionId,
        topology_snapshot_id: e.scope.topologySnapshotId,
      },
      base: {
        category_id: node.id,
        revision: node.revision,
        parent_id: node.parentId,
        level: node.level,
        name: node.name,
        description: node.description,
        active: true,
        is_global: false,
        scope_version_id: node.scopeVersionId,
        release_id: e.releaseId,
        envelope: e,
      },
      head_revision: node.revision,
      source_scope: {
        id: node.scopeVersionId,
        region_id: e.scope.regionId,
        campus_ids: e.scope.campusIds,
        topology_snapshot_id: e.scope.topologySnapshotId,
        release_id: e.releaseId,
      },
    },
  };
}
test('public native category sources never fall back to opaque or revive revoked text through metadata', async () => {
  const fixture = categorySource(),
    catalog = { id: id(7), regionId: id(2) };
  let source: unknown = fixture.source,
    kind: 'allow' | 'deny' | 'unavailable' = 'allow';
  const tx = {
    query: async () => ({ rows: [source] }),
  } as unknown as PoolClient;
  const review = {
    currentBatch: async (values: readonly unknown[]) =>
      values.map(() => ({ kind })),
  } as unknown as RatingCategoryContentReviewFacade;
  assert.deepEqual(
    await qualifyRatingCategoryRows(review, catalog, [fixture.category], tx),
    ['allow'],
  );
  kind = 'deny';
  assert.deepEqual(
    await qualifyRatingCategoryRows(review, catalog, [fixture.category], tx),
    ['deny'],
  );
  kind = 'unavailable';
  await assert.rejects(
    qualifyRatingCategoryRows(review, catalog, [fixture.category], tx),
    errorIs('CONTENT_REVIEW_UNAVAILABLE'),
  );
  kind = 'allow';
  for (const patch of [
    { lineage: null },
    { head_revision: id(99) },
    { base: { ...fixture.source.base, name: 'Unreviewed replacement' } },
    { source_scope: { ...fixture.source.source_scope, campus_ids: [id(99)] } },
    { lineage: { ...fixture.source.lineage, source_kind: 'opaque' } },
  ]) {
    source = { ...fixture.source, ...patch };
    await assert.rejects(
      qualifyRatingCategoryRows(review, catalog, [fixture.category], tx),
    );
  }
  source = {
    ordinal: 1,
    lineage: {
      source_kind: 'opaque',
      effective_revision: fixture.category.revision,
      base_revision: null,
      scope_version_id: null,
      topology_snapshot_id: null,
    },
    base: null,
    head_revision: null,
    source_scope: null,
  };
  const noFabricatedReview = {
    currentBatch: async (values: readonly unknown[]) => {
      assert.equal(values.length, 0);
      return [];
    },
  } as unknown as RatingCategoryContentReviewFacade;
  assert.deepEqual(
    await qualifyRatingCategoryRows(
      noFabricatedReview,
      catalog,
      [fixture.category],
      tx,
    ),
    ['allow'],
  );
});

test('category ancestor denial makes target/public category unavailable; lists omit exact deny', async () => {
  const fixture = categorySource(),
    catalog = { id: id(7), regionId: id(2) };
  const review = {
    currentBatch: async () => [{ kind: 'deny', reason: 'RATING_NOT_FOUND' }],
  } as unknown as RatingCategoryContentReviewFacade;
  const tx = {
    query: async (sql: string) => {
      if (sql.includes('navigation_epoch')) return { rows: [{ epoch: '0' }] };
      if (sql.includes('catalog_category_lineage'))
        return { rows: [fixture.source] };
      if (sql.includes('FROM whaleu_ratings.categories'))
        return { rows: [fixture.category] };
      assert.fail(`Unexpected category projection SQL: ${sql}`);
    },
  } as unknown as PoolClient;
  const records = new RatingsRepository(review);
  await assert.rejects(
    records.category(catalog, fixture.category.id, tx),
    errorIs('RATING_NOT_FOUND'),
  );
  assert.deepEqual(await records.categories(catalog, null, null, 20, tx), []);
});

test('category Review facts retained before a notice savepoint survive restoration and still fence prior positives', async () => {
  const f = fixture();
  assert.equal((await f.facade.current(descriptor(), f.tx)).kind, 'allow');
  const checkpoint = checkpointTransactionDeadlines(f.tx);
  restoreTransactionDeadlines(f.tx, checkpoint);
  assert.equal((await f.facade.current(descriptor(), f.tx)).kind, 'allow');
  await checkTransactionDeadlines(f.tx);
  f.state.epoch = '1';
  await assert.rejects(
    checkTransactionDeadlines(f.tx),
    errorIs('CONTENT_REVIEW_UNAVAILABLE'),
  );
});
