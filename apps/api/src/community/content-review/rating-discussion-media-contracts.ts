import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalEqual, canonicalJson } from './contracts.js';
import { ratingScopedReviewScopeSchema } from './rating-scoped-contracts.js';
import { ratingCanonicalText } from '../../ratings/contracts.js';
import {
  scopedId as id,
  scopedDigest as digest,
} from '../../ratings/scoped/contracts.js';
import { ratingDiscussionCapabilitySchema } from '../../ratings/scoped/discussion-media-contracts.js';

export const ratingDiscussionAttachmentSchema = z.strictObject({
  ordinal: z.number().int().min(0).max(8),
  memberId: id,
  assetId: id,
  manifestDigest: digest,
});
function attachments(maximum: 3 | 9) {
  return z
    .array(ratingDiscussionAttachmentSchema)
    .max(maximum)
    .refine(
      (images) =>
        images.every((image, index) => image.ordinal === index) &&
        new Set(images.map((image) => image.assetId)).size === images.length &&
        new Set(images.map((image) => image.memberId)).size === images.length,
    );
}
/** Includes the empty set; both text-only and image content use one new Review. */
export function ratingDiscussionAttachmentSetDigest(raw: unknown): string {
  const images = attachments(9).parse(raw);
  if (!canonicalEqual(images, raw))
    throw new Error('Noncanonical discussion attachment set');
  return createHash('sha256')
    .update(
      'whaleu:rating-discussion-attachment-set:v1\n' + canonicalJson(images),
    )
    .digest('hex');
}
const base = {
  version: z.literal(7),
  accountId: id,
  clientRequestId: id,
  targetId: id,
  targetRevision: id,
  categoryId: id,
  categoryRevision: id,
  scope: ratingScopedReviewScopeSchema,
  discussionMedia: ratingDiscussionCapabilitySchema,
  targetOrigin: z.strictObject({
    regionId: id.nullable(),
    originCampusId: id.nullable(),
  }),
  targetDefinitionRevision: id,
  targetContentVersion: z.number().int().min(1).max(2147483647),
  subjectId: id,
  subjectRevision: id,
  draftRevision: id,
  batchRequestId: id.nullable(),
  batchId: id.nullable(),
  sealedPlanDigest: digest.nullable(),
  authorMode: z.enum(['named', 'anonymous']),
  body: ratingCanonicalText(500, false),
  attachmentSetDigest: digest,
};
export const ratingDiscussionMediaEnvelopeSchema = z
  .discriminatedUnion('purpose', [
    z.strictObject({
      ...base,
      purpose: z.literal('publish_rating_comment_media_scoped'),
      images: attachments(9),
    }),
    z.strictObject({
      ...base,
      purpose: z.literal('publish_rating_reply_media_scoped'),
      images: attachments(3),
      rootId: id,
      rootRevision: id,
      replyTo: z.strictObject({ replyId: id, revision: id }).nullable(),
    }),
  ])
  .superRefine((value, ctx) => {
    if (
      (value.body.length === 0 && value.images.length === 0) ||
      value.attachmentSetDigest !==
        ratingDiscussionAttachmentSetDigest(value.images) ||
      (value.images.length === 0
        ? value.batchRequestId !== null ||
          value.batchId !== null ||
          value.sealedPlanDigest !== null
        : value.batchRequestId === null ||
          value.batchId === null ||
          value.sealedPlanDigest === null ||
          value.batchRequestId === value.clientRequestId) ||
      (value.purpose === 'publish_rating_reply_media_scoped' &&
        (value.subjectId === value.rootId ||
          value.subjectId === value.replyTo?.replyId ||
          value.rootId === value.replyTo?.replyId))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Exact whole discussion content required',
      });
  });
export type RatingDiscussionMediaEnvelope = z.infer<
  typeof ratingDiscussionMediaEnvelopeSchema
>;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function canonicalRatingDiscussionMediaEnvelope(
  raw: unknown,
): RatingDiscussionMediaEnvelope {
  const value = ratingDiscussionMediaEnvelopeSchema.parse(raw);
  if (!canonicalEqual(value, raw))
    throw new Error('Noncanonical discussion media Review envelope');
  return freeze(value);
}
export function ratingDiscussionMediaApprovalDigest(
  value: RatingDiscussionMediaEnvelope,
): string {
  return createHash('sha256')
    .update(
      'whaleu-rating-content-approval:v7\n' +
        canonicalJson(canonicalRatingDiscussionMediaEnvelope(value)),
    )
    .digest('hex');
}
export interface AcceptedRatingDiscussionMediaApproval {
  readonly version: 7;
  readonly decisionId: string;
  readonly digest: string;
  readonly envelope: RatingDiscussionMediaEnvelope;
}
