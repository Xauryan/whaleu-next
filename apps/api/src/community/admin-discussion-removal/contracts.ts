import { z } from 'zod';
import {
  punishmentSelectionSchema,
  punishmentReferenceOutputSchema,
} from '../../safety/account-moderation/contracts.js';

const id = z.uuid().transform((value) => value.toLowerCase());
const outputId = z.uuid().refine((value) => value === value.toLowerCase());
const targetVersion = z.string().regex(/^[a-f0-9]{64}$/);
export const adminDiscussionRemovalRequestIdSchema = z
  .uuidv4()
  .transform((value) => value.toLowerCase());
export const adminDiscussionRemovalTargetSchema = z.strictObject({
  kind: z.enum(['comment', 'reply']),
  id,
});
const outputTarget = adminDiscussionRemovalTargetSchema.extend({
  id: outputId,
});
export type AdminDiscussionRemovalTarget = z.infer<
  typeof adminDiscussionRemovalTargetSchema
>;
const adminDiscussionRemovalV1CommandSchema = z.strictObject({
  clientRequestId: adminDiscussionRemovalRequestIdSchema,
  target: adminDiscussionRemovalTargetSchema,
  expectedTargetVersion: targetVersion,
  action: z.literal('remove_discussion'),
});
export const adminDiscussionRemovalCommandSchema = z.union([
  adminDiscussionRemovalV1CommandSchema,
  adminDiscussionRemovalV1CommandSchema.extend({
    version: z.literal(2),
    punishment: punishmentSelectionSchema,
  }),
]);
export type AdminDiscussionRemovalCommand = z.infer<
  typeof adminDiscussionRemovalCommandSchema
>;
const receiptBase = {
  requestId: z.uuidv4().refine((value) => value === value.toLowerCase()),
  target: outputTarget,
  expectedTargetVersion: targetVersion,
  action: z.literal('remove_discussion'),
};
/** Private original-key outcome, never an identity lookup or a content preview. */
const adminDiscussionRemovalV1ReceiptSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    ...receiptBase,
    outcome: z.literal('applied'),
    eventId: outputId,
    recordedAt: z.iso.datetime({ precision: 3 }),
  }),
  z.strictObject({
    ...receiptBase,
    outcome: z.literal('rejected'),
    code: z.enum([
      'ADMIN_DISCUSSION_REMOVAL_STALE',
      'ADMIN_DISCUSSION_REMOVAL_CANCELLED',
    ]),
  }),
]);
export const adminDiscussionRemovalReceiptSchema = z.union([
  adminDiscussionRemovalV1ReceiptSchema,
  adminDiscussionRemovalV1ReceiptSchema.options[0]
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
  adminDiscussionRemovalV1ReceiptSchema.options[1].extend({
    version: z.literal(2),
    selection: punishmentSelectionSchema,
  }),
]);
export type AdminDiscussionRemovalReceipt = z.infer<
  typeof adminDiscussionRemovalReceiptSchema
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
export const adminDiscussionRemovalManagementQuerySchema =
  adminDiscussionRemovalTargetSchema.extend({
    version: z.literal('2').optional(),
  });
export const adminDiscussionRemovalManagementSchema = z.strictObject({
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
export type AdminDiscussionRemovalManagement = z.infer<
  typeof adminDiscussionRemovalManagementSchema
>;
export const adminDiscussionRemovalRecoverySchema = z.discriminatedUnion(
  'state',
  [
    z.strictObject({
      state: z.literal('recorded'),
      receipt: adminDiscussionRemovalReceiptSchema,
    }),
    z.strictObject({ state: z.literal('not_recorded') }),
  ],
);
export const adminDiscussionRemovalEmptyQuerySchema = z.strictObject({});
export const adminDiscussionRemovalEmptyBodySchema = z.union([
  z.undefined(),
  z.strictObject({}),
]);
