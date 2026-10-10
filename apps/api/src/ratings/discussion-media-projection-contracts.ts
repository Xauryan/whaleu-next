import { z } from 'zod';
import { ratingCanonicalText, ratingCommentSchema } from './contracts.js';
import { ratingReplySchema } from './discussion-contracts.js';
import { scopedDigest } from './scoped/contracts.js';
import { ratingsDiscussionMediaDescriptorSchema } from '../media/contracts-ratings-discussion.js';
import type { RatingsDiscussionMediaDescriptor } from '../media/contracts-ratings-discussion.js';
const common = {
  protocolVersion: z.literal(4),
  body: ratingCanonicalText(500, false),
  attachmentSetDigest: scopedDigest,
};
function completeProjection(value: {
  body: string;
  attachmentSetDigest: string;
  images: readonly RatingsDiscussionMediaDescriptor[];
}) {
  return (
    (value.body.length > 0 || value.images.length > 0) &&
    value.images.every(
      (image, ordinal) =>
        image.ordinal === ordinal &&
        image.attachmentSetDigest === value.attachmentSetDigest,
    ) &&
    new Set(value.images.map((image) => image.bindingId)).size ===
      value.images.length &&
    (value.images.length === 0 ||
      value.images.every(
        (image) =>
          image.contextId === value.images[0]!.contextId &&
          image.contextToken === value.images[0]!.contextToken,
      ))
  );
}
/** Wire projection only, not an authorization operation. Callers must first
 * prove every immutable manifest and the current real ancestor chain. */
export const ratingDiscussionMediaRootSchema = ratingCommentSchema
  .safeExtend({
    ...common,
    images: z.array(ratingsDiscussionMediaDescriptorSchema).max(9),
  })
  .refine(completeProjection)
  .refine((value) =>
    value.images.every(
      (image) =>
        image.targetId === value.targetId &&
        image.rootId === value.id &&
        image.replyId === null &&
        image.subjectRevision === value.revision,
    ),
  );
export const ratingDiscussionMediaReplySchema = ratingReplySchema
  .safeExtend({
    ...common,
    images: z.array(ratingsDiscussionMediaDescriptorSchema).max(3),
  })
  .refine(completeProjection)
  .refine((value) =>
    value.images.every(
      (image) =>
        image.targetId === value.targetId &&
        image.rootId === value.rootId &&
        image.replyId === value.id &&
        image.subjectRevision === value.revision,
    ),
  );
export type RatingDiscussionMediaRoot = z.infer<
  typeof ratingDiscussionMediaRootSchema
>;
export type RatingDiscussionMediaReply = z.infer<
  typeof ratingDiscussionMediaReplySchema
>;
