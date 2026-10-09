import { z } from 'zod';
import {
  ratingCategorySchema,
  ratingCursorSchema,
  ratingIdSchema,
  ratingPublicIdSchema,
  ratingText,
  ratingTimeSchema,
} from '../contracts.js';
export const RATING_CATEGORY_NODE_LIMIT = 32;
export const RATING_CATEGORY_RELEASE_SCOPE_LIMIT = 33;
export const ratingCategoryNodeKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,31}$/);
const nodeInput = z.strictObject({
  key: ratingCategoryNodeKeySchema,
  parentKey: ratingCategoryNodeKeySchema.nullable(),
  name: ratingText(100),
  description: ratingText(500, false),
});
export const prepareRatingCategoriesSchema = z
  .strictObject({
    clientRequestId: ratingIdSchema,
    regionId: ratingIdSchema.nullable(),
    expectedCatalogRevision: ratingIdSchema.nullable(),
    expectedScopeRevision: ratingCursorSchema,
    parentId: ratingIdSchema.nullable(),
    expectedParentRevision: ratingIdSchema.nullable(),
    nodes: z.array(nodeInput).min(1).max(RATING_CATEGORY_NODE_LIMIT),
    assetIds: z.tuple([]),
  })
  .superRefine((value, context) => {
    if ((value.parentId === null) !== (value.expectedParentRevision === null))
      context.addIssue({
        code: 'custom',
        message: 'A parent requires its exact revision',
      });
    const levels = new Map<string, number>();
    for (const [index, node] of value.nodes.entries()) {
      if (
        levels.has(node.key) ||
        (index === 0) !== (node.parentKey === null) ||
        (node.parentKey !== null && !levels.has(node.parentKey))
      ) {
        context.addIssue({
          code: 'custom',
          path: ['nodes', index],
          message: 'A single ordered unique tree is required',
        });
        continue;
      }
      const level =
        node.parentKey === null ? 1 : levels.get(node.parentKey)! + 1;
      if (level > 3)
        context.addIssue({
          code: 'custom',
          path: ['nodes', index],
          message: 'Category depth exceeds three',
        });
      levels.set(node.key, level);
    }
  });
export const commitRatingCategoriesSchema =
  prepareRatingCategoriesSchema.safeExtend({
    expectedContextRevision: ratingCursorSchema,
  });
export const ratingCreatedCategorySchema = z.strictObject({
  key: ratingCategoryNodeKeySchema,
  id: ratingPublicIdSchema,
  revision: ratingPublicIdSchema,
  parentId: ratingPublicIdSchema.nullable(),
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});
export const ratingCategoryManagementContextSchema = z.strictObject({
  regionId: ratingPublicIdSchema.nullable(),
  catalogRevision: ratingPublicIdSchema.nullable(),
  scopeRevision: ratingCursorSchema,
  campusIds: z.array(ratingPublicIdSchema).max(1000),
  parents: z
    .array(
      z.strictObject({
        id: ratingPublicIdSchema,
        revision: ratingPublicIdSchema,
        name: ratingCategorySchema.shape.name,
        level: z.union([z.literal(1), z.literal(2)]),
      }),
    )
    .max(10000),
  maximumNodes: z.literal(32),
  maximumDepth: z.literal(3),
});
export const ratingCategoryPreparationSchema = z.strictObject({
  requestId: ratingPublicIdSchema,
  contextRevision: ratingCursorSchema,
  categories: z
    .array(ratingCreatedCategorySchema)
    .min(1)
    .max(RATING_CATEGORY_NODE_LIMIT),
});
export const ratingCategoryRejectionSchema = z.enum([
  'RATING_CATEGORY_CONTEXT_CHANGED',
  'CONTENT_REJECTED',
  'RATING_CATEGORY_CANCELLED',
  'RATING_NOT_FOUND',
  'PHONE_VERIFICATION_REQUIRED',
  'SAFETY_ACTION_RESTRICTED',
]);
export const ratingCategoryRejectedSchema = z.strictObject({
  requestId: ratingPublicIdSchema,
  operation: z.literal('create_categories'),
  outcome: z.literal('rejected'),
  code: ratingCategoryRejectionSchema,
});
export const ratingCategoryReceiptSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    requestId: ratingPublicIdSchema,
    operation: z.literal('create_categories'),
    outcome: z.literal('applied'),
    releaseId: ratingPublicIdSchema,
    categories: z
      .array(ratingCreatedCategorySchema)
      .min(1)
      .max(RATING_CATEGORY_NODE_LIMIT),
    catalogs: z
      .array(
        z.strictObject({
          regionId: ratingPublicIdSchema.nullable(),
          catalogRevision: ratingPublicIdSchema,
        }),
      )
      .min(1)
      .max(RATING_CATEGORY_RELEASE_SCOPE_LIMIT),
    occurredAt: ratingTimeSchema,
  }),
  ratingCategoryRejectedSchema,
]);
export const ratingCategoryPrepareResultSchema = z.union([
  ratingCategoryPreparationSchema,
  ratingCategoryRejectedSchema,
]);
export type PrepareRatingCategories = z.infer<
  typeof prepareRatingCategoriesSchema
>;
export type CommitRatingCategories = z.infer<
  typeof commitRatingCategoriesSchema
>;
export type RatingCreatedCategory = z.infer<typeof ratingCreatedCategorySchema>;
export type RatingCategoryReceipt = z.infer<typeof ratingCategoryReceiptSchema>;
