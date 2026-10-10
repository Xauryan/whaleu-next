import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../../community/content-review/contracts.js';
import { ratingCanonicalText, ratingTimeSchema } from '../contracts.js';
import {
  scopedId,
  scopedDigest,
  scopedToken,
  ratingScopedCommandContextSchema,
  ratingScopedContextSchema,
  ratingScopedClosureSchema,
} from './contracts.js';

/** These numbers identify discussion images only. Cover command3/Review6 and
 * native cover journal11 remain independent, immutable recovery protocols. */
export const RATING_DISCUSSION_MEDIA_VERSIONS = Object.freeze({
  command: 4,
  context: 4,
  review: 7,
  media: 7,
  journal: 12,
} as const);
export const RATING_DISCUSSION_MEDIA_CAPABILITY = 'discussion_images' as const;
export const RATING_DISCUSSION_MEDIA_LIMITS = Object.freeze({
  root: 9,
  reply: 3,
});
export const ratingDiscussionCapabilitySchema = z.strictObject({
  id: scopedId,
  generation: scopedId,
  sourceDigest: scopedDigest,
  validUntil: ratingTimeSchema,
});
export const ratingDiscussionContextSchema = z
  .strictObject({
    ...ratingScopedContextSchema.shape,
    protocolVersion: z.literal(4),
    discussionMedia: ratingDiscussionCapabilitySchema,
  })
  .superRefine((value, ctx) => {
    const { discussionMedia, ...base } = value;
    if (
      !ratingScopedContextSchema.safeParse({ ...base, protocolVersion: 2 })
        .success ||
      !value.capabilities.includes(RATING_DISCUSSION_MEDIA_CAPABILITY) ||
      (value.purpose !== 'read' && value.purpose !== 'interact') ||
      Date.parse(discussionMedia.validUntil) < Date.parse(value.expiresAt)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid exact discussion media context',
      });
  });
export type RatingDiscussionContext = z.infer<
  typeof ratingDiscussionContextSchema
>;
export const ratingDiscussionCommandContextSchema = z
  .strictObject({
    ...ratingScopedCommandContextSchema.shape,
    discussionMedia: ratingDiscussionCapabilitySchema,
  })
  .refine((value) => {
    const { discussionMedia, ...base } = value;
    return (
      ratingDiscussionCapabilitySchema.safeParse(discussionMedia).success &&
      ratingScopedCommandContextSchema.safeParse(base).success
    );
  });
export type RatingDiscussionCommandContext = z.infer<
  typeof ratingDiscussionCommandContextSchema
>;

/** A client references a sealed batch, never supplies trusted manifest digests. */
export const ratingDiscussionImageSelectionSchema = z.strictObject({
  ordinal: z.number().int().min(0).max(8),
  memberId: scopedId,
  assetId: scopedId,
});
export function ratingDiscussionImagesSchema(maximum: 3 | 9) {
  return z
    .array(ratingDiscussionImageSelectionSchema)
    .max(maximum)
    .refine(
      (images) =>
        images.every((image, index) => image.ordinal === index) &&
        new Set(images.map((image) => image.assetId)).size === images.length &&
        new Set(images.map((image) => image.memberId)).size === images.length,
    );
}
const content = {
  clientRequestId: scopedId,
  categoryId: scopedId,
  expectedCategoryRevision: scopedId,
  targetId: scopedId,
  expectedTargetRevision: scopedId,
  expectedDefinitionRevision: scopedId,
  expectedContentVersion: z.number().int().min(1).max(2147483647),
  draftRevision: scopedId,
  batchRequestId: scopedId.nullable(),
  batchId: scopedId.nullable(),
  sealedPlanDigest: scopedDigest.nullable(),
  authorMode: z.enum(['named', 'anonymous']),
  body: ratingCanonicalText(500, false),
};
function validContent(value: {
  body: string;
  images: readonly unknown[];
  batchRequestId: string | null;
  batchId: string | null;
  sealedPlanDigest: string | null;
  clientRequestId: string;
}) {
  return (
    (value.body.length > 0 || value.images.length > 0) &&
    (value.images.length === 0
      ? value.batchRequestId === null &&
        value.batchId === null &&
        value.sealedPlanDigest === null
      : value.batchRequestId !== null &&
        value.batchId !== null &&
        value.sealedPlanDigest !== null &&
        value.batchRequestId !== value.clientRequestId)
  );
}
const rootPayload = z
  .strictObject({ ...content, images: ratingDiscussionImagesSchema(9) })
  .refine(validContent);
