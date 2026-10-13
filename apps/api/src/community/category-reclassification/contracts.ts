/** Bounded candidates only. Enum membership is not transition approval.
 * All candidates remain in the non-trading profile partition; indexed profile
 * membership relies on this invariant and must be revisited before expansion. */
import { z } from 'zod';

export const reclassificationCategorySchema = z.enum([
  'discussion',
  'confession',
  'companions',
  'pets',
  'internships',
  'scenery',
  'dorms',
  'research',
  'deep_sea',
]);
export type ReclassificationCategory = z.infer<
  typeof reclassificationCategorySchema
>;
const id = z.uuid().transform((value) => value.toLowerCase());
const requestId = z.uuidv4().transform((value) => value.toLowerCase());
const revision = z.number().int().min(0).max(2147483647);

/** Actor, scope, original category, policy and grant are exclusively server-derived. */
export const reclassificationCommandSchema = z.strictObject({
  clientRequestId: requestId,
  postId: id,
  expectedRevision: revision.max(2147483646),
  targetCategory: reclassificationCategorySchema,
});
export type ReclassificationCommand = z.infer<
  typeof reclassificationCommandSchema
>;

const receiptBase = {
  requestId: id,
  postId: id,
  expectedRevision: revision.max(2147483646),
  targetCategory: reclassificationCategorySchema,
};
/** Recovery is command metadata, never permission to return current content. */
export const reclassificationReceiptSchema = z
  .discriminatedUnion('outcome', [
    z.strictObject({
      ...receiptBase,
      outcome: z.literal('applied'),
      revision: revision.min(1),
      eventId: id,
      recordedAt: z.iso.datetime(),
    }),
    z.strictObject({
      ...receiptBase,
      outcome: z.literal('unchanged'),
      revision,
      eventId: id.nullable(),
      recordedAt: z.iso.datetime(),
    }),
    z.strictObject({
      ...receiptBase,
      outcome: z.literal('rejected'),
      code: z.enum([
        'POST_CATEGORY_STALE',
        'POST_CATEGORY_CANCELLED',
        'POST_CATEGORY_UNAVAILABLE',
      ]),
    }),
  ])
  .refine((receipt) => {
    if (receipt.outcome === 'rejected') return true;
    if (receipt.outcome === 'applied')
      return receipt.revision === receipt.expectedRevision + 1;
    return (
      receipt.revision === receipt.expectedRevision &&
      (receipt.revision === 0
        ? receipt.eventId === null
        : receipt.eventId !== null)
    );
  }, 'Receipt must preserve exact revision and event continuity');
export type ReclassificationReceipt = z.infer<
  typeof reclassificationReceiptSchema
>;

export const reclassificationRecoverySchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('recorded'),
    receipt: reclassificationReceiptSchema,
  }),
  // A not-recorded observation alone never authorizes a replacement request key.
  z.strictObject({ state: z.literal('not_recorded') }),
  z.strictObject({ state: z.literal('unavailable') }),
]);
export const reclassificationEmptyBodySchema = z.union([
  z.undefined(),
  z.strictObject({}),
]);

export const categoryManagementSchema = z
  .strictObject({
    postId: id,
    currentCategory: z.enum([
      'discussion',
      'feedback',
      'confession',
      'companions',
      'pets',
      'internships',
      'scenery',
      'dorms',
      'research',
      'deep_sea',
      'trading',
    ]),
    revision,
    canChange: z.boolean(),
    blocker: z.literal('related_sync_unsupported').optional(),
    targets: z.array(reclassificationCategorySchema).max(9),
  })
  .refine(
    (v) => v.blocker === undefined || (!v.canChange && v.targets.length === 0),
  );
export const categoryRequestIdSchema = requestId;
export const categoryPostIdSchema = id;
export const categoryEmptyQuerySchema = z.strictObject({});
