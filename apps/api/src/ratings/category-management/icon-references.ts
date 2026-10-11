import { z } from 'zod';
import { canonicalJson } from '../../community/content-review/contracts.js';
import { ApplicationError } from '../../http/application-error.js';
import { scopedDigest, scopedId } from '../scoped/contracts.js';
import { RatingScopedCompilationBudget } from '../scoped/compiler.js';
import {
  categoryIconAppearanceSchema,
  type CategoryIconAppearance,
} from './icon-contracts.js';

const source = z.strictObject({ id: scopedId, revision: scopedId });
export type CategoryIconSource = z.infer<typeof source>;
const unresolved = z.strictObject({
  kind: z.literal('unresolved'),
  reason: z.enum(['legacy_unknown', 'missing_coverage', 'conflicting_sources']),
});
const absent = z.strictObject({
  kind: z.literal('absent'),
  evidenceId: scopedId,
  evidenceDigest: scopedDigest,
});
const image = z.strictObject({
  kind: z.literal('image'),
  appearance: categoryIconAppearanceSchema,
});
const common = {
  definitionId: scopedId,
  categoryId: scopedId,
  identityId: scopedId,
  scopeKeys: z
    .array(
      z.union([
        z.literal('global'),
        z.string().regex(/^campus:[0-9a-f-]{36}$/),
      ]),
    )
    .min(1)
    .max(1001)
    .refine((keys) => keys.every((key, n) => n === 0 || keys[n - 1]! < key)),
  // All three are recovery roots; visibility and scope placement are not GC roots.
  retention: z.enum(['current', 'dormant', 'archived']),
};
export const categoryIconRootSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      ...common,
      kind: z.literal('base'),
      source,
      value: z.discriminatedUnion('kind', [unresolved, absent, image]),
    }),
    z.strictObject({
      ...common,
      kind: z.literal('override'),
      source: source.nullable(),
      campusId: scopedId,
      baseSource: source,
      value: z.discriminatedUnion('kind', [
        unresolved,
        absent,
        image,
        z.strictObject({ kind: z.literal('inherit') }),
      ]),
    }),
  ])
  .superRefine((root, ctx) => {
    if (root.value.kind !== 'image') return;
    const appearance = root.value.appearance;
    if (
      root.categoryId !== appearance.categoryId ||
      root.identityId !== appearance.identityId ||
      root.kind !== appearance.origin.kind ||
      (root.kind === 'override' &&
        (appearance.origin.kind !== 'override' ||
          root.campusId !== appearance.origin.campusId))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'An appearance belongs to one exact Category definition slot',
      });
  });
export type CategoryIconRoot = z.infer<typeof categoryIconRootSchema>;
export type CategoryIconBaseRoot = Extract<CategoryIconRoot, { kind: 'base' }>;
export type CategoryIconOverrideRoot = Extract<
  CategoryIconRoot,
  { kind: 'override' }
>;

const unavailable = (): never => {
  throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
};
function sourceEqual(a: CategoryIconSource, b: CategoryIconSource) {
  return a.id === b.id && a.revision === b.revision;
}
/** Independent roots may share an appearance only through exact source succession.
 * Equality of image digest, an empty URL, or missing legacy metadata proves nothing. */
export function validateCategoryIconRoots(
  raw: readonly CategoryIconRoot[],
  budget: RatingScopedCompilationBudget,
): readonly CategoryIconRoot[] {
  budget.observe({ categoryIconRoots: raw });
  const roots = raw.map((root) => {
    const parsed = categoryIconRootSchema.safeParse(root);
    return parsed.success ? parsed.data : unavailable();
  });
  if (new Set(roots.map((root) => root.definitionId)).size !== roots.length)
    unavailable();
  const slots = new Set<string>();
  const appearances = new Map<string, string>();
  const assets = new Map<string, string>();
  for (const root of roots) {
    const key = canonicalJson([
      root.kind,
      root.categoryId,
      root.kind === 'base' ? root.source : root.baseSource,
      root.kind === 'override' ? root.campusId : null,
    ]);
    if (slots.has(key)) unavailable();
    slots.add(key);
    if (root.value.kind === 'image') {
      const a = root.value.appearance,
        previous = appearances.get(a.appearanceId);
      if (previous !== undefined && previous !== canonicalJson(a))
        unavailable();
      const previousAsset = assets.get(a.assetId);
      if (previousAsset !== undefined && previousAsset !== a.appearanceId)
        unavailable();
      appearances.set(a.appearanceId, canonicalJson(a));
      assets.set(a.assetId, a.appearanceId);
    }
    if (root.kind === 'override') {
      const bases = roots.filter(
        (base) =>
          base.kind === 'base' &&
          base.categoryId === root.categoryId &&
          base.identityId === root.identityId &&
          sourceEqual(base.source, root.baseSource),
      );
      if (bases.length !== 1) unavailable();
    }
  }
  return roots;
}
export type ResolvedCategoryIcon =
  | {
      kind: 'absent';
      origin: 'base' | 'override';
      definitionId: string;
      evidenceId: string;
      evidenceDigest: string;
    }
  | {
      kind: 'image';
      origin: 'base' | 'override';
      definitionId: string;
      appearance: CategoryIconAppearance;
    };
