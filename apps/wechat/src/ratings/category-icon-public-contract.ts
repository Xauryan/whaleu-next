import { isRecord } from '../api/errors';
import { exact } from '../community/contract';
import { invalidRating, type RatingCategory } from './contract';
import {
  canonicalRatingScopedJson,
  decodeRatingScopedContext,
  ratingScopedDigest,
  type RatingScopedContext,
} from './scoped-contract';
import {
  decodeRatingScopedCategoryPage,
  type RatingScopedCategoryPage,
} from './scoped-read-contract';
import {
  decodeCategoryIconDescriptor,
  type CategoryIconDescriptor,
} from './category-icon-media-contract';
import type { RatingCategoryIconContext } from './category-icon-contract';
import { decodeRatingCategoryIconContext } from './category-icon-contract';
type VersionFive<T> = T extends RatingScopedContext
  ? Omit<T, 'protocolVersion'> & {
      readonly protocolVersion: 5;
      readonly mediaSnapshot: string;
    }
  : never;
export type CategoryIconPublicContext = VersionFive<RatingScopedContext>;
export type CategoryIconPublicCategory = RatingCategory & {
  readonly icon: CategoryIconDescriptor | null;
};
export type CategoryIconPublicPage = Omit<RatingScopedCategoryPage, 'items'> & {
  readonly items: readonly CategoryIconPublicCategory[];
};
export function decodeCategoryIconPublicContext(
  value: unknown,
): CategoryIconPublicContext {
  if (!isRecord(value) || value.protocolVersion !== 5) invalidRating();
  const { mediaSnapshot, ...old } = value;
  if (!ratingScopedDigest(mediaSnapshot)) invalidRating();
  const context = decodeRatingScopedContext({ ...old, protocolVersion: 2 });
  if (!context.capabilities.includes('category_icon')) invalidRating();
  return Object.freeze({
    ...context,
    protocolVersion: 5,
    mediaSnapshot,
  }) as CategoryIconPublicContext;
}
export function decodeCategoryIconPublicPage(
  value: unknown,
): CategoryIconPublicPage {
  exact(value, ['context', 'items', 'nextCursor', 'continuation']);
  if (!Array.isArray(value.items)) invalidRating();
  const icons = value.items.map((item: unknown) => {
    if (!isRecord(item) || !('icon' in item)) invalidRating();
    return item.icon === null ? null : decodeCategoryIconDescriptor(item.icon);
  });
  const page = decodeRatingScopedCategoryPage({
    ...value,
    items: value.items.map((item: unknown) => {
      if (!isRecord(item)) invalidRating();
      const { icon: _icon, ...body } = item;
      void _icon;
      return body;
    }),
  });
  const items = page.items.map((item, index) => {
    const icon = icons[index]!;
    if (
      icon &&
      (icon.categoryId !== item.id || icon.contextId !== page.context.contextId)
    )
      invalidRating();
    return Object.freeze({ ...item, icon });
  });
  return Object.freeze({ ...page, items: Object.freeze(items) });
}
export function matchCategoryIconPublicContext(
  old: RatingScopedContext,
  context: CategoryIconPublicContext,
): void {
  if (
    old.actorId !== context.actorId ||
    old.sessionGeneration !== context.sessionGeneration ||
    old.identityCampusId !== context.identityCampusId ||
    old.sourceDigest !== context.sourceDigest ||
    old.protocolGeneration !== context.protocolGeneration ||
    canonicalRatingScopedJson(old.selector) !==
      canonicalRatingScopedJson(context.selector) ||
    canonicalRatingScopedJson(old.heads) !==
      canonicalRatingScopedJson(context.heads) ||
    old.id === context.id
  )
    invalidRating();
}
export type CategoryIconReadContext =
  CategoryIconPublicContext | RatingCategoryIconContext;
export function categoryIconReadAuthorization(raw: CategoryIconReadContext) {
  if ('commandContext' in raw) {
    const context = decodeRatingCategoryIconContext(raw);
    return {
      id: context.commandContext.id,
      token: context.commandContext.token,
      expiresAt: context.expiresAt,
      actorId: null,
    };
  }
  const context = decodeCategoryIconPublicContext(raw);
  if (context.purpose !== 'read' || context.mode !== 'public') invalidRating();
  return {
    id: context.id,
    token: context.token,
    expiresAt: context.expiresAt,
    actorId: context.actorId,
  };
}
