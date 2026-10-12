import { z } from 'zod';
import {
  windowIdSchema as id,
  windowPublicIdSchema as publicId,
} from '../contracts.js';
// New bounded Next text policy; preserve the accepted text byte-for-byte.
export const windowDiscussionBodySchema = z
  .string()
  .min(1)
  .max(8000)
  .refine(
    (v) =>
      v.trim().length > 0 &&
      !v.includes('\u0000') &&
      Buffer.byteLength(v, 'utf8') <= 8000 &&
      Buffer.from(v, 'utf8').toString('utf8') === v,
  );
const limit = z
  .string()
  .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
  .transform(Number)
  .default(20);
export const windowDiscussionQuerySchema = z.strictObject({
  sort: z.enum(['likes', 'time']).default('likes'),
  limit,
  cursor: z.string().min(1).max(2000).optional(),
});
export const windowRepliesQuerySchema = windowDiscussionQuerySchema.omit({
  sort: true,
});
export type WindowDiscussionQuery = z.infer<typeof windowDiscussionQuerySchema>;
export const windowDiscussionAuthorSchema = z.strictObject({
  mode: z.literal('named'),
  profileId: publicId,
  displayName: z.string().min(1).max(200),
});
export const windowDiscussionItemSchema = z.strictObject({
  id: publicId,
  windowId: publicId,
  rootId: publicId.nullable(),
  replyToReplyId: publicId.nullable(),
  body: windowDiscussionBodySchema,
  author: windowDiscussionAuthorSchema,
  addressedAuthor: windowDiscussionAuthorSchema.nullable(),
  createdAt: z.iso.datetime(),
  likes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  replyCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  isLiked: z.boolean(),
  myMembershipRevision: publicId.nullable(),
});
export type WindowDiscussionItem = z.infer<typeof windowDiscussionItemSchema>;
export const windowDiscussionPageSchema = z.strictObject({
  windowId: publicId,
  catalogRevision: publicId,
  windowRevision: publicId,
  discussionRevision: z.string().regex(/^[1-9][0-9]{0,18}$/),
  root: windowDiscussionItemSchema.nullable(),
  items: z.array(windowDiscussionItemSchema).max(50),
  totalCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  nextCursor: z.string().min(1).max(2000).nullable(),
  continuation: z.enum(['more', 'end']),
  creatorNotice: z.literal('unavailable'),
});
const source = {
  clientRequestId: id,
  expectedCatalogRevision: id,
  expectedWindowRevision: id,
};
export const windowRootPublishSchema = z.strictObject({
  ...source,
  body: windowDiscussionBodySchema,
});
export const windowReplyPublishSchema = windowRootPublishSchema.extend({
  replyToReplyId: id.nullable(),
});
export const windowDiscussionLikeSchema = z.strictObject({
  ...source,
  expectedMembershipRevision: id.nullable(),
  active: z.boolean(),
});
export type WindowRootPublish = z.infer<typeof windowRootPublishSchema>;
export type WindowReplyPublish = z.infer<typeof windowReplyPublishSchema>;
export type WindowDiscussionLike = z.infer<typeof windowDiscussionLikeSchema>;
export const windowDiscussionOperationSchema = z.enum([
  'window.discussion.root.v1',
  'window.discussion.reply.v1',
  'window.discussion.like.v1',
]);
export type WindowDiscussionOperation = z.infer<
  typeof windowDiscussionOperationSchema
>;
const base = { requestId: publicId, windowId: publicId };
const codes = z.enum([
  'WINDOW_REVISION_CONFLICT',
  'WINDOW_DISCUSSION_MEMBERSHIP_CONFLICT',
  'WINDOW_DISCUSSION_CANCELLED',
  'CONTENT_REJECTED',
]);
export const windowDiscussionReceiptSchema = z.union([
  z.strictObject({
    ...base,
    operation: z.literal('window.discussion.root.v1'),
    outcome: z.literal('applied'),
    commentId: publicId,
    createdAt: z.iso.datetime(),
  }),
  z.strictObject({
    ...base,
    operation: z.literal('window.discussion.reply.v1'),
    rootId: publicId,
    outcome: z.literal('applied'),
    commentId: publicId,
    createdAt: z.iso.datetime(),
  }),
  z.strictObject({
    ...base,
    operation: z.literal('window.discussion.root.v1'),
    outcome: z.literal('rejected'),
    code: codes,
  }),
  z.strictObject({
    ...base,
    operation: z.literal('window.discussion.reply.v1'),
    rootId: publicId,
    outcome: z.literal('rejected'),
    code: codes,
  }),
  z.strictObject({
    ...base,
    operation: z.literal('window.discussion.like.v1'),
    commentId: publicId,
    outcome: z.literal('applied'),
    active: z.boolean(),
    membershipRevision: publicId,
    recordedAt: z.iso.datetime(),
  }),
  z
    .strictObject({
      ...base,
      operation: z.literal('window.discussion.like.v1'),
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
    operation: z.literal('window.discussion.like.v1'),
    commentId: publicId,
    outcome: z.literal('rejected'),
    code: codes,
  }),
]);
export type WindowDiscussionReceipt = z.infer<
  typeof windowDiscussionReceiptSchema
>;
export const windowDiscussionCancelSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('window.discussion.root.v1'),
    windowId: id,
    command: windowRootPublishSchema,
  }),
  z.strictObject({
    operation: z.literal('window.discussion.reply.v1'),
    windowId: id,
    rootId: id,
    command: windowReplyPublishSchema,
  }),
  z.strictObject({
    operation: z.literal('window.discussion.like.v1'),
    windowId: id,
    commentId: id,
    command: windowDiscussionLikeSchema,
  }),
]);
export type WindowDiscussionCancel = z.infer<
  typeof windowDiscussionCancelSchema
>;
export const windowDiscussionOwnSchema = z.union([
  z.strictObject({
    kind: z.literal('recorded'),
    active: z.boolean(),
    revision: publicId,
    recordedAt: z.iso.datetime(),
    catalogRevision: publicId,
    windowRevision: publicId,
  }),
  z.strictObject({ kind: z.literal('not_liked') }),
  z.strictObject({ kind: z.literal('unavailable') }),
]);
export const windowDiscussionTargetSchema = z.strictObject({
  windowId: publicId,
  rootId: publicId,
  commentId: publicId,
});
const noticeBase = {
  noticeId: publicId,
  createdAt: z.iso.datetime(),
  readAt: z.iso.datetime().nullable(),
};
export const windowDiscussionNoticeSchema = z.union([
  z.strictObject({ ...noticeBase, status: z.literal('unavailable') }),
  z.strictObject({
    ...noticeBase,
    status: z.literal('available'),
    kind: z.enum(['reply', 'like']),
    preview: z.strictObject({
      text: z.string().max(100),
      author: windowDiscussionAuthorSchema,
    }),
    target: windowDiscussionTargetSchema,
  }),
]);
export const windowDiscussionNoticePageSchema = z.strictObject({
  items: z.array(windowDiscussionNoticeSchema).max(50),
  nextCursor: z.string().min(1).max(2000).nullable(),
  unreadCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export const windowDiscussionNoticeReadSchema = z.strictObject({
  noticeId: publicId,
  readAt: z.iso.datetime(),
});
