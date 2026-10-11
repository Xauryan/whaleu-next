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

export const SCHOOL_QR_MEDIA_PROTOCOL =
  'school-configuration-qr-media-v1' as const;
export const schoolQrEntryKeySchema = z.enum([
  'treehole',
  'trading',
  'errand',
  'review',
  'official_account',
  'admin',
]);
export type SchoolQrEntryKey = z.infer<typeof schoolQrEntryKeySchema>;
export const prepareSchoolQrMediaSchema = z.strictObject({
  protocol: z.literal(SCHOOL_QR_MEDIA_PROTOCOL),
  clientRequestId: mediaV2IdSchema,
  regionId: mediaV2IdSchema,
  entryKey: schoolQrEntryKeySchema,
  expectedRevision: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER - 1),
  declaration: z.strictObject({
    mime: mediaMimeSchema,
    bytes: z.number().int().positive().max(MEDIA_MAX_INPUT_BYTES),
    sha256: mediaDigestSchema,
  }),
});
export type PrepareSchoolQrMediaInput = z.infer<
  typeof prepareSchoolQrMediaSchema
>;
export function schoolQrMediaRequestHash(actor: string, raw: unknown): string {
  const input = prepareSchoolQrMediaSchema.parse(raw);
  return createHash('sha256')
    .update('whaleu-school-configuration-qr-prepare:v1\n')
    .update(
      JSON.stringify({
        protocol: SCHOOL_QR_MEDIA_PROTOCOL,
        actorAccountId: mediaV2IdSchema.parse(actor),
        clientRequestId: input.clientRequestId,
        regionId: input.regionId,
        entryKey: input.entryKey,
        expectedRevision: input.expectedRevision,
        declaration: {
          mime: input.declaration.mime,
          bytes: input.declaration.bytes,
          sha256: input.declaration.sha256,
        },
      }),
    )
    .digest('hex');
}
export const schoolQrReferenceSchema = z.strictObject({
  regionId: mediaV2IdSchema,
  entryKey: schoolQrEntryKeySchema,
  entryRevision: z.number().int().positive().safe(),
  bindingId: mediaV2IdSchema,
});
export type SchoolQrReference = z.infer<typeof schoolQrReferenceSchema>;
export const schoolQrDescriptorSchema = schoolQrReferenceSchema.extend({
  protocol: z.literal(SCHOOL_QR_MEDIA_PROTOCOL),
  kind: z.literal('school-configuration-qr'),
  width: z.number().int().positive().max(2048),
  height: z.number().int().positive().max(2048),
  variants: z.tuple([z.literal('thumb-v1'), z.literal('display-v1')]),
});
export type SchoolQrDescriptor = z.infer<typeof schoolQrDescriptorSchema>;
const instant = z.number().int().positive().safe();
const base = {
  protocol: z.literal(SCHOOL_QR_MEDIA_PROTOCOL),
  intentId: mediaV2IdSchema,
  requestId: mediaV2IdSchema,
  requestHash: mediaDigestSchema,
  serverNow: instant,
};
export const schoolQrMediaStatusSchema = z.discriminatedUnion('status', [
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
export type SchoolQrMediaStatus = z.infer<typeof schoolQrMediaStatusSchema>;
export const schoolQrMediaRecoverySchema = z.discriminatedUnion('state', [
  z.strictObject({
    protocol: z.literal(SCHOOL_QR_MEDIA_PROTOCOL),
    requestId: mediaV2IdSchema,
    serverNow: instant,
    state: z.literal('not_recorded'),
    requestHash: z.null(),
  }),
  z.strictObject({
    protocol: z.literal(SCHOOL_QR_MEDIA_PROTOCOL),
    requestId: mediaV2IdSchema,
    serverNow: instant,
    state: z.literal('recorded'),
    requestHash: mediaDigestSchema,
    status: schoolQrMediaStatusSchema,
  }),
  z.strictObject({
    protocol: z.literal(SCHOOL_QR_MEDIA_PROTOCOL),
    requestId: mediaV2IdSchema,
    serverNow: instant,
    state: z.literal('cancelled_before_prepare'),
    requestHash: mediaDigestSchema,
    reason: z.literal('cancelled'),
  }),
]);
export const cancelSchoolQrMediaRequestSchema = z.strictObject({
  protocol: z.literal(SCHOOL_QR_MEDIA_PROTOCOL),
  requestHash: mediaDigestSchema,
});
export const schoolQrMediaGrantSchema = mediaGrantSchema
  .omit({ version: true })
  .extend({ protocol: z.literal(SCHOOL_QR_MEDIA_PROTOCOL) });
export const schoolQrMediaUploadObservedSchema = mediaUploadObservedSchema
  .omit({ version: true })
  .extend({ protocol: z.literal(SCHOOL_QR_MEDIA_PROTOCOL) });
