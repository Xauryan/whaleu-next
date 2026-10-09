import {
  decodeRatingCategoryCreationIntent,
  type RatingCategoryCreationInput,
  type RatingCategoryCreationIntent,
  type RatingCategoryCreationReceipt,
  type RatingCategoryManagementContext,
  type RatingCategoryPreparation,
  type RatingPreparedCategory,
} from '../src/ratings/category-management-contract';
import { regionId, requestId, revision, timestamp } from './ratings-helpers';

export const categoryTestId = (value: number): string =>
  `a0000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
export const categoryScopeRevision = 's'.repeat(43);
export const categoryContextRevision = 'c'.repeat(43);
export const existingCategoryParentId = categoryTestId(1);
export const existingCategoryParentRevision = categoryTestId(2);
export const categoryCampusIds = [categoryTestId(21), categoryTestId(22)];

export function categoryCreationIntent(
  patch: Partial<RatingCategoryCreationInput> = {},
): RatingCategoryCreationIntent {
  return decodeRatingCategoryCreationIntent({
    operation: 'create_categories',
    payload: {
      clientRequestId: requestId,
      regionId: null,
      expectedCatalogRevision: revision,
      expectedScopeRevision: categoryScopeRevision,
      parentId: null,
      expectedParentRevision: null,
      nodes: [
        {
          key: 'root',
          parentKey: null,
          name: 'Synthetic root',
          description: '',
        },
        {
          key: 'child',
          parentKey: 'root',
          name: 'Synthetic child',
          description: 'First\nsecond',
        },
        {
          key: 'leaf',
          parentKey: 'child',
          name: 'Synthetic leaf',
          description: 'Independent category text',
        },
      ],
      assetIds: [],
      ...patch,
    },
  });
}
export function categoryManagementContext(
  scope: string | null = null,
): RatingCategoryManagementContext {
  return {
    regionId: scope,
    catalogRevision: revision,
    scopeRevision: categoryScopeRevision,
    campusIds: [...categoryCampusIds],
    parents: [
      {
        id: existingCategoryParentId,
        revision: existingCategoryParentRevision,
        name: 'Existing root',
        level: 1,
      },
      {
        id: categoryTestId(3),
        revision: categoryTestId(4),
        name: 'Existing child',
        level: 2,
      },
    ],
    maximumNodes: 32,
    maximumDepth: 3,
  };
}
export function categoryPreparation(
  intent = categoryCreationIntent(),
  existingParentLevel: 1 | 2 = 1,
): RatingCategoryPreparation {
  const earlier = new Map<string, RatingPreparedCategory>();
  const categories = intent.payload.nodes.map(
    (node, index): RatingPreparedCategory => {
      const parent =
        node.parentKey === null ? undefined : earlier.get(node.parentKey);
      const category: RatingPreparedCategory = {
        key: node.key,
        id: categoryTestId(100 + index),
        revision: categoryTestId(200 + index),
        parentId: parent?.id ?? intent.payload.parentId,
        level: (parent
          ? parent.level + 1
          : intent.payload.parentId === null
            ? 1
            : existingParentLevel + 1) as 1 | 2 | 3,
      };
      earlier.set(node.key, category);
      return category;
    },
  );
  return {
    requestId: intent.payload.clientRequestId,
    contextRevision: categoryContextRevision,
    categories,
  };
}
export function categoryCreationReceipt(
  intent = categoryCreationIntent(),
  existingParentLevel: 1 | 2 = 1,
): Extract<RatingCategoryCreationReceipt, { outcome: 'applied' }> {
  return {
    requestId: intent.payload.clientRequestId,
    operation: 'create_categories',
    outcome: 'applied',
    releaseId: categoryTestId(300),
    categories: categoryPreparation(intent, existingParentLevel).categories,
    catalogs:
      intent.payload.regionId === null
        ? [
            { regionId: null, catalogRevision: categoryTestId(301) },
            { regionId, catalogRevision: categoryTestId(302) },
          ]
        : [
            {
              regionId: intent.payload.regionId,
              catalogRevision: categoryTestId(302),
            },
          ],
    occurredAt: timestamp,
  };
}
export function cancelledCategoryReceipt(
  intent = categoryCreationIntent(),
): Extract<RatingCategoryCreationReceipt, { outcome: 'rejected' }> {
  return {
    requestId: intent.payload.clientRequestId,
    operation: 'create_categories',
    outcome: 'rejected',
    code: 'RATING_CATEGORY_CANCELLED',
  };
}
