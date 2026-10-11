import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RatingScopedCatalogCompiler,
  RatingScopedCompilationBudget,
  type ScopedExpectedCategory,
} from '../src/ratings/scoped/compiler.js';
import {
  categoryIconContentFor,
  categoryIconContentDigest,
  compileCategoryIconRelease,
  type CategoryIconReleaseCoverage,
} from '../src/ratings/category-management/icon-extension.js';
import type {
  CategoryIconBaseRoot,
  CategoryIconOverrideRoot,
} from '../src/ratings/category-management/icon-references.js';
const id = (n: number) =>
  `a0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const campus = id(10),
  scopeKey = `campus:${campus}`;
const category: ScopedExpectedCategory = {
  body: {
    id: id(1),
    parentId: null,
    level: 1,
    kind: 'general',
    systemKey: null,
    isSystem: false,
    originKind: 'regional',
    name: '图标',
    description: '',
    active: true,
    hidden: false,
    ordinal: '0',
    identityKind: 'scoped_source',
    identityId: id(2),
  },
  baseSourceId: id(3),
  baseSourceRevision: id(4),
  overrideSourceId: null,
  overrideSourceRevision: null,
  lifecycleSourceId: null,
  lifecycleSourceRevision: null,
  orderSourceId: null,
  orderSourceRevision: null,
  placementRevision: id(5),
};
const base: CategoryIconBaseRoot = {
  kind: 'base',
  definitionId: id(20),
  categoryId: id(1),
  identityId: id(2),
  source: { id: id(3), revision: id(4) },
  scopeKeys: [scopeKey],
  retention: 'current',
  value: { kind: 'absent', evidenceId: id(21), evidenceDigest: 'a'.repeat(64) },
};
const budget = () => new RatingScopedCompilationBudget();
function catalogs() {
  return new RatingScopedCatalogCompiler().compile([
    {
      scopeKey,
      regionId: id(11),
      campusId: campus,
      sourceVector: [],
      categories: [category],
      memberships: [],
      validUntil: new Date('2027-01-01T00:00:00.000Z'),
      before: null,
    },
  ]);
}
function coverage(): CategoryIconReleaseCoverage[] {
  const content = categoryIconContentFor(category, campus, [base], budget());
  return [
    {
      scopeKey,
      categoryId: id(1),
      content,
      review: {
        id: id(22),
        definitionDigest: categoryIconContentDigest(content),
        approvalDigest: 'b'.repeat(64),
      },
    },
  ];
}
test('extension uses the exact old compiler release/catalog/effective revision without rewriting its bytes', () => {
  const original = catalogs(),
    before = JSON.stringify(original),
    ledger = budget();
  const extension = compileCategoryIconRelease(
    id(30),
    original,
    [base],
    coverage(),
    ledger,
  );
  assert.equal(JSON.stringify(original), before);
  assert.equal(extension.rows.length, 1);
  assert.equal(extension.rows[0]?.releaseId, id(30));
  assert.equal(extension.rows[0]?.catalogId, original[0]?.id);
  assert.equal(
    extension.rows[0]?.effectiveRevision,
    original[0]?.categories[0]?.revision,
  );
  assert.equal(
    extension.rows[0]?.effectiveDigest,
    original[0]?.categories[0]?.digest,
  );
  assert.ok(ledger.snapshot().bytes > 0);
  assert.notEqual(
    compileCategoryIconRelease(id(31), original, [base], coverage(), budget())
      .digest,
    extension.digest,
  );
});
test('media-only replacement has a different extension while the original source and text digest stay equal', () => {
  const original = catalogs(),
    old = compileCategoryIconRelease(
      id(30),
      original,
      [base],
      coverage(),
      budget(),
    );
  const replaced: CategoryIconBaseRoot = {
    ...base,
    definitionId: id(40),
    value: {
      kind: 'image',
      appearance: {
        appearanceId: id(41),
        assetId: id(42),
        manifestDigest: 'c'.repeat(64),
        actorId: id(43),
        categoryId: id(1),
        identityId: id(2),
        origin: { kind: 'base' },
      },
    },
  };
  const content = categoryIconContentFor(
    category,
    campus,
    [replaced],
    budget(),
  );
  const next = compileCategoryIconRelease(
    id(31),
    original,
    [replaced],
    [
      {
        ...coverage()[0]!,
        content,
        review: {
          id: id(44),
          definitionDigest: categoryIconContentDigest(content),
          approvalDigest: 'd'.repeat(64),
        },
      },
    ],
    budget(),
  );
  assert.notEqual(next.digest, old.digest);
  assert.equal(next.rows[0]?.effectiveDigest, old.rows[0]?.effectiveDigest);
  assert.equal(next.rows[0]?.content.icon.kind, 'image');
});
test('missing, duplicate, extra or stale review coverage is unavailable, never silently absent', () => {
  const original = catalogs(),
    c = coverage()[0]!;
  for (const supplied of [
    [],
    [c, c],
    [{ ...c, categoryId: id(77) }],
    [{ ...c, review: { ...c.review, definitionDigest: 'e'.repeat(64) } }],
  ])
    assert.throws(() =>
      compileCategoryIconRelease(id(30), original, [base], supplied, budget()),
    );
  assert.throws(() =>
    compileCategoryIconRelease(id(30), original, [], [c], budget()),
  );
});
test('body/source/identity/selector changes invalidate an old composite review', () => {
  for (const changed of [
    { ...category, body: { ...category.body, name: 'new' } },
    { ...category, body: { ...category.body, identityId: id(77) } },
    { ...category, baseSourceRevision: id(78) },
  ]) {
    const original = catalogs();
    original[0]!.categories[0]!.expected = changed;
    assert.throws(() =>
      compileCategoryIconRelease(
        id(30),
        original,
        [base],
        coverage(),
        budget(),
      ),
    );
  }
});
test('visibility/order/lifecycle do not forge changed body Review content', () => {
  const before = categoryIconContentFor(category, campus, [base], budget());
  const after = categoryIconContentFor(
    {
      ...category,
      body: { ...category.body, active: false, hidden: true, ordinal: '9' },
      lifecycleSourceId: id(50),
      lifecycleSourceRevision: id(51),
      orderSourceId: id(52),
      orderSourceRevision: id(53),
    },
    campus,
    [base],
    budget(),
  );
  assert.deepEqual(after, before);
});
test('an icon-only override has an independent definition and no fabricated text override', () => {
  const override: CategoryIconOverrideRoot = {
    kind: 'override',
    definitionId: id(60),
    categoryId: id(1),
    identityId: id(2),
    source: null,
    baseSource: base.source,
    campusId: campus,
    scopeKeys: [scopeKey],
    retention: 'current',
    value: {
      kind: 'absent',
      evidenceId: id(61),
      evidenceDigest: 'e'.repeat(64),
    },
  };
  const content = categoryIconContentFor(
    category,
    campus,
    [base, override],
    budget(),
  );
  assert.equal(content.overrideSource, null);
  assert.equal(content.overrideDefinitionId, override.definitionId);
  assert.equal(content.icon.origin, 'override');
  const original = catalogs();
  assert.equal(
    compileCategoryIconRelease(
      id(30),
      original,
      [base, override],
      [
        {
          ...coverage()[0]!,
          content,
          review: {
            id: id(62),
            definitionDigest: categoryIconContentDigest(content),
            approvalDigest: 'f'.repeat(64),
          },
        },
      ],
      budget(),
    ).rows.length,
    1,
  );
});
