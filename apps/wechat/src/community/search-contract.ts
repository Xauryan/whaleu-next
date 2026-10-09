import { isRecord } from '../api/errors';
import { isUuid } from '../profile/contract';
import {
  boundedText,
  decodeAuthor,
  displayDiscussionText,
  exact,
  invalid,
  isCategory,
  type Category,
  type Author,
} from './contract';
import { isTradingSubtype, type TradingSubtype } from './trading-contract';

export type SearchMode = 'keyword' | 'semantic';
export type SearchScope = 'all' | 'regional' | 'global';
export const isSearchScope = (value: unknown): value is SearchScope =>
  value === 'all' || value === 'regional' || value === 'global';
export type SearchSelector =
  | {
      readonly spaceId: string;
      readonly scope?: never;
      readonly category?: Category;
      readonly tradingSubtype?: TradingSubtype;
    }
  | {
      readonly scope: 'regional';
      readonly spaceId?: never;
      readonly category?: Category;
      readonly tradingSubtype?: TradingSubtype;
    }
  | {
      readonly scope: 'all' | 'global';
      readonly spaceId?: never;
      readonly category?: never;
      readonly tradingSubtype?: never;
    };
export type SearchKind = 'post' | 'comment' | 'reply';
export type SearchType = 'all' | SearchKind;
export const isSearchKind = (value: unknown): value is SearchKind =>
  value === 'post' || value === 'comment' || value === 'reply';
export const isSearchType = (value: unknown): value is SearchType =>
  value === 'all' || isSearchKind(value);
export interface SearchFilters {
  readonly type?: SearchType;
  readonly from?: string;
  readonly to?: string;
  readonly postId?: string;
}
export type SearchIntent = SearchSelector &
  SearchFilters & { readonly q: string };
export type SearchTarget =
  | { readonly kind: 'post'; readonly postId: string }
  | {
      readonly kind: 'comment';
      readonly postId: string;
      readonly rootCommentId: string;
    }
  | {
      readonly kind: 'reply';
      readonly postId: string;
      readonly rootCommentId: string;
      readonly replyId: string;
    };
export interface SearchHit {
  readonly kind: SearchKind;
  readonly contentId: string;
  readonly postId: string;
  readonly rootCommentId: string | null;
  readonly replyId: string | null;
  readonly space: {
    readonly id: string;
    readonly kind: 'regional' | 'global';
    readonly name: string;
  };
  readonly category: Category;
  readonly tradingSubtype: TradingSubtype | null;
  readonly tradingUrgency: 'normal' | 'urgent' | null;
  readonly createdAt: string;
  readonly author: Author;
  readonly postSummary: string;
  readonly snippet: {
    readonly segments: readonly {
      readonly text: string;
      readonly matched: boolean;
    }[];
    readonly truncatedBefore: boolean;
    readonly truncatedAfter: boolean;
  };
  readonly target: SearchTarget;
}
/** UTC only; preserve exact microseconds for filter boundaries, never JS millisecond rounding. */
export function canonicalSearchTimestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.startsWith('0000-') ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value.slice(0, 19) + '.000Z')) ||
    new Date(value.slice(0, 19) + '.000Z').toISOString().slice(0, 19) !==
      value.slice(0, 19)
  )
    invalid();
  const fraction = value.slice(19, -1).replace('.', '');
  return `${value.slice(0, 19)}.${fraction.padEnd(6, '0')}Z`;
}
export function searchTargetPath(target: SearchTarget): string {
  return target.kind === 'post'
    ? `/pages/community-detail/community-detail?postId=${target.postId}`
    : `/pages/community-thread/community-thread?postId=${target.postId}&rootCommentId=${target.rootCommentId}${target.kind === 'reply' ? `&replyId=${target.replyId}` : ''}`;
}
export type SearchContinuation =
  | 'more'
  | 'scan_pending'
  | 'end'
  | 'login_required'
  | 'phone_verification_required';
export interface SearchPage {
  readonly items: readonly SearchHit[];
  readonly effectiveTypes: readonly SearchKind[];
  readonly nextCursor: string | null;
  readonly continuation: SearchContinuation;
}
/** 32 bytes, unpadded base64url. The last character has two zero padding bits. */
export const searchCursor = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);

