import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { ApplicationError } from '../src/http/application-error.js';
import {
  canonicalRatingScopedCategorySource,
  ratingScopedApprovalDigest,
  type RatingScopedCategoryEnvelope,
} from '../src/community/content-review/rating-scoped-contracts.js';
import {
  planCategoryManagement,
  type CategorySnapshot,
  type ManagedCategoryRecord,
} from '../src/ratings/category-management/plan.js';
import {
  ratingCategoryScopedIntentHash,
  ratingCategoryScopedIntentSchema,
  ratingCategoryScopedOperations,
  type RatingCategoryScopedIntent,
  type RatingCategoryScopedOperation,
} from '../src/ratings/category-management/scoped-contracts.js';
import { ratingScopedIntentSchema } from '../src/ratings/scoped/contracts.js';
import type { ScopedExpectedCategory } from '../src/ratings/scoped/compiler.js';
import type { ScopedSourceRow } from '../src/ratings/scoped/source.facade.js';
import { ratingScopedDigest } from '../src/ratings/scoped/protocol-registry.js';

// Same stable IDs, UTF-8 payloads and published golden vectors as the native
// category-scoped-hash-vectors fixture, without importing native runtime code.
const id = (n: number) =>
  `a0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const actor = id(1),
  root = id(901),
  child = id(902),
  archivedChild = id(903),
  otherRoot = id(904);
const campusA = id(921),
  campusB = id(922),
  campusC = id(923);
const A = `campus:${campusA}`,
  B = `campus:${campusB}`,
  C = `campus:${campusC}`;
const requestId = '66666666-6666-4666-8666-666666666666';
const snapshotRevision = 'a'.repeat(64);
const expires = Date.parse('2026-11-01T00:00:00.000Z');
const context = {
  id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  token: 't'.repeat(43),
  tokenDigest: createHash('sha256').update('t'.repeat(43)).digest('hex'),
  selector: { kind: 'campus' as const, campusId: campusA },
  scopeRevision: 'b'.repeat(64),
  protocolGeneration: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  catalogRevision: '44444444-4444-4444-8444-444444444444',
  headRevision: '55555555-5555-4555-8555-555555555555',
  sourceDigest: 'c'.repeat(64),
};
function intent(
  operation: RatingCategoryScopedOperation,
  patch: Record<string, unknown> = {},
): RatingCategoryScopedIntent {
  const common = {
    clientRequestId: requestId,
    expectedSnapshot: snapshotRevision,
  };
  const category = { ...common, categoryId: root };
  const node = {
    key: 'root',
    parentKey: null,
    name: '分类 🌊',
    description: '',
  };
  const payloads = {
    create_categories_scoped: {
      ...common,
      parentId: null,
      placement: { kind: 'campuses', campusIds: [campusA] },
      nodes: [node],
    },
    edit_category_base_scoped: {
      ...category,
      name: '分类 🌊',
      description: '',
    },
    set_category_override_scoped: {
      ...category,
      name: { mode: 'inherit' },
      description: { mode: 'set', value: '' },
    },
    set_category_visibility_scoped: { ...category, hidden: true },
    reorder_categories_scoped: {
      ...common,
      parentId: null,
      action: 'set',
      orderedIds: [otherRoot, root],
    },
    set_category_scope_scoped: {
      ...category,
      placement: { kind: 'campuses', campusIds: [campusA] },
      propagation: 'subtree',
    },
    set_category_lifecycle_scoped: {
      ...category,
      state: 'disabled',
      restore: false,
    },
    batch_update_subcategories_scoped: {
      ...common,
      parentId: root,
      addNodes: [node],
      disableIds: [child],
      restoreIds: [archivedChild],
      enableIds: [],
      orderedChildren: [
        { kind: 'existing', id: child },
        { kind: 'new', key: 'root' },
        { kind: 'existing', id: archivedChild },
      ],
    },
    create_system_category_scoped: {
      ...common,
      systemKey: 'synthetic_general',
      name: '系统分类',
      description: '',
      placement: { kind: 'global' },
      levelCount: 3,
    },
  };
  return ratingCategoryScopedIntentSchema.parse({
    protocolVersion: 2,
    operation,
    context,
    payload: { ...payloads[operation], ...patch },
  });
}
const goldenHashes: Record<RatingCategoryScopedOperation, string> = {
  create_categories_scoped:
    '3adc246eec0405723be5dcda113a58525c2ad4f5291d4644523d4b014d76607f',
  edit_category_base_scoped:
    '377de0225c514e1063d2d612acac274f94b8f2a386143515612eef774a0b4829',
  set_category_override_scoped:
    '82a3ab064277542460ed922e08803c207b2c7f22e0e79f2e4feb3a0d3d714491',
  set_category_visibility_scoped:
    '16e056a0936f77e08bf6a48afefc588041cf094d258bf5e2ee987b21507d68ac',
  reorder_categories_scoped:
    '4cfa336b120deab8b9e9de976d1bd38e104d1dcb890793cc6aeb71c31960e38e',
  set_category_scope_scoped:
    '0a15599e4112cfcfa33261294d5ae110db358bc789ff31a3a359e2e3e32997b4',
  set_category_lifecycle_scoped:
    'ce486e23f50cf7a9dbfe804d491115b75bf53230510787d8f24fd496cf2b9254',
  batch_update_subcategories_scoped:
    '672a2788dcd71e511ea99ecd10288b543194b3bb1b29336323ad28a03d5e3129',
  create_system_category_scoped:
    '739021db62cf9b31ea4c822421089e405bcd75adfefbdb79e5b500d46d1e969a',
};
function source(
  n: number,
  kind: string,
  key: string,
  scopes: string[],
  payload: Record<string, unknown>,
): ScopedSourceRow {
  return {
    id: id(n),
    revision: id(n + 100000),
    source_kind: kind,
    source_key: key,
    scope_keys: [...scopes].sort(),
    payload,
    digest: ratingScopedDigest('test-source', { kind, key, scopes, payload }),
    issuer: 'synthetic-category-test-owner',
    source_reference: `synthetic:${n}`,
    policy_reference: 'synthetic:category-tests',
    valid_until: new Date(expires),
    current: true,
  };
}
function fixture(): CategorySnapshot {
  const scopes = [A, B, C, 'global'].sort();
  return {
    sources: [
      source(20, 'native_scoped_category_management', 'management', scopes, {
        enabled: true,
        operations: [...ratingCategoryScopedOperations],
      }),
      ...scopes.map((scope, n) =>
        source(30 + n, 'scope_absence', scope, [scope], {
          complete: true,
          categoryIds: [],
          targetIds: [],
          legacyCatalogIds: [],
        }),
      ),
    ],
    categories: [],
    targets: [],
    compatHeads: [],
    heads: scopes.map((scopeKey, n) => ({
      scopeKey,
      catalogRevision: id(40 + n),
      headRevision: id(50 + n),
    })),
    snapshotRevision,
    sourceDigest: 'c'.repeat(64),
    validUntil: expires,
  };
}
interface CategoryOptions {
  parentId?: string;
  level?: 1 | 2 | 3;
  ordinal?: string;
  systemKey?: string;
  maximumDepth?: 1 | 2 | 3;
}
function addCategory(
  snapshot: CategorySnapshot,
  n: number,
  scopes: string[] = [A],
  options: CategoryOptions = {},
) {
  const categoryId = id(n),
    baseId = id(n + 1000),
    revision = id(n + 101000);
  const body: ScopedExpectedCategory['body'] = {
    id: categoryId,
    parentId: options.parentId ?? null,
    level: options.level ?? 1,
    kind: 'general',
    systemKey: options.systemKey ?? null,
    isSystem: options.systemKey !== undefined,
    originKind: scopes.includes('global') ? 'global' : 'regional',
    name: `Category ${n}`,
    description: `Description ${n}`,
    active: true,
    hidden: false,
    ordinal: options.ordinal ?? String(n),
    identityKind: 'scoped_source',
    identityId: categoryId,
  };
  const envelope = canonicalRatingScopedCategorySource({
    sourceId: baseId,
    sourceRevision: revision,
    categoryId,
    envelope: {
      version: 5,
      purpose: 'publish_rating_category_base_scoped',
      accountId: actor,
      sourceId: baseId,
      sourceRevision: revision,
      categoryId,
      identityId: categoryId,
      issuanceId: baseId,
      issuanceDigest: 'd'.repeat(64),
      assetIds: [],
      placement: scopes.includes('global')
        ? { kind: 'global' }
        : { kind: 'campuses', campusIds: scopes.map((s) => s.slice(7)).sort() },
      body: {
        parentId: body.parentId,
        level: body.level,
        kind: body.kind,
        systemKey: body.systemKey,
        name: body.name,
        description: body.description,
      },
    },
  }).envelope;
  const base = source(
    n + 1000,
    'scoped_category_base',
    `category:${categoryId}`,
    scopes,
    {
      categoryId,
      active: body.active,
      hidden: body.hidden,
      ordinal: body.ordinal,
      originKind: body.originKind,
      identityKind: body.identityKind,
      identityId: categoryId,
      reviewEnvelope: envelope,
      issuanceDigest: envelope.issuanceDigest,
      ...(options.maximumDepth === undefined
        ? {}
        : { maximumDepth: options.maximumDepth }),
    },
  );
  const placement = source(
    n + 2000,
    'scoped_category_scope',
    `category:${categoryId}`,
    scopes,
    {
      categoryId,
      baseSourceId: base.id,
      baseSourceRevision: base.revision,
      scopeKeys: [...scopes],
      placementRevision: id(n + 3000),
    },
  );
  const rows: ManagedCategoryRecord[] = scopes.map((scopeKey) => ({
    scopeKey,
    catalogId: snapshot.heads.find((h) => h.scopeKey === scopeKey)!
      .catalogRevision,
    revision: id(n + 4000),
    expected: {
      body: { ...body },
      baseSourceId: base.id,
      baseSourceRevision: base.revision,
      overrideSourceId: null,
      overrideSourceRevision: null,
      lifecycleSourceId: null,
      lifecycleSourceRevision: null,
      orderSourceId: null,
      orderSourceRevision: null,
      placementRevision: id(n + 3000),
    },
    scopeKeys: [...scopes],
    placementSourceId: placement.id,
    placementSourceRevision: placement.revision,
    baseBody: { ...body },
    bodyCurrent: true,
  }));
  snapshot.sources.push(base, placement);
  snapshot.categories.push(...rows);
  refreshAbsence(snapshot);
  return { base, placement, rows, body };
}
function refreshAbsence(snapshot: CategorySnapshot) {
  for (const row of snapshot.sources.filter(
    (s) => s.source_kind === 'scope_absence',
  )) {
    row.payload['categoryIds'] = [
      ...new Set(
        snapshot.categories
          .filter((c) => c.scopeKey === row.source_key)
          .map((c) => c.expected.body.id),
      ),
    ].sort();
    row.payload['targetIds'] = [
      ...new Set(
        snapshot.targets
          .filter(
            (t) =>
              t.scopeKeys.includes(row.source_key) &&
              snapshot.categories.some(
                (c) =>
                  c.scopeKey === row.source_key &&
                  c.expected.body.id === t.categoryId,
              ),
          )
          .map((t) => t.targetId),
      ),
    ].sort();
  }
}
type FieldMode = { mode: 'inherit' } | { mode: 'set'; value: string };
function addOverride(
  snapshot: CategorySnapshot,
  category: ReturnType<typeof addCategory>,
  scope: string,
  n: number,
  modes: { name: FieldMode; description: FieldMode },
  inherit = false,
) {
  const row = source(
    n,
    'scoped_category_override',
    `category:${category.body.id}:${scope}`,
    [scope],
    {
      categoryId: category.body.id,
      baseSourceId: category.base.id,
      baseSourceRevision: category.base.revision,
      modes,
      action: inherit ? 'inherit' : 'set',
    },
  );
  if (!inherit) {
    const descriptor = canonicalRatingScopedCategorySource({
      sourceId: row.id,
      sourceRevision: row.revision,
      categoryId: category.body.id,
      envelope: {
        version: 5,
        purpose: 'publish_rating_category_override_scoped',
        accountId: actor,
        sourceId: row.id,
        sourceRevision: row.revision,
        categoryId: category.body.id,
        identityId: category.body.identityId,
        issuanceId: row.id,
        issuanceDigest: 'e'.repeat(64),
        assetIds: [],
        placement: { kind: 'campuses', campusIds: [scope.slice(7)] },
        scope: { kind: 'campus', campusId: scope.slice(7) },
        baseSourceId: category.base.id,
        baseSourceRevision: category.base.revision,
        body: {
          name:
            modes.name.mode === 'set' ? modes.name.value : category.body.name,
          description:
            modes.description.mode === 'set'
              ? modes.description.value
              : category.body.description,
        },
      },
    });
    row.payload['reviewEnvelope'] = descriptor.envelope;
    row.payload['issuanceDigest'] = descriptor.envelope.issuanceDigest;
  }
  snapshot.sources.push(row);
  for (const record of category.rows.filter((r) => r.scopeKey === scope)) {
    record.expected.overrideSourceId = row.id;
    record.expected.overrideSourceRevision = row.revision;
    record.expected.body.name =
      modes.name.mode === 'set' ? modes.name.value : category.body.name;
    record.expected.body.description =
      modes.description.mode === 'set'
        ? modes.description.value
        : category.body.description;
  }
  return row;
}
function addLifecycle(
  snapshot: CategorySnapshot,
  row: ManagedCategoryRecord,
  n: number,
  state: 'enabled' | 'disabled' | 'archived',
  hidden = false,
) {
  const life = source(
    n,
    'scoped_category_lifecycle',
    `category:${row.expected.body.id}:${row.scopeKey}`,
    [row.scopeKey],
    {
      categoryId: row.expected.body.id,
      baseSourceId: row.expected.baseSourceId,
      baseSourceRevision: row.expected.baseSourceRevision,
      active: state === 'enabled',
      hidden,
      businessState: state,
      businessStateRevision: id(n + 200000),
      authorizedExit: state !== 'enabled',
    },
  );
  snapshot.sources.push(life);
  row.expected.lifecycleSourceId = life.id;
  row.expected.lifecycleSourceRevision = life.revision;
  row.expected.body.active = state === 'enabled';
  row.expected.body.hidden = hidden;
  return life;
}
function addRegistry(
  snapshot: CategorySnapshot,
  patch: Record<string, unknown> = {},
) {
  const registry = source(
    80,
    'scoped_category_system_registry',
    'synthetic_general',
    [A, B, C, 'global'],
    {
      systemKey: 'synthetic_general',
      enabled: true,
      kind: 'general',
      consumer: 'ratings_general_v1',
      maximumDepth: 3,
      allowChildren: true,
      allowCampusOverride: true,
      allowDisable: true,
      ...patch,
    },
  );
  snapshot.sources.push(registry);
  return registry;
}
function plan(snapshot: CategorySnapshot, command: RatingCategoryScopedIntent) {
  return planCategoryManagement(
    actor,
    command,
    ratingCategoryScopedIntentHash(command),
    snapshot,
  );
}
function rejects(
  snapshot: CategorySnapshot,
  command: RatingCategoryScopedIntent,
  code: string,
) {
  assert.throws(
    () => plan(snapshot, command),
    (error: unknown) =>
      error instanceof ApplicationError && error.code === code,
  );
}
function envelopeOf(row: ScopedSourceRow): RatingScopedCategoryEnvelope {
  return canonicalRatingScopedCategorySource({
    sourceId: row.id,
    sourceRevision: row.revision,
    categoryId: row.payload['categoryId'],
    envelope: row.payload['reviewEnvelope'],
  }).envelope;
}

for (const operation of ratingCategoryScopedOperations) {
  test(`category exact UTF-8 hash vector: ${operation}`, () => {
    const value = intent(operation);
    assert.equal(
      ratingCategoryScopedIntentHash(value),
      goldenHashes[operation],
    );
    assert.equal(ratingScopedIntentSchema.safeParse(value).success, false);
    for (const extra of [
      { targetId: id(7) },
      { expectedTargetRevision: id(8) },
      { assetIds: [] },
      { reviewDecisionId: id(9) },
      { sourceId: id(10) },
    ]) {
      assert.equal(
        ratingCategoryScopedIntentSchema.safeParse({
          ...value,
          payload: { ...value.payload, ...extra },
        }).success,
        false,
      );
    }
    assert.equal(
      ratingCategoryScopedIntentSchema.safeParse({
        ...value,
        role: 'super_admin',
      }).success,
      false,
    );
    assert.notEqual(
      ratingCategoryScopedIntentHash({
        ...value,
        context: { ...value.context, sourceDigest: 'f'.repeat(64) },
      }),
      goldenHashes[operation],
    );
  });
}
test('category placement and override contracts reject implicit empty/global and ambiguous inherit', () => {
  for (const placement of [
    { kind: 'campuses', campusIds: [] },
    { kind: 'campuses', campusIds: [campusB, campusA] },
    { kind: 'campuses', campusIds: [campusA, campusA] },
    { kind: 'global', campusIds: [] },
  ]) {
    assert.throws(() => intent('create_categories_scoped', { placement }));
  }
  for (const name of [
    null,
    '',
    { mode: 'inherit', value: 'ignored' },
    { mode: 'set', value: '' },
  ])
    assert.throws(() => intent('set_category_override_scoped', { name }));
  assert.doesNotThrow(() =>
    intent('set_category_override_scoped', {
      description: { mode: 'set', value: '' },
    }),
  );
});
test('ordering is full-sibling-set CAS, preserves occupied slots, and emits no Review', () => {
  const snapshot = fixture();
  addCategory(snapshot, 901, [A], { ordinal: '10' });
  addCategory(snapshot, 904, [A], { ordinal: '90' });
  const command = intent('reorder_categories_scoped');
  const result = plan(snapshot, command);
  const order = result.sourceIssues.filter(
    (s) => s.kind === 'scoped_category_order',
  );
  assert.equal(order.length, 2);
  assert.deepEqual(
    order.map((s) => [s.payload['categoryId'], s.payload['ordinal']]),
    [
      [otherRoot, '10'],
      [root, '90'],
    ],
  );
  assert.deepEqual(result.envelopes, []);
  assert(
    result.sourceIssues.every(
      (s) => !Object.hasOwn(s.payload, 'reviewEnvelope'),
    ),
  );
  assert.deepEqual(
    result.beforeHeads,
    snapshot.heads.filter((h) => h.scopeKey === A),
  );
  rejects(
    snapshot,
    intent('reorder_categories_scoped', { orderedIds: [root] }),
    'RATING_SCOPED_CONTEXT_CHANGED',
  );
  rejects(
    snapshot,
    intent('reorder_categories_scoped', { orderedIds: [root, id(999)] }),
    'RATING_SCOPED_CONTEXT_CHANGED',
  );
  assert.throws(() =>
    intent('reorder_categories_scoped', { orderedIds: [root, root] }),
  );
  if (command.operation !== 'reorder_categories_scoped') assert.fail();
  rejects(
    snapshot,
    { ...command, payload: { ...command.payload, orderedIds: [root, root] } },
    'RATING_SCOPED_CONTEXT_CHANGED',
  );
});
test('no-op ordering retains the exact before vector and emits neither sources nor Review', () => {
  const snapshot = fixture();
  addCategory(snapshot, 901, [A], { ordinal: '10' });
  addCategory(snapshot, 904, [A], { ordinal: '90' });
  const result = plan(
    snapshot,
    intent('reorder_categories_scoped', { orderedIds: [root, otherRoot] }),
  );
  assert.equal(result.noop, true);
  assert.deepEqual(result.sourceIssues, []);
  assert.deepEqual(result.envelopes, []);
  assert.equal(
    result.beforeDigest,
    ratingScopedDigest('category-before', {
      heads: result.beforeHeads,
      vector: result.beforeVector,
    }),
  );
  assert.equal(
    result.previewDigest,
    ratingScopedDigest('category-plan', { ...result, previewDigest: '' }),
  );
});
test('base edit rebinds live and dormant exact overrides, lifecycle and ordering with fresh Review', () => {
  const snapshot = fixture(),
    category = addCategory(snapshot, 901, [A, B]);
  const live = addOverride(snapshot, category, A, 6000, {
    name: { mode: 'set', value: 'Campus A' },
    description: { mode: 'inherit' },
  });
  const dormant = addOverride(snapshot, category, C, 6001, {
    name: { mode: 'inherit' },
    description: { mode: 'set', value: '' },
  });
  const inherited = addOverride(
    snapshot,
    category,
    B,
    6002,
    { name: { mode: 'inherit' }, description: { mode: 'inherit' } },
    true,
  );
  const life = addLifecycle(
    snapshot,
    category.rows[1]!,
    6003,
    'disabled',
    true,
  );
  const order = source(
    6004,
    'scoped_category_order',
    `category:${root}:${C}`,
    [C],
    {
      categoryId: root,
      baseSourceId: category.base.id,
      baseSourceRevision: category.base.revision,
      ordinal: '7',
      action: 'set',
      parentId: null,
      siblingIds: [root],
    },
  );
  snapshot.sources.push(order);
  const before = structuredClone(snapshot);
  const result = plan(
    snapshot,
    intent('edit_category_base_scoped', {
      name: 'New base',
      description: 'New description',
    }),
  );
  assert.deepEqual(
    snapshot,
    before,
    'pure planner cannot mutate source or placement facts',
  );
  assert.deepEqual(result.affectedScopeKeys, [A, B, C]);
  assert.deepEqual(result.categoryIds, [root]);
  const base = result.sourceIssues.find(
    (s) => s.kind === 'scoped_category_base',
  );
  assert(base);
  for (const previous of [live, dormant, inherited, life, order]) {
    const next = result.sourceIssues.find(
      (s) => s.previousSourceId === previous.id,
    );
    assert(
      next,
      `missing successor of ${previous.source_kind}:${previous.source_key}`,
    );
    assert.equal(next.previousSourceRevision, previous.revision);
    assert.equal(next.payload['baseSourceId'], base.id);
    assert.equal(next.payload['baseSourceRevision'], base.revision);
    assert.deepEqual(next.scopeKeys, previous.scope_keys);
  }
  assert.equal(
    result.envelopes.length,
    3,
    'base plus live and dormant set overrides; inherit reset stays metadata',
  );
  for (const previous of [live, dormant]) {
    const next = result.sourceIssues.find(
      (s) => s.previousSourceId === previous.id,
    )!;
    const envelope = canonicalRatingScopedCategorySource({
      sourceId: next.id,
      sourceRevision: next.revision,
      categoryId: root,
      envelope: next.payload['reviewEnvelope'],
    }).envelope;
    assert.equal(envelope.purpose, 'publish_rating_category_override_scoped');
    if (envelope.purpose !== 'publish_rating_category_override_scoped')
      assert.fail();
    assert.equal(envelope.baseSourceId, base.id);
    assert.equal(envelope.baseSourceRevision, base.revision);
    assert.notEqual(
      ratingScopedApprovalDigest(envelope),
      ratingScopedApprovalDigest(envelopeOf(previous)),
    );
    assert.deepEqual(
      envelope.body,
      previous.id === live.id
        ? { name: 'Campus A', description: 'New description' }
        : { name: 'New base', description: '' },
    );
  }
  assert.equal(
    result.sourceIssues.find((s) => s.previousSourceId === inherited.id)!
      .payload['reviewEnvelope'],
    undefined,
  );
  assert.equal(
    result.sourceIssues.find((s) => s.previousSourceId === life.id)!.payload[
      'businessStateRevision'
    ],
    life.payload['businessStateRevision'],
  );
});
test('base edit needs one all-of policy including dormant source scopes and complete before heads', () => {
  for (const mode of [
    'partial-policy',
    'two-partial-policies',
    'missing-head',
    'unknown-dormant',
  ] as const) {
    const snapshot = fixture(),
      category = addCategory(snapshot, 901, [A, B]);
    const dormant = addOverride(snapshot, category, C, 6100, {
      name: { mode: 'set', value: 'Dormant' },
      description: { mode: 'inherit' },
    });
    const policy = snapshot.sources.find(
      (s) => s.source_kind === 'native_scoped_category_management',
    )!;
    if (mode === 'partial-policy' || mode === 'two-partial-policies')
      policy.scope_keys = [A, B];
    if (mode === 'two-partial-policies')
      snapshot.sources.push(
        source(6101, policy.source_kind, 'other-policy', [C], {
          ...policy.payload,
        }),
      );
    if (mode === 'missing-head')
      snapshot.heads = snapshot.heads.filter((h) => h.scopeKey !== C);
    if (mode === 'unknown-dormant') dormant.current = false;
    rejects(
      snapshot,
      intent('edit_category_base_scoped'),
      'RATING_SCOPE_UNAVAILABLE',
    );
  }
});
test('scope subtree includes B-only descendants and counts targets without moving target placements', () => {
  const snapshot = fixture();
  addCategory(snapshot, 901, [A, B]);
  addCategory(snapshot, 902, [B], { parentId: root, level: 2 });
  snapshot.targets.push(
    {
      targetId: id(7000),
      categoryId: root,
      scopeKeys: [A, B],
      placementRevision: id(7001),
    },
    {
      targetId: id(7002),
      categoryId: child,
      scopeKeys: [B],
      placementRevision: id(7003),
    },
    {
      targetId: id(7004),
      categoryId: id(999),
      scopeKeys: [B],
      placementRevision: id(7005),
    },
    {
      targetId: id(7006),
      categoryId: child,
      scopeKeys: [C],
      placementRevision: id(7007),
    },
  );
  refreshAbsence(snapshot);
  const targets = structuredClone(snapshot.targets);
  rejects(
    snapshot,
    intent('set_category_scope_scoped', { propagation: 'self' }),
    'RATING_SCOPED_CONTEXT_CHANGED',
  );
  const result = plan(snapshot, intent('set_category_scope_scoped'));
  assert.deepEqual(result.categoryIds, [root, child]);
  assert.deepEqual(result.affectedScopeKeys, [A, B]);
  assert.equal(result.globalRequired, true);
  assert.equal(result.affectedTargetCount, 2);
  assert.deepEqual(snapshot.targets, targets);
  assert(
    !result.sourceIssues.some((s) => s.kind === 'scoped_target_placement'),
  );
  const exits = result.sourceIssues.find(
    (s) => s.kind === 'scope_absence' && s.key === B,
  )!;
  assert.deepEqual(exits.payload['categoryIds'], []);
  assert.deepEqual(exits.payload['targetIds'], []);
  const entry = result.sourceIssues.find(
    (s) => s.kind === 'scope_absence' && s.key === A,
  )!;
  assert.deepEqual(entry.payload['categoryIds'], [root, child]);
  assert.deepEqual(
    entry.payload['targetIds'],
    [id(7000)],
    'B-only target does not migrate with its category',
  );
});
test('scope shrink retires duplicate placement heads instead of multiplying placements', () => {
  const snapshot = fixture(),
    category = addCategory(snapshot, 901, [A, B]);
  category.placement.scope_keys = [A];
  category.placement.payload['scopeKeys'] = [A];
  category.rows[0]!.scopeKeys = [A];
  const second = source(
    7200,
    'scoped_category_scope',
    'other-exact-placement',
    [B],
    {
      categoryId: root,
      baseSourceId: category.base.id,
      baseSourceRevision: category.base.revision,
      scopeKeys: [B],
      placementRevision: id(7201),
    },
  );
  snapshot.sources.push(second);
  Object.assign(category.rows[1]!, {
    scopeKeys: [B],
    placementSourceId: second.id,
    placementSourceRevision: second.revision,
  });
  category.rows[1]!.expected.placementRevision = id(7201);
  const result = plan(snapshot, intent('set_category_scope_scoped'));
  const scopes = result.sourceIssues.filter(
    (s) => s.kind === 'scoped_category_scope',
  );
  assert.equal(scopes.length, 2);
  assert.equal(scopes.filter((s) => s.placement !== undefined).length, 1);
  const retired = scopes.find((s) => s.payload['action'] === 'retired');
  assert(retired);
  assert.equal(retired.placement, undefined);
  assert.equal(retired.payload['authorizedExit'], true);
  assert.deepEqual(result.affectedScopeKeys, [A, B]);
});
test('system creation requires exactly one current registry and known consumer/kind/depth', () => {
  for (const mode of [
    'missing',
    'duplicate',
    'unknown',
    'disabled',
    'consumer',
    'kind',
    'depth-string',
    'depth-boolean',
    'depth-four',
  ] as const) {
    const snapshot = fixture();
    const registry = mode === 'missing' ? null : addRegistry(snapshot);
    if (mode === 'duplicate')
      snapshot.sources.push(
        source(81, 'scoped_category_system_registry', 'duplicate', ['global'], {
          ...registry!.payload,
        }),
      );
    if (mode === 'unknown') registry!.current = false;
    if (mode === 'disabled') registry!.payload['enabled'] = false;
    if (mode === 'consumer')
      registry!.payload['consumer'] = 'unknown_specialized_consumer';
    if (mode === 'kind') registry!.payload['kind'] = 'course';
    if (mode === 'depth-string') registry!.payload['maximumDepth'] = '3';
    if (mode === 'depth-boolean') registry!.payload['maximumDepth'] = true;
    if (mode === 'depth-four') registry!.payload['maximumDepth'] = 4;
    rejects(
      snapshot,
      intent('create_system_category_scoped', { levelCount: 1 }),
      'RATING_SCOPE_UNAVAILABLE',
    );
  }
  const snapshot = fixture(),
    registry = addRegistry(snapshot);
  const result = plan(snapshot, intent('create_system_category_scoped'));
  assert.equal(result.globalRequired, true);
  assert.deepEqual(result.registrySourceIds, [registry.id]);
  assert.equal(result.envelopes.length, 1);
  assert.equal(
    result.envelopes[0]!.purpose,
    'publish_rating_category_base_scoped',
  );
});
test('system children obey both registry and configured root depth and allowChildren', () => {
  for (const mode of [
    'configured-depth',
    'registry-depth',
    'children-denied',
  ] as const) {
    const snapshot = fixture();
    addRegistry(
      snapshot,
      mode === 'registry-depth'
        ? { maximumDepth: 1 }
        : mode === 'children-denied'
          ? { allowChildren: false }
          : {},
    );
    addCategory(snapshot, 901, [A], {
      systemKey: 'synthetic_general',
      maximumDepth: mode === 'configured-depth' ? 1 : 3,
    });
    rejects(
      snapshot,
      intent('create_categories_scoped', { parentId: root }),
      mode === 'children-denied'
        ? 'RATING_NOT_FOUND'
        : 'RATING_SCOPED_CONTEXT_CHANGED',
    );
  }
  const snapshot = fixture();
  const nodes = [
    { key: 'root', parentKey: null, name: 'Root', description: '' },
    { key: 'child', parentKey: 'root', name: 'Child', description: '' },
    { key: 'leaf', parentKey: 'child', name: 'Leaf', description: '' },
    {
      key: 'overflow',
      parentKey: 'leaf',
      name: 'Fourth level',
      description: '',
    },
  ];
  rejects(
    snapshot,
    intent('create_categories_scoped', { nodes }),
    'RATING_SCOPED_CONTEXT_CHANGED',
  );
});
test('archive restores only to disabled, retains hidden metadata and requires a separate enable', () => {
  const snapshot = fixture(),
    category = addCategory(snapshot, 901, [A, B]);
  addLifecycle(snapshot, category.rows[0]!, 7300, 'archived', true);
  addLifecycle(snapshot, category.rows[1]!, 7301, 'archived', false);
  for (const payload of [
    { state: 'enabled', restore: true },
    { state: 'enabled', restore: false },
    { state: 'disabled', restore: false },
  ]) {
    rejects(
      snapshot,
      intent('set_category_lifecycle_scoped', payload),
      'RATING_NOT_FOUND',
    );
  }
  const result = plan(
    snapshot,
    intent('set_category_lifecycle_scoped', {
      state: 'disabled',
      restore: true,
    }),
  );
  const lives = result.sourceIssues.filter(
    (s) => s.kind === 'scoped_category_lifecycle',
  );
  assert.equal(lives.length, 2);
  assert(
    lives.every(
      (s) =>
        s.payload['businessState'] === 'disabled' &&
        s.payload['active'] === false,
    ),
  );
  assert.deepEqual(
    lives.map((s) => [s.scopeKeys[0], s.payload['hidden']]),
    [
      [A, true],
      [B, false],
    ],
  );
  assert.deepEqual(result.envelopes, []);
  assert.deepEqual(result.affectedScopeKeys, [A, B]);
  const enabled = fixture();
  addCategory(enabled, 901);
  rejects(
    enabled,
    intent('set_category_lifecycle_scoped', {
      state: 'disabled',
      restore: true,
    }),
    'RATING_SCOPED_CONTEXT_CHANGED',
  );
});
test('visibility and explicit inheritance reset are metadata-only and remain exact-campus', () => {
  const snapshot = fixture(),
    category = addCategory(snapshot, 901, [A, B]);
  addOverride(snapshot, category, A, 7400, {
    name: { mode: 'set', value: 'Campus A' },
    description: { mode: 'set', value: '' },
  });
  for (const command of [
    intent('set_category_visibility_scoped'),
    intent('set_category_override_scoped', {
      name: { mode: 'inherit' },
      description: { mode: 'inherit' },
    }),
  ]) {
    const result = plan(snapshot, command);
    assert.deepEqual(result.affectedScopeKeys, [A]);
    assert.deepEqual(result.envelopes, []);
    assert(
      result.sourceIssues.every(
        (s) => s.scopeKeys.length === 1 && s.scopeKeys[0] === A,
      ),
    );
  }
});
test('one child batch plans addition, disable, restore and exact sibling ordering atomically', () => {
  const snapshot = fixture();
  addCategory(snapshot, 901, [A], { ordinal: '10' });
  addCategory(snapshot, 902, [A], { parentId: root, level: 2, ordinal: '20' });
  const archived = addCategory(snapshot, 903, [A], {
    parentId: root,
    level: 2,
    ordinal: '30',
  });
  addLifecycle(snapshot, archived.rows[0]!, 7450, 'archived', true);
  const result = plan(snapshot, intent('batch_update_subcategories_scoped'));
  const added = result.sourceIssues.find(
    (s) => s.kind === 'scoped_category_base',
  );
  assert(added);
  const newId = added.payload['categoryId'];
  assert.equal(typeof newId, 'string');
  assert.equal(
    result.envelopes.length,
    1,
    'only the newly added child has new body Review',
  );
  const envelope = result.envelopes[0]!;
  if (envelope.purpose !== 'publish_rating_category_base_scoped') assert.fail();
  assert.equal(envelope.body.parentId, root);
  const states = result.sourceIssues.filter(
    (s) => s.kind === 'scoped_category_lifecycle',
  );
  assert.deepEqual(
    states.map((s) => [s.payload['categoryId'], s.payload['businessState']]),
    [
      [child, 'disabled'],
      [archivedChild, 'disabled'],
    ],
  );
  const ordered = result.sourceIssues.filter(
    (s) => s.kind === 'scoped_category_order',
  );
  assert(ordered.length > 0);
  assert(
    ordered.every(
      (s) =>
        JSON.stringify(s.payload['siblingIds']) ===
        JSON.stringify([child, newId, archivedChild]),
    ),
  );
  assert.deepEqual(result.affectedScopeKeys, [A]);
  rejects(
    snapshot,
    intent('batch_update_subcategories_scoped', {
      orderedChildren: [
        { kind: 'existing', id: child },
        { kind: 'new', key: 'root' },
      ],
    }),
    'RATING_SCOPED_CONTEXT_CHANGED',
  );
  rejects(
    snapshot,
    intent('batch_update_subcategories_scoped', { enableIds: [child] }),
    'RATING_SCOPED_CONTEXT_CHANGED',
  );
  rejects(
    snapshot,
    intent('batch_update_subcategories_scoped', { disableIds: [root] }),
    'RATING_NOT_FOUND',
  );
});
test('blocked source text never enters edit preview before-values', () => {
  const snapshot = fixture(),
    category = addCategory(snapshot, 901);
  category.rows[0]!.bodyCurrent = false;
  category.rows[0]!.baseBody = null;
  snapshot.reviewBlockedSourceIds = [category.base.id];
  const result = plan(snapshot, intent('edit_category_base_scoped'));
  assert.equal(
    result.changes.find((c) => c.field === 'base_body')!.before,
    null,
  );
  assert.equal(
    result.changes.find((c) => c.field === 'base_body')!.beforeStatus,
    'unavailable',
  );
  assert.equal(
    result.changes.find((c) => c.field === 'effective_body')!.before,
    null,
  );
  assert.equal(
    result.changes.find((c) => c.field === 'effective_body')!.beforeStatus,
    'unavailable',
  );
  const nested = fixture();
  const ancestor = addCategory(nested, 901);
  addCategory(nested, 902, [A], { parentId: root, level: 2 });
  ancestor.rows[0]!.bodyCurrent = false;
  const descendant = plan(
    nested,
    intent('edit_category_base_scoped', { categoryId: child }),
  );
  assert.equal(
    descendant.changes.find((c) => c.field === 'effective_body')!.before,
    null,
  );
});
test('revoked overrides and held ancestry mask inherited before and after text, including dormant views', () => {
  for (const blocked of ['override', 'ancestor', 'dormant'] as const) {
    const snapshot = fixture(),
      ancestor = addCategory(snapshot, 901);
    const category = addCategory(snapshot, 902, [A], {
      parentId: root,
      level: 2,
    });
    const scope = blocked === 'dormant' ? C : A;
    const inherited = addOverride(snapshot, category, scope, 7560, {
      name: { mode: 'set', value: 'Old inherited private set-name' },
      description: {
        mode: 'set',
        value: 'Old inherited private set-description',
      },
    });
    if (blocked === 'ancestor') ancestor.rows[0]!.bodyCurrent = false;
    else {
      snapshot.reviewBlockedSourceIds = [inherited.id];
      if (blocked !== 'dormant') category.rows[0]!.bodyCurrent = false;
    }
    const draft = {
      categoryId: child,
      name: 'New explicitly entered base',
      description: 'New explicitly entered description',
    };
    const result = plan(snapshot, intent('edit_category_base_scoped', draft));
    const effective = result.changes.find(
      (change) =>
        change.field === 'effective_body' && change.scopeKeys.includes(scope),
    );
    assert(
      effective,
      `${blocked}: retain the complete affected view, even when its text is unavailable`,
    );
    assert.equal(effective.before, null);
    assert.equal(effective.beforeStatus, 'unavailable');
    assert.equal(effective.after, null);
    assert.equal(effective.afterStatus, 'unavailable');
    const visible = JSON.stringify(result.changes);
    assert(!visible.includes('Old inherited private set-name'));
    assert(!visible.includes('Old inherited private set-description'));
    const base = result.changes.find((change) => change.field === 'base_body');
    assert(base);
    assert.equal(base.afterStatus, 'available');
    assert.deepEqual(JSON.parse(base.after!), {
      name: draft.name,
      description: draft.description,
    });
    assert(result.affectedScopeKeys.includes(scope));
    assert(
      result.envelopes.some(
        (envelope) =>
          envelope.purpose === 'publish_rating_category_override_scoped',
      ),
      'internal replacement still requires an exact new Review instead of silently dropping the override',
    );
  }
  const created = plan(fixture(), intent('create_categories_scoped'));
  const addition = created.changes.find((change) => change.field === 'create');
  assert(addition);
  assert.equal(addition.before, null);
  assert.equal(
    addition.beforeStatus,
    'absent',
    'a genuinely new category is distinct from redacted old text',
  );
  assert.equal(addition.afterStatus, 'available');
});
test('beforeCompatHeads retains complete intersecting compat domains and is covered by preview digest', () => {
  const snapshot = fixture();
  const regional = {
    compatKey: id(7600),
    versionId: id(7601),
    legacyCatalogId: id(7602),
    scopeKeys: [A, B],
  };
  snapshot.compatHeads = [
    regional,
    {
      compatKey: 'global',
      versionId: id(7603),
      legacyCatalogId: id(7604),
      scopeKeys: ['global'],
    },
  ];
  addCategory(snapshot, 901, [A], { ordinal: '10' });
  addCategory(snapshot, 904, [A], { ordinal: '20' });
  const result = plan(snapshot, intent('reorder_categories_scoped'));
  assert.deepEqual(result.affectedScopeKeys, [A]);
  assert.deepEqual(
    result.beforeCompatHeads,
    [regional],
    'the full shared compat domain is retained even for an A-only change',
  );
  const changed = {
    ...result,
    beforeCompatHeads: [{ ...regional, versionId: id(7605) }],
    previewDigest: '',
  };
  assert.notEqual(
    ratingScopedDigest('category-plan', changed),
    result.previewDigest,
  );
});
test('policy and every affected dependency constrain the minimum deadline, including dormant views', () => {
  const snapshot = fixture(),
    category = addCategory(snapshot, 901, [A, B]);
  const dormant = addOverride(snapshot, category, C, 7500, {
    name: { mode: 'inherit' },
    description: { mode: 'set', value: 'Dormant' },
  });
  const policy = snapshot.sources.find(
    (s) => s.source_kind === 'native_scoped_category_management',
  )!;
  policy.valid_until = new Date(expires - 2000);
  dormant.valid_until = new Date(expires - 4000);
  snapshot.validUntil = expires - 1000;
  assert.equal(
    plan(snapshot, intent('edit_category_base_scoped')).validUntil,
    dormant.valid_until.toISOString(),
  );
  policy.valid_until = new Date(expires - 5000);
  assert.equal(
    plan(snapshot, intent('edit_category_base_scoped')).validUntil,
    policy.valid_until.toISOString(),
  );
  snapshot.validUntil = expires - 6000;
  assert.equal(
    plan(snapshot, intent('edit_category_base_scoped')).validUntil,
    new Date(snapshot.validUntil).toISOString(),
  );
  for (const mode of [
    'missing',
    'disabled',
    'operation',
    'duplicate',
  ] as const) {
    const deniedSnapshot = fixture();
    addCategory(deniedSnapshot, 901);
    const p = deniedSnapshot.sources.find(
      (s) => s.source_kind === 'native_scoped_category_management',
    )!;
    if (mode === 'missing')
      deniedSnapshot.sources = deniedSnapshot.sources.filter(
        (s) => s.id !== p.id,
      );
    if (mode === 'disabled') p.payload['enabled'] = false;
    if (mode === 'operation')
      p.payload['operations'] = ['set_category_visibility_scoped'];
    if (mode === 'duplicate')
      deniedSnapshot.sources.push(
        source(7501, p.source_kind, 'duplicate-policy', [...p.scope_keys], {
          ...p.payload,
        }),
      );
    rejects(
      deniedSnapshot,
      intent('edit_category_base_scoped'),
      'RATING_SCOPE_UNAVAILABLE',
    );
  }
});
test('a global-only registry constrains a campus system plan deadline without expanding affected scopes', () => {
  const snapshot = fixture();
  const registry = addRegistry(snapshot);
  registry.scope_keys = ['global'];
  registry.valid_until = new Date(expires - 12345);
  const result = plan(
    snapshot,
    intent('create_system_category_scoped', {
      placement: { kind: 'campuses', campusIds: [campusA] },
      levelCount: 2,
    }),
  );
  assert.deepEqual(result.affectedScopeKeys, [A]);
  assert.equal(result.globalRequired, true);
  assert.deepEqual(result.registrySourceIds, [registry.id]);
  assert.equal(result.validUntil, registry.valid_until.toISOString());
  assert.deepEqual(
    result.beforeHeads,
    snapshot.heads.filter((head) => head.scopeKey === A),
  );
  assert(
    !result.beforeVector.some(
      (row) =>
        typeof row === 'object' &&
        row !== null &&
        'id' in row &&
        row.id === registry.id,
    ),
    'independent registry authority is not invented as an affected campus source',
  );
});

test('a no-disable system can be enabled or truthfully remain enabled but cannot be disabled or archived', () => {
  const snapshot = fixture();
  addRegistry(snapshot, { allowDisable: false });
  const category = addCategory(snapshot, 901, [A], {
    systemKey: 'synthetic_general',
    maximumDepth: 3,
  });
  assert.equal(
    plan(
      snapshot,
      intent('set_category_lifecycle_scoped', {
        state: 'enabled',
        restore: false,
      }),
    ).noop,
    true,
  );
  rejects(
    snapshot,
    intent('set_category_lifecycle_scoped', {
      state: 'disabled',
      restore: false,
    }),
    'RATING_NOT_FOUND',
  );
  rejects(
    snapshot,
    intent('set_category_lifecycle_scoped', {
      state: 'archived',
      restore: false,
    }),
    'RATING_NOT_FOUND',
  );
  addLifecycle(snapshot, category.rows[0]!, 9600, 'disabled', false);
  assert.equal(
    plan(
      snapshot,
      intent('set_category_lifecycle_scoped', {
        state: 'enabled',
        restore: false,
      }),
    ).noop,
    false,
  );
});
