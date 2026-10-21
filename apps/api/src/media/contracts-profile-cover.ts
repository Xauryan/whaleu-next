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

export const PROFILE_COVER_MEDIA_PROTOCOL = 'profile-cover-v1' as const;
export const prepareProfileCoverMediaSchema = z.strictObject({
  protocol: z.literal(PROFILE_COVER_MEDIA_PROTOCOL),
  clientRequestId: mediaV2IdSchema,
  expectedRevision: z.number().int().min(0).max(2147483646),
  slot: z.literal('cover'),
  declaration: z.strictObject({
    mime: mediaMimeSchema,
    bytes: z.number().int().positive().max(MEDIA_MAX_INPUT_BYTES),
    sha256: mediaDigestSchema,
  }),
});
export type PrepareProfileCoverMediaInput = z.infer<
  typeof prepareProfileCoverMediaSchema
>;
export function profileCoverMediaRequestHash(
  actor: string,
  raw: unknown,
): string {
  const input = prepareProfileCoverMediaSchema.parse(raw);
  return createHash('sha256')
    .update('whaleu-profile-cover-prepare:v1\n')
    .update(
      JSON.stringify({
        protocol: PROFILE_COVER_MEDIA_PROTOCOL,
        actorAccountId: mediaV2IdSchema.parse(actor),
        clientRequestId: input.clientRequestId,
        expectedRevision: input.expectedRevision,
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
export const profileCoverMediaParentSchema = z.strictObject({
  ownerKind: z.literal('profile'),
  resourceKind: z.literal('cover'),
  resourceId: mediaV2IdSchema,
  contentVersion: z.literal(1),
});
export type ProfileCoverMediaParent = z.infer<
  typeof profileCoverMediaParentSchema
>;
const instant = z.number().int().positive().safe();
const base = {
  protocol: z.literal(PROFILE_COVER_MEDIA_PROTOCOL),
  editId: mediaV2IdSchema,
  intentId: mediaV2IdSchema,
  requestId: mediaV2IdSchema,
  requestHash: mediaDigestSchema,
  serverNow: instant,
};
export const profileCoverCommandReceiptSchema = z.strictObject({
  protocol: z.literal(PROFILE_COVER_MEDIA_PROTOCOL),
  clientRequestId: mediaV2IdSchema,
  requestHash: mediaDigestSchema,
  resultingRevision: z.number().int().min(1).max(2147483647),
  operation: z.literal('select_cover'),
});
export const profileCoverMediaStatusSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...base,
    status: z.literal('prepared'),
    editId: mediaV2IdSchema,
    operationDeadlineAt: instant,
    upload: z.enum(['none', 'in_flight', 'reconcile_needed']),
  }),
  z.strictObject({
    ...base,
    status: z.literal('uploaded'),
    editId: mediaV2IdSchema,
    operationDeadlineAt: instant,
  }),
  z.strictObject({
    ...base,
    status: z.literal('processing'),
    editId: mediaV2IdSchema,
    operationDeadlineAt: instant,
    retryAfterMs: z.number().int().min(250).max(30000),
  }),
  z.strictObject({
    ...base,
    status: z.literal('ready_unbound'),
    editId: mediaV2IdSchema,
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
    command: profileCoverCommandReceiptSchema,
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
export type ProfileCoverMediaStatus = z.infer<
  typeof profileCoverMediaStatusSchema
>;
const request = {
  protocol: z.literal(PROFILE_COVER_MEDIA_PROTOCOL),
  requestId: mediaV2IdSchema,
  serverNow: instant,
};
export const profileCoverMediaRecoverySchema = z.discriminatedUnion('state', [
  z.strictObject({
    ...request,
    state: z.literal('not_recorded'),
    requestHash: z.null(),
  }),
  z.strictObject({
    ...request,
    state: z.literal('recorded'),
    requestHash: mediaDigestSchema,
    status: profileCoverMediaStatusSchema,
  }),
  z.strictObject({
    ...request,
    state: z.literal('cancelled_before_prepare'),
    requestHash: mediaDigestSchema,
    reason: z.literal('cancelled'),
  }),
]);
export type ProfileCoverMediaRecovery = z.infer<
  typeof profileCoverMediaRecoverySchema
>;
export const cancelProfileCoverMediaRequestSchema = z.strictObject({
  protocol: z.literal(PROFILE_COVER_MEDIA_PROTOCOL),
  requestHash: mediaDigestSchema,
});
export const profileCoverMediaCancelSchema = z.discriminatedUnion('result', [
  z.strictObject({
    protocol: z.literal(PROFILE_COVER_MEDIA_PROTOCOL),
    result: z.literal('cancelled'),
    status: profileCoverMediaStatusSchema.options[5].extend({
      reason: z.literal('cancelled'),
    }),
  }),
  z.strictObject({
    protocol: z.literal(PROFILE_COVER_MEDIA_PROTOCOL),
    result: z.literal('already_terminal'),
    status: profileCoverMediaStatusSchema.options[5],
  }),
  z.strictObject({
    protocol: z.literal(PROFILE_COVER_MEDIA_PROTOCOL),
    result: z.literal('bound_history'),
    status: profileCoverMediaStatusSchema.options[4],
  }),
]);
export type ProfileCoverMediaCancel = z.infer<
  typeof profileCoverMediaCancelSchema
>;
export const profileCoverMediaGrantSchema = mediaGrantSchema
  .omit({ version: true })
  .extend({
    protocol: z.literal(PROFILE_COVER_MEDIA_PROTOCOL),
    editId: mediaV2IdSchema,
  });
export const profileCoverMediaUploadObservedSchema = mediaUploadObservedSchema
  .omit({ version: true })
  .extend({
    protocol: z.literal(PROFILE_COVER_MEDIA_PROTOCOL),
    editId: mediaV2IdSchema,
  });
export const profileCoverMediaDescriptorSchema = z.strictObject({
  protocol: z.literal(PROFILE_COVER_MEDIA_PROTOCOL),
  kind: z.literal('profile-cover'),
  profileId: mediaV2IdSchema,
  appearanceId: mediaV2IdSchema,
  bindingId: mediaV2IdSchema,
  width: z.number().int().positive().max(2048),
  height: z.number().int().positive().max(2048),
  variants: z.tuple([z.literal('thumb-v1'), z.literal('display-v1')]),
});
export type ProfileCoverMediaDescriptor = z.infer<
  typeof profileCoverMediaDescriptorSchema
>;
export const profileCoverMediaDeliverySchema = z.strictObject({
  profileId: mediaV2IdSchema,
  appearanceId: mediaV2IdSchema,
  variant: mediaVariantSchema,
});
