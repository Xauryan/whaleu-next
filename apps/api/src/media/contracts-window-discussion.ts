import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  MEDIA_MAX_INPUT_BYTES,
  mediaDigestSchema,
  mediaMimeSchema,
} from './contracts.js';
import {
  mediaV2IdSchema,
  mediaGrantSchema,
  mediaUploadObservedSchema,
} from './contracts-v2.js';

export const WINDOW_DISCUSSION_MEDIA_PROTOCOL =
  'window-discussion-media-v1' as const;
export const prepareWindowDiscussionMediaSchema = z.strictObject({
  protocol: z.literal(WINDOW_DISCUSSION_MEDIA_PROTOCOL),
  clientRequestId: mediaV2IdSchema,
  publicationRequestId: mediaV2IdSchema,
  windowId: mediaV2IdSchema,
  catalogRevision: mediaV2IdSchema,
  windowRevision: mediaV2IdSchema,
  rootId: mediaV2IdSchema.nullable(),
  replyToReplyId: mediaV2IdSchema.nullable(),
  ordinal: z.number().int().min(0).max(2),
  declaration: z.strictObject({
    mime: mediaMimeSchema,
    bytes: z.number().int().positive().max(MEDIA_MAX_INPUT_BYTES),
    sha256: mediaDigestSchema,
  }),
});
export type PrepareWindowDiscussionMediaInput = z.infer<
  typeof prepareWindowDiscussionMediaSchema
>;
export function windowDiscussionMediaRequestHash(
  actor: string,
  raw: unknown,
): string {
  const input = prepareWindowDiscussionMediaSchema.parse(raw);
  return createHash('sha256')
    .update('whaleu-window-discussion-media-prepare:v1\n')
    .update(
      JSON.stringify({
        protocol: WINDOW_DISCUSSION_MEDIA_PROTOCOL,
        actorAccountId: mediaV2IdSchema.parse(actor),
        clientRequestId: input.clientRequestId,
        publicationRequestId: input.publicationRequestId,
        windowId: input.windowId,
        catalogRevision: input.catalogRevision,
        windowRevision: input.windowRevision,
        rootId: input.rootId,
        replyToReplyId: input.replyToReplyId,
        ordinal: input.ordinal,
        declaration: {
          mime: input.declaration.mime,
          bytes: input.declaration.bytes,
          sha256: input.declaration.sha256,
        },
      }),
    )
    .digest('hex');
}
export const windowDiscussionReferenceSchema = z.strictObject({
  windowId: mediaV2IdSchema,
  commentId: mediaV2IdSchema,
  bindingId: mediaV2IdSchema,
  ordinal: z.number().int().min(0).max(2),
});
export type WindowDiscussionReference = z.infer<
  typeof windowDiscussionReferenceSchema
>;
export const windowDiscussionDescriptorSchema =
  windowDiscussionReferenceSchema.extend({
    protocol: z.literal(WINDOW_DISCUSSION_MEDIA_PROTOCOL),
    kind: z.literal('window-discussion-media'),
    width: z.number().int().positive().max(2048),
    height: z.number().int().positive().max(2048),
    variants: z.tuple([z.literal('thumb-v1'), z.literal('display-v1')]),
  });
export type WindowDiscussionDescriptor = z.infer<
  typeof windowDiscussionDescriptorSchema
>;
const instant = z.number().int().positive().safe();
const base = {
  protocol: z.literal(WINDOW_DISCUSSION_MEDIA_PROTOCOL),
  intentId: mediaV2IdSchema,
  requestId: mediaV2IdSchema,
  requestHash: mediaDigestSchema,
  serverNow: instant,
};
export const windowDiscussionMediaStatusSchema = z.discriminatedUnion(
  'status',
  [
    z.strictObject({
      ...base,
      status: z.literal('prepared'),
      operationDeadlineAt: instant,
      upload: z.enum(['none', 'in_flight', 'reconcile_needed']),
    }),
    z.strictObject({
      ...base,
      status: z.literal('uploaded'),
      operationDeadlineAt: instant,
    }),
    z.strictObject({
      ...base,
      status: z.literal('processing'),
      operationDeadlineAt: instant,
      retryAfterMs: z.number().int().min(250).max(30000),
    }),
    z.strictObject({
      ...base,
      status: z.literal('ready_unbound'),
      assetId: mediaV2IdSchema,
      manifestDigest: mediaDigestSchema,
      bindBefore: instant,
      mediaProof: z.literal('current'),
    }),
    z.strictObject({
      ...base,
      status: z.literal('bound_history'),
      assetId: mediaV2IdSchema,
      bindingId: mediaV2IdSchema,
      attachmentState: z.enum(['active', 'detached']),
    }),
    z.strictObject({
      ...base,
      status: z.literal('terminal'),
      reason: z.enum(['cancelled', 'expired', 'rejected', 'deleted']),
      cleanup: z.enum(['pending', 'retained', 'confirmed']),
    }),
    z.strictObject({
      ...base,
      status: z.literal('unavailable'),
      reason: z.literal('MEDIA_UNAVAILABLE'),
      retryable: z.boolean(),
    }),
  ],
);
export type WindowDiscussionMediaStatus = z.infer<
  typeof windowDiscussionMediaStatusSchema
