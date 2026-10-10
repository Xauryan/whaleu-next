import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  MEDIA_MAX_INPUT_BYTES,
  mediaDigestSchema,
  mediaMimeSchema,
  mediaVariantSchema,
} from './contracts.js';
import {
  mediaV2IdSchema,
  mediaGrantSchema,
  mediaUploadObservedSchema,
} from './contracts-v2.js';

export const RATINGS_MEDIA_PROTOCOL = 'ratings-target-media-v1' as const;
export const prepareRatingsMediaSchema = z.strictObject({
  protocol: z.literal(RATINGS_MEDIA_PROTOCOL),
  clientRequestId: mediaV2IdSchema,
  editScopeId: mediaV2IdSchema,
  scopeRevision: mediaDigestSchema,
  slot: z.literal('cover'),
  declaration: z.strictObject({
    mime: mediaMimeSchema,
    bytes: z.number().int().positive().max(MEDIA_MAX_INPUT_BYTES),
    sha256: mediaDigestSchema,
  }),
});
export type PrepareRatingsMediaInput = z.infer<
  typeof prepareRatingsMediaSchema
>;
export function ratingsMediaRequestHash(actor: string, raw: unknown): string {
  const input = prepareRatingsMediaSchema.parse(raw);
  return createHash('sha256')
    .update('whaleu-ratings-target-media-prepare:v1\n')
    .update(
      JSON.stringify({
        protocol: RATINGS_MEDIA_PROTOCOL,
        actorAccountId: mediaV2IdSchema.parse(actor),
        clientRequestId: input.clientRequestId,
        editScopeId: input.editScopeId,
        scopeRevision: input.scopeRevision,
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
export const ratingsMediaParentSchema = z.strictObject({
  ownerKind: z.literal('ratings'),
  resourceKind: z.literal('target_cover'),
  resourceId: mediaV2IdSchema,
  contentVersion: z.literal(1),
});
export type RatingsMediaParent = z.infer<typeof ratingsMediaParentSchema>;
export const ratingsMediaDescriptorSchema = z.strictObject({
  protocol: z.literal(RATINGS_MEDIA_PROTOCOL),
  kind: z.literal('ratings-target-media'),
  targetId: mediaV2IdSchema,
  contextId: mediaV2IdSchema,
  contextToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  appearanceId: mediaV2IdSchema,
  bindingId: mediaV2IdSchema,
  width: z.number().int().positive().max(2048),
  height: z.number().int().positive().max(2048),
  variants: z.tuple([z.literal('thumb-v1'), z.literal('display-v1')]),
});
export type RatingsMediaDescriptor = z.infer<
  typeof ratingsMediaDescriptorSchema
>;
export const ratingsMediaDeliverySchema = z.strictObject({
  targetId: mediaV2IdSchema,
  appearanceId: mediaV2IdSchema,
  variant: mediaVariantSchema,
  contextId: mediaV2IdSchema,
  contextToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

const instant = z.number().int().positive().safe();
const base = {
  protocol: z.literal(RATINGS_MEDIA_PROTOCOL),
  editScopeId: mediaV2IdSchema,
  intentId: mediaV2IdSchema,
  requestId: mediaV2IdSchema,
  requestHash: mediaDigestSchema,
  serverNow: instant,
};
export const ratingsMediaStatusSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...base,
    status: z.literal('prepared'),
    editScopeId: mediaV2IdSchema,
    operationDeadlineAt: instant,
    upload: z.enum(['none', 'in_flight', 'reconcile_needed']),
  }),
  z.strictObject({
    ...base,
    status: z.literal('uploaded'),
    editScopeId: mediaV2IdSchema,
    operationDeadlineAt: instant,
  }),
  z.strictObject({
    ...base,
    status: z.literal('processing'),
    editScopeId: mediaV2IdSchema,
    operationDeadlineAt: instant,
    retryAfterMs: z.number().int().min(250).max(30000),
  }),
  z.strictObject({
    ...base,
    status: z.literal('ready_unbound'),
    editScopeId: mediaV2IdSchema,
    assetId: mediaV2IdSchema,
    readyRetentionUntil: instant,
    editExpiresAt: instant,
    bindBefore: instant,
    mediaProof: z.literal('current'),
  }),
  z.strictObject({
    ...base,
    status: z.literal('bound_history'),
    assetId: mediaV2IdSchema,
    bindingId: mediaV2IdSchema,
    appearanceId: mediaV2IdSchema,
    targetId: mediaV2IdSchema,
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
export type RatingsMediaStatus = z.infer<typeof ratingsMediaStatusSchema>;
const request = {
  protocol: z.literal(RATINGS_MEDIA_PROTOCOL),
  requestId: mediaV2IdSchema,
  serverNow: instant,
};
export const ratingsMediaRecoverySchema = z.discriminatedUnion('state', [
  z.strictObject({
    ...request,
    state: z.literal('not_recorded'),
    requestHash: z.null(),
  }),
  z.strictObject({
    ...request,
    state: z.literal('recorded'),
    requestHash: mediaDigestSchema,
    status: ratingsMediaStatusSchema,
  }),
  z.strictObject({
    ...request,
    state: z.literal('cancelled_before_prepare'),
    requestHash: mediaDigestSchema,
    reason: z.literal('cancelled'),
  }),
]);
export type RatingsMediaRecovery = z.infer<typeof ratingsMediaRecoverySchema>;
export const cancelRatingsMediaRequestSchema = z.strictObject({
  protocol: z.literal(RATINGS_MEDIA_PROTOCOL),
  requestHash: mediaDigestSchema,
});
export const ratingsMediaCancelSchema = z.discriminatedUnion('result', [
  z.strictObject({
    protocol: z.literal(RATINGS_MEDIA_PROTOCOL),
    result: z.literal('cancelled'),
    status: ratingsMediaStatusSchema.options[5].extend({
      reason: z.literal('cancelled'),
    }),
  }),
  z.strictObject({
    protocol: z.literal(RATINGS_MEDIA_PROTOCOL),
    result: z.literal('already_terminal'),
    status: ratingsMediaStatusSchema.options[5],
  }),
  z.strictObject({
    protocol: z.literal(RATINGS_MEDIA_PROTOCOL),
    result: z.literal('bound_history'),
    status: ratingsMediaStatusSchema.options[4],
  }),
]);
export type RatingsMediaCancel = z.infer<typeof ratingsMediaCancelSchema>;
export const ratingsMediaGrantSchema = mediaGrantSchema
  .omit({ version: true })
  .extend({
    protocol: z.literal(RATINGS_MEDIA_PROTOCOL),
    editScopeId: mediaV2IdSchema,
  });
export const ratingsMediaUploadObservedSchema = mediaUploadObservedSchema
  .omit({ version: true })
  .extend({
    protocol: z.literal(RATINGS_MEDIA_PROTOCOL),
    editScopeId: mediaV2IdSchema,
  });
