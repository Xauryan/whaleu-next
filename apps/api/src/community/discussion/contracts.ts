import { z } from 'zod';
import { publishCommentSchema, pageQuerySchema } from '../contracts.js';
import type { ApplicationErrorCode } from '../../http/application-error.js';
export const publishReplySchema = publishCommentSchema.safeExtend({
  clientRequestId: z.uuidv4().transform((id) => id.toLowerCase()),
  imageAssetIds: z
    .array(z.uuid().transform((id) => id.toLowerCase()))
    .max(3)
    .refine((ids) => new Set(ids).size === ids.length)
    .default([]),
  targetReplyId: z
    .uuid()
    .transform((id) => id.toLowerCase())
    .nullable()
    .default(null),
});
export type PublishReply = z.infer<typeof publishReplySchema>;
export const commentsQuerySchema = pageQuerySchema.extend({
  sort: z.enum(['time', 'likes']).default('likes'),
  order: z.enum(['asc', 'desc']).default('desc'),
  previewLimit: z
    .string()
    .regex(/^[1-5]$/)
    .default('2')
    .transform(Number),
});
export type CommentsQuery = z.infer<typeof commentsQuerySchema>;
export const repliesQuerySchema = pageQuerySchema.extend({
  limit: z
    .string()
    .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
    .default('20')
    .transform(Number),
});
export const contextQuerySchema = z
  .strictObject({
    commentId: z.uuid().optional(),
    replyId: z.uuid().optional(),
  })
  .refine((value) => Number(!!value.commentId) + Number(!!value.replyId) === 1);
export const discussionMutationSchema = z.strictObject({
  clientRequestId: z.uuidv4().transform((id) => id.toLowerCase()),
});
export type DiscussionOperation =
  'set_comment_like' | 'set_reply_like' | 'set_comment_pin';
export type DiscussionReceipt =
  | {
      requestId: string;
      operation: DiscussionOperation;
      outcome: 'applied';
      resourceId: string;
      desired: boolean;
    }
  | {
      requestId: string;
      operation: DiscussionOperation;
      outcome: 'rejected';
      code: ApplicationErrorCode;
    };
