import { z } from 'zod';

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
export const adminDiscussionRemovalCommandSchema = z.strictObject({
  clientRequestId: adminDiscussionRemovalRequestIdSchema,
  target: adminDiscussionRemovalTargetSchema,
  expectedTargetVersion: targetVersion,
  action: z.literal('remove_discussion'),
});
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
export const adminDiscussionRemovalReceiptSchema = z.discriminatedUnion(
  'outcome',
  [
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
  ],
);
export type AdminDiscussionRemovalReceipt = z.infer<
  typeof adminDiscussionRemovalReceiptSchema
>;
export const adminDiscussionRemovalManagementSchema = z.strictObject({
  target: outputTarget,
  targetVersion,
  canRemove: z.literal(true),
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
