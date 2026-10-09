import { z } from 'zod';
import {
  ratingIdSchema,
  ratingPublicIdSchema,
  ratingTimeSchema,
} from '../../contracts.js';
export const deleteRatingTargetSchema = z.strictObject({
  clientRequestId: ratingIdSchema,
  expectedTargetRevision: ratingPublicIdSchema,
});
export const cancelRatingTargetDeletionSchema = deleteRatingTargetSchema.extend(
  {
    targetId: ratingPublicIdSchema,
  },
);
export const ratingTargetOwnerDeletionContextSchema = z.strictObject({
  targetId: ratingPublicIdSchema,
  revision: ratingPublicIdSchema,
  deletion: z.strictObject({
    kind: z.enum(['not_owner_deleted', 'owner_deleted']),
  }),
});
export const ratingTargetOwnerDeletionRejectionSchema = z.enum([
  'RATING_NOT_FOUND',
  'RATING_REVISION_CONFLICT',
  'PHONE_VERIFICATION_REQUIRED',
  'SAFETY_ACTION_RESTRICTED',
  'RATING_TARGET_DELETION_CANCELLED',
]);
export const ratingTargetOwnerDeletionReceiptSchema = z.discriminatedUnion(
  'outcome',
  [
    z.strictObject({
      requestId: ratingPublicIdSchema,
      operation: z.literal('delete_target'),
      outcome: z.enum(['applied', 'noop']),
      targetId: ratingPublicIdSchema,
      revision: ratingPublicIdSchema,
      occurredAt: ratingTimeSchema,
    }),
    z.strictObject({
      requestId: ratingPublicIdSchema,
      operation: z.literal('delete_target'),
      outcome: z.literal('rejected'),
      code: ratingTargetOwnerDeletionRejectionSchema,
    }),
  ],
);
export type DeleteRatingTarget = z.infer<typeof deleteRatingTargetSchema>;
export type RatingTargetDeletionIntent = z.infer<
  typeof cancelRatingTargetDeletionSchema
>;
export type RatingTargetOwnerDeletionReceipt = z.infer<
  typeof ratingTargetOwnerDeletionReceiptSchema
>;
