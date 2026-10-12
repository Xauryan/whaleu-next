import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../../../community/content-review/contracts.js';
import {
  windowIdSchema as id,
  windowPublicIdSchema as publicId,
} from '../contracts.js';
import {
  windowDiscussionBodySchema,
  windowDiscussionItemSchema,
  windowDiscussionPageSchema,
  windowDiscussionAuthorSchema,
  windowDiscussionTargetSchema,
} from './contracts.js';

/** A new bounded Next policy, not a claim about legacy upload limits. */
export const WINDOW_DISCUSSION_V2 = 'window-discussion-v2' as const;
export const WINDOW_DISCUSSION_MAX_IMAGES = 3;
export const windowDiscussionImageFactSchema = z.strictObject({
  assetId: id,
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const windowDiscussionImageSetSchema = z
  .array(windowDiscussionImageFactSchema)
  .max(WINDOW_DISCUSSION_MAX_IMAGES)
  .refine(
    (images) =>
      new Set(images.map((image) => image.assetId)).size === images.length,
  );
export type WindowDiscussionImageFact = z.infer<
  typeof windowDiscussionImageFactSchema
>;
export const windowDiscussionImageReferenceSchema = z.strictObject({
  windowId: publicId,
  commentId: publicId,
  bindingId: publicId,
  ordinal: z.number().int().min(0).max(2),
});
export const windowDiscussionBodyV2Schema = z.union([
  z.literal(''),
  windowDiscussionBodySchema,
]);
const source = {
  protocol: z.literal(WINDOW_DISCUSSION_V2),
  clientRequestId: id,
  expectedCatalogRevision: id,
  expectedWindowRevision: id,
  body: windowDiscussionBodyV2Schema,
  images: windowDiscussionImageSetSchema,
};
const hasContent = (v: { body: string; images: unknown[] }) =>
  v.body.length > 0 || v.images.length > 0;
export const windowRootPublishV2Schema = z
  .strictObject(source)
  .refine(hasContent);
export const windowReplyPublishV2Schema = z
  .strictObject({ ...source, replyToReplyId: id.nullable() })
  .refine(hasContent);
export type WindowRootPublishV2 = z.infer<typeof windowRootPublishV2Schema>;
export type WindowReplyPublishV2 = z.infer<typeof windowReplyPublishV2Schema>;
export const windowDiscussionOperationV2Schema = z.enum([
  'window.discussion.root.v2',
  'window.discussion.reply.v2',
]);
export type WindowDiscussionOperationV2 = z.infer<
  typeof windowDiscussionOperationV2Schema
>;
export function windowDiscussionIntentHashV2(
  actorId: string,
  windowId: string,
  subjectId: string | null,
  operation: WindowDiscussionOperationV2,
  command: WindowRootPublishV2 | WindowReplyPublishV2,
) {
  return createHash('sha256')
    .update(
      'whaleu:window-discussion-command:v2\n' +
        canonicalJson({ actorId, windowId, subjectId, operation, command }),
    )
    .digest('hex');
}
const codes = z.enum([
  'WINDOW_REVISION_CONFLICT',
  'WINDOW_DISCUSSION_CANCELLED',
  'CONTENT_REJECTED',
]);
const base = { requestId: publicId, windowId: publicId };
export const windowDiscussionReceiptV2Schema = z.union([
  z.strictObject({
    ...base,
    operation: z.literal('window.discussion.root.v2'),
    outcome: z.literal('applied'),
    commentId: publicId,
    createdAt: z.iso.datetime(),
  }),
  z.strictObject({
    ...base,
    operation: z.literal('window.discussion.reply.v2'),
    rootId: publicId,
    outcome: z.literal('applied'),
    commentId: publicId,
    createdAt: z.iso.datetime(),
  }),
  z.strictObject({
    ...base,
    operation: z.literal('window.discussion.root.v2'),
    outcome: z.literal('rejected'),
    code: codes,
  }),
  z.strictObject({
    ...base,
    operation: z.literal('window.discussion.reply.v2'),
    rootId: publicId,
    outcome: z.literal('rejected'),
    code: codes,
  }),
]);
export type WindowDiscussionReceiptV2 = z.infer<
  typeof windowDiscussionReceiptV2Schema
>;
/** Cold recovery contains only the original hash/context, never draft body or bytes. */
export const windowDiscussionCancelV2Schema = z.discriminatedUnion(
  'operation',
  [
    z.strictObject({
      protocol: z.literal(WINDOW_DISCUSSION_V2),
      operation: z.literal('window.discussion.root.v2'),
      windowId: id,
      intentHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
    }),
    z.strictObject({
      protocol: z.literal(WINDOW_DISCUSSION_V2),
      operation: z.literal('window.discussion.reply.v2'),
      windowId: id,
      rootId: id,
      intentHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
    }),
  ],
);
export type WindowDiscussionCancelV2 = z.infer<
  typeof windowDiscussionCancelV2Schema
>;
export const windowDiscussionItemV2Schema = windowDiscussionItemSchema
  .extend({
    protocol: z.literal(WINDOW_DISCUSSION_V2),
    body: windowDiscussionBodyV2Schema,
    images: z.array(windowDiscussionImageReferenceSchema).max(3),
  })
  .refine(hasContent);
export type WindowDiscussionItemV2 = z.infer<
  typeof windowDiscussionItemV2Schema
>;
export const windowDiscussionPageV2Schema = windowDiscussionPageSchema.extend({
  protocol: z.literal(WINDOW_DISCUSSION_V2),
  root: windowDiscussionItemV2Schema.nullable(),
  items: z.array(windowDiscussionItemV2Schema).max(50),
});
const noticeBase = {
  noticeId: publicId,
  createdAt: z.iso.datetime(),
  readAt: z.iso.datetime().nullable(),
};
export const windowDiscussionNoticeV2Schema = z.union([
  z.strictObject({ ...noticeBase, status: z.literal('unavailable') }),
  z
    .strictObject({
      ...noticeBase,
      status: z.literal('available'),
      kind: z.enum(['reply', 'like']),
      preview: z.strictObject({
        text: z.string().max(100),
        author: windowDiscussionAuthorSchema,
        thumbnail: windowDiscussionImageReferenceSchema.nullable(),
      }),
      target: windowDiscussionTargetSchema,
    })
    .refine((v) => v.kind !== 'like' || v.preview.thumbnail === null),
]);
export const windowDiscussionNoticePageV2Schema = z.strictObject({
  protocol: z.literal(WINDOW_DISCUSSION_V2),
  items: z.array(windowDiscussionNoticeV2Schema).max(50),
  nextCursor: z.string().min(1).max(2000).nullable(),
  unreadCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
