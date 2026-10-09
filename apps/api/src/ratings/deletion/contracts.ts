import { z } from 'zod';
import {
  ratingIdSchema,
  ratingPublicIdSchema,
  ratingCursorSchema,
  ratingTimeSchema,
} from '../contracts.js';

export const ratingDeletionKindSchema = z.enum(['comment', 'reply']);
const contextFields = {
  subjectKind: ratingDeletionKindSchema,
  targetId: ratingPublicIdSchema,
  rootId: ratingPublicIdSchema,
  subjectId: ratingPublicIdSchema,
  regionId: ratingPublicIdSchema.nullable(),
  targetRevision: ratingPublicIdSchema,
  rootRevision: ratingPublicIdSchema,
  revision: ratingPublicIdSchema,
  deleted: z.boolean(),
};
const validRoot = (value: {
  subjectKind: 'comment' | 'reply';
  rootId: string;
  subjectId: string;
  rootRevision: string;
  revision: string;
}) =>
  value.subjectKind !== 'comment' ||
  (value.rootId === value.subjectId && value.rootRevision === value.revision);
export const ratingDeletionContextSchema = z
  .strictObject(contextFields)
  .refine(validRoot);
export const ratingAdminDeletionContextSchema = z
  .strictObject({ ...contextFields, contextRevision: ratingCursorSchema })
  .refine(validRoot);
const commandFields = {
  clientRequestId: ratingIdSchema,
  targetId: ratingIdSchema,
  expectedTargetRevision: ratingIdSchema,
  expectedRevision: ratingIdSchema,
  expectedContextRevision: ratingCursorSchema,
};
export const adminDeleteRatingCommentSchema = z.strictObject(commandFields);
export const adminDeleteRatingReplySchema = z.strictObject({
  ...commandFields,
  rootId: ratingIdSchema,
  expectedRootRevision: ratingIdSchema,
});
export const ratingAdminDeletionOperationSchema = z.enum([
  'admin_delete_comment',
  'admin_delete_reply',
]);
export const ratingAdminDeletionRejectionSchema = z.enum([
  'RATING_NOT_FOUND',
  'RATING_REVISION_CONFLICT',
  'PHONE_VERIFICATION_REQUIRED',
  'SAFETY_ACTION_RESTRICTED',
]);
export const ratingAdminDeletionReceiptSchema = z.discriminatedUnion(
  'outcome',
  [
    z
      .strictObject({
        requestId: ratingPublicIdSchema,
        operation: ratingAdminDeletionOperationSchema,
        outcome: z.enum(['applied', 'noop']),
        targetId: ratingPublicIdSchema,
        rootId: ratingPublicIdSchema,
        subjectId: ratingPublicIdSchema,
        revision: ratingPublicIdSchema,
        occurredAt: ratingTimeSchema,
      })
      .refine(
        (r) =>
          r.operation !== 'admin_delete_comment' || r.rootId === r.subjectId,
      ),
    z.strictObject({
      requestId: ratingPublicIdSchema,
      operation: ratingAdminDeletionOperationSchema,
      outcome: z.literal('rejected'),
      code: ratingAdminDeletionRejectionSchema,
    }),
  ],
);
export type RatingDeletionKind = z.infer<typeof ratingDeletionKindSchema>;
export type RatingDeletionContext = z.infer<typeof ratingDeletionContextSchema>;
export type RatingAdminDeletionContext = z.infer<
  typeof ratingAdminDeletionContextSchema
>;
export type AdminDeleteRatingComment = z.infer<
  typeof adminDeleteRatingCommentSchema
>;
export type AdminDeleteRatingReply = z.infer<
  typeof adminDeleteRatingReplySchema
>;
export type RatingAdminDeletionOperation = z.infer<
  typeof ratingAdminDeletionOperationSchema
>;
export type RatingAdminDeletionReceipt = z.infer<
  typeof ratingAdminDeletionReceiptSchema
>;
