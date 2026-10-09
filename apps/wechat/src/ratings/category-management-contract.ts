import { isRecord } from '../api/errors';
import { exact } from '../community/contract';
import {
  canonicalRatingText,
  invalidRating,
  ratingCursor,
  ratingId,
} from './contract';
import { ratingNullableId, ratingTimestamp } from './discussion-contract';

export interface RatingCategoryCreationNode {
  readonly key: string;
  readonly parentKey: string | null;
  readonly name: string;
  readonly description: string;
}
export interface RatingCategoryCreationInput {
  readonly clientRequestId: string;
  readonly regionId: string | null;
  readonly expectedCatalogRevision: string | null;
  readonly expectedScopeRevision: string;
  readonly parentId: string | null;
  readonly expectedParentRevision: string | null;
  readonly nodes: readonly RatingCategoryCreationNode[];
  readonly assetIds: readonly [];
}
export interface RatingCategoryCreationIntent {
  readonly operation: 'create_categories';
  readonly payload: RatingCategoryCreationInput;
}
export interface RatingCategoryManagementContext {
  readonly regionId: string | null;
  readonly catalogRevision: string | null;
  readonly scopeRevision: string;
  readonly campusIds: readonly string[];
  readonly parents: readonly {
    readonly id: string;
    readonly revision: string;
    readonly name: string;
    readonly level: 1 | 2;
  }[];
  readonly maximumNodes: 32;
  readonly maximumDepth: 3;
}
export interface RatingPreparedCategory {
  readonly key: string;
  readonly id: string;
  readonly revision: string;
  readonly parentId: string | null;
  readonly level: 1 | 2 | 3;
}
export interface RatingCategoryPreparation {
  readonly requestId: string;
  readonly contextRevision: string;
  readonly categories: readonly RatingPreparedCategory[];
}
export const ratingCategoryRejections = [
  'RATING_CATEGORY_CONTEXT_CHANGED',
  'CONTENT_REJECTED',
  'RATING_CATEGORY_CANCELLED',
  'RATING_NOT_FOUND',
  'PHONE_VERIFICATION_REQUIRED',
  'SAFETY_ACTION_RESTRICTED',
] as const;
export type RatingCategoryCreationReceipt =
  | {
      readonly requestId: string;
      readonly operation: 'create_categories';
      readonly outcome: 'rejected';
      readonly code: (typeof ratingCategoryRejections)[number];
    }
  | {
      readonly requestId: string;
      readonly operation: 'create_categories';
      readonly outcome: 'applied';
      readonly releaseId: string;
      readonly categories: readonly RatingPreparedCategory[];
      readonly catalogs: readonly {
        readonly regionId: string | null;
        readonly catalogRevision: string;
      }[];
      readonly occurredAt: string;
    };
export type RatingCategoryPrepared =
  | RatingCategoryPreparation
  | Extract<RatingCategoryCreationReceipt, { outcome: 'rejected' }>;
const keyValid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(value);
const text = (raw: unknown, maximum: number, required = true): string => {
  const result = canonicalRatingText(raw, maximum, required);
  if (result !== raw) invalidRating();
  return result;
};

