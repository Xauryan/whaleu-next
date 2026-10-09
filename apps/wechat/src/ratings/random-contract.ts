import { isRecord } from '../api/errors';
import { exact } from '../community/contract';
import {
  decodeRatingSummary,
  decodeRatingTarget,
  invalidRating,
  ratingId,
  type RatingSummary,
  type RatingTarget,
} from './contract';

export interface RatingRandomQuery {
  readonly categoryId: string;
  readonly campusId?: string;
  readonly minimumAverage?: number;
}
export interface RatingRandomResult {
  readonly context: {
    readonly categoryId: string;
    readonly campusId: string | null;
    readonly minimumAverage: number | null;
  };
  readonly candidateCount: number;
  readonly item: {
    readonly regionId: string | null;
    readonly target: RatingTarget;
    readonly summary: RatingSummary;
  } | null;
}
export const ratingMinimumAverage = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 1 &&
  value <= 5 &&
  /^\d(?:\.\d)?$/.test(String(value));

/** Omission deliberately means global only. A physical campus is never a region. */
export function decodeRatingRandomQuery(value: unknown): RatingRandomQuery {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !['categoryId', 'campusId', 'minimumAverage'].includes(key),
    ) ||
    !ratingId(value.categoryId) ||
    ('campusId' in value && !ratingId(value.campusId)) ||
    ('minimumAverage' in value && !ratingMinimumAverage(value.minimumAverage))
  )
    invalidRating();
  exact(value, [
    'categoryId',
    ...('campusId' in value ? ['campusId'] : []),
    ...('minimumAverage' in value ? ['minimumAverage'] : []),
  ]);
  return Object.freeze({
    categoryId: value.categoryId,
    ...('campusId' in value ? { campusId: value.campusId as string } : {}),
    ...('minimumAverage' in value
      ? { minimumAverage: value.minimumAverage as number }
      : {}),
  });
}

export function decodeRatingRandomResult(value: unknown): RatingRandomResult {
  exact(value, ['context', 'candidateCount', 'item']);
  exact(value.context, ['categoryId', 'campusId', 'minimumAverage']);
  const context = value.context;
  if (
    !ratingId(context.categoryId) ||
    !(context.campusId === null || ratingId(context.campusId)) ||
    !(
      context.minimumAverage === null ||
      ratingMinimumAverage(context.minimumAverage)
    ) ||
    typeof value.candidateCount !== 'number' ||
    !Number.isSafeInteger(value.candidateCount) ||
    value.candidateCount < 0 ||
    value.candidateCount > Number.MAX_SAFE_INTEGER ||
    (value.candidateCount === 0) !== (value.item === null)
  )
    invalidRating();
  let item: RatingRandomResult['item'] = null;
  if (value.item !== null) {
    exact(value.item, ['regionId', 'target', 'summary']);
    if (
      !(value.item.regionId === null || ratingId(value.item.regionId)) ||
      (context.campusId === null && value.item.regionId !== null)
    )
      invalidRating();
    const summary = decodeRatingSummary(value.item.summary);
    if (
      context.minimumAverage !== null &&
      (summary.status !== 'known' ||
        summary.count === 0 ||
        summary.sum * 10 <
          summary.count * Math.round(context.minimumAverage * 10))
    )
      invalidRating();
    const target = decodeRatingTarget(value.item.target);
    if (target.allowedActions.setScore !== (summary.status === 'known'))
      invalidRating();
    item = Object.freeze({ regionId: value.item.regionId, target, summary });
  }
  return Object.freeze({
    context: Object.freeze({
      categoryId: context.categoryId,
      campusId: context.campusId,
      minimumAverage: context.minimumAverage,
    }),
    candidateCount: value.candidateCount,
    item,
  });
}

export function matchRatingRandomResult(
  query: RatingRandomQuery,
  result: RatingRandomResult,
): void {
  if (
    result.context.categoryId !== query.categoryId ||
    result.context.campusId !== (query.campusId ?? null) ||
    result.context.minimumAverage !== (query.minimumAverage ?? null)
  )
    invalidRating();
}

export function decodeRatingRandomRoute(value: unknown): {
  readonly categoryId: string;
} {
  exact(value, ['categoryId']);
  if (!ratingId(value.categoryId)) invalidRating();
  return Object.freeze({ categoryId: value.categoryId });
}
