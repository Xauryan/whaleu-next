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

export const PROFILE_MEDIA_PROTOCOL = 'profile-media-v1' as const;
export const profileMediaId = z
  .uuid()
  .refine((value) => value === value.toLowerCase());
const id = profileMediaId;
export const catalogKeySchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
export const avatarPrepareSchema = z.strictObject({
  protocol: z.literal(PROFILE_MEDIA_PROTOCOL),
  clientRequestId: id,
  expectedRevision: expectedRevisionSchema,
  slot: z.literal('avatar'),
  declaration: z.strictObject({
    mime: mediaMimeSchema,
    bytes: z.number().int().positive().max(MEDIA_MAX_INPUT_BYTES),
    sha256: mediaDigestSchema,
  }),
});
export type AvatarPrepare = z.infer<typeof avatarPrepareSchema>;
export const avatarSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('clear') }),
  z.strictObject({
    kind: z.literal('catalog'),
    catalogVersion: catalogKeySchema,
    itemId: catalogKeySchema,
  }),
  z.strictObject({ kind: z.literal('custom'), editId: id, assetId: id }),
]);
export const avatarCommandSchema = z.strictObject({
  protocol: z.literal(PROFILE_MEDIA_PROTOCOL),
  clientRequestId: id,
  expectedRevision: expectedRevisionSchema,
  source: avatarSourceSchema,
});
export type AvatarCommand = z.infer<typeof avatarCommandSchema>;
export const avatarReceiptSchema = z.strictObject({
  protocol: z.literal(PROFILE_MEDIA_PROTOCOL),
  clientRequestId: id,
  requestHash: mediaDigestSchema,
  resultingRevision: z.number().int().min(1).max(2147483647),
  operation: z.literal('select_avatar'),
});
export type AvatarReceipt = z.infer<typeof avatarReceiptSchema>;
export const avatarCommandRecoverySchema = z.discriminatedUnion('state', [
  z.strictObject({
    protocol: z.literal(PROFILE_MEDIA_PROTOCOL),
    clientRequestId: id,
    state: z.literal('not_recorded'),
  }),
  z.strictObject({
    protocol: z.literal(PROFILE_MEDIA_PROTOCOL),
    clientRequestId: id,
    state: z.literal('committed'),
    receipt: avatarReceiptSchema,
  }),
  z.strictObject({
    protocol: z.literal(PROFILE_MEDIA_PROTOCOL),
    clientRequestId: id,
    state: z.literal('cancelled'),
    requestHash: mediaDigestSchema,
  }),
]);
export type AvatarCommandRecovery = z.infer<typeof avatarCommandRecoverySchema>;
export const avatarSelectedSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('clear') }),
  z.strictObject({
    kind: z.literal('catalog'),
    catalogVersion: catalogKeySchema,
    itemId: catalogKeySchema,
    contentHash: mediaDigestSchema,
  }),
  z.strictObject({
    kind: z.literal('custom'),
    editId: id,
    assetId: id,
    manifestDigest: mediaDigestSchema,
  }),
]);
export type AvatarSelectedSource = z.infer<typeof avatarSelectedSourceSchema>;
export const avatarReviewEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  purpose: z.literal('select_profile_avatar'),
  accountId: id,
  clientRequestId: id,
  expectedRevision: expectedRevisionSchema,
  appearanceId: id,
  previousAppearanceId: id.nullable(),
  slot: z.literal('avatar'),
  source: avatarSelectedSourceSchema,
});
export type AvatarReviewEnvelope = z.infer<typeof avatarReviewEnvelopeSchema>;
function digest(domain: string, data: unknown): string {
  return createHash('sha256')
    .update(`${domain}\n${canonicalJson(data)}`)
    .digest('hex');
}
export function avatarPrepareHash(actor: string, input: unknown): string {
  const intent = avatarPrepareSchema.parse(input);
  return createHash('sha256')
    .update(
      'whaleu-profile-media-prepare:v1\n' +
        JSON.stringify({
          protocol: PROFILE_MEDIA_PROTOCOL,
          actorAccountId: id.parse(actor),
          clientRequestId: intent.clientRequestId,
          expectedRevision: intent.expectedRevision,
          slot: intent.slot,
          declaration: intent.declaration,
        }),
    )
    .digest('hex');
}
export function avatarCommandHash(actor: string, input: unknown): string {
  const intent = avatarCommandSchema.parse(input);
  return createHash('sha256')
    .update(
      'whaleu-profile-avatar-command:v1\n' +
        JSON.stringify({
          protocol: PROFILE_MEDIA_PROTOCOL,
          actorAccountId: id.parse(actor),
          clientRequestId: intent.clientRequestId,
          expectedRevision: intent.expectedRevision,
          source: intent.source,
        }),
    )
    .digest('hex');
}
export function avatarReviewDigest(input: unknown): string {
  return digest(
    'whaleu-profile-avatar-review:v1',
    avatarReviewEnvelopeSchema.parse(input),
  );
}
export const avatarVariantSchema = mediaVariantSchema;

export const avatarCommandCancelSchema = z.strictObject({
  protocol: z.literal(PROFILE_MEDIA_PROTOCOL),
  requestHash: mediaDigestSchema,
});