/** Canonical input only: a stored intent must never be silently repaired or reinterpreted. */
export function decodeRatingCategoryNodes(
  raw: unknown,
): readonly RatingCategoryCreationNode[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 32) invalidRating();
  const levels = new Map<string, number>();
  return Object.freeze(
    raw.map((node: unknown, index) => {
      exact(node, ['key', 'parentKey', 'name', 'description']);
      if (
        !keyValid(node.key) ||
        levels.has(node.key) ||
        (index === 0
          ? node.parentKey !== null
          : !keyValid(node.parentKey) || !levels.has(node.parentKey))
      )
        invalidRating();
      const level =
        node.parentKey === null ? 1 : levels.get(node.parentKey as string)! + 1;
      if (level > 3) invalidRating();
      levels.set(node.key, level);
      return Object.freeze({
        key: node.key,
        parentKey: node.parentKey as string | null,
        name: text(node.name, 100),
        description: text(node.description, 500, false),
      });
    }),
  );
}
export function decodeRatingCategoryCreationInput(
  value: unknown,
): RatingCategoryCreationInput {
  exact(value, [
    'clientRequestId',
    'regionId',
    'expectedCatalogRevision',
    'expectedScopeRevision',
    'parentId',
    'expectedParentRevision',
    'nodes',
    'assetIds',
  ]);
  if (
    !ratingId(value.clientRequestId) ||
    !ratingNullableId(value.regionId) ||
    !ratingNullableId(value.expectedCatalogRevision) ||
    !ratingCursor(value.expectedScopeRevision) ||
    !ratingNullableId(value.parentId) ||
    !ratingNullableId(value.expectedParentRevision) ||
    (value.parentId === null) !== (value.expectedParentRevision === null) ||
    (value.parentId !== null && value.expectedCatalogRevision === null) ||
    !Array.isArray(value.assetIds) ||
    value.assetIds.length !== 0
  )
    invalidRating();
  const nodes = decodeRatingCategoryNodes(value.nodes);
  if (value.parentId !== null) {
    const levels = new Map<string, number>();
    for (const node of nodes) {
      const level =
        node.parentKey === null ? 1 : levels.get(node.parentKey)! + 1;
      // Every existing parent consumes at least one level. Its exact level is rechecked by the context/server.
      if (level > 2) invalidRating();
      levels.set(node.key, level);
    }
  }
  return Object.freeze({
    clientRequestId: value.clientRequestId,
    regionId: value.regionId,
    expectedCatalogRevision: value.expectedCatalogRevision,
    expectedScopeRevision: value.expectedScopeRevision,
    parentId: value.parentId,
    expectedParentRevision: value.expectedParentRevision,
    nodes,
    assetIds: Object.freeze([]) as readonly [],
  });
}
export function decodeRatingCategoryCreationIntent(
  value: unknown,
): RatingCategoryCreationIntent {
  exact(value, ['operation', 'payload']);
  if (value.operation !== 'create_categories') invalidRating();
  return Object.freeze({
    operation: 'create_categories',
    payload: decodeRatingCategoryCreationInput(value.payload),
  });
}
export function decodeRatingCategoryManagementContext(
  value: unknown,
): RatingCategoryManagementContext {
  exact(value, [
    'regionId',
    'catalogRevision',
    'scopeRevision',
    'campusIds',
    'parents',
    'maximumNodes',
    'maximumDepth',
  ]);
  if (
    !ratingNullableId(value.regionId) ||
    !ratingNullableId(value.catalogRevision) ||
    !ratingCursor(value.scopeRevision) ||
    value.maximumNodes !== 32 ||
    value.maximumDepth !== 3 ||
    !Array.isArray(value.campusIds) ||
    value.campusIds.length > 1000 ||
    !value.campusIds.every(ratingId) ||
    (value.regionId !== null && value.campusIds.length === 0) ||
    value.campusIds.some((id, i, ids) => i > 0 && ids[i - 1]! >= id) ||
    !Array.isArray(value.parents) ||
    value.parents.length > 10000
  )
    invalidRating();
  const ids = new Set<string>();
  const parents = value.parents.map((parent: unknown) => {
    exact(parent, ['id', 'revision', 'name', 'level']);
    if (
      !ratingId(parent.id) ||
      ids.has(parent.id) ||
      !ratingId(parent.revision) ||
      (parent.level !== 1 && parent.level !== 2) ||
      value.catalogRevision === null
    )
      invalidRating();
    ids.add(parent.id);
    return Object.freeze({
      id: parent.id,
      revision: parent.revision,
      name: text(parent.name, 100),
      level: parent.level,
    });
  });
  return Object.freeze({
    regionId: value.regionId,
    catalogRevision: value.catalogRevision,
    scopeRevision: value.scopeRevision,
    campusIds: Object.freeze([...value.campusIds]),
    parents: Object.freeze(parents),
    maximumNodes: 32,
    maximumDepth: 3,
  });
}
function decodeCategories(raw: unknown): readonly RatingPreparedCategory[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 32) invalidRating();
  const ids = new Set<string>(),
    revisions = new Set<string>(),
    keys = new Set<string>();
  return Object.freeze(
    raw.map((node: unknown) => {
      exact(node, ['key', 'id', 'revision', 'parentId', 'level']);
      if (
        !keyValid(node.key) ||
        keys.has(node.key) ||
        !ratingId(node.id) ||
        ids.has(node.id) ||
        !ratingId(node.revision) ||
        revisions.has(node.revision) ||
        !ratingNullableId(node.parentId) ||
        ![1, 2, 3].includes(node.level as number) ||
        node.id === node.parentId
      )
        invalidRating();
      ids.add(node.id);
      revisions.add(node.revision);
      keys.add(node.key);
      return Object.freeze({
        key: node.key,
        id: node.id,
        revision: node.revision,
        parentId: node.parentId,
        level: node.level as 1 | 2 | 3,
      });
    }),
  );
}
export function decodeRatingCategoryPreparation(
  value: unknown,
): RatingCategoryPreparation {
  exact(value, ['requestId', 'contextRevision', 'categories']);
  if (!ratingId(value.requestId) || !ratingCursor(value.contextRevision))
    invalidRating();
  return Object.freeze({
    requestId: value.requestId,
    contextRevision: value.contextRevision,
    categories: decodeCategories(value.categories),
  });
}
export function decodeRatingCategoryCreationReceipt(
  value: unknown,
): RatingCategoryCreationReceipt {
  if (!isRecord(value)) invalidRating();
  if (value.outcome === 'rejected') {
    exact(value, ['requestId', 'operation', 'outcome', 'code']);
    if (
      !ratingId(value.requestId) ||
      value.operation !== 'create_categories' ||
      !(ratingCategoryRejections as readonly unknown[]).includes(value.code)
    )
      invalidRating();
    return Object.freeze({
      requestId: value.requestId,
      operation: 'create_categories',
      outcome: 'rejected',
      code: value.code as (typeof ratingCategoryRejections)[number],
    });
  }
  exact(value, [
    'requestId',
    'operation',
    'outcome',
    'releaseId',
    'categories',
    'catalogs',
    'occurredAt',
  ]);
  if (
    !ratingId(value.requestId) ||
    value.operation !== 'create_categories' ||
    value.outcome !== 'applied' ||
    !ratingId(value.releaseId) ||
    !ratingTimestamp(value.occurredAt) ||
    !Array.isArray(value.catalogs) ||
    value.catalogs.length === 0 ||
    value.catalogs.length > 33
  )
    invalidRating();
  const scopes = new Set<string | null>(),
    revisions = new Set<string>();
  const catalogs = value.catalogs.map((catalog: unknown) => {
    exact(catalog, ['regionId', 'catalogRevision']);
    if (
      !ratingNullableId(catalog.regionId) ||
      !ratingId(catalog.catalogRevision) ||
      scopes.has(catalog.regionId) ||
      revisions.has(catalog.catalogRevision)
    )
      invalidRating();
    scopes.add(catalog.regionId);
    revisions.add(catalog.catalogRevision);
    return Object.freeze({
      regionId: catalog.regionId,
      catalogRevision: catalog.catalogRevision,
    });
  });
  return Object.freeze({
    requestId: value.requestId,
    operation: 'create_categories',
    outcome: 'applied',
    releaseId: value.releaseId,
    categories: decodeCategories(value.categories),
    catalogs: Object.freeze(catalogs),
    occurredAt: value.occurredAt,
  });
}
export function decodeRatingCategoryPrepared(
  value: unknown,
): RatingCategoryPrepared {
  if (isRecord(value) && 'outcome' in value) {
    const receipt = decodeRatingCategoryCreationReceipt(value);
    if (receipt.outcome !== 'rejected') invalidRating();
    return receipt;
  }
  return decodeRatingCategoryPreparation(value);
}
function matchCategories(
  intent: RatingCategoryCreationIntent,
  categories: readonly RatingPreparedCategory[],
): void {
  if (categories.length !== intent.payload.nodes.length) invalidRating();
  const earlier = new Map<string, RatingPreparedCategory>();
  categories.forEach((category, index) => {
    const node = intent.payload.nodes[index]!;
    const parent = node.parentKey === null ? null : earlier.get(node.parentKey);
    if (
      category.key !== node.key ||
      category.parentId !== (parent ? parent.id : intent.payload.parentId) ||
      (parent
        ? category.level !== parent.level + 1
        : intent.payload.parentId === null
          ? category.level !== 1
          : category.level < 2) ||
      category.id === intent.payload.parentId
    )
      invalidRating();
    earlier.set(node.key, category);
  });
}
export function matchRatingCategoryPreparation(
  intent: RatingCategoryCreationIntent,
  prepared: RatingCategoryPreparation,
): void {
  if (prepared.requestId !== intent.payload.clientRequestId) invalidRating();
  matchCategories(intent, prepared.categories);
}
export function matchRatingCategoryCreationReceipt(
  intent: RatingCategoryCreationIntent,
  receipt: RatingCategoryCreationReceipt,
): void {
  if (
    receipt.requestId !== intent.payload.clientRequestId ||
    receipt.operation !== intent.operation
  )
    invalidRating();
  if (receipt.outcome === 'applied') {
    matchCategories(intent, receipt.categories);
    if (
      !receipt.catalogs.some(
        (catalog) => catalog.regionId === intent.payload.regionId,
      ) ||
      (intent.payload.regionId !== null &&
        receipt.catalogs.some(
          (catalog) => catalog.regionId !== intent.payload.regionId,
        )) ||
      receipt.catalogs.some(
        (catalog) =>
          catalog.catalogRevision === intent.payload.expectedCatalogRevision,
      )
    )
      invalidRating();
  }
}
export interface RatingCategoryManagementRoute {
  readonly regionId: string | null;
}
export function decodeRatingCategoryManagementRoute(
  value: unknown,
): RatingCategoryManagementRoute {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== 'regionId') ||
    (value.regionId !== undefined && !ratingNullableId(value.regionId))
  )
    invalidRating();
  return Object.freeze({
    regionId: (value.regionId as string | null | undefined) ?? null,
  });
}
export function ratingCategoryManagementPath(
  regionId: string | null,
): string | null {
  if (!ratingNullableId(regionId)) return null;
  return `/pages/rating-category-create/rating-category-create${regionId ? `?regionId=${regionId}` : ''}`;
}