/** The caller first resolves the original current catalog and its exact sources.
 * Never finds a latest definition, a same-region override, or an arbitrary base. */
export function resolveCategoryIcon(
  roots: readonly CategoryIconRoot[],
  input: {
    categoryId: string;
    identityId: string;
    baseSource: CategoryIconSource;
    overrideSource: CategoryIconSource | null;
    campusId: string | null;
  },
  budget: RatingScopedCompilationBudget,
): ResolvedCategoryIcon {
  const selected = roots.filter(
    (root) =>
      root.kind === 'base' &&
      root.categoryId === input.categoryId &&
      root.identityId === input.identityId &&
      sourceEqual(root.source, input.baseSource),
  );
  if (selected.length !== 1) unavailable();
  let root = selected[0]!;
  if (input.campusId === null && input.overrideSource !== null) unavailable();
  if (input.campusId !== null) {
    const overrides = roots.filter(
      (candidate): candidate is CategoryIconOverrideRoot =>
        candidate.kind === 'override' &&
        candidate.categoryId === input.categoryId &&
        candidate.identityId === input.identityId &&
        candidate.campusId === input.campusId &&
        sourceEqual(candidate.baseSource, input.baseSource),
    );
    if (
      overrides.length > 1 ||
      (input.overrideSource !== null && overrides.length !== 1)
    )
      unavailable();
    const override = overrides[0];
    if (override) {
      if (
        canonicalJson(override.source) !== canonicalJson(input.overrideSource)
      )
        unavailable();
      if (override.value.kind !== 'inherit') root = override;
    }
  }
  const value = root.value;
  budget.observe({
    categoryIconSelection: { ...input, definitionId: root.definitionId, value },
  });
  if (value.kind === 'absent')
    return {
      kind: 'absent',
      origin: root.kind,
      definitionId: root.definitionId,
      evidenceId: value.evidenceId,
      evidenceDigest: value.evidenceDigest,
    };
  if (value.kind === 'image')
    return {
      kind: 'image',
      origin: root.kind,
      definitionId: root.definitionId,
      appearance: value.appearance,
    };
  return unavailable();
}

/** Text-compatible base sources are not necessarily media-compatible. Every
 * candidate is required, including removed placements and dormant overrides. */
export function consolidateCategoryIconBases(
  candidates: readonly CategoryIconBaseRoot[],
  expectedSources: readonly CategoryIconSource[],
  budget: RatingScopedCompilationBudget,
): {
  value: CategoryIconBaseRoot['value'];
  predecessorDefinitionIds: string[];
} {
  budget.observe({
    categoryIconConsolidation: { candidates, expectedSources },
  });
  if (
    !candidates.length ||
    candidates.length !== expectedSources.length ||
    new Set(expectedSources.map(canonicalJson)).size !==
      expectedSources.length ||
    new Set(candidates.map((root) => canonicalJson(root.source))).size !==
      candidates.length ||
    candidates.some(
      (root) =>
        !expectedSources.some((expected) => sourceEqual(root.source, expected)),
    )
  )
    unavailable();
  const first = candidates[0]!;
  if (
    candidates.some(
      (root) =>
        root.categoryId !== first.categoryId ||
        root.identityId !== first.identityId,
    )
  )
    unavailable();
  const value = first.value;
  if (
    value.kind === 'unresolved' ||
    candidates.some((root) => root.value.kind === 'unresolved')
  )
    unavailable();
  if (
    candidates.some(
      (root) =>
        root.value.kind !== value.kind ||
        (value.kind === 'image' &&
          (root.value.kind !== 'image' ||
            canonicalJson(root.value.appearance) !==
              canonicalJson(value.appearance))),
    )
  )
    unavailable();
  // All independent absence evidence stays in the predecessor closure. Returning
  // a value does not consume, publish or supersede those evidence records.
  return {
    value,
    predecessorDefinitionIds: candidates
      .map((root) => root.definitionId)
      .sort(),
  };
}

export interface CategoryIconRecoveryHold {
  readonly appearanceId: string;
  readonly kind: 'prepared_command' | 'delivery' | 'worker_lease';
}
export interface CategoryIconRetirementPlan {
  readonly candidates: readonly CategoryIconAppearance[];
  readonly blocked: readonly {
    appearanceId: string;
    reason: 'recoverable_root' | 'unresolved_root' | 'in_flight';
  }[];
}
/** Candidates are obligations to recheck under owner/Media locks, not permission
 * to detach or a claim of object absence. Historical versions are not roots. */
