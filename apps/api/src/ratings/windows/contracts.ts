import { z } from 'zod';
export const windowIdSchema = z
  .uuid()
  .transform((value) => value.toLowerCase());
export const windowPublicIdSchema = z
  .uuid()
  .refine((value) => value === value.toLowerCase());
export const windowScoreSchema = z.number().finite().int().min(-10).max(10);
export const windowQuerySchema = z.strictObject({
  canteenIds: z
    .string()
    .max(740)
    .transform((value) => value.split(','))
    .pipe(z.array(windowIdSchema).min(1).max(20))
    .transform((values) => [...new Set(values)].sort())
    .optional(),
  floorId: windowIdSchema.optional(),
  minRating: z
    .string()
    .regex(/^-?(?:\d|10)(?:\.\d{1,4})?$/)
    .transform(Number)
    .pipe(z.number().min(-10).max(10))
    .optional(),
  limit: z
    .string()
    .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
    .transform(Number)
    .default(20),
  cursor: z.string().min(1).max(2000).optional(),
});
export type WindowQuery = z.infer<typeof windowQuerySchema>;
export const windowSummarySchema = z.union([
  z
    .strictObject({
      kind: z.literal('known'),
      ratingCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      mean: z.number().min(-10).max(10).multipleOf(0.1).nullable(),
    })
    .refine((v) => (v.ratingCount === 0 ? v.mean === null : v.mean !== null)),
  z.strictObject({ kind: z.literal('unavailable') }),
]);
export const windowOwnSchema = z.union([
  z.strictObject({
    kind: z.literal('recorded'),
    score: windowScoreSchema,
    revision: windowPublicIdSchema,
    recordedAt: z.iso.datetime(),
  }),
  z.strictObject({ kind: z.literal('not_submitted') }),
  z.strictObject({ kind: z.literal('unavailable') }),
]);
export const windowFloorSchema = z.strictObject({
  id: windowPublicIdSchema,
  sourceFloorKey: z.string().min(1).max(200),
  label: z.string().min(1).max(200),
});
export const windowCanteenSchema = z.strictObject({
  id: windowPublicIdSchema,
  revision: windowPublicIdSchema,
  name: z.string().min(1).max(200),
  sourceCanteenKey: z.string().min(1).max(200),
  campusId: windowPublicIdSchema,
  campusLabel: z.string().min(1).max(200),
  sourceCampusKey: z.string().min(1).max(200),
  floors: z.array(windowFloorSchema).max(100),
});
export const windowCatalogSchema = z.strictObject({
  catalogRevision: windowPublicIdSchema,
  canteens: z.array(windowCanteenSchema).max(100),
});
export const windowSchema = z.strictObject({
  id: windowPublicIdSchema,
  revision: windowPublicIdSchema,
  name: z.string().min(1).max(200),
  canteenId: windowPublicIdSchema,
  canteenName: z.string().min(1).max(200),
  floor: windowFloorSchema,
  summary: windowSummarySchema,
});
export const windowPageSchema = z.strictObject({
  catalogRevision: windowPublicIdSchema,
  scoreRevision: z.string().regex(/^[1-9][0-9]{0,18}$/),
  items: z.array(windowSchema).max(50),
  nextCursor: z.string().min(1).max(2000).nullable(),
  continuation: z.enum(['more', 'end']),
});
export const windowDetailSchema = z.strictObject({
  catalogRevision: windowPublicIdSchema,
  window: windowSchema,
  myScore: windowOwnSchema,
});
export const windowSetScoreSchema = z.strictObject({
  clientRequestId: windowIdSchema,
  expectedCatalogRevision: windowIdSchema,
  expectedWindowRevision: windowIdSchema,
  expectedOwnScoreRevision: windowIdSchema.nullable(),
  score: windowScoreSchema,
});
export type WindowSetScore = z.infer<typeof windowSetScoreSchema>;
const base = {
  requestId: windowPublicIdSchema,
  operation: z.literal('window.score.set.v1'),
  windowId: windowPublicIdSchema,
};
export const windowReceiptSchema = z.union([
  z.strictObject({
    ...base,
    outcome: z.enum(['applied', 'noop']),
    score: windowScoreSchema,
    scoreRevision: windowPublicIdSchema,
    recordedAt: z.iso.datetime(),
  }),
  z.strictObject({
    ...base,
    outcome: z.literal('rejected'),
    code: z.enum([
      'WINDOW_REVISION_CONFLICT',
      'WINDOW_SCORE_REVISION_CONFLICT',
      'WINDOW_SCORE_CANCELLED',
    ]),
  }),
]);
export type WindowReceipt = z.infer<typeof windowReceiptSchema>;
export const windowCancelSchema = z.strictObject({
  windowId: windowIdSchema,
  command: windowSetScoreSchema,
});
export type WindowCancel = z.infer<typeof windowCancelSchema>;
export const windowEmptySchema = z.strictObject({});