>;
export const windowDiscussionMediaRecoverySchema = z.discriminatedUnion(
  'state',
  [
    z.strictObject({
      protocol: z.literal(WINDOW_DISCUSSION_MEDIA_PROTOCOL),
      requestId: mediaV2IdSchema,
      serverNow: instant,
      state: z.literal('not_recorded'),
      requestHash: z.null(),
    }),
    z.strictObject({
      protocol: z.literal(WINDOW_DISCUSSION_MEDIA_PROTOCOL),
      requestId: mediaV2IdSchema,
      serverNow: instant,
      state: z.literal('recorded'),
      requestHash: mediaDigestSchema,
      status: windowDiscussionMediaStatusSchema,
    }),
    z.strictObject({
      protocol: z.literal(WINDOW_DISCUSSION_MEDIA_PROTOCOL),
      requestId: mediaV2IdSchema,
      serverNow: instant,
      state: z.literal('cancelled_before_prepare'),
      requestHash: mediaDigestSchema,
      reason: z.literal('cancelled'),
    }),
  ],
);
export const cancelWindowDiscussionMediaRequestSchema = z.strictObject({
  protocol: z.literal(WINDOW_DISCUSSION_MEDIA_PROTOCOL),
  requestHash: mediaDigestSchema,
  windowId: mediaV2IdSchema,
  publicationRequestId: mediaV2IdSchema,
});
export const windowDiscussionMediaGrantSchema = mediaGrantSchema
  .omit({ version: true })
  .extend({ protocol: z.literal(WINDOW_DISCUSSION_MEDIA_PROTOCOL) });
export const windowDiscussionMediaUploadObservedSchema =
  mediaUploadObservedSchema
    .omit({ version: true })
    .extend({ protocol: z.literal(WINDOW_DISCUSSION_MEDIA_PROTOCOL) });

export const windowDiscussionMediaFactSchema = z.strictObject({
  assetId: mediaV2IdSchema,
  manifestDigest: mediaDigestSchema,
});
export const windowDiscussionMediaBindingSchema =
  windowDiscussionMediaFactSchema.extend({
    bindingId: mediaV2IdSchema,
    ordinal: z.number().int().min(0).max(2),
  });
export type WindowDiscussionMediaFact = z.infer<
  typeof windowDiscussionMediaFactSchema
>;
export type WindowDiscussionMediaBinding = z.infer<
  typeof windowDiscussionMediaBindingSchema
>;

/** The ordered position is the publication slot. It cannot be borrowed from a
 * sibling owner or silently renumbered while accepting a prepared asset. */
export const windowDiscussionMediaFactsSchema = z
  .array(windowDiscussionMediaFactSchema)
  .max(3)
  .refine(
    (images) => new Set(images.map((x) => x.assetId)).size === images.length,
  );
export const windowDiscussionMediaBindingsSchema = z
  .array(windowDiscussionMediaBindingSchema)
  .max(3)
  .refine(
    (images) =>
      new Set(images.map((x) => x.assetId)).size === images.length &&
      new Set(images.map((x) => x.bindingId)).size === images.length &&
      images.every((x, ordinal) => x.ordinal === ordinal),
  );
export const windowDiscussionMediaContextSchema = z.strictObject({
  publicationRequestId: mediaV2IdSchema,
  windowId: mediaV2IdSchema,
  catalogRevision: mediaV2IdSchema,
  windowRevision: mediaV2IdSchema,
  rootId: mediaV2IdSchema.nullable(),
  replyToReplyId: mediaV2IdSchema.nullable(),
  contextDigest: mediaDigestSchema,
});
export type WindowDiscussionMediaContext = z.infer<
  typeof windowDiscussionMediaContextSchema
>;
