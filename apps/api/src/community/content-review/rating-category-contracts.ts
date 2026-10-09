import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ratingText } from '../../ratings/contracts.js';
import { prepareRatingCategoriesSchema } from '../../ratings/category-management/contracts.js';
import { canonicalEqual, canonicalJson } from './contracts.js';

const id = z.uuid().refine((value) => value === value.toLowerCase());
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const campusIds = z
  .array(id)
  .max(1000)
  .refine((ids) =>
    ids.every((value, index) => index === 0 || ids[index - 1]! < value),
  );
const assigned = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  id,
  revision: id,
  parentId: id.nullable(),
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  name: ratingText(100),
  description: ratingText(500, false),
  scopeVersionId: id,
});
/** A category release has its own purpose, shape and digest. It is never a
 * target publication and cannot be consumed by a v1-v3 binding. */
export const ratingCategoryEnvelopeSchema = z
  .strictObject({
    version: z.literal(4),
    purpose: z.literal('publish_rating_categories'),
    accountId: id,
    clientRequestId: id,
    releaseId: id,
    intent: prepareRatingCategoriesSchema,
    scope: z.strictObject({
      regionId: id.nullable(),
      topologySnapshotId: id,
      campusIds,
      scopeRevision: token,
    }),
    categories: z.array(assigned).min(1).max(32),
    catalogs: z
      .array(
        z.strictObject({
          regionId: id.nullable(),
          beforeCatalogId: id.nullable(),
          afterCatalogId: id,
          campusIds,
        }),
      )
      .min(1)
      .max(33),
    assetIds: z.tuple([]),
  })
  .superRefine((value, context) => {
    const invalid = () =>
      context.addIssue({
        code: 'custom',
        message: 'Category release must match its exact intent, tree and scope',
      });
    if (
      value.clientRequestId !== value.intent.clientRequestId ||
      value.scope.regionId !== value.intent.regionId ||
      value.scope.scopeRevision !== value.intent.expectedScopeRevision ||
      value.categories.length !== value.intent.nodes.length
    )
      invalid();
    if (value.scope.regionId !== null && value.scope.campusIds.length === 0)
      invalid();
    const seenIds = new Set<string>(),
      seenRevisions = new Set<string>();
    const nodes = new Map<string, z.infer<typeof assigned>>();
    for (const [index, category] of value.categories.entries()) {
      const node = value.intent.nodes[index];
      if (
        !node ||
        category.key !== node.key ||
        category.name !== node.name ||
        category.description !== node.description ||
        seenIds.has(category.id) ||
        seenRevisions.has(category.revision) ||
        category.scopeVersionId !== value.categories[0]!.scopeVersionId
      )
        invalid();
      const parent = node?.parentKey ? nodes.get(node.parentKey) : undefined;
      if (
        index === 0
          ? category.parentId !== value.intent.parentId ||
            (category.parentId === null && category.level !== 1) ||
            (category.parentId !== null && category.level === 1)
          : !parent ||
            category.parentId !== parent.id ||
            category.level !== parent.level + 1
      )
        invalid();
      seenIds.add(category.id);
      seenRevisions.add(category.revision);
      nodes.set(category.key, category);
    }
    if (value.intent.parentId !== null && seenIds.has(value.intent.parentId))
      invalid();
    let previous: string | undefined;
    const outputs = new Set<string>(),
      union = new Set<string>();
    for (const catalog of value.catalogs) {
      const key = catalog.regionId ?? '';
      if (previous !== undefined && previous >= key) invalid();
      previous = key;
      if (
        outputs.has(catalog.afterCatalogId) ||
        catalog.beforeCatalogId === catalog.afterCatalogId ||
        (catalog.regionId !== null && !catalog.campusIds.length)
      )
        invalid();
      outputs.add(catalog.afterCatalogId);
      for (const campus of catalog.campusIds) {
        if (catalog.regionId !== null && union.has(campus)) invalid();
        if (catalog.regionId !== null) union.add(campus);
      }
      if (
        value.scope.regionId !== null &&
        (value.catalogs.length !== 1 ||
          catalog.regionId !== value.scope.regionId ||
          !canonicalEqual(catalog.campusIds, value.scope.campusIds))
      )
        invalid();
      if (
        catalog.regionId === value.scope.regionId &&
        catalog.beforeCatalogId !== value.intent.expectedCatalogRevision
      )
        invalid();
    }
    if (
      value.scope.regionId === null &&
      (value.catalogs[0]!.regionId !== null ||
        !canonicalEqual(value.catalogs[0]!.campusIds, value.scope.campusIds) ||
        !canonicalEqual([...union].sort(), value.scope.campusIds))
    )
      invalid();
  });
export type RatingCategoryEnvelope = z.infer<
  typeof ratingCategoryEnvelopeSchema
>;
export interface AcceptedRatingCategoryApproval {
  readonly decisionId: string;
  readonly digest: string;
  readonly version: 4;
  readonly envelope: RatingCategoryEnvelope;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function canonicalRatingCategoryEnvelope(
  value: unknown,
): RatingCategoryEnvelope {
  const envelope = ratingCategoryEnvelopeSchema.parse(value);
  if (!canonicalEqual(envelope, value))
    throw new Error('Noncanonical category envelope');
  return freeze(envelope);
}
export function ratingCategoryApprovalDigest(
  value: RatingCategoryEnvelope,
): string {
  return createHash('sha256')
    .update(
      `whaleu-rating-content-approval:v4\n${canonicalJson(canonicalRatingCategoryEnvelope(value))}`,
    )
    .digest('hex');
}
export interface RatingCategoryBaseDescriptor {
  readonly categoryId: string;
  readonly baseRevision: string;
  readonly envelope: RatingCategoryEnvelope;
}
export function canonicalRatingCategoryBase(
  value: RatingCategoryBaseDescriptor,
): RatingCategoryBaseDescriptor {
  const descriptor = z
    .strictObject({ categoryId: id, baseRevision: id, envelope: z.unknown() })
    .parse(value);
  const envelope = canonicalRatingCategoryEnvelope(descriptor.envelope);
  if (
    !envelope.categories.some(
      (category) =>
        category.id === descriptor.categoryId &&
        category.revision === descriptor.baseRevision,
    )
  )
    throw new Error('Category is absent from its exact Review envelope');
  return Object.freeze({ ...descriptor, envelope });
}
