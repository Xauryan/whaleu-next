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

export const PROFILE_MEDIA_PROTOCOL = 'profile-media-v1' as const;
export const prepareProfileMediaSchema = z.strictObject({
  protocol: z.literal(PROFILE_MEDIA_PROTOCOL),
  clientRequestId: mediaV2IdSchema,
  expectedRevision: z.number().int().min(0).max(2147483646),
  slot: z.literal('avatar'),
  declaration: z.strictObject({
    mime: mediaMimeSchema,
    bytes: z.number().int().positive().max(MEDIA_MAX_INPUT_BYTES),
    sha256: mediaDigestSchema,
  }),
});
export type PrepareProfileMediaInput = z.infer<
  typeof prepareProfileMediaSchema
>;
export function profileMediaRequestHash(actor: string, raw: unknown): string {
  const input = prepareProfileMediaSchema.parse(raw);
  return createHash('sha256')
    .update('whaleu-profile-media-prepare:v1\n')
    .update(
      JSON.stringify({
        protocol: PROFILE_MEDIA_PROTOCOL,
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
export const profileMediaParentSchema = z.strictObject({
  ownerKind: z.literal('profile'),
  resourceKind: z.literal('avatar'),
  resourceId: mediaV2IdSchema,
  contentVersion: z.literal(1),
});
export type ProfileMediaParent = z.infer<typeof profileMediaParentSchema>;
const instant = z.number().int().positive().safe();
const base = {
  protocol: z.literal(PROFILE_MEDIA_PROTOCOL),
  editId: mediaV2IdSchema,
  intentId: mediaV2IdSchema,
  requestId: mediaV2IdSchema,
  requestHash: mediaDigestSchema,
  serverNow: instant,
};
export const profileAvatarCommandReceiptSchema = z.strictObject({
  protocol: z.literal(PROFILE_MEDIA_PROTOCOL),
  clientRequestId: mediaV2IdSchema,
  requestHash: mediaDigestSchema,
  resultingRevision: z.number().int().min(1).max(2147483647),
  operation: z.literal('select_avatar'),
});
export const profileMediaStatusSchema = z.discriminatedUnion('status', [
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
    command: profileAvatarCommandReceiptSchema,
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
export type ProfileMediaStatus = z.infer<typeof profileMediaStatusSchema>;
const request = {
  protocol: z.literal(PROFILE_MEDIA_PROTOCOL),
  requestId: mediaV2IdSchema,
  serverNow: instant,
};
export const profileMediaRecoverySchema = z.discriminatedUnion('state', [
  z.strictObject({
    ...request,
    state: z.literal('not_recorded'),
    requestHash: z.null(),
  }),
  z.strictObject({
    ...request,
    state: z.literal('recorded'),
    requestHash: mediaDigestSchema,
    status: profileMediaStatusSchema,
  }),
  z.strictObject({
    ...request,
    state: z.literal('cancelled_before_prepare'),
    requestHash: mediaDigestSchema,
    reason: z.literal('cancelled'),
  }),
]);
export type ProfileMediaRecovery = z.infer<typeof profileMediaRecoverySchema>;
export const cancelProfileMediaRequestSchema = z.strictObject({
  protocol: z.literal(PROFILE_MEDIA_PROTOCOL),
  requestHash: mediaDigestSchema,
});
export const profileMediaCancelSchema = z.discriminatedUnion('result', [
  z.strictObject({
    protocol: z.literal(PROFILE_MEDIA_PROTOCOL),
    result: z.literal('cancelled'),
    status: profileMediaStatusSchema.options[5].extend({
      reason: z.literal('cancelled'),
    }),
  }),
  z.strictObject({
    protocol: z.literal(PROFILE_MEDIA_PROTOCOL),
    result: z.literal('already_terminal'),
    status: profileMediaStatusSchema.options[5],
  }),
  z.strictObject({
    protocol: z.literal(PROFILE_MEDIA_PROTOCOL),
    result: z.literal('bound_history'),
    status: profileMediaStatusSchema.options[4],
  }),
]);
export type ProfileMediaCancel = z.infer<typeof profileMediaCancelSchema>;
export const profileMediaGrantSchema = mediaGrantSchema
  .omit({ version: true })
  .extend({
    protocol: z.literal(PROFILE_MEDIA_PROTOCOL),
    editId: mediaV2IdSchema,
  });
export const profileMediaUploadObservedSchema = mediaUploadObservedSchema
  .omit({ version: true })
  .extend({
    protocol: z.literal(PROFILE_MEDIA_PROTOCOL),
    editId: mediaV2IdSchema,
  });
export const profileMediaDescriptorSchema = z.strictObject({
  protocol: z.literal(PROFILE_MEDIA_PROTOCOL),
  kind: z.literal('profile-media'),
  profileId: mediaV2IdSchema,
  appearanceId: mediaV2IdSchema,
  bindingId: mediaV2IdSchema,
  width: z.number().int().positive().max(2048),
  height: z.number().int().positive().max(2048),
  variants: z.tuple([z.literal('thumb-v1'), z.literal('display-v1')]),
});
export type ProfileMediaDescriptor = z.infer<
  typeof profileMediaDescriptorSchema
>;
export const profileMediaDeliverySchema = z.strictObject({
  profileId: mediaV2IdSchema,
  appearanceId: mediaV2IdSchema,
  variant: mediaVariantSchema,
});
