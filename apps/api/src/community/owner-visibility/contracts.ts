import { z } from 'zod';

export const ownerVisibilityIdSchema = z
  .uuid()
  .transform((value) => value.toLowerCase());
export const ownerVisibilityRequestIdSchema = z
  .uuidv4()
  .transform((value) => value.toLowerCase());
const version = z.number().int().min(0).max(2147483647);
export const ownerVisibilityCommandSchema = z.strictObject({
  clientRequestId: ownerVisibilityRequestIdSchema,
  postId: ownerVisibilityIdSchema,
  ownerHidden: z.boolean(),
  expectedVersion: version.max(2147483646),
});
export type OwnerVisibilityCommand = z.infer<
  typeof ownerVisibilityCommandSchema
>;

/** Authenticated author metadata only. Never contains content or author identity. */
export const ownerVisibilityManagementSchema = z.strictObject({
  postId: z.uuid(),
  ownerHidden: z.boolean(),
  version,
  canChange: z.boolean(),
});
export type OwnerVisibilityManagement = z.infer<
  typeof ownerVisibilityManagementSchema
>;
const receiptBase = {
  requestId: z.uuid(),
  postId: z.uuid(),
  ownerHidden: z.boolean(),
  expectedVersion: version.max(2147483646),
};
export const ownerVisibilityReceiptSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    ...receiptBase,
    outcome: z.literal('applied'),
    version: version.min(1),
    changed: z.boolean(),
    recordedAt: z.iso.datetime(),
  }),
  z.strictObject({
    ...receiptBase,
    outcome: z.literal('rejected'),
    code: z.enum([
      'POST_OWNER_VISIBILITY_STALE',
      'POST_OWNER_VISIBILITY_CANCELLED',
      'POST_OWNER_VISIBILITY_UNAVAILABLE',
    ]),
  }),
]);
export type OwnerVisibilityReceipt = z.infer<
  typeof ownerVisibilityReceiptSchema
>;
export const ownerVisibilityEmptyQuerySchema = z.strictObject({});
export const ownerVisibilityEmptyBodySchema = z.union([
  z.undefined(),
  z.strictObject({}),
]);
