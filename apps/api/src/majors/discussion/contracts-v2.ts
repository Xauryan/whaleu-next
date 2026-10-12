import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../../community/content-review/contracts.js';
import {
  majorIdSchema as id,
  majorPublicIdSchema as publicId,
} from '../contracts.js';
import {
  majorDiscussionBodySchema,
  majorDiscussionItemSchema,
  majorDiscussionPageSchema,
  majorDiscussionAuthorSchema,
  majorDiscussionTargetSchema,
} from './contracts.js';

/** A new bounded Next policy, not a claim about legacy upload limits. */
export const MAJOR_DISCUSSION_V2 = 'major-discussion-v2' as const;
export const MAJOR_DISCUSSION_MAX_IMAGES = 3;
export const majorDiscussionImageFactSchema = z.strictObject({
  assetId: id,
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const majorDiscussionImageSetSchema = z
  .array(majorDiscussionImageFactSchema)
  .max(MAJOR_DISCUSSION_MAX_IMAGES)
  .refine(
    (images) =>
      new Set(images.map((image) => image.assetId)).size === images.length,
  );
export type MajorDiscussionImageFact = z.infer<
  typeof majorDiscussionImageFactSchema
>;
export const majorDiscussionImageReferenceSchema = z.strictObject({
  majorId: publicId,
  commentId: publicId,
  bindingId: publicId,
  ordinal: z.number().int().min(0).max(2),
});
// Major always requires valid nonblank text, even with images.
export const majorDiscussionBodyV2Schema = majorDiscussionBodySchema;
const source = {
  protocol: z.literal(MAJOR_DISCUSSION_V2),
  clientRequestId: id,
  expectedCatalogRevision: id,
  expectedMajorRevision: id,
  body: majorDiscussionBodyV2Schema,
  images: majorDiscussionImageSetSchema,
};
export const majorRootPublishV2Schema = z.strictObject(source);
export const majorReplyPublishV2Schema = z.strictObject({
  ...source,
  replyToReplyId: id.nullable(),
});
export type MajorRootPublishV2 = z.infer<typeof majorRootPublishV2Schema>;
export type MajorReplyPublishV2 = z.infer<typeof majorReplyPublishV2Schema>;
export const majorDiscussionOperationV2Schema = z.enum([
  'major.discussion.root.v2',
  'major.discussion.reply.v2',
]);
export type MajorDiscussionOperationV2 = z.infer<
  typeof majorDiscussionOperationV2Schema
>;
export function majorDiscussionIntentHashV2(
  actorId: string,
  majorId: string,
  subjectId: string | null,
  operation: MajorDiscussionOperationV2,
  command: MajorRootPublishV2 | MajorReplyPublishV2,
) {
  return createHash('sha256')
    .update(
      'whaleu:major-discussion-command:v2\n' +
        canonicalJson({ actorId, majorId, subjectId, operation, command }),
    )
    .digest('hex');
}
const codes = z.enum([
  'MAJOR_REVISION_CONFLICT',
  'MAJOR_DISCUSSION_CANCELLED',
  'CONTENT_REJECTED',
]);
const base = { requestId: publicId, majorId: publicId };
export const majorDiscussionReceiptV2Schema = z.union([
  z.strictObject({
    ...base,
    operation: z.literal('major.discussion.root.v2'),
    outcome: z.literal('applied'),
    commentId: publicId,
    createdAt: z.iso.datetime(),
  }),
  z.strictObject({
    ...base,
    operation: z.literal('major.discussion.reply.v2'),
    rootId: publicId,
    outcome: z.literal('applied'),
    commentId: publicId,
    createdAt: z.iso.datetime(),
  }),
  z.strictObject({
    ...base,
    operation: z.literal('major.discussion.root.v2'),
    outcome: z.literal('rejected'),
    code: codes,
  }),
  z.strictObject({
    ...base,
    operation: z.literal('major.discussion.reply.v2'),
    rootId: publicId,
    outcome: z.literal('rejected'),
    code: codes,
  }),
]);
export type MajorDiscussionReceiptV2 = z.infer<
  typeof majorDiscussionReceiptV2Schema
>;
/** Cold recovery contains only the original hash/context, never draft body or bytes. */
export const majorDiscussionCancelV2Schema = z.discriminatedUnion('operation', [
  z.strictObject({
    protocol: z.literal(MAJOR_DISCUSSION_V2),
    operation: z.literal('major.discussion.root.v2'),
    majorId: id,
    intentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  }),
  z.strictObject({
    protocol: z.literal(MAJOR_DISCUSSION_V2),
    operation: z.literal('major.discussion.reply.v2'),
    majorId: id,
    rootId: id,
    intentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  }),
]);
export type MajorDiscussionCancelV2 = z.infer<
  typeof majorDiscussionCancelV2Schema
>;
export const majorDiscussionItemV2Schema = majorDiscussionItemSchema.extend({
  protocol: z.literal(MAJOR_DISCUSSION_V2),
  body: majorDiscussionBodyV2Schema,
  images: z.array(majorDiscussionImageReferenceSchema).max(3),
});
export type MajorDiscussionItemV2 = z.infer<typeof majorDiscussionItemV2Schema>;
export const majorDiscussionPageV2Schema = majorDiscussionPageSchema.extend({
  protocol: z.literal(MAJOR_DISCUSSION_V2),
  root: majorDiscussionItemV2Schema.nullable(),
  items: z.array(majorDiscussionItemV2Schema).max(50),
});
const noticeBase = {
  noticeId: publicId,
  createdAt: z.iso.datetime(),
  readAt: z.iso.datetime().nullable(),
};
export const majorDiscussionNoticeV2Schema = z.union([
  z.strictObject({ ...noticeBase, status: z.literal('unavailable') }),
  z
    .strictObject({
      ...noticeBase,
      status: z.literal('available'),
      kind: z.enum(['reply', 'like']),
      preview: z.strictObject({
        text: z.string().max(100),
        author: majorDiscussionAuthorSchema,
        thumbnail: majorDiscussionImageReferenceSchema.nullable(),
      }),
      target: majorDiscussionTargetSchema,
    })
    .refine((v) => v.kind !== 'like' || v.preview.thumbnail === null),
]);
export const majorDiscussionNoticePageV2Schema = z.strictObject({
  protocol: z.literal(MAJOR_DISCUSSION_V2),
  items: z.array(majorDiscussionNoticeV2Schema).max(50),
  nextCursor: z.string().min(1).max(2000).nullable(),
  unreadCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
