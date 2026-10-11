import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../../community/content-review/contracts.js';
import { ApplicationError } from '../../http/application-error.js';
import { scopedDigest, scopedId } from '../scoped/contracts.js';
import {
  RatingScopedCompilationBudget,
  type ScopedCompiledCatalog,
  type ScopedExpectedCategory,
} from '../scoped/compiler.js';
import {
  categoryIconAppearanceSchema,
  RATING_CATEGORY_ICON_EXTENSION,
} from './icon-contracts.js';
import {
  resolveCategoryIcon,
  validateCategoryIconRoots,
  type CategoryIconRoot,
} from './icon-references.js';

const source = z.strictObject({ id: scopedId, revision: scopedId });
const selector = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('global') }),
  z.strictObject({ kind: z.literal('campus'), campusId: scopedId }),
]);
/** Body and icon are one reviewed definition. Visibility/order/lifecycle are
 * still proved by the original Category owner, not invented body Review. */
export const categoryIconContentSchema = z
  .strictObject({
    categoryId: scopedId,
    identityId: scopedId,
    parentId: scopedId.nullable(),
    level: z.number().int().min(1).max(3),
    kind: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/),
    systemKey: z.string().nullable(),
    name: z.string(),
    description: z.string(),
    selector,
    baseSource: source,
    overrideSource: source.nullable(),
    baseDefinitionId: scopedId,
    overrideDefinitionId: scopedId.nullable(),
    icon: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('absent'),
        origin: z.enum(['base', 'override']),
        definitionId: scopedId,
        evidenceId: scopedId,
        evidenceDigest: scopedDigest,
      }),
      z.strictObject({
        kind: z.literal('image'),
        origin: z.enum(['base', 'override']),
        definitionId: scopedId,
        appearance: categoryIconAppearanceSchema,
      }),
    ]),
  })
  .superRefine((content, ctx) => {
    if (
      (content.overrideSource !== null &&
        content.overrideDefinitionId === null) ||
      (content.selector.kind === 'global' &&
        (content.overrideSource !== null ||
          content.overrideDefinitionId !== null)) ||
      (content.parentId === null) !== (content.level === 1) ||
      (content.icon.origin === 'base' &&
        content.icon.definitionId !== content.baseDefinitionId) ||
      (content.icon.origin === 'override' &&
        content.icon.definitionId !== content.overrideDefinitionId) ||
      (content.icon.kind === 'image' &&
        (content.icon.appearance.categoryId !== content.categoryId ||
          content.icon.appearance.identityId !== content.identityId ||
          content.icon.appearance.origin.kind !== content.icon.origin ||
          (content.icon.appearance.origin.kind === 'override' &&
            (content.selector.kind !== 'campus' ||
              content.icon.appearance.origin.campusId !==
                content.selector.campusId))))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Exact Category content and icon provenance required',
      });
  });
export type CategoryIconContent = z.infer<typeof categoryIconContentSchema>;
export function categoryIconDigest(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(
      `${RATING_CATEGORY_ICON_EXTENSION}:${domain}\n${canonicalJson(value)}`,
    )
    .digest('hex');
}
export function categoryIconContentDigest(content: CategoryIconContent) {
  return categoryIconDigest(
    'content',
    categoryIconContentSchema.parse(content),
  );
}
export interface CategoryIconReviewBinding {
  readonly id: string;
  readonly definitionDigest: string;
  readonly approvalDigest: string;
}
/** Inputs are immutable owner snapshots, not accepted client authority. The
 * publisher must consume/qualify the exact Review binding in its transaction. */
