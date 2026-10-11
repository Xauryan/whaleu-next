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

export const ORGANIZATION_MEDIA_PROTOCOL = 'organization-media-v1' as const;
export const organizationMediaSlotSchema = z.enum([
  'avatar',
  'mainQr',
  'managerContact',
  'linkedOfficialQr',
  'introImage0',
  'introImage1',
  'introImage2',
  'introImage3',
  'introImage4',
  'introImage5',
  'introImage6',
  'introImage7',
  'introImage8',
]);
export type OrganizationMediaSlot = z.infer<typeof organizationMediaSlotSchema>;
export const prepareOrganizationMediaSchema = z.strictObject({
  protocol: z.literal(ORGANIZATION_MEDIA_PROTOCOL),
  clientRequestId: mediaV2IdSchema,
  organizationId: mediaV2IdSchema,
  slot: organizationMediaSlotSchema,
  applicationRevision: z
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
export type PrepareOrganizationMediaInput = z.infer<
  typeof prepareOrganizationMediaSchema
>;
export function organizationMediaRequestHash(
  actor: string,
  raw: unknown,
): string {
  const input = prepareOrganizationMediaSchema.parse(raw);
  return createHash('sha256')
    .update('whaleu-organization-media-prepare:v1\n')
    .update(
      JSON.stringify({
        protocol: ORGANIZATION_MEDIA_PROTOCOL,
        actorAccountId: mediaV2IdSchema.parse(actor),
        clientRequestId: input.clientRequestId,
        organizationId: input.organizationId,
        slot: input.slot,
        applicationRevision: input.applicationRevision,
        declaration: {
          mime: input.declaration.mime,
          bytes: input.declaration.bytes,
          sha256: input.declaration.sha256,
        },
      }),
    )
    .digest('hex');
}
export const organizationReferenceSchema = z.strictObject({
  organizationId: mediaV2IdSchema,
  slot: organizationMediaSlotSchema,
  applicationRevision: z.number().int().positive().safe(),
  bindingId: mediaV2IdSchema,
});
export type OrganizationReference = z.infer<typeof organizationReferenceSchema>;
export const organizationDescriptorSchema = organizationReferenceSchema.extend({
  protocol: z.literal(ORGANIZATION_MEDIA_PROTOCOL),
  kind: z.literal('organization-media'),
  width: z.number().int().positive().max(2048),
  height: z.number().int().positive().max(2048),
  variants: z.tuple([z.literal('thumb-v1'), z.literal('display-v1')]),
});
export type OrganizationDescriptor = z.infer<
  typeof organizationDescriptorSchema
>;
const instant = z.number().int().positive().safe();
const base = {
  protocol: z.literal(ORGANIZATION_MEDIA_PROTOCOL),
  intentId: mediaV2IdSchema,
  requestId: mediaV2IdSchema,
  requestHash: mediaDigestSchema,
  serverNow: instant,
};
export const organizationMediaStatusSchema = z.discriminatedUnion('status', [
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
export type OrganizationMediaStatus = z.infer<
  typeof organizationMediaStatusSchema
>;
export const organizationMediaRecoverySchema = z.discriminatedUnion('state', [
  z.strictObject({
    protocol: z.literal(ORGANIZATION_MEDIA_PROTOCOL),
    requestId: mediaV2IdSchema,
    serverNow: instant,
    state: z.literal('not_recorded'),
    requestHash: z.null(),
  }),
  z.strictObject({
    protocol: z.literal(ORGANIZATION_MEDIA_PROTOCOL),
    requestId: mediaV2IdSchema,
    serverNow: instant,
    state: z.literal('recorded'),
    requestHash: mediaDigestSchema,
    status: organizationMediaStatusSchema,
  }),
  z.strictObject({
    protocol: z.literal(ORGANIZATION_MEDIA_PROTOCOL),
    requestId: mediaV2IdSchema,
    serverNow: instant,
    state: z.literal('cancelled_before_prepare'),
    requestHash: mediaDigestSchema,
    reason: z.literal('cancelled'),
  }),
]);
export const cancelOrganizationMediaRequestSchema = z.strictObject({
  protocol: z.literal(ORGANIZATION_MEDIA_PROTOCOL),
  requestHash: mediaDigestSchema,
});
export const organizationMediaGrantSchema = mediaGrantSchema
  .omit({ version: true })
  .extend({ protocol: z.literal(ORGANIZATION_MEDIA_PROTOCOL) });
export const organizationMediaUploadObservedSchema = mediaUploadObservedSchema
  .omit({ version: true })
  .extend({ protocol: z.literal(ORGANIZATION_MEDIA_PROTOCOL) });
