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

export const VERIFICATION_EVIDENCE_MEDIA_PROTOCOL =
  'verification-evidence-media-v1' as const;
export const prepareVerificationEvidenceMediaSchema = z.strictObject({
  protocol: z.literal(VERIFICATION_EVIDENCE_MEDIA_PROTOCOL),
  clientRequestId: mediaV2IdSchema,
  applicationId: mediaV2IdSchema,
  revision: z
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
export type PrepareVerificationEvidenceMediaInput = z.infer<
  typeof prepareVerificationEvidenceMediaSchema
>;
export function verificationEvidenceMediaRequestHash(
  actor: string,
  raw: unknown,
): string {
  const input = prepareVerificationEvidenceMediaSchema.parse(raw);
  return createHash('sha256')
    .update('whaleu-verification-evidence-media-prepare:v1\n')
    .update(
      JSON.stringify({
        protocol: VERIFICATION_EVIDENCE_MEDIA_PROTOCOL,
        actorAccountId: mediaV2IdSchema.parse(actor),
        clientRequestId: input.clientRequestId,
        applicationId: input.applicationId,
        revision: input.revision,
        declaration: {
          mime: input.declaration.mime,
          bytes: input.declaration.bytes,
          sha256: input.declaration.sha256,
        },
      }),
    )
    .digest('hex');
}
export const verificationEvidenceReferenceSchema = z.strictObject({
  applicationId: mediaV2IdSchema,
  revision: z.number().int().positive().safe(),
  bindingId: mediaV2IdSchema,
});
export type VerificationEvidenceReference = z.infer<
  typeof verificationEvidenceReferenceSchema
>;
export const verificationEvidenceDescriptorSchema =
  verificationEvidenceReferenceSchema.extend({
    protocol: z.literal(VERIFICATION_EVIDENCE_MEDIA_PROTOCOL),
    kind: z.literal('verification-evidence'),
    width: z.number().int().positive().max(2048),
    height: z.number().int().positive().max(2048),
    variants: z.tuple([z.literal('thumb-v1'), z.literal('display-v1')]),
  });
export type VerificationEvidenceDescriptor = z.infer<
  typeof verificationEvidenceDescriptorSchema
>;
const instant = z.number().int().positive().safe();
const base = {
  protocol: z.literal(VERIFICATION_EVIDENCE_MEDIA_PROTOCOL),
  intentId: mediaV2IdSchema,
  requestId: mediaV2IdSchema,
  requestHash: mediaDigestSchema,
  serverNow: instant,
};
export const verificationEvidenceMediaStatusSchema = z.discriminatedUnion(
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
export type VerificationEvidenceMediaStatus = z.infer<
  typeof verificationEvidenceMediaStatusSchema
>;
export const verificationEvidenceMediaRecoverySchema = z.discriminatedUnion(
  'state',
  [
    z.strictObject({
      protocol: z.literal(VERIFICATION_EVIDENCE_MEDIA_PROTOCOL),
      requestId: mediaV2IdSchema,
      serverNow: instant,
      state: z.literal('not_recorded'),
      requestHash: z.null(),
    }),
    z.strictObject({
      protocol: z.literal(VERIFICATION_EVIDENCE_MEDIA_PROTOCOL),
      requestId: mediaV2IdSchema,
      serverNow: instant,
      state: z.literal('recorded'),
      requestHash: mediaDigestSchema,
      status: verificationEvidenceMediaStatusSchema,
    }),
    z.strictObject({
      protocol: z.literal(VERIFICATION_EVIDENCE_MEDIA_PROTOCOL),
      requestId: mediaV2IdSchema,
      serverNow: instant,
      state: z.literal('cancelled_before_prepare'),
      requestHash: mediaDigestSchema,
      reason: z.literal('cancelled'),
    }),
  ],
);
export const cancelVerificationEvidenceMediaRequestSchema = z.strictObject({
  protocol: z.literal(VERIFICATION_EVIDENCE_MEDIA_PROTOCOL),
  requestHash: mediaDigestSchema,
});
export const verificationEvidenceMediaGrantSchema = mediaGrantSchema
  .omit({ version: true })
  .extend({ protocol: z.literal(VERIFICATION_EVIDENCE_MEDIA_PROTOCOL) });
export const verificationEvidenceMediaUploadObservedSchema =
  mediaUploadObservedSchema
    .omit({ version: true })
    .extend({ protocol: z.literal(VERIFICATION_EVIDENCE_MEDIA_PROTOCOL) });

/** Only this closed upload reference may be submitted. It contains no locator. */
export const verificationEvidenceUploadDescriptorSchema = z.strictObject({
  protocol: z.literal(VERIFICATION_EVIDENCE_MEDIA_PROTOCOL),
  kind: z.literal('verification-evidence-upload'),
  assetId: mediaV2IdSchema,
});
export type VerificationEvidenceUploadDescriptor = z.infer<
  typeof verificationEvidenceUploadDescriptorSchema
>;