export interface CategoryIconReleaseCoverage {
  readonly scopeKey: string;
  readonly categoryId: string;
  readonly content: CategoryIconContent;
  readonly review: CategoryIconReviewBinding;
}
export interface CategoryIconReleaseRow {
  readonly releaseId: string;
  readonly catalogId: string;
  readonly scopeKey: string;
  readonly categoryId: string;
  readonly effectiveRevision: string;
  readonly effectiveDigest: string;
  readonly placementRevision: string;
  readonly extensionVersion: typeof RATING_CATEGORY_ICON_EXTENSION;
  readonly content: CategoryIconContent;
  readonly review: CategoryIconReviewBinding;
  readonly digest: string;
}
const unavailable = (): never => {
  throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
};
function contentFor(
  category: ScopedExpectedCategory,
  campusId: string | null,
  roots: readonly CategoryIconRoot[],
  budget: RatingScopedCompilationBudget,
): CategoryIconContent {
  const b = category.body;
  const baseSource = {
    id: category.baseSourceId,
    revision: category.baseSourceRevision,
  };
  const overrideSource =
    category.overrideSourceId === null
      ? null
      : {
          id: category.overrideSourceId,
          revision: category.overrideSourceRevision ?? unavailable(),
        };
  if (
    (category.overrideSourceId === null) !==
    (category.overrideSourceRevision === null)
  )
    unavailable();
  const base = roots.filter(
    (root) =>
      root.kind === 'base' &&
      root.categoryId === b.id &&
      root.identityId === b.identityId &&
      root.source.id === baseSource.id &&
      root.source.revision === baseSource.revision,
  );
  const overrides = roots.filter(
    (root) =>
      root.kind === 'override' &&
      root.categoryId === b.id &&
      root.identityId === b.identityId &&
      root.campusId === campusId &&
      root.baseSource.id === baseSource.id &&
      root.baseSource.revision === baseSource.revision,
  );
  if (
    base.length !== 1 ||
    overrides.length > 1 ||
    (overrideSource !== null && overrides.length !== 1)
  )
    unavailable();
  return categoryIconContentSchema.parse({
    categoryId: b.id,
    identityId: b.identityId,
    parentId: b.parentId,
    level: b.level,
    kind: b.kind,
    systemKey: b.systemKey,
    name: b.name,
    description: b.description,
    selector:
      campusId === null ? { kind: 'global' } : { kind: 'campus', campusId },
    baseSource,
    overrideSource,
    baseDefinitionId: base[0]!.definitionId,
    overrideDefinitionId: overrides[0]?.definitionId ?? null,
    icon: resolveCategoryIcon(
      roots,
      {
        categoryId: b.id,
        identityId: b.identityId,
        baseSource,
        overrideSource,
        campusId,
      },
      budget,
    ),
  });
}
/** Build exact review content before selecting any display/download image. */
export function categoryIconContentFor(
  category: ScopedExpectedCategory,
  campusId: string | null,
  roots: readonly CategoryIconRoot[],
  budget: RatingScopedCompilationBudget,
): CategoryIconContent {
  return contentFor(
    category,
    campusId,
    validateCategoryIconRoots(roots, budget),
    budget,
  );
}
/** Independent extension compiler. It never changes a frozen expected body,
 * global source vector, catalog ID, effective revision or original hash. */
export function compileCategoryIconRelease(
  releaseId: string,
  catalogs: readonly ScopedCompiledCatalog[],
  rawRoots: readonly CategoryIconRoot[],
  coverage: readonly CategoryIconReleaseCoverage[],
  budget: RatingScopedCompilationBudget,
): { rows: readonly CategoryIconReleaseRow[]; digest: string } {
  scopedId.parse(releaseId);
  const roots = validateCategoryIconRoots(rawRoots, budget);
  budget.observe({ categoryIconCoverage: coverage });
  const byKey = new Map<string, CategoryIconReleaseCoverage>();
  for (const item of coverage) {
    const key = `${item.scopeKey}:${item.categoryId}`;
    if (byKey.has(key)) unavailable();
    scopedId.parse(item.review.id);
    scopedDigest.parse(item.review.approvalDigest);
    if (
      item.review.definitionDigest !==
        categoryIconContentDigest(item.content) ||
      item.content.categoryId !== item.categoryId ||
      item.scopeKey !==
        (item.content.selector.kind === 'global'
          ? 'global'
          : `campus:${item.content.selector.campusId}`)
    )
      unavailable();
    byKey.set(key, item);
  }
  const rows: CategoryIconReleaseRow[] = [];
  const seenScopes = new Set<string>();
  for (const catalog of catalogs) {
    if (
      seenScopes.has(catalog.scopeKey) ||
      catalog.scopeKey !==
        (catalog.campusId === null ? 'global' : `campus:${catalog.campusId}`)
    )
      unavailable();
    seenScopes.add(catalog.scopeKey);
    for (const category of catalog.categories) {
      const key = `${catalog.scopeKey}:${category.expected.body.id}`;
      const exact = byKey.get(key) ?? unavailable();
      byKey.delete(key);
      const content = contentFor(
        category.expected,
        catalog.campusId,
        roots,
        budget,
      );
      if (canonicalJson(exact.content) !== canonicalJson(content))
        unavailable();
      const body = {
        releaseId,
        catalogId: catalog.id,
        scopeKey: catalog.scopeKey,
        categoryId: category.expected.body.id,
        effectiveRevision: category.revision,
        effectiveDigest: category.digest,
        placementRevision: category.expected.placementRevision,
        extensionVersion: RATING_CATEGORY_ICON_EXTENSION,
        content,
        review: exact.review,
      };
      const row = { ...body, digest: categoryIconDigest('release-row', body) };
      budget.observe({ categoryIconReleaseRow: row });
      rows.push(row);
    }
  }
  // Extra/duplicate coverage is as invalid as missing coverage; no selective pool.
  if (byKey.size !== 0) unavailable();
  rows.sort(
    (a, b) =>
      a.scopeKey.localeCompare(b.scopeKey) ||
      a.categoryId.localeCompare(b.categoryId),
  );
  return {
    rows,
    digest: categoryIconDigest(
      'release',
      rows.map((row) => row.digest),
    ),
  };
}
