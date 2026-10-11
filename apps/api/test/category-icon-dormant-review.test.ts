import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { canonicalJson } from '../src/community/content-review/contracts.js';
import {
  canonicalRatingScopedEnvelope,
  ratingScopedApprovalDigest,
} from '../src/community/content-review/rating-scoped-contracts.js';
import { startTransactionDeadlines } from '../src/database/transaction-deadlines.js';
import { categoryIconMediaContentKey } from '../src/media/category-icon-content-snapshot.facade.js';
import {
  currentCategoryIconManagementRoot,
  type CategoryIconManagementRootDependencies,
} from '../src/ratings/category-management/icon-root-current.js';
import { review8Binding } from './support/rating-category-icon-review-fixtures.js';
import {
  categoryIconContentDigest,
  compileCategoryIconRelease,
  type CategoryIconContent,
  type CategoryIconReleaseCoverage,
} from '../src/ratings/category-management/icon-extension.js';
import type { CategoryIconPlan } from '../src/ratings/category-management/icon-plan.js';
import { categoryIconManagementSlots } from '../src/ratings/category-management/icon-management-slots.js';
import {
  partitionCategoryIconPublicationCoverage,
  writeCategoryIconPublication,
} from '../src/ratings/category-management/icon-publication.js';
import {
  plannedCategoryIconContents,
  plannedCategoryIconEnvelopes,
} from '../src/ratings/category-management/icon-review-plan.js';
import type {
  CategoryIconBaseRoot,
  CategoryIconOverrideRoot,
  CategoryIconRoot,
} from '../src/ratings/category-management/icon-references.js';
import type {
  CategoryManagementPlan,
  CategorySnapshot,
} from '../src/ratings/category-management/plan.js';
import {
  RatingScopedCatalogCompiler,
  RatingScopedCompilationBudget,
  type ScopedExpectedCategory,
} from '../src/ratings/scoped/compiler.js';
import type { ScopedSourceRow } from '../src/ratings/scoped/source.facade.js';

