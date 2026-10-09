import { z } from 'zod';
import {
  ratingPublicIdSchema as id,
  ratingIdSchema,
  ratingTimeSchema,
  ratingRejectionSchema,
} from '../contracts.js';
const command = {
  clientRequestId: ratingIdSchema,
  regionId: id.nullable(),
  targetId: id,
  expectedTargetRevision: id,
  expectedRevision: id,
  expectedLikeRevision: id,
  liked: z.boolean(),
};
export const setRatingCommentLikeSchema = z.strictObject(command);
export const setRatingReplyLikeSchema = z.strictObject({
  ...command,
  rootId: id,
  expectedRootRevision: id,
});
export const ratingLikeStateSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('unavailable') }),
  z.strictObject({
    status: z.literal('known'),
    targetId: id,
    rootId: id,
    replyId: id.nullable(),
    count: z.number().int().nonnegative().max(2147483647),
    liked: z.boolean(),
    revision: id,
    allowedActions: z.strictObject({ setLike: z.literal(true) }),
  }),
]);
export const ratingLikeOperationSchema = z.enum([
  'set_comment_like',
  'set_reply_like',
]);
export const ratingLikeReceiptSchema = z.discriminatedUnion('outcome', [
  z
    .strictObject({
      requestId: id,
      operation: ratingLikeOperationSchema,
      outcome: z.enum(['applied', 'noop']),
      targetId: id,
      rootId: id,
      replyId: id.nullable(),
      liked: z.boolean(),
      revision: id,
      occurredAt: ratingTimeSchema,
    })
    .refine(
      (r) => (r.operation === 'set_comment_like') === (r.replyId === null),
    ),
  z.strictObject({
    requestId: id,
    operation: ratingLikeOperationSchema,
    outcome: z.literal('rejected'),
    code: ratingRejectionSchema,
  }),
]);
export type RatingLikeOperation = z.infer<typeof ratingLikeOperationSchema>;
export type RatingLikeReceipt = z.infer<typeof ratingLikeReceiptSchema>;
export type RatingLikeState = z.infer<typeof ratingLikeStateSchema>;
export type SetRatingCommentLike = z.infer<typeof setRatingCommentLikeSchema>;
export type SetRatingReplyLike = z.infer<typeof setRatingReplyLikeSchema>;
