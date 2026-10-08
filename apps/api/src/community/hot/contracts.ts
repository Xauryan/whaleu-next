import { z } from 'zod';
import type { PostView } from '../contracts.js';
export const HOT_RANGES = Object.freeze({
  day: { days: 1, cap: 50 },
  week: { days: 7, cap: 200 },
  month: { days: 30, cap: 1000 },
  half_year: { days: 180, cap: 1000 },
  year: { days: 365, cap: 1000 },
  history: { days: null, cap: 1000 },
} as const);
export const hotRangeSchema = z.enum([
  'day',
  'week',
  'month',
  'half_year',
  'year',
  'history',
]);
export const hotQuerySchema = z.strictObject({
  spaceId: z.uuid().refine((id) => id === id.toLowerCase()),
  range: hotRangeSchema.default('day'),
  limit: z
    .string()
    .regex(/^(?:[1-9]|10)$/)
    .default('10')
    .transform(Number),
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .refine(
      (value) =>
        Buffer.from(value, 'base64url').toString('base64url') === value,
    )
    .optional(),
});
export type HotQuery = z.infer<typeof hotQuerySchema>;
export interface HotPage {
  items: PostView[];
  nextCursor: string | null;
  continuation:
    | 'more'
    | 'scan_pending'
    | 'end'
    | 'login_required'
    | 'phone_verification_required';
}

export const hotEmptyBodySchema = z.union([z.undefined(), z.strictObject({})]);
