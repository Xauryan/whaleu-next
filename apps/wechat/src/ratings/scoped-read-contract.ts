import { isRecord } from '../api/errors';
import { exact } from '../community/contract';
import {
  decodeRatingCategory,
  decodeRatingTarget,
  decodeRatingComment,
  decodeRatingSummary,
  invalidRating,
  ratingCursor,
  ratingId,
  type RatingCategory,
  type RatingTarget,
  type RatingComment,
  type RatingAuthorMode,
  type RatingSummary,
} from './contract';
import {
  decodeRatingReply,
  ratingNullableId,
  ratingTimestamp,
  type RatingReply,
} from './discussion-contract';
import { ratingMinimumAverage } from './random-contract';
import {
  decodeRatingNavigationSelector,
  decodeRatingRandomCandidateSelector,
  decodeRatingScopedLocator,
  ratingNavigationKey,
  type RatingNavigationSelector,
  type RatingRandomCandidateSelector,
  type RatingScopedContext,
  type RatingScopedLocator,
} from './scoped-contract';

export interface RatingScopedPageContext {
  readonly contextId: string;
  readonly selector: RatingNavigationSelector;
  readonly catalogRevision: string;
  readonly protocolGeneration: string;
}
export interface RatingScopedPage<T, C extends RatingScopedPageContext> {
  readonly context: C;
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly continuation: 'more' | 'scan' | 'end';
}
export type RatingScopedCategoryPage = RatingScopedPage<
  RatingCategory,
  RatingScopedPageContext & { readonly parentId: string | null }
>;
export type RatingScopedTargetPage = RatingScopedPage<
  RatingTarget,
  RatingScopedPageContext & { readonly categoryId: string }
>;
export type RatingScopedCommentPage = RatingScopedPage<
  RatingComment,
  RatingScopedPageContext & { readonly targetId: string }
>;
export type RatingScopedSubscriptionPage = RatingScopedPage<
  RatingTarget,
  RatingScopedPageContext
>;
export type RatingScopedDiscussionContext = RatingScopedPageContext & {
  readonly targetId: string;
  readonly rootId: string;
};
export type RatingScopedReplyPageContext = RatingScopedDiscussionContext & {
  readonly order: 'oldest';
};
export type RatingScopedReplyPage = RatingScopedPage<
  RatingReply,
  RatingScopedReplyPageContext
>;
export interface RatingScopedDiscussion {
  readonly context: RatingScopedDiscussionContext;
  readonly root: RatingComment;
  readonly allowedActions: {
    readonly createReply: boolean;
    readonly authorModes: readonly RatingAuthorMode[];
  };
}
export interface RatingScopedReplyPosition {
  readonly context: RatingScopedReplyPageContext;
  readonly anchorReplyId: string;
  readonly page: RatingScopedReplyPage;
}
function decodeContext(
  v: unknown,
  extra: readonly string[] = [],
): RatingScopedPageContext {
  exact(v, [
    'contextId',
    'selector',
    'catalogRevision',
    'protocolGeneration',
    ...extra,
  ]);
  if (
    !ratingId(v.contextId) ||
    !ratingId(v.catalogRevision) ||
    !ratingId(v.protocolGeneration)
  )
    invalidRating();
  return Object.freeze({
    contextId: v.contextId,
    selector: decodeRatingNavigationSelector(v.selector),
    catalogRevision: v.catalogRevision,
    protocolGeneration: v.protocolGeneration,
  });
}
function decodeCategoryContext(
  v: unknown,
): RatingScopedCategoryPage['context'] {
  const base = decodeContext(v, ['parentId']);
  if (!isRecord(v) || !ratingNullableId(v.parentId)) invalidRating();
  return Object.freeze({ ...base, parentId: v.parentId });
}
function decodeTargetContext(v: unknown): RatingScopedTargetPage['context'] {
  const base = decodeContext(v, ['categoryId']);
  if (!isRecord(v) || !ratingId(v.categoryId)) invalidRating();
  return Object.freeze({ ...base, categoryId: v.categoryId });
}
function decodeCommentContext(v: unknown): RatingScopedCommentPage['context'] {
  const base = decodeContext(v, ['targetId']);
  if (!isRecord(v) || !ratingId(v.targetId)) invalidRating();
  return Object.freeze({ ...base, targetId: v.targetId });
}
function decodeDiscussionContext(
  v: unknown,
  extra: readonly string[] = [],
): RatingScopedDiscussionContext {
  const base = decodeContext(v, ['targetId', 'rootId', ...extra]);
  if (!isRecord(v) || !ratingId(v.targetId) || !ratingId(v.rootId))
    invalidRating();
  return Object.freeze({ ...base, targetId: v.targetId, rootId: v.rootId });
}
function decodeReplyContext(v: unknown): RatingScopedReplyPageContext {
  const base = decodeDiscussionContext(v, ['order']);
  if (!isRecord(v) || v.order !== 'oldest') invalidRating();
  return Object.freeze({ ...base, order: v.order });
}
function decodePage<
  T extends { readonly id: string },
  C extends RatingScopedPageContext,