const replyPayload = z
  .strictObject({
    ...content,
    images: ratingDiscussionImagesSchema(3),
    rootId: scopedId,
    expectedRootRevision: scopedId,
    replyTo: z
      .strictObject({ replyId: scopedId, expectedRevision: scopedId })
      .nullable(),
  })
  .refine(validContent)
  .refine((value) => value.replyTo?.replyId !== value.rootId);
const base = {
  protocolVersion: z.literal(4),
  context: ratingDiscussionCommandContextSchema,
};
export const ratingDiscussionMediaIntentSchema = z.discriminatedUnion(
  'operation',
  [
    z.strictObject({
      ...base,
      operation: z.literal('create_comment_scoped'),
      payload: rootPayload,
    }),
    z.strictObject({
      ...base,
      operation: z.literal('create_reply_scoped'),
      payload: replyPayload,
    }),
  ],
);
export type RatingDiscussionMediaIntent = z.infer<
  typeof ratingDiscussionMediaIntentSchema
>;
export function ratingDiscussionMediaCommandHash(
  raw: RatingDiscussionMediaIntent,
): string {
  const value = ratingDiscussionMediaIntentSchema.parse(raw);
  return createHash('sha256')
    .update(
      'whaleu:rating-discussion-media-command:v1\n' +
        canonicalJson({
          protocolVersion: value.protocolVersion,
          operation: value.operation,
          intent: { context: value.context, payload: value.payload },
        }),
    )
    .digest('hex');
}
const result = {
  targetId: scopedId,
  revision: scopedId,
  occurredAt: ratingTimeSchema,
};
const receipt = {
  protocolVersion: z.literal(4),
  requestId: scopedId,
  intentHash: scopedDigest,
};
export const ratingDiscussionMediaReceiptSchema = z.union([
  z.strictObject({
    ...receipt,
    operation: z.enum(['create_comment_scoped', 'create_reply_scoped']),
    outcome: z.literal('closed'),
    code: ratingScopedClosureSchema,
  }),
  z.strictObject({
    ...receipt,
    operation: z.literal('create_comment_scoped'),
    outcome: z.literal('applied'),
    result: z.strictObject({ ...result, subjectId: scopedId }),
  }),
  z.strictObject({
    ...receipt,
    operation: z.literal('create_reply_scoped'),
    outcome: z.literal('applied'),
    result: z.strictObject({ ...result, rootId: scopedId, replyId: scopedId }),
  }),
]);
export type RatingDiscussionMediaReceipt = z.infer<
  typeof ratingDiscussionMediaReceiptSchema
>;
export const ratingDiscussionMediaCommitSchema = z.discriminatedUnion(
  'operation',
  [
    ratingDiscussionMediaIntentSchema.options[0].extend({
      preparationContextRevision: scopedToken,
    }),
    ratingDiscussionMediaIntentSchema.options[1].extend({
      preparationContextRevision: scopedToken,
    }),
  ],
);
export const ratingDiscussionMediaPreparationSchema = z
  .strictObject({
    intent: ratingDiscussionMediaIntentSchema,
    contextRevision: scopedToken,
    targetId: scopedId,
    targetRevision: scopedId,
    definitionRevision: scopedId,
    contentVersion: z.number().int().min(1).max(2147483647),
    subjectId: scopedId,
    subjectRevision: scopedId,
    attachmentSetDigest: scopedDigest,
    validUntil: ratingTimeSchema,
  })
  .refine(
    (value) =>
      value.targetId === value.intent.payload.targetId &&
      value.targetRevision === value.intent.payload.expectedTargetRevision &&
      value.definitionRevision ===
        value.intent.payload.expectedDefinitionRevision &&
      value.contentVersion === value.intent.payload.expectedContentVersion &&
      Date.parse(value.validUntil) <=
        Date.parse(value.intent.context.discussionMedia.validUntil) &&
      (value.intent.operation !== 'create_reply_scoped' ||
        (value.subjectId !== value.intent.payload.rootId &&
          value.subjectId !== value.intent.payload.replyTo?.replyId)),
  );

/** Recovery deliberately carries no body, image list, or expired context token. */
export const ratingDiscussionMediaHashCancelSchema = z.strictObject({
  protocolVersion: z.literal(4),
  operation: z.enum(['create_comment_scoped', 'create_reply_scoped']),
  intentHash: scopedDigest,
});
