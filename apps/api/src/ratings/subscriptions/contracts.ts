import { z } from 'zod';
import {
  ratingPublicIdSchema as id,
  ratingIdSchema,
  ratingTimeSchema,
  ratingRejectionSchema,
} from '../contracts.js';
export const setRatingSubscriptionSchema = z.strictObject({
  clientRequestId: ratingIdSchema,
  regionId: id.nullable(),
  expectedTargetRevision: id,
  expectedSubscriptionRevision: id,
  subscribed: z.boolean(),
});
export const ratingSubscriptionStateSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('unavailable') }),
  z.strictObject({
    status: z.literal('known'),
    targetId: id,
    subscribed: z.boolean(),
    count: z.number().int().nonnegative().max(2147483647),
    revision: id,
    allowedActions: z.strictObject({ setSubscription: z.literal(true) }),
  }),
]);
export const ratingSubscriptionQuerySchema = z.strictObject({
  regionId: id.nullable(),
  targets: z
    .array(z.strictObject({ targetId: id, expectedTargetRevision: id }))
    .min(1)
    .max(20)
    .refine(
      (items) => new Set(items.map((i) => i.targetId)).size === items.length,
    ),
});
export const ratingSubscriptionQueryResponseSchema = z
  .strictObject({
    items: z
      .array(
        z.strictObject({ targetId: id, state: ratingSubscriptionStateSchema }),
      )
      .min(1)
      .max(20),
  })
  .refine(
    (r) =>
      new Set(r.items.map((i) => i.targetId)).size === r.items.length &&
      r.items.every(
        (i) =>
          i.state.status === 'unavailable' || i.state.targetId === i.targetId,
      ),
  );
export const ratingSubscriptionOperationSchema = z.literal(
  'set_target_subscription',
);
export const ratingSubscriptionReceiptSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    requestId: id,
    operation: ratingSubscriptionOperationSchema,
    outcome: z.enum(['applied', 'noop']),
    targetId: id,
    subscribed: z.boolean(),
    revision: id,
    occurredAt: ratingTimeSchema,
  }),
  z.strictObject({
    requestId: id,
    operation: ratingSubscriptionOperationSchema,
    outcome: z.literal('rejected'),
    code: ratingRejectionSchema,
  }),
]);
export type RatingSubscriptionOperation = z.infer<
  typeof ratingSubscriptionOperationSchema
>;
export type RatingSubscriptionReceipt = z.infer<
  typeof ratingSubscriptionReceiptSchema
>;
export type RatingSubscriptionState = z.infer<
  typeof ratingSubscriptionStateSchema
>;
export type SetRatingSubscription = z.infer<typeof setRatingSubscriptionSchema>;
export type RatingSubscriptionQuery = z.infer<
  typeof ratingSubscriptionQuerySchema
>;