export function planCategoryIconRetirement(
  before: readonly CategoryIconRoot[],
  after: readonly CategoryIconRoot[],
  holds: readonly CategoryIconRecoveryHold[],
  retiredAppearanceIds: ReadonlySet<string>,
  budget: RatingScopedCompilationBudget,
): CategoryIconRetirementPlan {
  const old = validateCategoryIconRoots(before, budget);
  const current = validateCategoryIconRoots(after, budget);
  budget.observe({
    categoryIconRecoveryHolds: holds,
    retiredAppearanceIds: [...retiredAppearanceIds].sort(),
  });
  const previous = new Map<string, CategoryIconAppearance>();
  for (const root of old)
    if (root.value.kind === 'image')
      previous.set(root.value.appearance.appearanceId, root.value.appearance);
  const retained = new Set<string>();
  const unknownCategories = new Set<string>();
  for (const root of current) {
    if (root.value.kind === 'unresolved')
      unknownCategories.add(root.categoryId);
    if (root.value.kind !== 'image') continue;
    const appearance = root.value.appearance;
    if (retiredAppearanceIds.has(appearance.appearanceId)) unavailable();
    const prior = previous.get(appearance.appearanceId);
    if (
      prior !== undefined &&
      canonicalJson(prior) !== canonicalJson(appearance)
    )
      unavailable();
    retained.add(appearance.appearanceId);
  }
  const held = new Set(holds.map((hold) => hold.appearanceId));
  const candidates: CategoryIconAppearance[] = [],
    blocked: CategoryIconRetirementPlan['blocked'][number][] = [];
  for (const appearance of [...previous.values()].sort((a, b) =>
    a.appearanceId.localeCompare(b.appearanceId),
  )) {
    const id = appearance.appearanceId;
    if (retiredAppearanceIds.has(id)) continue;
    const reason = retained.has(id)
      ? 'recoverable_root'
      : unknownCategories.has(appearance.categoryId)
        ? 'unresolved_root'
        : held.has(id)
          ? 'in_flight'
          : null;
    if (reason) blocked.push({ appearanceId: id, reason });
    else candidates.push(appearance);
  }
  return { candidates, blocked };
}

/** Permission domains come from the complete recoverable closure, not only the
 * post-edit placement. Source-plan scopes remain untouched for old validation. */
export function categoryIconAffectedScopes(
  textScopeKeys: readonly string[],
  roots: readonly CategoryIconRoot[],
  categoryIds: ReadonlySet<string>,
  budget: RatingScopedCompilationBudget,
): string[] {
  const scopes = new Set(textScopeKeys);
  for (const root of validateCategoryIconRoots(roots, budget)) {
    if (!categoryIds.has(root.categoryId)) continue;
    for (const key of root.scopeKeys) scopes.add(key);
    if (root.kind === 'override') scopes.add(`campus:${root.campusId}`);
  }
  if (scopes.size > 1001) unavailable();
  const result = [...scopes].sort();
  budget.observe({ categoryIconAffectedScopes: result });
  return result;
}

/** Source consolidation is a whole-lineage operation. It may not merge equal
 * base images while silently choosing one of two dormant campus overrides. */
export function consolidateCategoryIconLineages(
  roots: readonly CategoryIconRoot[],
  expectedDefinitionIds: readonly string[],
  expectedBaseSources: readonly CategoryIconSource[],
  budget: RatingScopedCompilationBudget,
): {
  base: ReturnType<typeof consolidateCategoryIconBases>;
  overrides: readonly {
    campusId: string;
    value: CategoryIconOverrideRoot['value'];
    predecessorDefinitionIds: readonly string[];
  }[];
  predecessorDefinitionIds: readonly string[];
} {
  const checked = validateCategoryIconRoots(roots, budget);
  const actualIds = checked.map((root) => root.definitionId).sort();
  if (
    new Set(expectedDefinitionIds).size !== expectedDefinitionIds.length ||
    canonicalJson(actualIds) !==
      canonicalJson([...expectedDefinitionIds].sort())
  )
    unavailable();
  const bases = checked.filter(
    (root): root is CategoryIconBaseRoot => root.kind === 'base',
  );
  const base = consolidateCategoryIconBases(bases, expectedBaseSources, budget);
  const overrideRoots = checked.filter(
    (root): root is CategoryIconOverrideRoot => root.kind === 'override',
  );
  const campuses = [
    ...new Set(overrideRoots.map((root) => root.campusId)),
  ].sort();
  const overrides: {
    campusId: string;
    value: CategoryIconOverrideRoot['value'];
    predecessorDefinitionIds: string[];
  }[] = [];
  for (const campusId of campuses) {
    const candidates = bases.map((b) =>
      overrideRoots.find(
        (root) =>
          root.campusId === campusId && sourceEqual(root.baseSource, b.source),
      ),
    );
    const signature = (root: CategoryIconOverrideRoot | undefined): string => {
      if (!root || root.value.kind === 'inherit') return 'inherit';
      if (root.value.kind === 'unresolved') return unavailable();
      return root.value.kind === 'absent'
        ? 'absent'
        : canonicalJson(root.value.appearance);
    };
    const signatures = candidates.map(signature);
    if (new Set(signatures).size !== 1) unavailable();
    const present = candidates.filter(
      (root): root is CategoryIconOverrideRoot => root !== undefined,
    );
    const first = present[0] ?? unavailable();
    overrides.push({
      campusId,
      value: first.value,
      predecessorDefinitionIds: present.map((root) => root.definitionId).sort(),
    });
  }
  return { base, overrides, predecessorDefinitionIds: actualIds };
}