>(
  v: unknown,
  decodePageContext: (v: unknown) => C,
  decode: (v: unknown) => T,
): RatingScopedPage<T, C> {
  exact(v, ['context', 'items', 'nextCursor', 'continuation']);
  const context = decodePageContext(v.context);
  if (
    !Array.isArray(v.items) ||
    v.items.length > 50 ||
    !(v.nextCursor === null || ratingCursor(v.nextCursor)) ||
    !['more', 'scan', 'end'].includes(String(v.continuation)) ||
    (v.nextCursor === null) !== (v.continuation === 'end')
  )
    invalidRating();
  const items = v.items.map(decode);
  if (new Set(items.map((item) => item.id)).size !== items.length)
    invalidRating();
  return Object.freeze({
    context,
    items: Object.freeze(items),
    nextCursor: v.nextCursor,
    continuation: v.continuation as 'more' | 'scan' | 'end',
  });
}
export function decodeRatingScopedCategoryPage(
  v: unknown,
): RatingScopedCategoryPage {
  const result = decodePage(v, decodeCategoryContext, decodeRatingCategory);
  if (result.items.some((item) => item.parentId !== result.context.parentId))
    invalidRating();
  return result;
}
export function decodeRatingScopedTargetPage(
  v: unknown,
): RatingScopedTargetPage {
  const result = decodePage(v, decodeTargetContext, decodeRatingTarget);
  if (
    result.items.some((item) => item.categoryId !== result.context.categoryId)
  )
    invalidRating();
  return result;
}
export function decodeRatingScopedCommentPage(
  v: unknown,
): RatingScopedCommentPage {
  const result = decodePage(v, decodeCommentContext, decodeRatingComment);
  if (result.items.some((item) => item.targetId !== result.context.targetId))
    invalidRating();
  return result;
}
export function decodeRatingScopedSubscriptionPage(
  v: unknown,
): RatingScopedSubscriptionPage {
  return decodePage(v, decodeContext, decodeRatingTarget);
}
export function decodeRatingScopedDiscussion(
  v: unknown,
): RatingScopedDiscussion {
  exact(v, ['context', 'root', 'allowedActions']);
  const context = decodeDiscussionContext(v.context);
  const root = decodeRatingComment(v.root);
  exact(v.allowedActions, ['createReply', 'authorModes']);
  const actions = v.allowedActions;
  if (
    root.id !== context.rootId ||
    root.targetId !== context.targetId ||
    typeof actions.createReply !== 'boolean' ||
    !Array.isArray(actions.authorModes) ||
    actions.authorModes.length < 1 ||
    actions.authorModes.length > 2 ||
    actions.authorModes[0] !== 'named' ||
    actions.authorModes.some(
      (mode: unknown) => mode !== 'named' && mode !== 'anonymous',
    ) ||
    new Set(actions.authorModes).size !== actions.authorModes.length
  )
    invalidRating();
  return Object.freeze({
    context,
    root,
    allowedActions: Object.freeze({
      createReply: actions.createReply,
      authorModes: Object.freeze([
        ...actions.authorModes,
      ] as RatingAuthorMode[]),
    }),
  });
}
export function decodeRatingScopedReplyPage(v: unknown): RatingScopedReplyPage {
  const result = decodePage(v, decodeReplyContext, decodeRatingReply);
  if (
    result.items.some(
      (item) =>
        item.targetId !== result.context.targetId ||
        item.rootId !== result.context.rootId,
    )
  )
    invalidRating();
  return result;
}
export function decodeRatingScopedReplyPosition(
  v: unknown,
): RatingScopedReplyPosition {
  exact(v, ['context', 'anchorReplyId', 'page']);
  const context = decodeReplyContext(v.context);
  const page = decodeRatingScopedReplyPage(v.page);
  if (
    !ratingId(v.anchorReplyId) ||
    page.items[0]?.id !== v.anchorReplyId ||
    JSON.stringify(context) !== JSON.stringify(page.context)
  )
    invalidRating();
  return Object.freeze({ context, anchorReplyId: v.anchorReplyId, page });
}
export function matchRatingScopedPage(
  context: RatingScopedContext,
  page: RatingScopedPageContext,
): void {
  if (
    context.purpose === 'random' ||
    context.heads.length !== 1 ||
    page.contextId !== context.id ||
    page.catalogRevision !== context.heads[0]!.catalogRevision ||
    page.protocolGeneration !== context.protocolGeneration ||
    ratingNavigationKey(page.selector) !== ratingNavigationKey(context.selector)
  )
    invalidRating();
}
export interface RatingScopedRandomResult {
  readonly context: {
    readonly contextId: string;
    readonly selector: RatingRandomCandidateSelector;
    readonly protocolGeneration: string;
    readonly categoryId: string;
    readonly minimumAverage: number | null;
  };
  readonly candidateCount: number;
  readonly item: {
    readonly locator: RatingScopedLocator;
    readonly target: RatingTarget;
    readonly summary: RatingSummary;
  } | null;
}
export function decodeRatingScopedRandomResult(
  v: unknown,
): RatingScopedRandomResult {
  exact(v, ['context', 'candidateCount', 'item']);
  exact(v.context, [
    'contextId',
    'selector',
    'protocolGeneration',
    'categoryId',
    'minimumAverage',
  ]);
  const raw = v.context;
  if (
    !ratingId(raw.contextId) ||
    !ratingId(raw.protocolGeneration) ||
    !ratingId(raw.categoryId) ||
    !(
      raw.minimumAverage === null || ratingMinimumAverage(raw.minimumAverage)
    ) ||
    typeof v.candidateCount !== 'number' ||
    !Number.isSafeInteger(v.candidateCount) ||
    v.candidateCount < 0 ||
    v.candidateCount > 10_000 ||
    (v.candidateCount === 0) !== (v.item === null)
  )
    invalidRating();
  const context = Object.freeze({
    contextId: raw.contextId,
    selector: decodeRatingRandomCandidateSelector(raw.selector),
    protocolGeneration: raw.protocolGeneration,
    categoryId: raw.categoryId,
    minimumAverage: raw.minimumAverage,
  });
  let item: RatingScopedRandomResult['item'] = null;
  if (v.item !== null) {
    exact(v.item, ['locator', 'target', 'summary']);
    const locator = decodeRatingScopedLocator(v.item.locator),
      target = decodeRatingTarget(v.item.target),
      summary = decodeRatingSummary(v.item.summary);
    if (
      locator.targetId !== target.id ||
      locator.rootId !== null ||
      locator.replyId !== null ||
      (context.selector.kind === 'global' &&
        locator.selector.kind !== 'global') ||
      (context.minimumAverage !== null &&
        (summary.status !== 'known' ||
          summary.count === 0 ||
          summary.sum * 10 <
            summary.count * Math.round(context.minimumAverage * 10))) ||
      target.allowedActions.setScore !== (summary.status === 'known')
    )
      invalidRating();
    item = Object.freeze({ locator, target, summary });
  }
  return Object.freeze({ context, candidateCount: v.candidateCount, item });
}
export type RatingScopedNoticeKind =
  'updates' | 'like-updates' | 'subscription-updates';
