import { isRecord } from '../api/errors';
import { isUuid } from '../profile/contract';
import {
  boundedText,
  decodePost,
  exact,
  invalid,
  isCategory,
  type Category,
  type Post,
} from './contract';
import { isTradingSubtype, type TradingSubtype } from './trading-contract';

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
export type SearchIntent = SearchSelector & { readonly q: string };
export type SearchContinuation =
  | 'more'
  | 'scan_pending'
  | 'end'
  | 'login_required'
  | 'phone_verification_required';
export interface SearchPage {
  readonly items: readonly Post[];
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
  return Object.freeze({
    ...(value.scope !== undefined
      ? { scope: value.scope as SearchScope }
      : { spaceId: value.spaceId as string }),
    q,
    ...(value.category !== undefined
      ? { category: value.category as Category }
      : {}),
    ...(value.tradingSubtype !== undefined
      ? { tradingSubtype: value.tradingSubtype as TradingSubtype }
      : {}),
  }) as SearchIntent;
}
export function decodeSearchPage(value: unknown): SearchPage {
  exact(value, ['items', 'nextCursor', 'continuation']);
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
  const items = value.items.map(decodePost);
  if (new Set(items.map((item) => item.id)).size !== items.length) invalid();
  return Object.freeze({
    items: Object.freeze(items),
    nextCursor: value.nextCursor as string | null,
    continuation: continuation as SearchContinuation,
  });
}
