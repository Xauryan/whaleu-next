import { isRecord } from '../api/errors';
import { isUuid } from '../profile/contract';
import { decodePost, exact, invalid, type Post } from './contract';

export const hotRanges = [
  { key: 'day', label: '最近24小时' },
  { key: 'week', label: '最近7天' },
  { key: 'month', label: '最近30天' },
  { key: 'half_year', label: '最近180天' },
  { key: 'year', label: '最近365天' },
  { key: 'history', label: '全部时间' },
] as const;
export type HotRange = (typeof hotRanges)[number]['key'];
export const isHotRange = (value: unknown): value is HotRange =>
  hotRanges.some((range) => range.key === value);
export interface HotIntent {
  readonly spaceId: string;
  readonly range: HotRange;
}
export type HotContinuation =
  | 'more'
  | 'scan_pending'
  | 'end'
  | 'login_required'
  | 'phone_verification_required';
export interface HotPage {
  readonly items: readonly Post[];
  readonly nextCursor: string | null;
  readonly continuation: HotContinuation;
}
/** Random 32-byte server reference, never a readable score or ranking coordinate. */
export const hotCursor = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);

/** Public navigation contains an explicit space and optional range, never feed filters. */
export function decodeHotIntent(value: unknown): HotIntent {
  if (!isRecord(value)) invalid();
  const hasRange = Object.prototype.hasOwnProperty.call(value, 'range');
  exact(value, ['spaceId', ...(hasRange ? ['range'] : [])]);
  if (!isUuid(value.spaceId) || (hasRange && !isHotRange(value.range)))
    invalid();
  return Object.freeze({
    spaceId: value.spaceId,
    range: hasRange ? (value.range as HotRange) : 'day',
  });
}
export function decodeHotPage(value: unknown): HotPage {
  exact(value, ['items', 'nextCursor', 'continuation']);
  if (!Array.isArray(value.items) || value.items.length > 10) invalid();
  const continuation = value.continuation;
  if (continuation === 'more' || continuation === 'scan_pending') {
    if (
      !hotCursor(value.nextCursor) ||
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
  // Live score movement may repeat a post across pages; only one response is unique.
  if (new Set(items.map((item) => item.id)).size !== items.length) invalid();
  return Object.freeze({
    items: Object.freeze(items),
    nextCursor: value.nextCursor as string | null,
    continuation: continuation as HotContinuation,
  });
}
