import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  MEDIA_MAX_INPUT_BYTES,
  mediaDigestSchema,
  mediaIdSchema,
  mediaMimeSchema,
  prepareMediaSchema,
} from './contracts.js';

export const mediaV2IdSchema = mediaIdSchema.refine(
  (value) => value === value.toLowerCase(),
  'Canonical lowercase UUID required',
);

/** The original-byte digest is identity only; it is never image/Review evidence. */
export const prepareMediaV2Schema = prepareMediaSchema.extend({
  clientRequestId: mediaV2IdSchema,
  draftId: mediaV2IdSchema,
  spaceId: mediaV2IdSchema,
  declaration: z.strictObject({
    mime: mediaMimeSchema,
    bytes: z.number().int().positive().max(MEDIA_MAX_INPUT_BYTES),
    sha256: mediaDigestSchema,
  }),
});
export type PrepareMediaV2Input = z.infer<typeof prepareMediaV2Schema>;
export function mediaRequestHash(actorAccountId: string, raw: unknown): string {
  const input = prepareMediaV2Schema.parse(raw);
  return createHash('sha256')
    .update('whaleu-media-request:v2\n')
    .update(
      JSON.stringify({
        version: 2,
        actorAccountId: mediaV2IdSchema.parse(actorAccountId),
        clientRequestId: input.clientRequestId,
        purpose: input.purpose,
        draftId: input.draftId,
        spaceId: input.spaceId,
        slot: input.slot,
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
const instant = z.number().int().positive().safe();
export const mediaGenerationSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine(
    (value) =>
      /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n,
  );
const base = {
  version: z.literal(2),
  intentId: mediaIdSchema,
  requestId: mediaIdSchema,
  requestHash: mediaDigestSchema,
  serverNow: instant,
};
export const publicationReferenceSchema = z.strictObject({
  clientRequestId: mediaIdSchema,
  operation: z.literal('publish_post'),
  intentHash: mediaDigestSchema,
});
export const mediaStatusV2Schema = z.discriminatedUnion('status', [
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
    assetId: mediaIdSchema,
    readyRetentionUntil: instant,
    draftExpiresAt: instant,
    bindBefore: instant,
    mediaProof: z.literal('current'),
  }),
  z.strictObject({
    ...base,
    status: z.literal('bound_history'),
    assetId: mediaIdSchema,
    bindingId: mediaIdSchema,
    publication: publicationReferenceSchema.nullable(),
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
export type MediaStatusV2 = z.infer<typeof mediaStatusV2Schema>;
const requestBase = {
  version: z.literal(2),
  requestId: mediaIdSchema,
  serverNow: instant,
};
export const mediaRequestRecoverySchema = z.discriminatedUnion('state', [
  z.strictObject({
    ...requestBase,
    state: z.literal('not_recorded'),
    requestHash: z.null(),
  }),
  z.strictObject({
    ...requestBase,
    state: z.literal('active'),
    requestHash: mediaDigestSchema,
    status: z.discriminatedUnion('status', [
      mediaStatusV2Schema.options[0],
      mediaStatusV2Schema.options[1],
      mediaStatusV2Schema.options[2],
      mediaStatusV2Schema.options[3],
      mediaStatusV2Schema.options[6],
    ]),
  }),
  z.strictObject({
    ...requestBase,
    state: z.literal('bound_history'),
    requestHash: mediaDigestSchema,
    status: mediaStatusV2Schema.options[4],
  }),
  z.strictObject({
    ...requestBase,
    state: z.literal('terminal'),
    requestHash: mediaDigestSchema,
    reason: z.enum(['cancelled', 'expired', 'rejected', 'deleted']),
    status: mediaStatusV2Schema.options[5].nullable(),
  }),
]);
export type MediaRequestRecovery = z.infer<typeof mediaRequestRecoverySchema>;
export const mediaCancelRequestSchema = z.strictObject({
  requestHash: mediaDigestSchema,
});
export const mediaCancelV2Schema = z.discriminatedUnion('result', [
  z.strictObject({
    version: z.literal(2),
    result: z.literal('cancelled'),
    status: mediaStatusV2Schema.options[5].extend({
      reason: z.literal('cancelled'),
    }),
  }),
  z.strictObject({
    version: z.literal(2),
    result: z.literal('already_terminal'),
    status: mediaStatusV2Schema.options[5],
  }),
  z.strictObject({
    version: z.literal(2),
    result: z.literal('bound_history'),
    status: mediaStatusV2Schema.options[4],
  }),
]);
export type MediaCancelV2 = z.infer<typeof mediaCancelV2Schema>;
export const mediaGrantSchema = z.strictObject({
  version: z.literal(1),
  strategy: z.literal('authenticated-multipart-v1'),
  intentId: mediaIdSchema,
  generation: mediaGenerationSchema,
  grantId: mediaIdSchema,
  method: z.literal('POST'),
  fieldName: z.literal('file'),
  maxBytes: z.literal(MEDIA_MAX_INPUT_BYTES),
  expectedBytes: z.number().int().positive().max(MEDIA_MAX_INPUT_BYTES),
  expectedMime: mediaMimeSchema,
  expectedSha256: mediaDigestSchema,
  grantExpiresAt: instant,
  operationDeadlineAt: instant,
  serverNow: instant,
});
export type MediaUploadGrant = z.infer<typeof mediaGrantSchema>;
export const mediaUploadObservedSchema = z.strictObject({
  version: z.literal(2),
  status: z.literal('uploadObserved'),
  intentId: mediaIdSchema,
  generation: mediaGenerationSchema,
  grantId: mediaIdSchema,
  bytes: z.number().int().positive().max(MEDIA_MAX_INPUT_BYTES),
  sha256: mediaDigestSchema,
  next: z.literal('finalize'),
});
export type MediaUploadObserved = z.infer<typeof mediaUploadObservedSchema>;
