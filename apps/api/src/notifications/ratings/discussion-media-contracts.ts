import { z } from 'zod';
import {
  ratingAuthorSchema,
  ratingCanonicalText,
  ratingTimeSchema,
} from '../../ratings/contracts.js';
import {
  scopedId as id,
  ratingScopedLocatorSchema,
} from '../../ratings/scoped/contracts.js';
import { ratingsDiscussionMediaDescriptorSchema } from '../../media/contracts-ratings-discussion.js';
/** Explicit optional current detail. Existing scoped metadata and historical
 * text-only preview decoders are unchanged. A thumbnail follows whole-set proof. */
export const ratingDiscussionNoticePreviewSchema = z
  .strictObject({
    body: ratingCanonicalText(500, false),
    author: ratingAuthorSchema,
    imageCount: z.number().int().min(0).max(9),
    thumbnail: ratingsDiscussionMediaDescriptorSchema.nullable(),
  })
  .refine(
    (value) =>
      (value.body.length > 0 || value.imageCount > 0) &&
      (value.imageCount === 0
        ? value.thumbnail === null
        : value.thumbnail !== null && value.thumbnail.ordinal === 0),
  );
const base = {
  protocolVersion: z.literal(4),
  noticeId: id,
  createdAt: ratingTimeSchema,
  readAt: ratingTimeSchema.nullable(),
};
const available = {
  ...base,
  status: z.literal('available'),
  domain: z.literal('ratings'),
  target: ratingScopedLocatorSchema,
  preview: ratingDiscussionNoticePreviewSchema,
};
export const ratingDiscussionNoticeSchema = z
  .union([
    z.strictObject({ ...base, status: z.literal('unavailable') }),
    z.strictObject({
      ...available,
      kind: z.literal('reply'),
      reason: z.enum(['direct_root', 'direct_reply']),
    }),
    z.strictObject({
      ...available,
      kind: z.literal('like'),
      reason: z.literal('like'),
      actor: ratingAuthorSchema.refine((author) => author.mode === 'named'),
    }),
    z.strictObject({
      ...available,
      kind: z.literal('subscription'),
      reason: z.literal('target_subscription'),
      activity: z.enum(['root', 'reply']),
    }),
  ])
  .refine(
    (value) =>
      value.status === 'unavailable' ||
      (value.target.rootId !== null &&
        (value.target.replyId === null || value.preview.imageCount <= 3) &&
        (value.kind !== 'reply' || value.target.replyId !== null) &&
        (value.kind !== 'subscription' ||
          (value.activity === 'root') === (value.target.replyId === null)) &&
        (value.preview.author.mode !== 'anonymous' ||
          value.preview.author.targetId === value.target.targetId) &&
        (value.preview.thumbnail === null ||
          (value.preview.thumbnail.targetId === value.target.targetId &&
            value.preview.thumbnail.rootId === value.target.rootId &&
            value.preview.thumbnail.replyId === value.target.replyId))),
  );
export type RatingDiscussionNotice = z.infer<
  typeof ratingDiscussionNoticeSchema
>;
/** Worker-only content evidence, never a thumbnail or legacy text preview.
 * Materialization stores immutable notice identities rather than this body. */
export const ratingDiscussionMaterializationPreviewSchema = z
  .strictObject({
    protocolVersion: z.literal(4),
    body: ratingCanonicalText(500, false),
    imageCount: z.number().int().min(0).max(9),
    attachmentSetDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .refine((value) => value.body.length > 0 || value.imageCount > 0);
export type RatingDiscussionMaterializationPreview = z.infer<
  typeof ratingDiscussionMaterializationPreviewSchema
>;
