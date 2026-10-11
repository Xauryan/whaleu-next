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

export const ERRAND_MEDIA_PROTOCOL = 'errand-media-v1' as const;
export const errandMediaSlotSchema = z.enum([
  'public0',
  'public1',
  'public2',
  'private0',
  'private1',
  'private2',
]);
export type ErrandMediaSlot = z.infer<typeof errandMediaSlotSchema>;
export const prepareErrandMediaSchema = z.strictObject({
  protocol: z.literal(ERRAND_MEDIA_PROTOCOL),
  clientRequestId: mediaV2IdSchema,
  draftId: mediaV2IdSchema,
  targetRegionId: mediaV2IdSchema,
  slot: errandMediaSlotSchema,
  draftRevision: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER - 1),
  declaration: z.strictObject({
    mime: mediaMimeSchema,
    bytes: z.number().int().positive().max(MEDIA_MAX_INPUT_BYTES),
    sha256: mediaDigestSchema,
  }),
});
export type PrepareErrandMediaInput = z.infer<typeof prepareErrandMediaSchema>;
export function errandMediaRequestHash(actor: string, raw: unknown): string {
  const input = prepareErrandMediaSchema.parse(raw);
  return createHash('sha256')
    .update('whaleu-errand-media-prepare:v1\n')
    .update(
      JSON.stringify({
        protocol: ERRAND_MEDIA_PROTOCOL,
        actorAccountId: mediaV2IdSchema.parse(actor),
        clientRequestId: input.clientRequestId,
        draftId: input.draftId,
        draftRevision: input.draftRevision,
        targetRegionId: input.targetRegionId,
        slot: input.slot,
        declaration: {
          mime: input.declaration.mime,
          bytes: input.declaration.bytes,
          sha256: input.declaration.sha256,
        },
      }),
    )
    .digest('hex');
}
export const errandReferenceSchema = z.strictObject({
  orderId: mediaV2IdSchema,
  slot: errandMediaSlotSchema,
  revision: z.number().int().positive().safe(),
  bindingId: mediaV2IdSchema,
});
export type ErrandReference = z.infer<typeof errandReferenceSchema>;
export const errandDescriptorSchema = errandReferenceSchema.extend({
  protocol: z.literal(ERRAND_MEDIA_PROTOCOL),
  kind: z.literal('errand-media'),
  width: z.number().int().positive().max(2048),
  height: z.number().int().positive().max(2048),
  variants: z.tuple([z.literal('thumb-v1'), z.literal('display-v1')]),
});
export type ErrandDescriptor = z.infer<typeof errandDescriptorSchema>;
const instant = z.number().int().positive().safe();
const base = {
  protocol: z.literal(ERRAND_MEDIA_PROTOCOL),
  intentId: mediaV2IdSchema,
  requestId: mediaV2IdSchema,
  requestHash: mediaDigestSchema,
  serverNow: instant,
};
export const errandMediaStatusSchema = z.discriminatedUnion('status', [
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
export type ErrandMediaStatus = z.infer<typeof errandMediaStatusSchema>;
export const errandMediaRecoverySchema = z.discriminatedUnion('state', [
  z.strictObject({
    protocol: z.literal(ERRAND_MEDIA_PROTOCOL),
    requestId: mediaV2IdSchema,
    serverNow: instant,
    state: z.literal('not_recorded'),
    requestHash: z.null(),
  }),
  z.strictObject({
    protocol: z.literal(ERRAND_MEDIA_PROTOCOL),
    requestId: mediaV2IdSchema,
    serverNow: instant,
    state: z.literal('recorded'),
    requestHash: mediaDigestSchema,
    status: errandMediaStatusSchema,
  }),
  z.strictObject({
    protocol: z.literal(ERRAND_MEDIA_PROTOCOL),
    requestId: mediaV2IdSchema,
    serverNow: instant,
    state: z.literal('cancelled_before_prepare'),
    requestHash: mediaDigestSchema,
    reason: z.literal('cancelled'),
  }),
]);
export const cancelErrandMediaRequestSchema = z.strictObject({
  protocol: z.literal(ERRAND_MEDIA_PROTOCOL),
  requestHash: mediaDigestSchema,
});
export const errandMediaGrantSchema = mediaGrantSchema
  .omit({ version: true })
  .extend({ protocol: z.literal(ERRAND_MEDIA_PROTOCOL) });
export const errandMediaUploadObservedSchema = mediaUploadObservedSchema
  .omit({ version: true })
  .extend({ protocol: z.literal(ERRAND_MEDIA_PROTOCOL) });

export const errandMediaFactSchema = z.strictObject({
  slot: errandMediaSlotSchema,
  assetId: mediaV2IdSchema,
  manifestDigest: mediaDigestSchema,
});
export const errandMediaBindingSchema = errandMediaFactSchema.extend({
  bindingId: mediaV2IdSchema,
});
export const errandMediaFactsSchema = z
  .array(errandMediaFactSchema)
  .max(6)
  .refine(
    (v) =>
      new Set(v.map((x) => x.assetId)).size === v.length &&
      new Set(v.map((x) => x.slot)).size === v.length,
  );
export const errandMediaBindingsSchema = z
  .array(errandMediaBindingSchema)
  .max(6)
  .refine(
    (v) =>
      new Set(v.map((x) => x.assetId)).size === v.length &&
      new Set(v.map((x) => x.slot)).size === v.length &&
      new Set(v.map((x) => x.bindingId)).size === v.length,
  );
export type ErrandMediaFact = z.infer<typeof errandMediaFactSchema>;
export type ErrandMediaBinding = z.infer<typeof errandMediaBindingSchema>;
export const errandMediaAudience = (slot: ErrandMediaSlot) =>
  slot.startsWith('public')
    ? ('errand-public' as const)
    : ('errand-private' as const);
export const errandMediaPurpose = (slot: ErrandMediaSlot) =>
  slot.startsWith('public')
    ? ('errand-public-image' as const)
    : ('errand-private-image' as const);