const id = (n: number) =>
  `c1000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const A = id(10),
  B = id(11),
  scopes = [`campus:${A}`, `campus:${B}`],
  budget = () => new RatingScopedCompilationBudget();
function fixture() {
  const appearance = (n: number, campusId: string | null) => ({
    appearanceId: id(n),
    assetId: id(n + 1),
    manifestDigest: 'a'.repeat(64),
    actorId: id(1),
    categoryId: id(2),
    identityId: id(3),
    origin:
      campusId === null
        ? { kind: 'base' as const }
        : { kind: 'override' as const, campusId },
  });
  const base: CategoryIconBaseRoot = {
    kind: 'base',
    definitionId: id(30),
    categoryId: id(2),
    identityId: id(3),
    source: { id: id(31), revision: id(32) },
    scopeKeys: [scopes[0]!],
    retention: 'current',
    value: { kind: 'image', appearance: appearance(100, null) },
  };
  const override = (campusId: string, n: number): CategoryIconOverrideRoot => ({
    kind: 'override',
    definitionId: id(n),
    categoryId: base.categoryId,
    identityId: base.identityId,
    source: { id: id(n + 1), revision: id(n + 2) },
    baseSource: base.source,
    campusId,
    scopeKeys: [`campus:${campusId}`],
    retention: campusId === B ? 'dormant' : 'current',
    value: { kind: 'image', appearance: appearance(n + 100, campusId) },
  });
  const active = override(A, 40),
    dormant = override(B, 50),
    roots: CategoryIconRoot[] = [base, active, dormant];
  const body: ScopedExpectedCategory['body'] = {
    id: base.categoryId,
    identityId: base.identityId,
    identityKind: 'scoped_source',
    parentId: null,
    level: 1,
    kind: 'general',
    systemKey: null,
    isSystem: false,
    originKind: 'regional',
    name: 'Current original base',
    description: 'Current inherited description',
    active: true,
    hidden: false,
    ordinal: '0',
  };
  const source = (
    sourceId: string,
    revision: string,
    kind: string,
    scopeKeys: string[],
    payload: Record<string, unknown>,
  ): ScopedSourceRow => ({
    id: sourceId,
    revision,
    source_kind: kind,
    source_key: `${kind}:${sourceId}`,
    scope_keys: scopeKeys,
    payload,
    digest: 'b'.repeat(64),
    issuer: 'ratings-category-management',
    source_reference: 'synthetic-unit',
    policy_reference: 'synthetic-unit',
    valid_until: new Date('2027-01-01T00:00:00.000Z'),
    current: true,
  });
  const common = {
    version: 5,
    accountId: id(1),
    categoryId: base.categoryId,
    identityId: base.identityId,
    issuanceDigest: 'c'.repeat(64),
    placement: { kind: 'campuses', campusIds: [A] },
    assetIds: [],
  };
  const sources = [
    source(
      base.source.id,
      base.source.revision,
      'scoped_category_base',
      base.scopeKeys,
      {
        reviewEnvelope: canonicalRatingScopedEnvelope({
          ...common,
          purpose: 'publish_rating_category_base_scoped',
          sourceId: base.source.id,
          sourceRevision: base.source.revision,
          issuanceId: base.source.id,
          body: {
            parentId: body.parentId,
            level: body.level,
            kind: body.kind,
            systemKey: body.systemKey,
            name: body.name,
            description: body.description,
          },
        }),
      },
    ),
    ...[active, dormant].map((root) =>
      source(
        root.source!.id,
        root.source!.revision,
        'scoped_category_override',
        root.scopeKeys,
        {
          modes: {
            name: { mode: 'set', value: `Original override ${root.campusId}` },
            description: { mode: 'inherit' },
          },
          reviewEnvelope: canonicalRatingScopedEnvelope({
            ...common,
            purpose: 'publish_rating_category_override_scoped',
            placement: { kind: 'campuses', campusIds: [root.campusId] },
            sourceId: root.source!.id,
            sourceRevision: root.source!.revision,
            issuanceId: root.source!.id,
            baseSourceId: base.source.id,
            baseSourceRevision: base.source.revision,
            scope: { kind: 'campus', campusId: root.campusId },
            body: {
              name: `Original override ${root.campusId}`,
              description: body.description,
            },
          }),
        },
      ),
    ),
    source(id(60), id(61), 'scoped_category_scope', [scopes[0]!], {
      categoryId: base.categoryId,
      baseSourceId: base.source.id,
      baseSourceRevision: base.source.revision,
    }),
  ];
  const snapshot: CategorySnapshot = {
    sources,
    categories: [],
    targets: [],
    heads: [],
    snapshotRevision: 'd'.repeat(64),
    sourceDigest: 'e'.repeat(64),
    validUntil: Date.parse('2027-01-01T00:00:00.000Z'),
  };
  const textPlan: CategoryManagementPlan = {
    version: 1,
    accountId: id(1),
    requestId: id(4),
    intentHash: '1'.repeat(64),
    operation: 'set_category_scope_scoped',
    sourceIssues: [],
    envelopes: [],
    categoryIds: [base.categoryId],
    affectedScopeKeys: scopes,
    globalRequired: false,
    beforeHeads: [],
    beforeCompatHeads: [],
    beforeBaseAvailability: [],
    beforeVector: [],
    beforeDigest: '2'.repeat(64),
    policySourceId: id(70),
    policySourceRevision: id(71),
    registrySourceIds: [],
    changes: [],
    affectedTargetCount: 0,
    previewDigest: '3'.repeat(64),
    validUntil: '2027-01-01T00:00:00.000Z',
    noop: false,
  };
  const plan: CategoryIconPlan = {
    version: 1,
    accountId: id(1),
    requestId: id(4),
    outerHash: '4'.repeat(64),
    textHash: textPlan.intentHash,
    textPlan,
    beforeSnapshot: '5'.repeat(64),
    beforeRoots: [],
    afterRoots: roots,
    newAppearances: [],
    uploads: [],
    categoryIds: [base.categoryId],
    affectedScopeKeys: scopes,
    globalRequired: false,
    noop: false,
    mediaNoop: false,
    adoptionRequired: false,
    digest: '6'.repeat(64),
  };
  const category: ScopedExpectedCategory = {
    body: { ...body, name: `Original override ${A}` },
    baseSourceId: base.source.id,
    baseSourceRevision: base.source.revision,
    overrideSourceId: active.source!.id,
    overrideSourceRevision: active.source!.revision,
    lifecycleSourceId: null,
    lifecycleSourceRevision: null,
    orderSourceId: null,
    orderSourceRevision: null,
    placementRevision: id(80),
  };
  const outputs = () =>
    new RatingScopedCatalogCompiler().compile(
      [A, B].map((campusId) => ({
        scopeKey: `campus:${campusId}`,
        regionId: id(90),
        campusId,
        sourceVector: [],
        categories: campusId === A ? [category] : [],
        memberships: [],
        validUntil: new Date('2027-01-01T00:00:00.000Z'),
        before: null,
      })),
    );
  return {
    base,
    active,
    dormant,
    roots,
    body,
    sources,
    snapshot,
    plan,
    category,
    outputs,
  };
}
function coverage(
  contents: readonly CategoryIconContent[],
): CategoryIconReleaseCoverage[] {
  return contents.map((content, index) => ({
    scopeKey:
      content.selector.kind === 'global'
        ? 'global'
        : `campus:${content.selector.campusId}`,
    categoryId: content.categoryId,
    content,
    review: {
      id: id(500 + index),
      definitionDigest: categoryIconContentDigest(content),
      approvalDigest: 'f'.repeat(64),
    },
  }));
}
const unavailable = { code: 'RATING_SCOPE_UNAVAILABLE' };

test('scope shrink retains exact dormant Review8 and a fully overridden original base slot without publishing either', () => {
  const f = fixture(),
    contents = plannedCategoryIconContents(f.plan, f.snapshot, budget());
  assert.equal(contents.length, 3);
  const base = contents.find(
    (content) => content.icon.definitionId === f.base.definitionId,
  )!;
  const dormant = contents.find(
    (content) => content.icon.definitionId === f.dormant.definitionId,
  )!;
  assert.equal(base.name, f.body.name);
  assert.equal(base.overrideDefinitionId, null);
  assert.equal(base.overrideSource, null);
  assert.deepEqual(base.selector, { kind: 'campus', campusId: A });
  assert.equal(dormant.name, `Original override ${B}`);
  assert.equal(dormant.description, f.body.description);
  assert.deepEqual(dormant.overrideSource, f.dormant.source);
  const parts = partitionCategoryIconPublicationCoverage(
    f.outputs(),
    f.roots,
    coverage(contents),
    scopes,
    budget(),
  );
  assert.equal(parts.publicCoverage.length, 1);
  assert.equal(parts.managementCoverage.length, 3);
  const compiled = compileCategoryIconRelease(
    id(800),
    f.outputs(),
    f.roots,
    parts.publicCoverage,
    budget(),
  );
  assert.deepEqual(
    compiled.rows.map((row) => row.content.icon.definitionId),
    [f.active.definitionId],
  );
  assert.equal(
    compiled.rows.some((row) => row.scopeKey === scopes[1]),
    false,
  );
});

test('base succession uses exact reissued dormant Review5 modes/body and rejects an old-base envelope', () => {
  const f = fixture(),
    before = plannedCategoryIconContents(f.plan, f.snapshot, budget());
  f.base.source = { id: id(901), revision: id(902) };
  f.base.definitionId = id(903);
  for (const [index, root] of [f.active, f.dormant].entries()) {
    root.baseSource = f.base.source;
    root.definitionId = id(910 + index);
    root.source = { id: id(920 + index), revision: id(930 + index) };
  }
  f.plan.textPlan.sourceIssues = f.sources.map((old, index) => {
    const payload = structuredClone(old.payload);
    const envelope = payload['reviewEnvelope'] as
      Record<string, unknown> | undefined;
    const root = [f.base, f.active, f.dormant][index];
    const next =
      root && root.source ? root.source : { id: id(950), revision: id(951) };
    if (envelope) {
      envelope['sourceId'] = next.id;
      envelope['sourceRevision'] = next.revision;
      envelope['issuanceId'] = next.id;
      (envelope['body'] as Record<string, unknown>)['description'] =
        'New inherited description';
      if (index > 0) {
        envelope['baseSourceId'] = f.base.source.id;
        envelope['baseSourceRevision'] = f.base.source.revision;
      }
    } else {
      payload['baseSourceId'] = f.base.source.id;
      payload['baseSourceRevision'] = f.base.source.revision;
    }
    return {
      id: next.id,
      revision: next.revision,
      kind: old.source_kind,
      key: old.source_key,
      scopeKeys: old.scope_keys,
      payload,
      previousSourceId: old.id,
      previousSourceRevision: old.revision,
    };
  });
  const after = plannedCategoryIconContents(f.plan, f.snapshot, budget()),
    dormant = after.find(
      (content) => content.icon.definitionId === f.dormant.definitionId,
    )!;
  assert.equal(dormant.description, 'New inherited description');
  assert.equal(dormant.name, `Original override ${B}`);
  assert.notEqual(
    categoryIconContentDigest(dormant),
    categoryIconContentDigest(
      before.find(
        (content) =>
          content.selector.kind === 'campus' && content.selector.campusId === B,
      )!,
    ),
  );
  (
    f.plan.textPlan.sourceIssues[2]!.payload['reviewEnvelope'] as Record<
      string,
      unknown
    >
  )['baseSourceId'] = id(31);
  assert.throws(
    () => plannedCategoryIconContents(f.plan, f.snapshot, budget()),
    unavailable,
  );
});

test('public inherited image and original base management body retain separate exact provenance and Review digests', () => {
  const f = fixture();
  f.active.value = { kind: 'inherit' };
  const contents = plannedCategoryIconContents(f.plan, f.snapshot, budget());
  const sameAppearance = contents.filter(
    (content) => content.icon.definitionId === f.base.definitionId,
  );
  assert.equal(sameAppearance.length, 2);
  assert.equal(new Set(sameAppearance.map(categoryIconContentDigest)).size, 2);
  assert.ok(
    sameAppearance.some(
      (content) =>
        content.overrideDefinitionId === null && content.name === f.body.name,
    ),
  );
  assert.ok(
    sameAppearance.some(
      (content) =>
        content.overrideDefinitionId === f.active.definitionId &&
        content.name !== f.body.name,
    ),
  );
  const parts = partitionCategoryIconPublicationCoverage(
    f.outputs(),
    f.roots,
    coverage(contents).reverse(),
    scopes,
    budget(),
  );
  assert.equal(
    parts.publicCoverage[0]!.content.overrideDefinitionId,
    f.active.definitionId,
  );
  assert.equal(
    parts.managementCoverage.find(
      (item) => item.content.icon.definitionId === f.base.definitionId,
    )!.content.overrideDefinitionId,
    null,
  );
});

test('whole coverage rejects missing dormant/base, duplicate, foreign, and conflicting direct-root bodies', () => {
  const f = fixture(),
    items = coverage(plannedCategoryIconContents(f.plan, f.snapshot, budget()));
  const direct = items.find(
    (item) => item.content.icon.definitionId === f.base.definitionId,
  )!;
  const conflicting = coverage([
    { ...direct.content, name: 'Untrusted alternate base body' },
  ])[0]!;
  for (const supplied of [
    items.filter(
      (item) => item.content.icon.definitionId !== f.dormant.definitionId,
    ),
    items.filter(
      (item) => item.content.icon.definitionId !== f.base.definitionId,
    ),
    [...items, items[0]!],
    [...items, conflicting],
    [
      ...items,
      coverage([{ ...direct.content, selector: { kind: 'global' } }])[0]!,
    ],
  ])
    assert.throws(
      () =>
        partitionCategoryIconPublicationCoverage(
          f.outputs(),
          f.roots,
          supplied,
          scopes,
          budget(),
        ),
      unavailable,
    );
  assert.equal(
    categoryIconManagementSlots(f.roots, scopes).some(
      (slot) => slot.selector.kind === 'global',
    ),
    false,
  );
  assert.equal(
    categoryIconManagementSlots(f.roots, [scopes[0]!]).some(
      (slot) => slot.root.definitionId === f.dormant.definitionId,
    ),
    false,
  );
});

test('Review intents retain outer request authority and include exact dormant bytes without a separate release', () => {
  const f = fixture(),
    contents = plannedCategoryIconContents(f.plan, f.snapshot, budget());
  const envelopes = plannedCategoryIconEnvelopes(f.plan, contents, {
    id: id(980),
    digest: 'a'.repeat(64),
    protocolGeneration: id(981),
    topologySnapshotId: id(982),
    sourceDigest: 'b'.repeat(64),
  });
  assert.equal(envelopes.length, 3);
  assert.ok(
    envelopes.every(
      (envelope) =>
        envelope.intentHash === f.plan.outerHash &&
        envelope.textHash === f.plan.textHash &&
        envelope.clientRequestId === f.plan.requestId,
    ),
  );
  assert.equal(
    new Set(envelopes.map((envelope) => envelope.definitionId)).size,
    3,
  );
});

test('same-release manifest charges and persists management-only coverage, while foreign carry does not rewrite management heads', async () => {
  const f = fixture(),
    parts = partitionCategoryIconPublicationCoverage(
      f.outputs(),
      f.roots,
      coverage(plannedCategoryIconContents(f.plan, f.snapshot, budget())),
      scopes,
      budget(),
    );
  const compiled = compileCategoryIconRelease(
    id(800),
    f.outputs(),
    f.roots,
    parts.publicCoverage,
    budget(),
  );
  const calls: { sql: string; values: unknown[] }[] = [];
  const tx = {
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      return {
        rows: sql.startsWith(
          'SELECT * FROM whaleu_ratings.category_icon_review_bindings',
        )
          ? (values[0] as string[]).map((id) => ({
              id,
              fixture: 'exact reviewed metadata',
            }))
          : [],
      };
    },
  } as unknown as PoolClient;
  const publication = {
    compiled,
    digest: 'd'.repeat(64),
    extent: [],
    scopeKeys: scopes,
    roots: f.roots,
    capabilities: [],
    mutation: null,
    managementCoverage: parts.managementCoverage,
    writeManagementHeads: true,
  };
  await writeCategoryIconPublication(id(800), publication, tx, budget());
  assert.equal(
    calls.filter((call) =>
      call.sql.includes('INSERT INTO whaleu_ratings.category_icon_projections'),
    ).length,
    1,
  );
  assert.equal(
    calls.filter((call) =>
      call.sql.includes(
        'INSERT INTO whaleu_ratings.category_icon_management_review_heads',
      ),
    ).length,
    3,
  );
  const manifest = calls.find((call) =>
    call.sql.includes(
      'INSERT INTO whaleu_ratings.category_icon_release_manifests',
    ),
  )!;
  assert.equal(manifest.values[7], canonicalJson(parts.managementCoverage));
  assert.equal(
    manifest.values[5],
    Buffer.byteLength(
      canonicalJson({
        extent: [],
        roots: f.roots,
        capabilities: [],
        rows: compiled.rows,
        managementCoverage: parts.managementCoverage,
      }),
      'utf8',
    ),
  );
  calls.length = 0;
  await writeCategoryIconPublication(
    id(800),
    { ...publication, writeManagementHeads: false },
    tx,
    budget(),
  );
  assert.equal(
    calls.some((call) =>
      call.sql.includes('category_icon_management_review_heads'),
    ),
    false,
  );
  assert.equal(
    calls.find((call) =>
      call.sql.includes(
        'INSERT INTO whaleu_ratings.category_icon_release_manifests',
      ),
    )!.values[7],
    canonicalJson(parts.managementCoverage),
  );
});

function managementReadFixture(kind: 'base' | 'dormant') {
  const f = fixture(),
    root = kind === 'base' ? f.base : f.dormant;
  const contents = plannedCategoryIconContents(f.plan, f.snapshot, budget());
  const content = contents.find(
    (item) => item.icon.definitionId === root.definitionId,
  )!;
  const envelope = plannedCategoryIconEnvelopes(f.plan, [content], {
    id: id(980),
    digest: 'a'.repeat(64),
    protocolGeneration: id(981),
    topologySnapshotId: id(982),
    sourceDigest: 'b'.repeat(64),
  })[0]!;
  const binding = review8Binding(envelope);
  const head = {
    root_key: canonicalJson([root.definitionId, content.selector]),
    root_definition_id: root.definitionId,
    selector: content.selector,
    review_binding_id: binding.id,
    binding,
  };
  const sourceIds: string[] = [],
    mediaCalls: unknown[] = [];
  let rejectSource = false;
  const tx = {
    query: async (sql: string, values: unknown[] = []) => {
      assert.equal(
        /category_icon_projections/.test(sql),
        false,
        'Management cannot borrow a public projection',
      );
      if (sql.includes('SELECT version,epoch::text'))
        return { rows: [{ version: 1, epoch: '1' }] };
      if (sql.includes('SELECT jsonb_build_object('))
        return { rows: [{ state: { epoch: '1', keys: values[0] } }] };
      if (sql.includes('category_icon_snapshot('))
        return { rows: [{ snapshot: 'a'.repeat(64) }] };
      if (
        sql.includes(
          'FROM whaleu_ratings.category_icon_management_review_heads',
        )
      )
        return { rows: [head] };
      if (sql.includes('FROM unnest($1::uuid[],$2::uuid[]) wanted'))
        return {
          rows: f.sources
            .filter((source) => (values[0] as string[]).includes(source.id))
            .map((source) => ({ ...source, original_body: null })),
        };
      assert.fail(`Unexpected query: ${sql}`);
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  const dependencies: CategoryIconManagementRootDependencies = {
    roots: { roots: async () => f.roots },
    sourceReview: {
      currentCategorySource: async (descriptor) => {
        sourceIds.push(descriptor.sourceId);
        return rejectSource
          ? { kind: 'unavailable' }
          : {
              kind: 'allow',
              value: {
                version: 5,
                decisionId: id(1000),
                digest: ratingScopedApprovalDigest(descriptor.envelope),
                envelope: descriptor.envelope,
              },
            };
      },
    },
    review: {
      currentBatch: async () => [
        {
          kind: 'allow',
          value: {
            version: 8,
            decisionId: binding.decision_id,
            digest: binding.approval_digest,
            envelope,
          },
        },
      ],
    },
    mediaProof: { capture: async () => 'f'.repeat(64) },
    media: {
      readBatch: async (references) =>
        new Map(
          references.map(({ parent, expected }) => {
            mediaCalls.push(parent);
            return [
              categoryIconMediaContentKey(parent),
              {
                version: 8 as const,
                parent,
                decision: 'allow' as const,
                validUntil: Date.parse('2027-01-01T00:00:00.000Z'),
                attachments: [
                  {
                    slot: 'icon' as const,
                    ordinal: 0 as const,
                    bindingId: id(1001),
                    assetId: expected[0]!.assetId,
                    manifestDigest: expected[0]!.digest,
                    width: 64,
                    height: 64,
                    policyRevision: 'media-static-v1',
                    intentId: id(1002),
                    intentState: 'ready' as const,
                    headRevision: '1',
                    eventId: id(1003),
                  },
                ],
              },
            ];
          }),
        ),
    },
  };
  const run = () =>
    currentCategoryIconManagementRoot(
      {
        categoryId: root.categoryId,
        appearanceId:
          root.value.kind === 'image' ? root.value.appearance.appearanceId : '',
        selector: content.selector,
      },
      tx,
      budget(),
      dependencies,
    );
  return {
    ...f,
    root,
    content,
    sourceIds,
    mediaCalls,
    run,
    denySource: () => {
      rejectSource = true;
    },
  };
}

test('direct base management reads original Review5 body despite complete campus override and still requires its own Review8 and Media8', async () => {
  const f = managementReadFixture('base'),
    current = await f.run();
  assert.equal(current.content.name, f.body.name);
  assert.equal(current.content.overrideSource, null);
  assert.equal(current.qualification.kind, 'management-root');
  assert.deepEqual(f.sourceIds, [f.base.source.id]);
  assert.equal(f.mediaCalls.length, 1);
  const denied = managementReadFixture('base');
  denied.denySource();
  await assert.rejects(denied.run(), { code: 'CONTENT_REVIEW_UNAVAILABLE' });
  assert.equal(denied.mediaCalls.length, 0);
});

test('dormant management reads exact source successor and rejects old definition or ambiguous same-appearance lineage', async () => {
  const f = managementReadFixture('dormant'),
    current = await f.run();
  assert.equal(current.content.icon.definitionId, f.dormant.definitionId);
  assert.deepEqual(f.sourceIds, [f.base.source.id, f.dormant.source!.id]);
  const stale = managementReadFixture('dormant');
  stale.dormant.definitionId = id(1100);
  await assert.rejects(stale.run(), unavailable);
  assert.equal(stale.mediaCalls.length, 0);
  const ambiguous = managementReadFixture('base');
  ambiguous.roots.push({
    ...ambiguous.base,
    definitionId: id(1101),
    source: { id: id(1102), revision: id(1103) },
  });
  await assert.rejects(ambiguous.run(), unavailable);
  assert.equal(ambiguous.mediaCalls.length, 0);
});
