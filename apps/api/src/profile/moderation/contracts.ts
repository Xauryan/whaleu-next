import { z } from 'zod';
const id = z.uuid().transform((value) => value.toLowerCase());
export const moderationRequestIdSchema = z
  .uuidv4()
  .transform((value) => value.toLowerCase());
const revision = z.number().int().min(0).max(2147483647);
export const moderationTargetSchema = z.strictObject({
  kind: z.enum(['post', 'comment', 'reply']),
  id,
});
export type ModerationTarget = z.infer<typeof moderationTargetSchema>;
// Inputs canonicalize UUID casing. Output schemas validate canonical state without
// transforms, so the actual response contract also exports to OpenAPI JSON Schema.
const outputId = z.uuid().refine((value) => value === value.toLowerCase());
const outputRequestId = z
  .uuidv4()
  .refine((value) => value === value.toLowerCase());
const outputTarget = moderationTargetSchema.extend({ id: outputId });
export const moderationCommandSchema = z.strictObject({
  clientRequestId: moderationRequestIdSchema,
  target: moderationTargetSchema,
  expectedProfileRevision: revision.max(2147483646),
  action: z.literal('reset_nickname'),
});
export type ModerationCommand = z.infer<typeof moderationCommandSchema>;
const receiptBase = {
  requestId: outputRequestId,
  target: outputTarget,
  expectedProfileRevision: revision.max(2147483646),
  action: z.literal('reset_nickname'),
};
/** Minimal durable command metadata. Never includes a subject identity or display. */
export const moderationReceiptSchema = z
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
        'PROFILE_MODERATION_STALE',
        'PROFILE_MODERATION_CANCELLED',
      ]),
    }),
  ])
  .refine(
    (value) =>
      value.outcome === 'rejected' ||
      value.revision === value.expectedProfileRevision + 1,
  );
export type ModerationReceipt = z.infer<typeof moderationReceiptSchema>;
export const moderationManagementSchema = z.union([
  z.strictObject({
    target: outputTarget,
    displayName: z.string().min(1).max(20),
    revision: revision.max(2147483646),
    canReset: z.literal(true),
  }),
  z.strictObject({
    target: outputTarget,
    canReset: z.literal(false),
    availability: z.literal('unavailable'),
    blocker: z.literal('related_sync_unsupported'),
  }),
]);
export type ModerationManagement = z.infer<typeof moderationManagementSchema>;
export const moderationRecoverySchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('recorded'),
    receipt: moderationReceiptSchema,
  }),
  z.strictObject({ state: z.literal('not_recorded') }),
]);
export const moderationEmptyQuerySchema = z.strictObject({});
export const moderationEmptyBodySchema = z.union([
  z.undefined(),
  z.strictObject({}),
]);
