import { z } from 'zod';
import {
  ratingIdSchema,
  ratingPublicIdSchema,
  ratingSummarySchema,
  ratingTargetSchema,
} from '../contracts.js';

export const ratingMinimumAverageSchema = z
  .number()
  .min(1)
  .max(5)
  .refine((value) => Number.isInteger(value * 10));
export const ratingRandomQuerySchema = z.strictObject({
  categoryId: ratingIdSchema,
  campusId: ratingIdSchema.optional(),
  minimumAverage: z
    .union([
      ratingMinimumAverageSchema,
      z
        .string()
        .regex(/^[1-4](?:\.[0-9])?$|^5(?:\.0)?$/)
        .transform(Number),
    ])
    .optional(),
});
export const ratingRandomResponseSchema = z
  .strictObject({
    context: z.strictObject({
      campusId: ratingPublicIdSchema.nullable(),
      categoryId: ratingPublicIdSchema,
      minimumAverage: ratingMinimumAverageSchema.nullable(),
    }),
    candidateCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    item: z
      .strictObject({
        regionId: ratingPublicIdSchema.nullable(),
        target: ratingTargetSchema,
        summary: ratingSummarySchema,
      })
      .nullable(),
  })
  .refine((value) => (value.candidateCount === 0) === (value.item === null))
  .refine(
    (value) =>
      value.context.campusId !== null ||
      value.item === null ||
      value.item.regionId === null,
  )
  .refine(
    (value) =>
      value.item === null ||
      value.item.target.allowedActions.setScore ===
        (value.item.summary.status === 'known'),
  )
  .refine((value) => {
    const minimum = value.context.minimumAverage;
    if (minimum === null || value.item === null) return true;
    const summary = value.item.summary;
    return (
      summary.status === 'known' &&
      summary.count > 0 &&
      BigInt(summary.sum) * 10n >=
        BigInt(Math.round(minimum * 10)) * BigInt(summary.count)
    );
  });
export type RatingRandomQuery = z.infer<typeof ratingRandomQuerySchema>;
