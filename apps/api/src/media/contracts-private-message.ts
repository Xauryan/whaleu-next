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

export const PRIVATE_MESSAGE_MEDIA_PROTOCOL =
  'private-message-media-v1' as const;
export const preparePrivateMessageMediaSchema = z.strictObject({
  protocol: z.literal(PRIVATE_MESSAGE_MEDIA_PROTOCOL),
  clientRequestId: mediaV2IdSchema,
  conversationId: mediaV2IdSchema,
  messageRequestId: z.uuidv4().refine((value) => value === value.toLowerCase()),
  declaration: z.strictObject({
    mime: mediaMimeSchema,
    bytes: z.number().int().positive().max(MEDIA_MAX_INPUT_BYTES),
    sha256: mediaDigestSchema,
  }),
});
export type PreparePrivateMessageMediaInput = z.infer<
  typeof preparePrivateMessageMediaSchema
>;
export function privateMessageMediaRequestHash(
  actor: string,
  raw: unknown,
): string {
  const input = preparePrivateMessageMediaSchema.parse(raw);
  return createHash('sha256')
    .update('whaleu-private-message-media-prepare:v1\n')
    .update(
      JSON.stringify({
        protocol: PRIVATE_MESSAGE_MEDIA_PROTOCOL,
        actorAccountId: mediaV2IdSchema.parse(actor),
        clientRequestId: input.clientRequestId,
        conversationId: input.conversationId,
        messageRequestId: input.messageRequestId,
        declaration: {
          mime: input.declaration.mime,
          bytes: input.declaration.bytes,
          sha256: input.declaration.sha256,
        },
      }),
    )
    .digest('hex');
}
export const privateMessageReferenceSchema = z.strictObject({
  conversationId: mediaV2IdSchema,
  messageId: mediaV2IdSchema,
  bindingId: mediaV2IdSchema,
});
export type PrivateMessageReference = z.infer<
  typeof privateMessageReferenceSchema
>;
export const privateMessageDescriptorSchema =
  privateMessageReferenceSchema.extend({
    protocol: z.literal(PRIVATE_MESSAGE_MEDIA_PROTOCOL),
    kind: z.literal('private-message-media'),
    width: z.number().int().positive().max(2048),
    height: z.number().int().positive().max(2048),
    variants: z.tuple([z.literal('thumb-v1'), z.literal('display-v1')]),
  });
export type PrivateMessageDescriptor = z.infer<
  typeof privateMessageDescriptorSchema
>;
const instant = z.number().int().positive().safe();
const base = {
  protocol: z.literal(PRIVATE_MESSAGE_MEDIA_PROTOCOL),
  intentId: mediaV2IdSchema,
  requestId: mediaV2IdSchema,
  requestHash: mediaDigestSchema,
  serverNow: instant,
};
export const privateMessageMediaStatusSchema = z.discriminatedUnion('status', [
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
]);
export type PrivateMessageMediaStatus = z.infer<
  typeof privateMessageMediaStatusSchema
>;
export const privateMessageMediaRecoverySchema = z.discriminatedUnion('state', [
  z.strictObject({
    protocol: z.literal(PRIVATE_MESSAGE_MEDIA_PROTOCOL),
    requestId: mediaV2IdSchema,
    serverNow: instant,
    state: z.literal('not_recorded'),
    requestHash: z.null(),
  }),
  z.strictObject({
    protocol: z.literal(PRIVATE_MESSAGE_MEDIA_PROTOCOL),
    requestId: mediaV2IdSchema,
    serverNow: instant,
    state: z.literal('recorded'),
    requestHash: mediaDigestSchema,
    status: privateMessageMediaStatusSchema,
  }),
  z.strictObject({
    protocol: z.literal(PRIVATE_MESSAGE_MEDIA_PROTOCOL),
    requestId: mediaV2IdSchema,
    serverNow: instant,
    state: z.literal('cancelled_before_prepare'),
    requestHash: mediaDigestSchema,
    reason: z.literal('cancelled'),
  }),
]);
export const cancelPrivateMessageMediaRequestSchema = z.strictObject({
  protocol: z.literal(PRIVATE_MESSAGE_MEDIA_PROTOCOL),
  requestHash: mediaDigestSchema,
  conversationId: mediaV2IdSchema,
  messageRequestId: z.uuidv4().refine((value) => value === value.toLowerCase()),
});
export const privateMessageMediaGrantSchema = mediaGrantSchema
  .omit({ version: true })
  .extend({ protocol: z.literal(PRIVATE_MESSAGE_MEDIA_PROTOCOL) });
export const privateMessageMediaUploadObservedSchema = mediaUploadObservedSchema
  .omit({ version: true })
  .extend({ protocol: z.literal(PRIVATE_MESSAGE_MEDIA_PROTOCOL) });

export const privateMessageMediaFactSchema = z.strictObject({
  assetId: mediaV2IdSchema,
  manifestDigest: mediaDigestSchema,
});
export const privateMessageMediaBindingSchema =
  privateMessageMediaFactSchema.extend({ bindingId: mediaV2IdSchema });
export type PrivateMessageMediaFact = z.infer<
  typeof privateMessageMediaFactSchema
>;
export type PrivateMessageMediaBinding = z.infer<
  typeof privateMessageMediaBindingSchema
>;
