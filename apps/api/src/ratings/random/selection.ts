import { ApplicationError } from '../../http/application-error.js';
import type { RatingSummary } from '../contracts.js';
import { ratingMinimumAverageSchema } from './contracts.js';

/** Compare the exact rational score, never the rounded display average. */
export function matchesRatingMinimum(
  summary: RatingSummary,
  minimum?: number,
): boolean {
  if (minimum === undefined) return true;
  if (!ratingMinimumAverageSchema.safeParse(minimum).success)
    throw new ApplicationError('RATING_UNAVAILABLE');
  if (summary.status !== 'known')
    throw new ApplicationError('RATING_SCORE_UNAVAILABLE');
  return (
    summary.count > 0 &&
    BigInt(summary.sum) * 10n >=
      BigInt(Math.round(minimum * 10)) * BigInt(summary.count)
  );
}
