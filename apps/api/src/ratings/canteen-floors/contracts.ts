import { z } from 'zod';
import {
  windowIdSchema,
  windowPublicIdSchema,
  windowCatalogSchema,
} from '../windows/contracts.js';
export const floorIdSchema = windowIdSchema;
export const floorCatalogSchema = windowCatalogSchema;
export const floorScoreSchema = z.number().finite().min(1).max(5);
export const floorSummarySchema = z.union([
  z
    .strictObject({
      kind: z.literal('known'),
      ratingCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      mean: z.number().min(1).max(5).multipleOf(0.1).nullable(),
    })
    .refine((v) => (v.ratingCount === 0 ? v.mean === null : v.mean !== null)),
  z.strictObject({ kind: z.literal('unavailable') }),
]);
export const floorOwnSchema = z.union([
  z.strictObject({
    kind: z.literal('recorded'),
    score: floorScoreSchema,
    revision: windowPublicIdSchema,
    recordedAt: z.iso.datetime(),
  }),
  z.strictObject({ kind: z.literal('not_submitted') }),
  z.strictObject({ kind: z.literal('unavailable') }),
]);
export const floorSchema = z.strictObject({
  id: windowPublicIdSchema,
  canteenRevision: windowPublicIdSchema,
  canteenId: windowPublicIdSchema,
  canteenName: z.string().min(1).max(200),
  sourceFloorKey: z.string().min(1).max(200),
  label: z.string().min(1).max(200),
  summary: floorSummarySchema,
});
export const floorDetailSchema = z.strictObject({
  catalogRevision: windowPublicIdSchema,
  floor: floorSchema,
  myScore: floorOwnSchema,
});
export const floorSetScoreSchema = z.strictObject({
  clientRequestId: floorIdSchema,
  expectedCatalogRevision: floorIdSchema,
  expectedCanteenRevision: floorIdSchema,
  score: floorScoreSchema,
});
export type FloorSetScore = z.infer<typeof floorSetScoreSchema>;
const base = {
  requestId: windowPublicIdSchema,
  operation: z.literal('floor.score.first.v1'),
  floorId: windowPublicIdSchema,
};
export const floorReceiptSchema = z.union([
  z.strictObject({
    ...base,
    outcome: z.literal('applied'),
    score: floorScoreSchema,
    scoreRevision: windowPublicIdSchema,
    recordedAt: z.iso.datetime(),
  }),
  z.strictObject({
    ...base,
    outcome: z.literal('rejected'),
    code: z.enum([
      'FLOOR_REVISION_CONFLICT',
      'FLOOR_ALREADY_RATED',
      'FLOOR_SCORE_CANCELLED',
    ]),
  }),
]);
export type FloorReceipt = z.infer<typeof floorReceiptSchema>;
export const floorCancelSchema = z.strictObject({
  floorId: floorIdSchema,
  command: floorSetScoreSchema,
});
export type FloorCancel = z.infer<typeof floorCancelSchema>;
export const floorEmptySchema = z.strictObject({});
