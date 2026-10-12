import { z } from 'zod';
import { windowIdSchema, windowPublicIdSchema } from '../contracts.js';
/** Preserve exact accepted bytes: no trim, case fold or Unicode normalization. */
export const dishNameSchema = z.string().refine((value) => {
  const points = Array.from(value);
  return (
    points.length >= 1 &&
    points.length <= 10 &&
    value.trim().length > 0 &&
    points.every((point) => {
      const code = point.codePointAt(0)!;
      return (
        code > 31 &&
        !(code >= 127 && code <= 159) &&
        !(code >= 0xd800 && code <= 0xdfff)
      );
    })
  );
});
export const dishIdentitySchema = z.string().regex(/^(?:[a-f0-9]{2}){1,40}$/);
export const dishQuerySchema = z.strictObject({
  limit: z
    .string()
    .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
    .transform(Number)
    .default(20),
  cursor: z.string().min(1).max(2000).optional(),
});
export type DishQuery = z.infer<typeof dishQuerySchema>;
export const dishOwnQuerySchema = z.strictObject({ dishName: dishNameSchema });
export const dishOwnSchema = z.union([
  z.strictObject({
    kind: z.literal('recorded'),
    active: z.boolean(),
    revision: windowPublicIdSchema,
    recordedAt: z.iso.datetime(),
    catalogRevision: windowPublicIdSchema,
    windowRevision: windowPublicIdSchema,
  }),
  z.strictObject({ kind: z.literal('not_recommended') }),
  z.strictObject({ kind: z.literal('unavailable') }),
]);
export const dishItemSchema = z.strictObject({
  dishName: dishNameSchema,
  dishIdentity: dishIdentitySchema,
  recommendationCount: z.number().int().min(1).max(1000),
  isRecommended: z.boolean(),
  myMembershipRevision: windowPublicIdSchema.nullable(),
});
export const dishPageSchema = z.strictObject({
  windowId: windowPublicIdSchema,
  catalogRevision: windowPublicIdSchema,
  windowRevision: windowPublicIdSchema,
  membershipRevision: z.string().regex(/^[1-9][0-9]{0,18}$/),
  items: z.array(dishItemSchema).max(50),
  nextCursor: z.string().min(1).max(2000).nullable(),
  continuation: z.enum(['more', 'end']),
});
export const dishCommandSchema = z.strictObject({
  clientRequestId: windowIdSchema,
  expectedCatalogRevision: windowIdSchema,
  expectedWindowRevision: windowIdSchema,
  expectedMembershipRevision: windowIdSchema.nullable(),
  dishName: dishNameSchema,
});
export type DishCommand = z.infer<typeof dishCommandSchema>;
export const dishOperationSchema = z.enum([
  'window.dish.recommend.v1',
  'window.dish.retract.v1',
]);
export type DishOperation = z.infer<typeof dishOperationSchema>;
const receiptBase = {
  requestId: windowPublicIdSchema,
  operation: dishOperationSchema,
  windowId: windowPublicIdSchema,
  dishIdentity: dishIdentitySchema,
};
export const dishReceiptSchema = z.union([
  z.strictObject({
    ...receiptBase,
    outcome: z.literal('applied'),
    active: z.boolean(),
    membershipRevision: windowPublicIdSchema,
    recordedAt: z.iso.datetime(),
  }),
  z.strictObject({
    ...receiptBase,
    outcome: z.literal('rejected'),
    code: z.enum([
      'WINDOW_REVISION_CONFLICT',
      'DISH_MEMBERSHIP_REVISION_CONFLICT',
      'DISH_ALREADY_RECOMMENDED',
      'DISH_NOT_RECOMMENDED',
      'DISH_CANCELLED',
      'CONTENT_REJECTED',
    ]),
  }),
]);
export type DishReceipt = z.infer<typeof dishReceiptSchema>;
export const dishCancelSchema = z.strictObject({
  windowId: windowIdSchema,
  operation: dishOperationSchema,
  command: dishCommandSchema,
});
export type DishCancel = z.infer<typeof dishCancelSchema>;
