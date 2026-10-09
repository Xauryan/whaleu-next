import { z } from 'zod';
import {
  ratingIdSchema,
  ratingPublicIdSchema,
  ratingText,
  ratingCursorSchema,
  ratingTimeSchema,
} from '../contracts.js';
export const prepareRatingTargetSchema = z.strictObject({
  clientRequestId: ratingIdSchema,
  regionId: ratingIdSchema.nullable(),
  categoryId: ratingIdSchema,
  expectedCategoryRevision: ratingIdSchema,
  expectedCatalogRevision: ratingIdSchema,
  name: ratingText(100),
  description: ratingText(500, false),
  assetIds: z.tuple([]),
});
export const createRatingTargetSchema = prepareRatingTargetSchema.extend({
  expectedContextRevision: ratingCursorSchema,
});
export const ratingTargetPreparationSchema = z.strictObject({
  requestId: ratingPublicIdSchema,
  targetId: ratingPublicIdSchema,
  revision: ratingPublicIdSchema,
  contextRevision: ratingCursorSchema,
});
export const ratingTargetCreationAppliedSchema = z.strictObject({
  requestId: ratingPublicIdSchema,
  operation: z.literal('create_target'),
  outcome: z.literal('applied'),
  targetId: ratingPublicIdSchema,
  revision: ratingPublicIdSchema,
  catalogRevision: ratingPublicIdSchema,
  occurredAt: ratingTimeSchema,
});
export type PrepareRatingTarget = z.infer<typeof prepareRatingTargetSchema>;
export type CreateRatingTarget = z.infer<typeof createRatingTargetSchema>;

export const ratingTargetCreationRejectedSchema = z.strictObject({
  requestId: ratingPublicIdSchema,
  operation: z.literal('create_target'),
  outcome: z.literal('rejected'),
  code: z.enum([
    'RATING_CREATION_CONTEXT_CHANGED',
    'CONTENT_REJECTED',
    'RATING_CREATION_CANCELLED',
  ]),
});
export const ratingTargetCreationReceiptSchema = z.discriminatedUnion(
  'outcome',
  [ratingTargetCreationAppliedSchema, ratingTargetCreationRejectedSchema],
);
