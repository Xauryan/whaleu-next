import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RatingScopedCompilationBudget } from '../src/ratings/scoped/compiler.js';
import {
  categoryIconAffectedScopes,
  consolidateCategoryIconBases,
  consolidateCategoryIconLineages,
  planCategoryIconRetirement,
  resolveCategoryIcon,
  validateCategoryIconRoots,
  type CategoryIconBaseRoot,
  type CategoryIconOverrideRoot,
  type CategoryIconRoot,
} from '../src/ratings/category-management/icon-references.js';
import type { CategoryIconAppearance } from '../src/ratings/category-management/icon-contracts.js';
const id = (n: number) =>
  `a0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const budget = () => new RatingScopedCompilationBudget();
const A = id(10),
  B = id(11),
  C = id(12);
const appearance = (
  n: number,
  campusId: string | null = null,
): CategoryIconAppearance => ({
  appearanceId: id(n),
  assetId: id(n + 1),
  manifestDigest: 'a'.repeat(64),
  actorId: id(2),
  categoryId: id(3),
  identityId: id(4),
  origin: campusId === null ? { kind: 'base' } : { kind: 'override', campusId },
});
const image = appearance(100);
const base = (
  value: CategoryIconBaseRoot['value'] = { kind: 'image', appearance: image },
): CategoryIconBaseRoot => ({
  kind: 'base',
  definitionId: id(30),
  categoryId: id(3),
  identityId: id(4),
  source: { id: id(31), revision: id(32) },
  scopeKeys: [`campus:${A}`, `campus:${B}`],
  retention: 'current',
  value,
});
const over = (
  value: CategoryIconOverrideRoot['value'] = { kind: 'inherit' },
  campusId = A,
): CategoryIconOverrideRoot => ({
  kind: 'override',
  definitionId: id(campusId === A ? 40 : 45),
  categoryId: id(3),
  identityId: id(4),
  source: { id: id(campusId === A ? 41 : 46), revision: id(42) },
  baseSource: base().source,
  campusId,
  scopeKeys: [`campus:${campusId}`],
  retention: 'current',
  value,
});
const absent = {
  kind: 'absent' as const,
  evidenceId: id(50),
  evidenceDigest: 'b'.repeat(64),
};
function selected(
  roots: readonly CategoryIconRoot[],
  campusId: string | null,
  override: CategoryIconOverrideRoot | null = null,
) {
  return resolveCategoryIcon(
    roots,
    {
      categoryId: id(3),
      identityId: id(4),
      baseSource: base().source,
      overrideSource: override?.source ?? null,
      campusId,
    },
    budget(),
  );
}
const retire = (before: CategoryIconRoot[], after: CategoryIconRoot[]) =>
  planCategoryIconRetirement(before, after, [], new Set(), budget());
const rejects = (fn: () => unknown) =>
  assert.throws(fn, { code: 'RATING_SCOPE_UNAVAILABLE' });
test('a base image is one immutable appearance inherited by multiple exact campuses', () => {
  const oa = over(),
    ob = over({ kind: 'inherit' }, B),
    roots = [base(), oa, ob];
  validateCategoryIconRoots(roots, budget());
  assert.deepEqual(selected(roots, A, oa), selected(roots, B, ob));
  assert.equal(selected(roots, null).kind, 'image');
});
test('explicit no image differs from inherit and does not retire the base', () => {
  const oa = over(absent),
    roots = [base(), oa];
  assert.equal(selected(roots, A, oa).kind, 'absent');
  assert.equal(selected(roots, B).kind, 'image');
  assert.deepEqual(retire([base()], roots).candidates, []);
  assert.equal(retire([base()], roots).blocked[0]?.reason, 'recoverable_root');
});
test('campus override cannot be chosen from another campus or region', () => {
  const oa = over({ kind: 'image', appearance: appearance(200, A) });
  rejects(() => selected([base(), oa], B, oa));
  rejects(() => selected([base(), oa], null, oa));
});
test('missing and unresolved coverage never become an absent icon', () => {
  rejects(() => selected([], A));
  rejects(() =>
    selected([base({ kind: 'unresolved', reason: 'legacy_unknown' })], A),
  );
  const oa = over();
  rejects(() => selected([base()], A, oa));
  rejects(() => validateCategoryIconRoots([oa], budget()));
});
test('same identity/source revision is required, not a latest-base lookup', () => {
  const other = base();
  other.source = { id: id(60), revision: id(61) };
  rejects(() => selected([other], A));
  const oa = over();
  oa.baseSource = other.source;
  rejects(() => selected([base(), other, oa], A, oa));
});
test('every recovery root retains its appearance: dormant, archived, and removed campus', () => {
  for (const retention of ['current', 'dormant', 'archived'] as const) {
    const retained = { ...base(), retention, scopeKeys: [`campus:${C}`] };
    assert.equal(retire([base()], [retained]).candidates.length, 0);
    assert.equal(
      retire([base()], [retained]).blocked[0]?.reason,
      'recoverable_root',
    );
  }
});
test('overriding, hiding, restoring and reordering do not erase base recovery roots', () => {
  const before = [base(), over()];
  const after = [
    base(),
    {
      ...over({ kind: 'image', appearance: appearance(200, A) }),
      retention: 'archived' as const,
    },
  ];
  assert.equal(retire(before, after).candidates.length, 0);
  assert.equal(
    retire(after, [base(), over()]).candidates[0]?.appearanceId,
    id(200),
  );
});
test('the last explicit replace/clear creates a retirement candidate, not a detached binding', () => {
  const result = retire([base()], [base(absent)]);
  assert.deepEqual(result.candidates, [image]);
  assert.deepEqual(result.blocked, []);
});
test('unknown surviving Category roots prevent a false no-reference claim', () => {
  const unresolved = {
    ...base({ kind: 'unresolved' as const, reason: 'legacy_unknown' as const }),
    source: { id: id(61), revision: id(62) },
    definitionId: id(63),
    retention: 'dormant' as const,
  };
  const result = retire([base(), unresolved], [base(absent), unresolved]);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.blocked[0]?.reason, 'unresolved_root');
});
test('pending commands, delivery and worker leases defer cleanup without becoming permanent history roots', () => {
  for (const kind of [
    'prepared_command',
    'delivery',
    'worker_lease',
  ] as const) {
    const result = planCategoryIconRetirement(
      [base()],
      [base(absent)],
      [{ appearanceId: image.appearanceId, kind }],
      new Set(),
      budget(),
    );
    assert.equal(result.candidates.length, 0);
    assert.equal(result.blocked[0]?.reason, 'in_flight');
  }
  assert.equal(retire([base()], [base(absent)]).candidates.length, 1);
});
test('retired appearances never reattach during restore', () => {
  rejects(() =>
    planCategoryIconRetirement(
      [base(absent)],
      [base()],
      [],
      new Set([image.appearanceId]),
      budget(),
    ),
  );
});
test('appearance metadata cannot mutate during text-only source succession', () => {
  const changed = base({
    kind: 'image',
    appearance: { ...image, manifestDigest: 'c'.repeat(64) },
  });
  rejects(() => retire([base()], [changed]));
  const next = {
    ...base(),
    definitionId: id(62),
    source: { id: id(63), revision: id(64) },
  };
  assert.equal(retire([base()], [next]).candidates.length, 0);
});
test('base/override slots and distinct assets cannot share an appearance authorization', () => {
  rejects(() =>
    validateCategoryIconRoots(
      [base(), over({ kind: 'image', appearance: image })],
      budget(),
    ),
  );
  const duplicate = {
    ...base(),
    definitionId: id(62),
    source: { id: id(63), revision: id(64) },
    value: {
      kind: 'image' as const,
      appearance: { ...image, appearanceId: id(101) },
    },
  };
  rejects(() => validateCategoryIconRoots([base(), duplicate], budget()));
});
test('matching text/digest is insufficient to consolidate different image appearances', () => {
  const a = base(),
    b = {
      ...base({ kind: 'image', appearance: appearance(200) }),
      definitionId: id(62),
      source: { id: id(63), revision: id(64) },
    };
  rejects(() =>
    consolidateCategoryIconBases([a, b], [a.source, b.source], budget()),
  );
});
test('consolidation requires the exact complete predecessor inventory and explicit absence evidence', () => {
  const a = base(absent),
    b = {
      ...base({ ...absent, evidenceId: id(51) }),
      definitionId: id(62),
      source: { id: id(63), revision: id(64) },
    };
  assert.deepEqual(
    consolidateCategoryIconBases([a, b], [a.source, b.source], budget())
      .predecessorDefinitionIds,
    [a.definitionId, b.definitionId].sort(),
  );
  rejects(() =>
    consolidateCategoryIconBases([a], [a.source, b.source], budget()),
  );
  rejects(() =>
    consolidateCategoryIconBases([a, a], [a.source, b.source], budget()),
  );
  rejects(() =>
    consolidateCategoryIconBases(
      [a, { ...b, value: { kind: 'unresolved', reason: 'legacy_unknown' } }],
      [a.source, b.source],
      budget(),
    ),
  );
});
test('all-of domains include dormant/removed overrides without altering the original text plan', () => {
  const text = [`campus:${A}`];
  const ob = {
    ...over(absent, B),
    retention: 'dormant' as const,
    scopeKeys: [`campus:${C}`],
  };
  assert.deepEqual(
    categoryIconAffectedScopes(text, [base(), ob], new Set([id(3)]), budget()),
    [`campus:${A}`, `campus:${B}`, `campus:${C}`],
  );
  assert.deepEqual(text, [`campus:${A}`]);
});
test('image metadata shares the supplied whole-operation ledger', () => {
  const shared = budget();
  class ExhaustedBudget extends RatingScopedCompilationBudget {
    override observe() {
      throw new Error('budget');
    }
  }
  const tiny = new ExhaustedBudget();
  assert.throws(() => validateCategoryIconRoots([base()], tiny), /budget/);
  assert.throws(
    () => categoryIconAffectedScopes([], [base()], new Set([id(3)]), tiny),
    /budget/,
  );
  assert.ok(validateCategoryIconRoots([base()], shared));
});

test('a media-only campus override exists without inventing a text override source', () => {
  const iconOnly = { ...over(absent), source: null };
  validateCategoryIconRoots([base(), iconOnly], budget());
  assert.equal(selected([base(), iconOnly], A).kind, 'absent');
  assert.equal(selected([base(), iconOnly], B).kind, 'image');
  const ownImage = {
    ...over({ kind: 'image' as const, appearance: appearance(200, A) }),
    source: null,
  };
  assert.equal(selected([base(), ownImage], A).origin, 'override');
  assert.equal(
    selected([base(), { ...iconOnly, value: { kind: 'inherit' as const } }], A)
      .origin,
    'base',
  );
});
test('independent icon overrides still require the exact current text source or explicit text absence', () => {
  rejects(() => selected([base(), over(absent)], A));
  const iconOnly = { ...over(absent), source: null };
  rejects(() => selected([base(), iconOnly], A, over()));
});

test('whole-lineage consolidation includes dormant icon overrides, not just matching base text/images', () => {
  const a = base(),
    b = {
      ...base(),
      definitionId: id(62),
      source: { id: id(63), revision: id(64) },
    };
  const oa = { ...over(absent), retention: 'dormant' as const };
  const ob = {
    ...over({ kind: 'image' as const, appearance: appearance(200, A) }),
    definitionId: id(65),
    baseSource: b.source,
    source: null,
    retention: 'archived' as const,
  };
  const roots = [a, b, oa, ob];
  rejects(() =>
    consolidateCategoryIconLineages(
      roots,
      roots.map((r) => r.definitionId),
      [a.source, b.source],
      budget(),
    ),
  );
  rejects(() =>
    consolidateCategoryIconLineages(
      [a, b, oa],
      roots.map((r) => r.definitionId),
      [a.source, b.source],
      budget(),
    ),
  );
  const equal = { ...ob, value: absent };
  const result = consolidateCategoryIconLineages(
    [a, b, oa, equal],
    roots.map((r) => r.definitionId),
    [a.source, b.source],
    budget(),
  );
  assert.equal(result.overrides.length, 1);
  assert.deepEqual(
    result.overrides[0]?.predecessorDefinitionIds,
    [oa.definitionId, ob.definitionId].sort(),
  );
});
