import { z } from 'zod';

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
export const adminPostRemovalCommandSchema = z.strictObject({
  clientRequestId: adminPostRemovalRequestIdSchema,
  target: adminPostRemovalTargetSchema,
  expectedTargetVersion: targetVersion,
  action: z.literal('remove_post'),
});
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
export const adminPostRemovalReceiptSchema = z.discriminatedUnion('outcome', [
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
export type AdminPostRemovalReceipt = z.infer<
  typeof adminPostRemovalReceiptSchema
>;
export const adminPostRemovalManagementSchema = z.strictObject({
  target: outputTarget,
  targetVersion,
  canRemove: z.literal(true),
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
