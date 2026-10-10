import type { Decision } from '../community/community-policy.js';
import {
  canonicalRatingDiscussionMediaEnvelope,
  type RatingDiscussionMediaEnvelope,
} from '../community/content-review/rating-discussion-media-contracts.js';
import {
  ratingsDiscussionMediaDescriptorSchema,
  ratingsDiscussionMediaParentSchema,
  type RatingsDiscussionMediaDescriptor,
  type RatingsDiscussionMediaParent,
} from '../media/contracts-ratings-discussion.js';
import { canonicalEqual } from '../community/content-review/contracts.js';

/** A Media current snapshot, not a request, URL or a reusable authorization
 * grant. The caller must retain the underlying Media final proof in its owner
 * transaction; this pure function only joins exact complete-set evidence. */
export interface RatingDiscussionImageCurrent {
  readonly actorAccountId: string;
  readonly parent: RatingsDiscussionMediaParent;
  readonly assetId: string;
  readonly manifestDigest: string;
  readonly descriptor: RatingsDiscussionMediaDescriptor;
}
export function ratingDiscussionWholeSetDecision(
  raw: RatingDiscussionMediaEnvelope,
  observations: readonly Decision<RatingDiscussionImageCurrent>[],
): Decision<readonly RatingsDiscussionMediaDescriptor[]> {
  try {
    const envelope = canonicalRatingDiscussionMediaEnvelope(raw);
    if (observations.length !== envelope.images.length)
      return { kind: 'unavailable' };
    const parent = ratingsDiscussionMediaParentSchema.parse(
      envelope.purpose === 'publish_rating_comment_media_scoped'
        ? {
            ownerKind: 'ratings',
            resourceKind: 'rating_comment',
            targetId: envelope.targetId,
            resourceId: envelope.subjectId,
            contentVersion: 1,
          }
        : {
            ownerKind: 'ratings',
            resourceKind: 'rating_reply',
            targetId: envelope.targetId,
            rootId: envelope.rootId,
            resourceId: envelope.subjectId,
            contentVersion: 1,
          },
    );
    const images: RatingsDiscussionMediaDescriptor[] = [];
    let denied = false;
    for (let ordinal = 0; ordinal < observations.length; ordinal++) {
      const observation = observations[ordinal]!,
        expected = envelope.images[ordinal]!;
      if (observation.kind === 'unavailable') return { kind: 'unavailable' };
      if (observation.kind === 'deny') {
        denied = true;
        continue;
      }
      const value = observation.value,
        descriptor = ratingsDiscussionMediaDescriptorSchema.parse(
          value.descriptor,
        );
      if (
        value.actorAccountId !== envelope.accountId ||
        !canonicalEqual(
          ratingsDiscussionMediaParentSchema.parse(value.parent),
          parent,
        ) ||
        value.assetId !== expected.assetId ||
        value.manifestDigest !== expected.manifestDigest ||
        descriptor.ordinal !== ordinal ||
        descriptor.targetId !== envelope.targetId ||
        descriptor.subjectRevision !== envelope.subjectRevision ||
        descriptor.attachmentSetDigest !== envelope.attachmentSetDigest ||
        (envelope.purpose === 'publish_rating_comment_media_scoped'
          ? descriptor.rootId !== envelope.subjectId ||
            descriptor.replyId !== null
          : descriptor.rootId !== envelope.rootId ||
            descriptor.replyId !== envelope.subjectId)
      )
        return { kind: 'unavailable' };
      images.push(descriptor);
    }
    if (denied) return { kind: 'deny', reason: 'RATING_NOT_FOUND' };
    if (
      new Set(images.map((image) => image.bindingId)).size !== images.length ||
      (images.length > 0 &&
        images.some(
          (image) =>
            image.contextId !== images[0]!.contextId ||
            image.contextToken !== images[0]!.contextToken,
        ))
    )
      return { kind: 'unavailable' };
    return { kind: 'allow', value: Object.freeze(images) };
  } catch {
    return { kind: 'unavailable' };
  }
}