/** Validation/canonicalization only. Matching and Unicode lowercase belong to the server. */
export function canonicalSearchQuery(raw: unknown): string {
  if (typeof raw !== 'string') invalid();
  const text = raw.replace(/\r\n/g, '\n');
  // Validate before trim, including otherwise trimmable prohibited controls.
  if (!boundedText(text, 0, Number.MAX_SAFE_INTEGER)) invalid();
  const q = text.trim();
  if (!boundedText(q, 1, 200)) invalid();
  return q;
}
export function decodeSearchIntent(value: unknown): SearchIntent {
  if (!isRecord(value)) invalid();
  exact(value, [
    ...(Object.prototype.hasOwnProperty.call(value, 'scope')
      ? ['scope']
      : ['spaceId']),
    'q',
    ...['type', 'from', 'to', 'postId'].filter((key) =>
      Object.prototype.hasOwnProperty.call(value, key),
    ),
    ...(Object.prototype.hasOwnProperty.call(value, 'category')
      ? ['category']
      : []),
    ...(Object.prototype.hasOwnProperty.call(value, 'tradingSubtype')
      ? ['tradingSubtype']
      : []),
  ]);
  if (
    (Object.prototype.hasOwnProperty.call(value, 'scope')
      ? !isSearchScope(value.scope)
      : !isUuid(value.spaceId)) ||
    ((value.scope === 'all' || value.scope === 'global') &&
      (Object.prototype.hasOwnProperty.call(value, 'category') ||
        Object.prototype.hasOwnProperty.call(value, 'tradingSubtype'))) ||
    (value.category !== undefined && !isCategory(value.category)) ||
    (Object.prototype.hasOwnProperty.call(value, 'category') &&
      value.category === undefined) ||
    (Object.prototype.hasOwnProperty.call(value, 'tradingSubtype') &&
      (value.category !== 'trading' || !isTradingSubtype(value.tradingSubtype)))
  )
    invalid();
  const q = canonicalSearchQuery(value.q);
  if (
    (Object.prototype.hasOwnProperty.call(value, 'type') &&
      !isSearchType(value.type)) ||
    (Object.prototype.hasOwnProperty.call(value, 'postId') &&
      !isUuid(value.postId))
  )
    invalid();
  const from = Object.prototype.hasOwnProperty.call(value, 'from')
    ? canonicalSearchTimestamp(value.from)
    : undefined;
  const to = Object.prototype.hasOwnProperty.call(value, 'to')
    ? canonicalSearchTimestamp(value.to)
    : undefined;
  if (from && to && from >= to) invalid();
  return Object.freeze({
    ...(value.scope !== undefined
      ? { scope: value.scope as SearchScope }
      : { spaceId: value.spaceId as string }),
    q,
    ...(value.type !== undefined ? { type: value.type as SearchType } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(value.postId !== undefined ? { postId: value.postId as string } : {}),
    ...(value.category !== undefined
      ? { category: value.category as Category }
      : {}),
    ...(value.tradingSubtype !== undefined
      ? { tradingSubtype: value.tradingSubtype as TradingSubtype }
      : {}),
  }) as SearchIntent;
}
export function decodeSearchHit(value: unknown): SearchHit {
  return decodeHit(value, true);
}
function decodeHit(value: unknown, requireMatch: boolean): SearchHit {
  exact(value, [
    'kind',
    'contentId',
    'postId',
    'rootCommentId',
    'replyId',
    'space',
    'category',
    'tradingSubtype',
    'tradingUrgency',
    'createdAt',
    'author',
    'postSummary',
    'snippet',
    'target',
  ]);
  exact(value.space, ['id', 'kind', 'name']);
  exact(value.snippet, ['segments', 'truncatedBefore', 'truncatedAfter']);
  if (
    !isSearchKind(value.kind) ||
    !isUuid(value.contentId) ||
    !isUuid(value.postId) ||
    !isUuid(value.space.id) ||
    !['regional', 'global'].includes(String(value.space.kind)) ||
    !boundedText(value.space.name, 1, 200) ||
    !isCategory(value.category) ||
    (value.space.kind === 'global' && value.category !== 'discussion') ||
    !(
      value.tradingSubtype === null || isTradingSubtype(value.tradingSubtype)
    ) ||
    !(
      value.tradingUrgency === null ||
      value.tradingUrgency === 'normal' ||
      value.tradingUrgency === 'urgent'
    ) ||
    (value.category === 'trading'
      ? value.tradingUrgency === null
      : value.tradingUrgency !== null || value.tradingSubtype !== null) ||
    canonicalSearchTimestamp(value.createdAt) !== value.createdAt ||
    !displayDiscussionText(value.postSummary) ||
    [...value.postSummary].length > 80 ||
    !Array.isArray(value.snippet.segments) ||
    value.snippet.segments.length < 1 ||
    value.snippet.segments.length > 240 ||
    typeof value.snippet.truncatedBefore !== 'boolean' ||
    typeof value.snippet.truncatedAfter !== 'boolean'
  )
    invalid();
  exact(
    value.target,
    value.kind === 'post'
      ? ['kind', 'postId']
      : value.kind === 'comment'
        ? ['kind', 'postId', 'rootCommentId']
        : ['kind', 'postId', 'rootCommentId', 'replyId'],
  );
  if (
    value.target.kind !== value.kind ||
    value.target.postId !== value.postId ||
    (value.kind === 'post'
      ? value.contentId !== value.postId ||
        value.rootCommentId !== null ||
        value.replyId !== null
      : !isUuid(value.rootCommentId) ||
        value.target.rootCommentId !== value.rootCommentId ||
        (value.kind === 'comment'
          ? value.contentId !== value.rootCommentId || value.replyId !== null
          : !isUuid(value.replyId) ||
            value.contentId !== value.replyId ||
            value.target.replyId !== value.replyId))
  )
    invalid();
  const author = decodeAuthor(value.author);
  if (author.avatar !== null) invalid();
  const segments = value.snippet.segments.map((segment: unknown) => {
    exact(segment, ['text', 'matched']);
    if (
      !displayDiscussionText(segment.text) ||
      [...segment.text].length < 1 ||
      [...segment.text].length > 240 ||
      typeof segment.matched !== 'boolean'
    )
      invalid();
    return Object.freeze({ text: segment.text, matched: segment.matched });
  });
  if (
    (requireMatch && !segments.some((segment) => segment.matched)) ||
    segments.reduce((sum, segment) => sum + [...segment.text].length, 0) > 240
  )
    invalid();
  return Object.freeze({
    ...value,
    author,
    space: Object.freeze({ ...value.space }),
    snippet: Object.freeze({
      ...value.snippet,
      segments: Object.freeze(segments),
    }),
    target: Object.freeze({ ...value.target }),
  }) as unknown as SearchHit;
}
export function decodeSearchPage(value: unknown): SearchPage {
  exact(value, ['items', 'nextCursor', 'continuation', 'effectiveTypes']);
  if (
    !Array.isArray(value.effectiveTypes) ||
    !value.effectiveTypes.length ||
    value.effectiveTypes.some((kind) => !isSearchKind(kind)) ||
    new Set(value.effectiveTypes).size !== value.effectiveTypes.length
  )
    invalid();
  if (!Array.isArray(value.items) || value.items.length > 10) invalid();
  const continuation = value.continuation;
  if (continuation === 'more' || continuation === 'scan_pending') {
    if (
      !searchCursor(value.nextCursor) ||
      (continuation === 'more' && !value.items.length)
    )
      invalid();
  } else if (
    !['end', 'login_required', 'phone_verification_required'].includes(
      continuation as string,
    ) ||
    value.nextCursor !== null
  )
    invalid();
  const items = value.items.map(decodeSearchHit);
  if (
    new Set(items.map((item) => `${item.kind}:${item.contentId}`)).size !==
    items.length
  )
    invalid();
  const effectiveTypes = value.effectiveTypes as SearchKind[];
  if (items.some((item) => !effectiveTypes.includes(item.kind))) invalid();
  return Object.freeze({
    effectiveTypes: Object.freeze([
      ...value.effectiveTypes,
    ]) as readonly SearchKind[],
    items: Object.freeze(items),
    nextCursor: value.nextCursor as string | null,
    continuation: continuation as SearchContinuation,
  });
}

/** Semantic relevance is not evidence of a literal match or an exhaustive result set. */
export interface SemanticSearchPage {
  readonly mode: 'semantic';
  readonly indexStatus: 'current';
  readonly ranking: 'embedding-top32-reranked';
  readonly items: readonly SearchHit[];
}
export function decodeSemanticSearchPage(value: unknown): SemanticSearchPage {
  exact(value, ['mode', 'indexStatus', 'ranking', 'items']);
  if (
    value.mode !== 'semantic' ||
    value.indexStatus !== 'current' ||
    value.ranking !== 'embedding-top32-reranked' ||
    !Array.isArray(value.items) ||
    value.items.length > 10
  )
    invalid();
  const items = value.items.map((item: unknown) => decodeHit(item, false));
  if (
    new Set(items.map((item) => `${item.kind}:${item.contentId}`)).size !==
    items.length
  )
    invalid();
  return Object.freeze({
    mode: 'semantic',
    indexStatus: 'current',
    ranking: 'embedding-top32-reranked',
    items: Object.freeze(items),
  });
}
