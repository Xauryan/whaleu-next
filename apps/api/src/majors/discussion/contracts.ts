import { z } from 'zod';
import {
  majorIdSchema as id,
  majorTextBodySchema,
  majorPublicIdSchema as publicId,
} from '../contracts.js';
export const majorDiscussionBodySchema = majorTextBodySchema;
const limit = z
  .string()
  .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
  .transform(Number)
  .default(20);
export const majorDiscussionQuerySchema = z.strictObject({
  sort: z.enum(['likes', 'time']).default('likes'),
  limit,
  cursor: z.string().min(1).max(2000).optional(),
});
export const majorRepliesQuerySchema = majorDiscussionQuerySchema.omit({
  sort: true,
});
export type MajorDiscussionQuery = z.infer<typeof majorDiscussionQuerySchema>;
export const majorDiscussionAuthorSchema = z.strictObject({
  mode: z.literal('named'),
  profileId: publicId,
  displayName: z.string().min(1).max(200),
});
export const majorDiscussionItemSchema = z.strictObject({
  id: publicId,
  majorId: publicId,
  rootId: publicId.nullable(),
  replyToReplyId: publicId.nullable(),
  body: majorDiscussionBodySchema,
  author: majorDiscussionAuthorSchema,
  addressedAuthor: majorDiscussionAuthorSchema.nullable(),
  createdAt: z.iso.datetime(),
  likes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  replyCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  isLiked: z.boolean(),
  myMembershipRevision: publicId.nullable(),
});
export type MajorDiscussionItem = z.infer<typeof majorDiscussionItemSchema>;
export const majorDiscussionPageSchema = z.strictObject({
  majorId: publicId,
  catalogRevision: publicId,
  majorRevision: publicId,
  discussionRevision: z.string().regex(/^[1-9][0-9]{0,18}$/),
  root: majorDiscussionItemSchema.nullable(),
  items: z.array(majorDiscussionItemSchema).max(50),
  totalCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  nextCursor: z.string().min(1).max(2000).nullable(),
  continuation: z.enum(['more', 'end']),
});
const source = {
  clientRequestId: id,
  expectedCatalogRevision: id,
  expectedMajorRevision: id,
};
export const majorRootPublishSchema = z.strictObject({
  ...source,
  body: majorDiscussionBodySchema,
});
export const majorReplyPublishSchema = majorRootPublishSchema.extend({
  replyToReplyId: id.nullable(),
});
export const majorDiscussionLikeSchema = z.strictObject({
  ...source,
  expectedMembershipRevision: id.nullable(),
  active: z.boolean(),
});
export type MajorRootPublish = z.infer<typeof majorRootPublishSchema>;
export type MajorReplyPublish = z.infer<typeof majorReplyPublishSchema>;
export type MajorDiscussionLike = z.infer<typeof majorDiscussionLikeSchema>;
export const majorDiscussionOperationSchema = z.enum([
  'major.discussion.root.v1',
  'major.discussion.reply.v1',
  'major.discussion.like.v1',
]);
export type MajorDiscussionOperation = z.infer<
  typeof majorDiscussionOperationSchema
>;
const base = { requestId: publicId, majorId: publicId };
const codes = z.enum([
  'MAJOR_REVISION_CONFLICT',
  'MAJOR_DISCUSSION_MEMBERSHIP_CONFLICT',
  'MAJOR_DISCUSSION_CANCELLED',
  'CONTENT_REJECTED',
]);
export const majorDiscussionReceiptSchema = z.union([
  z.strictObject({
    ...base,
    operation: z.literal('major.discussion.root.v1'),
    outcome: z.literal('applied'),
    commentId: publicId,
    createdAt: z.iso.datetime(),
  }),
  z.strictObject({
    ...base,
    operation: z.literal('major.discussion.reply.v1'),
    rootId: publicId,
    outcome: z.literal('applied'),
    commentId: publicId,
    createdAt: z.iso.datetime(),
  }),
  z.strictObject({
    ...base,
    operation: z.literal('major.discussion.root.v1'),
    outcome: z.literal('rejected'),
    code: codes,
  }),
  z.strictObject({
    ...base,
    operation: z.literal('major.discussion.reply.v1'),
    rootId: publicId,
    outcome: z.literal('rejected'),
    code: codes,
  }),
  z.strictObject({
    ...base,
    operation: z.literal('major.discussion.like.v1'),
    commentId: publicId,
    outcome: z.literal('applied'),
    active: z.boolean(),
    membershipRevision: publicId,
    recordedAt: z.iso.datetime(),
  }),
  z
    .strictObject({
      ...base,
      operation: z.literal('major.discussion.like.v1'),
      commentId: publicId,
      outcome: z.literal('noop'),
      active: z.boolean(),
      membershipRevision: publicId.nullable(),
      recordedAt: z.iso.datetime().nullable(),
    })
    .refine(
      (v) =>
        (v.membershipRevision === null) === (v.recordedAt === null) &&
        (!v.active || v.membershipRevision !== null),
    ),
  z.strictObject({
    ...base,
    operation: z.literal('major.discussion.like.v1'),
    commentId: publicId,
    outcome: z.literal('rejected'),
    code: codes,
  }),
]);
export type MajorDiscussionReceipt = z.infer<
  typeof majorDiscussionReceiptSchema
>;
export const majorDiscussionCancelSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('major.discussion.root.v1'),
    majorId: id,
    command: majorRootPublishSchema,
  }),
  z.strictObject({
    operation: z.literal('major.discussion.reply.v1'),
    majorId: id,
    rootId: id,
    command: majorReplyPublishSchema,
  }),
  z.strictObject({
    operation: z.literal('major.discussion.like.v1'),
    majorId: id,
    commentId: id,
    command: majorDiscussionLikeSchema,
  }),
]);
export type MajorDiscussionCancel = z.infer<typeof majorDiscussionCancelSchema>;
export const majorDiscussionOwnSchema = z.union([
  z.strictObject({
    kind: z.literal('recorded'),
    active: z.boolean(),
    revision: publicId,
    recordedAt: z.iso.datetime(),
    catalogRevision: publicId,
    majorRevision: publicId,
  }),
  z.strictObject({ kind: z.literal('not_liked') }),
  z.strictObject({ kind: z.literal('unavailable') }),
]);
export const majorDiscussionTargetSchema = z.strictObject({
  majorId: publicId,
  rootId: publicId,
  commentId: publicId,
});
const noticeBase = {
  noticeId: publicId,
  createdAt: z.iso.datetime(),
  readAt: z.iso.datetime().nullable(),
};
export const majorDiscussionNoticeSchema = z.union([
  z.strictObject({ ...noticeBase, status: z.literal('unavailable') }),
  z.strictObject({
    ...noticeBase,
    status: z.literal('available'),
    kind: z.enum(['reply', 'like']),
    preview: z.strictObject({
      text: z.string().max(100),
      author: majorDiscussionAuthorSchema,
    }),
    target: majorDiscussionTargetSchema,
  }),
]);
export const majorDiscussionNoticePageSchema = z.strictObject({
  items: z.array(majorDiscussionNoticeSchema).max(50),
  nextCursor: z.string().min(1).max(2000).nullable(),
  unreadCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export const majorDiscussionNoticeReadSchema = z.strictObject({
  noticeId: publicId,
  readAt: z.iso.datetime(),
});
