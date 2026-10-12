import { z } from 'zod';
import {
  majorIdSchema as id,
  majorPublicIdSchema as publicId,
} from '../contracts.js';
export const majorDiscussionDeleteSchema = z.strictObject({
  clientRequestId: id,
  rootId: id.nullable(),
});
export type MajorDiscussionDelete = z.infer<typeof majorDiscussionDeleteSchema>;
export const majorDiscussionDeleteCancelSchema = z.strictObject({
  operation: z.literal('major.discussion.delete.v1'),
  majorId: id,
  commentId: id,
  command: majorDiscussionDeleteSchema,
});
export type MajorDiscussionDeleteCancel = z.infer<
  typeof majorDiscussionDeleteCancelSchema
>;
const base = {
  requestId: publicId,
  operation: z.literal('major.discussion.delete.v1'),
  majorId: publicId,
  commentId: publicId,
  rootId: publicId.nullable(),
};
export const majorDiscussionDeleteReceiptSchema = z.union([
  z.strictObject({
    ...base,
    outcome: z.enum(['applied', 'noop']),
    tombstoneId: publicId,
    recordedAt: z.iso.datetime(),
  }),
  z.strictObject({
    ...base,
    outcome: z.literal('rejected'),
    code: z.literal('MAJOR_DISCUSSION_CANCELLED'),
  }),
]);
export type MajorDiscussionDeleteReceipt = z.infer<
  typeof majorDiscussionDeleteReceiptSchema
>;

export const majorDiscussionDeleteCapabilityQuerySchema = z.strictObject({
  rootId: id.optional(),
});
export const majorDiscussionDeleteCapabilitySchema = z.strictObject({
  majorId: publicId,
  commentId: publicId,
  rootId: publicId.nullable(),
  allowed: z.boolean(),
});