export interface RatingScopedNotice {
  readonly noticeId: string;
  readonly createdAt: string;
  readonly readAt: string | null;
  readonly status: 'unavailable';
}
export interface RatingScopedUpdatesPage {
  readonly items: readonly RatingScopedNotice[];
  readonly nextCursor: string | null;
  readonly unreadCount: number;
}
export type RatingScopedNoticeTarget =
  | { readonly noticeId: string; readonly status: 'unavailable' }
  | {
      readonly noticeId: string;
      readonly status: 'available';
      readonly target: RatingScopedLocator;
    };
export function decodeRatingScopedUpdatesPage(
  v: unknown,
): RatingScopedUpdatesPage {
  exact(v, ['items', 'nextCursor', 'unreadCount']);
  if (
    !Array.isArray(v.items) ||
    v.items.length > 20 ||
    !(v.nextCursor === null || ratingCursor(v.nextCursor)) ||
    typeof v.unreadCount !== 'number' ||
    !Number.isSafeInteger(v.unreadCount) ||
    v.unreadCount < 0 ||
    v.unreadCount > 2147483647
  )
    invalidRating();
  const items = v.items.map((raw: unknown): RatingScopedNotice => {
    exact(raw, ['noticeId', 'createdAt', 'readAt', 'status']);
    if (
      !ratingId(raw.noticeId) ||
      !ratingTimestamp(raw.createdAt) ||
      !(raw.readAt === null || ratingTimestamp(raw.readAt)) ||
      raw.status !== 'unavailable'
    )
      invalidRating();
    return Object.freeze({
      noticeId: raw.noticeId,
      createdAt: raw.createdAt,
      readAt: raw.readAt,
      status: 'unavailable',
    });
  });
  if (new Set(items.map((item) => item.noticeId)).size !== items.length)
    invalidRating();
  return Object.freeze({
    items: Object.freeze(items),
    nextCursor: v.nextCursor,
    unreadCount: v.unreadCount,
  });
}
export function decodeRatingScopedNoticeTarget(
  v: unknown,
): RatingScopedNoticeTarget {
  if (!isRecord(v)) invalidRating();
  exact(v, [
    'noticeId',
    'status',
    ...(v.status === 'available' ? ['target'] : []),
  ]);
  if (!ratingId(v.noticeId)) invalidRating();
  if (v.status === 'unavailable')
    return Object.freeze({ noticeId: v.noticeId, status: 'unavailable' });
  if (v.status !== 'available') invalidRating();
  return Object.freeze({
    noticeId: v.noticeId,
    status: 'available',
    target: decodeRatingScopedLocator(v.target),
  });
}
export interface RatingScopedEditContext {
  readonly context: RatingScopedPageContext;
  readonly targetId: string;
  readonly revision: string;
  readonly definitionRevision: string;
  readonly contentVersion: number;
  readonly categoryId: string;
  readonly categoryRevision: string;
  readonly name: string;
  readonly description: string;
}
export function decodeRatingScopedEditContext(
  v: unknown,
): RatingScopedEditContext {
  exact(v, [
    'context',
    'targetId',
    'revision',
    'definitionRevision',
    'contentVersion',
    'categoryId',
    'categoryRevision',
    'name',
    'description',
  ]);
  if (
    !ratingId(v.targetId) ||
    !ratingId(v.revision) ||
    !ratingId(v.definitionRevision) ||
    !ratingId(v.categoryId) ||
    !ratingId(v.categoryRevision) ||
    typeof v.contentVersion !== 'number' ||
    !Number.isSafeInteger(v.contentVersion) ||
    v.contentVersion < 1 ||
    v.contentVersion > 2147483646 ||
    typeof v.name !== 'string' ||
    typeof v.description !== 'string'
  )
    invalidRating();
  // Reuse the strict domain text validators without inventing a legacy scope.
  const target = decodeRatingTarget({
    id: v.targetId,
    categoryId: v.categoryId,
    revision: v.revision,
    name: v.name,
    description: v.description,
    allowedActions: {
      setScore: false,
      createComment: false,
      authorModes: ['named'],
    },
  });
  return Object.freeze({
    context: decodeContext(v.context, []),
    targetId: v.targetId,
    revision: v.revision,
    definitionRevision: v.definitionRevision,
    contentVersion: v.contentVersion,
    categoryId: v.categoryId,
    categoryRevision: v.categoryRevision,
    name: target.name,
    description: target.description,
  });
}
