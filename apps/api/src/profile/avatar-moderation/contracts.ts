import { z } from 'zod';
const id = z.uuid().transform((value) => value.toLowerCase());
export const avatarModerationRequestIdSchema = z
  .uuidv4()
  .transform((value) => value.toLowerCase());
const revision = z.number().int().min(0).max(2147483647);
export const avatarModerationTargetSchema = z.strictObject({
  kind: z.enum(['post', 'comment', 'reply']),
  id,
});
export type AvatarModerationTarget = z.infer<
  typeof avatarModerationTargetSchema
>;
// Inputs canonicalize UUID casing. Output schemas validate canonical state without
// transforms, so the actual response contract also exports to OpenAPI JSON Schema.
const outputId = z.uuid().refine((value) => value === value.toLowerCase());
const outputRequestId = z
  .uuidv4()
  .refine((value) => value === value.toLowerCase());
const outputTarget = avatarModerationTargetSchema.extend({ id: outputId });
export const avatarModerationCommandSchema = z.strictObject({
  clientRequestId: avatarModerationRequestIdSchema,
  target: avatarModerationTargetSchema,
  expectedProfileRevision: revision.max(2147483646),
  expectedAppearanceId: id,
  action: z.literal('clear_custom_avatar'),
});
export type AvatarModerationCommand = z.infer<
  typeof avatarModerationCommandSchema
>;
const receiptBase = {
  expectedAppearanceId: outputId,
  requestId: outputRequestId,
  target: outputTarget,
  expectedProfileRevision: revision.max(2147483646),
  action: z.literal('clear_custom_avatar'),
};
/** Minimal durable command metadata. Never includes a subject identity or display. */
export const avatarModerationReceiptSchema = z
  .discriminatedUnion('outcome', [
    z.strictObject({
      ...receiptBase,
      outcome: z.literal('applied'),
      revision: revision.min(1),
      eventId: outputId,
      recordedAt: z.iso.datetime(),
    }),
    z.strictObject({
      ...receiptBase,
      outcome: z.literal('rejected'),
      code: z.enum([
        'PROFILE_AVATAR_MODERATION_STALE',
        'PROFILE_AVATAR_MODERATION_NOT_APPLICABLE',
        'PROFILE_AVATAR_MODERATION_CANCELLED',
      ]),
    }),
  ])
  .refine(
    (value) =>
      value.outcome === 'rejected' ||
      value.revision === value.expectedProfileRevision + 1,
  );
export type AvatarModerationReceipt = z.infer<
  typeof avatarModerationReceiptSchema
>;
export const avatarModerationManagementSchema = z.strictObject({
  target: outputTarget,
  displayName: z.string().min(1).max(20),
  revision: revision.max(2147483646),
  canClearCustomAvatar: z.boolean(),
  expectedAppearanceId: outputId.nullable(),
});
export type AvatarModerationManagement = z.infer<
  typeof avatarModerationManagementSchema
>;
export const avatarModerationRecoverySchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('recorded'),
    receipt: avatarModerationReceiptSchema,
  }),
  z.strictObject({ state: z.literal('not_recorded') }),
]);
export const avatarModerationEmptyQuerySchema = z.strictObject({});
export const avatarModerationEmptyBodySchema = z.union([
  z.undefined(),
  z.strictObject({}),
]);
