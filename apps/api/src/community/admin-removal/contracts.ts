import { z } from 'zod';
import {
  punishmentSelectionSchema,
  punishmentReferenceOutputSchema,
} from '../../safety/account-moderation/contracts.js';

const id = z.uuid().transform((value) => value.toLowerCase());
const outputId = z.uuid().refine((value) => value === value.toLowerCase());
const targetVersion = z.string().regex(/^[a-f0-9]{64}$/);
export const adminPostRemovalRequestIdSchema = z
  .uuidv4()
  .transform((value) => value.toLowerCase());
export const adminPostRemovalTargetSchema = z.strictObject({
  kind: z.literal('post'),
  id,
});
const outputTarget = adminPostRemovalTargetSchema.extend({ id: outputId });
export type AdminPostRemovalTarget = z.infer<
  typeof adminPostRemovalTargetSchema
>;
const adminPostRemovalV1CommandSchema = z.strictObject({
  clientRequestId: adminPostRemovalRequestIdSchema,
  target: adminPostRemovalTargetSchema,
  expectedTargetVersion: targetVersion,
  action: z.literal('remove_post'),
});
export const adminPostRemovalCommandSchema = z.union([
  adminPostRemovalV1CommandSchema,
  adminPostRemovalV1CommandSchema
    .extend({ version: z.literal(2), punishment: punishmentSelectionSchema })
    .refine(
      (c) =>
        c.punishment.duration.kind !== 'finite' ||
        c.punishment.duration.unit !== 'minutes',
      'Post punishment uses hours or days',
    ),
]);
export type AdminPostRemovalCommand = z.infer<
  typeof adminPostRemovalCommandSchema
>;
const receiptBase = {
  requestId: z.uuidv4().refine((value) => value === value.toLowerCase()),
  target: outputTarget,
  expectedTargetVersion: targetVersion,
  action: z.literal('remove_post'),
};
/** Private original-key outcome, never an identity lookup or a content preview. */
const adminPostRemovalV1ReceiptSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    ...receiptBase,
    outcome: z.literal('applied'),
    eventId: outputId,
    recordedAt: z.iso.datetime({ precision: 3 }),
  }),
  z.strictObject({
    ...receiptBase,
    outcome: z.literal('rejected'),
    code: z.enum(['ADMIN_POST_REMOVAL_STALE', 'ADMIN_POST_REMOVAL_CANCELLED']),
  }),
]);
export const adminPostRemovalReceiptSchema = z.union([
  adminPostRemovalV1ReceiptSchema,
  adminPostRemovalV1ReceiptSchema.options[0]
    .extend({
      version: z.literal(2),
      selection: punishmentSelectionSchema,
      punishment: punishmentReferenceOutputSchema,
    })
    .refine(
      (receipt) =>
        receipt.punishment.kind === receipt.selection.kind &&
        receipt.punishment.revision ===
          (BigInt(receipt.selection.expectedRevision) + 1n).toString(),
    ),
  adminPostRemovalV1ReceiptSchema.options[1].extend({
    version: z.literal(2),
    selection: punishmentSelectionSchema,
  }),
]);
export type AdminPostRemovalReceipt = z.infer<
  typeof adminPostRemovalReceiptSchema
>;
const punishmentOptionSchema = z.strictObject({
  revision: z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/),
  current: z
    .strictObject({
      punishmentId: outputId,
      endsAt: z.iso.datetime({ precision: 3 }).nullable(),
    })
    .nullable(),
});
export const adminPostRemovalManagementQuerySchema =
  adminPostRemovalTargetSchema.extend({ version: z.literal('2').optional() });
export const adminPostRemovalManagementSchema = z.strictObject({
  target: outputTarget,
  targetVersion,
  canRemove: z.literal(true),
  punishmentOptions: z
    .strictObject({
      interaction_mute: punishmentOptionSchema,
      access_suspension: punishmentOptionSchema,
    })
    .optional(),
});
export type AdminPostRemovalManagement = z.infer<
  typeof adminPostRemovalManagementSchema
>;
export const adminPostRemovalRecoverySchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('recorded'),
    receipt: adminPostRemovalReceiptSchema,
  }),
  z.strictObject({ state: z.literal('not_recorded') }),
]);
export const adminPostRemovalEmptyQuerySchema = z.strictObject({});
export const adminPostRemovalEmptyBodySchema = z.union([
  z.undefined(),
  z.strictObject({}),
]);
