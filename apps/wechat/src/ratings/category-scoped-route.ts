import { isRecord } from '../api/errors';
import { invalidRating, ratingId } from './contract';
import {
  decodeRatingNavigationSelector,
  type RatingNavigationSelector,
} from './scoped-contract';

export interface RatingCategoryScopedRoute {
  readonly selector: RatingNavigationSelector;
  readonly categoryId: string | null;
}
/** Routes identify an explicitly chosen view. They never carry authority or prepared data. */
export function decodeRatingCategoryScopedRoute(
  raw: unknown,
): RatingCategoryScopedRoute {
  if (
    !isRecord(raw) ||
    Object.keys(raw).some(
      (key) => !['scope', 'campusId', 'categoryId'].includes(key),
    )
  )
    invalidRating();
  if (
    (raw.scope !== 'global' && raw.scope !== 'campus') ||
    (raw.scope === 'global' && raw.campusId !== undefined) ||
    (raw.categoryId !== undefined && !ratingId(raw.categoryId))
  )
    invalidRating();
  return Object.freeze({
    selector: decodeRatingNavigationSelector(
      raw.scope === 'global'
        ? { kind: 'global' }
        : { kind: 'campus', campusId: raw.campusId },
    ),
    categoryId: typeof raw.categoryId === 'string' ? raw.categoryId : null,
  });
}
export function ratingCategoryScopedQuery(
  route: RatingCategoryScopedRoute,
): Readonly<Record<string, string>> {
  const selector = decodeRatingNavigationSelector(route.selector);
  if (route.categoryId !== null && !ratingId(route.categoryId)) invalidRating();
  return Object.freeze({
    scope: selector.kind,
    ...(selector.kind === 'campus' ? { campusId: selector.campusId } : {}),
    ...(route.categoryId === null ? {} : { categoryId: route.categoryId }),
  });
}
export function ratingCategoryScopedPath(
  route: RatingCategoryScopedRoute,
  editor = false,
): string {
  const query = ratingCategoryScopedQuery(route);
  const page = editor ? 'rating-category-editor' : 'rating-category-manage';
  return `/pages/${page}/${page}?${Object.entries(query)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&')}`;
}
