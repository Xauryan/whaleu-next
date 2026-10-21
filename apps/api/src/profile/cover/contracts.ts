import { createHash } from 'node:crypto';
import { z } from 'zod';
import { expectedRevisionSchema } from '../contracts.js';
import { canonicalJson } from '../../community/content-review/contracts.js';
import {
  MEDIA_MAX_INPUT_BYTES,
  mediaDigestSchema,
  mediaMimeSchema,
  mediaVariantSchema,
} from '../../media/contracts.js';

export const PROFILE_COVER_PROTOCOL = 'profile-cover-v1' as const;
export const profileCoverMediaId = z
  .uuid()
  .refine((value) => value === value.toLowerCase());
const id = profileCoverMediaId;
export const coverPrepareSchema = z.strictObject({
  protocol: z.literal(PROFILE_COVER_PROTOCOL),
  clientRequestId: id,
  expectedRevision: expectedRevisionSchema,
  slot: z.literal('cover'),
  declaration: z.strictObject({
    mime: mediaMimeSchema,
    bytes: z.number().int().positive().max(MEDIA_MAX_INPUT_BYTES),
    sha256: mediaDigestSchema,
  }),
});
export type CoverPrepare = z.infer<typeof coverPrepareSchema>;
export const coverSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('clear') }),
  z.strictObject({ kind: z.literal('custom'), editId: id, assetId: id }),
]);
export const coverCommandSchema = z.strictObject({
  protocol: z.literal(PROFILE_COVER_PROTOCOL),
  clientRequestId: id,
  expectedRevision: expectedRevisionSchema,
  source: coverSourceSchema,
});
export type CoverCommand = z.infer<typeof coverCommandSchema>;
export const coverReceiptSchema = z.strictObject({
  protocol: z.literal(PROFILE_COVER_PROTOCOL),
  clientRequestId: id,
  requestHash: mediaDigestSchema,
  resultingRevision: z.number().int().min(1).max(2147483647),
  operation: z.literal('select_cover'),
});
export type CoverReceipt = z.infer<typeof coverReceiptSchema>;
export const coverCommandRecoverySchema = z.discriminatedUnion('state', [
  z.strictObject({
    protocol: z.literal(PROFILE_COVER_PROTOCOL),
    clientRequestId: id,
    state: z.literal('not_recorded'),
  }),
  z.strictObject({
    protocol: z.literal(PROFILE_COVER_PROTOCOL),
    clientRequestId: id,
    state: z.literal('committed'),
    receipt: coverReceiptSchema,
  }),
  z.strictObject({
    protocol: z.literal(PROFILE_COVER_PROTOCOL),
    clientRequestId: id,
    state: z.literal('cancelled'),
    requestHash: mediaDigestSchema,
  }),
]);
export type CoverCommandRecovery = z.infer<typeof coverCommandRecoverySchema>;
export const coverSelectedSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('clear') }),
  z.strictObject({
    kind: z.literal('custom'),
    editId: id,
    assetId: id,
    manifestDigest: mediaDigestSchema,
  }),
]);
export type CoverSelectedSource = z.infer<typeof coverSelectedSourceSchema>;
export const coverReviewEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  purpose: z.literal('select_profile_cover'),
  accountId: id,
  clientRequestId: id,
  expectedRevision: expectedRevisionSchema,
  appearanceId: id,
  previousAppearanceId: id.nullable(),
  slot: z.literal('cover'),
  source: coverSelectedSourceSchema,
});
export type CoverReviewEnvelope = z.infer<typeof coverReviewEnvelopeSchema>;
function digest(domain: string, data: unknown): string {
  return createHash('sha256')
    .update(`${domain}\n${canonicalJson(data)}`)
    .digest('hex');
}
export function coverPrepareHash(actor: string, input: unknown): string {
  const intent = coverPrepareSchema.parse(input);
  return createHash('sha256')
    .update(
      'whaleu-profile-cover-prepare:v1\n' +
        JSON.stringify({
          protocol: PROFILE_COVER_PROTOCOL,
          actorAccountId: id.parse(actor),
          clientRequestId: intent.clientRequestId,
          expectedRevision: intent.expectedRevision,
          slot: intent.slot,
          declaration: intent.declaration,
        }),
    )
    .digest('hex');
}
export function coverCommandHash(actor: string, input: unknown): string {
  const intent = coverCommandSchema.parse(input);
  return createHash('sha256')
    .update(
      'whaleu-profile-cover-command:v1\n' +
        JSON.stringify({
          protocol: PROFILE_COVER_PROTOCOL,
          actorAccountId: id.parse(actor),
          clientRequestId: intent.clientRequestId,
          expectedRevision: intent.expectedRevision,
          source: intent.source,
        }),
    )
    .digest('hex');
}
export function coverReviewDigest(input: unknown): string {
  return digest(
    'whaleu-profile-cover-review:v1',
    coverReviewEnvelopeSchema.parse(input),
  );
}
export const coverVariantSchema = mediaVariantSchema;

export const coverCommandCancelSchema = z.strictObject({
  protocol: z.literal(PROFILE_COVER_PROTOCOL),
  requestHash: mediaDigestSchema,
});

export const coverCapabilitiesSchema = z.strictObject({
  protocol: z.literal(PROFILE_COVER_PROTOCOL),
  upload: z.enum(['available', 'unavailable']),
});
