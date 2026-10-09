import { z } from 'zod';
import {
  ratingCursorSchema,
  ratingIdSchema,
  ratingPublicIdSchema,
  ratingText,
  ratingTargetSchema,
  ratingTimeSchema,
} from '../../contracts.js';
const contentVersion = z.number().int().min(1).max(2147483646);
export const ratingTargetEditContextSchema = z.strictObject({
  targetId: ratingPublicIdSchema,
  revision: ratingPublicIdSchema,
  definitionRevision: ratingPublicIdSchema,
  contentVersion,
  regionId: ratingPublicIdSchema.nullable(),
  categoryId: ratingPublicIdSchema,
  categoryRevision: ratingPublicIdSchema,
  catalogRevision: ratingPublicIdSchema,
  name: ratingTargetSchema.shape.name,
  description: ratingTargetSchema.shape.description,
});
export const prepareRatingTargetEditSchema = z.strictObject({
  clientRequestId: ratingIdSchema,
  targetId: ratingIdSchema,
  regionId: ratingIdSchema.nullable(),
  expectedTargetRevision: ratingIdSchema,
  expectedDefinitionRevision: ratingIdSchema,
  expectedContentVersion: contentVersion,
  categoryId: ratingIdSchema,
  expectedCategoryRevision: ratingIdSchema,
  expectedCatalogRevision: ratingIdSchema,
  name: ratingText(100),
  description: ratingText(500, false),
  assetIds: z.tuple([]),
});
export const commitRatingTargetEditSchema =
  prepareRatingTargetEditSchema.extend({
    expectedContextRevision: ratingCursorSchema,
  });
export const ratingTargetEditPreparationSchema = z.strictObject({
  requestId: ratingPublicIdSchema,
  targetId: ratingPublicIdSchema,
  revision: ratingPublicIdSchema,
  definitionRevision: ratingPublicIdSchema,
  contentVersion: z.number().int().min(2).max(2147483647),
  contextRevision: ratingCursorSchema,
});
export const ratingTargetEditRejectionSchema = z.enum([
  'RATING_EDIT_CONTEXT_CHANGED',
  'CONTENT_REJECTED',
  'RATING_EDIT_CANCELLED',
  'RATING_NOT_FOUND',
  'PHONE_VERIFICATION_REQUIRED',
  'AFFILIATION_VERIFICATION_REQUIRED',
  'IDENTITY_CAMPUS_REQUIRED',
  'SAFETY_ACTION_RESTRICTED',
]);
export const ratingTargetEditRejectedSchema = z.strictObject({
  requestId: ratingPublicIdSchema,
  operation: z.literal('edit_target'),
  outcome: z.literal('rejected'),
  code: ratingTargetEditRejectionSchema,
});
export const ratingTargetEditReceiptSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    requestId: ratingPublicIdSchema,
    operation: z.literal('edit_target'),
    outcome: z.enum(['applied', 'noop']),
    targetId: ratingPublicIdSchema,
    revision: ratingPublicIdSchema,
    definitionRevision: ratingPublicIdSchema,
    contentVersion: z.number().int().min(1).max(2147483647),
    occurredAt: ratingTimeSchema,
  }),
  ratingTargetEditRejectedSchema,
]);
export const ratingTargetEditPrepareResultSchema = z.union([
  ratingTargetEditPreparationSchema,
  ratingTargetEditRejectedSchema,
]);
export type PrepareRatingTargetEdit = z.infer<
  typeof prepareRatingTargetEditSchema
>;
export type CommitRatingTargetEdit = z.infer<
  typeof commitRatingTargetEditSchema
>;
export type RatingTargetEditReceipt = z.infer<
  typeof ratingTargetEditReceiptSchema
>;
