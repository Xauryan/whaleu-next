import { isRecord } from '../api/errors';
import { exact } from '../community/contract';
import {
  decodeRatingAuthor,
  invalidRating,
  ratingCursor,
  ratingId,
  type RatingAuthor,
} from './contract';
import {
  ratingNullableId,
  ratingOutputText,
  ratingTimestamp,
} from './discussion-contract';
export interface RatingNoticeLocator {
  readonly regionId: string | null;
  readonly targetId: string;
  readonly rootId: string;
  readonly replyId: string;
}
interface Base {
  readonly noticeId: string;
  readonly createdAt: string;
  readonly readAt: string | null;
}
export type RatingNotice =
  | (Base & { readonly status: 'unavailable' })
  | (Base & {
      readonly status: 'available';
      readonly domain: 'ratings';
      readonly kind: 'reply';
      readonly reason: 'direct_root' | 'direct_reply';
      readonly target: RatingNoticeLocator;
      readonly preview: {
        readonly text: string;
        readonly author: RatingAuthor;
      };
    });
export interface RatingUpdatesPage {
  readonly items: readonly RatingNotice[];
  readonly nextCursor: string | null;
  readonly unreadCount: number;
}
export type RatingNoticeTarget =
  | { readonly noticeId: string; readonly status: 'unavailable' }
  | {
      readonly noticeId: string;
      readonly status: 'available';
      readonly target: RatingNoticeLocator;
    };
export interface RatingNoticeRead {
  readonly noticeId: string;
  readonly readAt: string;
  readonly unreadCount: number;
}
export function decodeRatingNoticeLocator(value: unknown): RatingNoticeLocator {
  exact(value, ['regionId', 'targetId', 'rootId', 'replyId']);
  if (
    !ratingNullableId(value.regionId) ||
    !ratingId(value.targetId) ||
    !ratingId(value.rootId) ||
    !ratingId(value.replyId)
  )
    invalidRating();
  return Object.freeze({
    regionId: value.regionId,
    targetId: value.targetId,
    rootId: value.rootId,
    replyId: value.replyId,
  });
}
const count = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 2147483647;
export function decodeRatingUnread(value: unknown): {
  readonly unreadCount: number;
} {
  exact(value, ['unreadCount']);
  if (!count(value.unreadCount)) invalidRating();
  return Object.freeze({ unreadCount: value.unreadCount });
}
export function decodeRatingNotice(value: unknown): RatingNotice {
  if (!isRecord(value)) invalidRating();
  exact(value, [
    'noticeId',
    'createdAt',
    'readAt',
    'status',
    ...(value.status === 'available'
      ? ['domain', 'kind', 'reason', 'target', 'preview']
      : []),
  ]);
  if (
    !ratingId(value.noticeId) ||
    !ratingTimestamp(value.createdAt) ||
    !(value.readAt === null || ratingTimestamp(value.readAt))
  )
    invalidRating();
  const base = {
    noticeId: value.noticeId,
    createdAt: value.createdAt,
    readAt: value.readAt,
  };
  if (value.status === 'unavailable')
    return Object.freeze({ ...base, status: 'unavailable' });
  if (
    value.status !== 'available' ||
    value.domain !== 'ratings' ||
    value.kind !== 'reply' ||
    !['direct_root', 'direct_reply'].includes(String(value.reason))
  )
    invalidRating();
  const target = decodeRatingNoticeLocator(value.target);
  exact(value.preview, ['text', 'author']);
  return Object.freeze({
    ...base,
    status: 'available',
    domain: 'ratings',
    kind: 'reply',
    reason: value.reason as 'direct_root' | 'direct_reply',
    target,
    preview: Object.freeze({
      text: ratingOutputText(value.preview.text),
      author: decodeRatingAuthor(value.preview.author, target.targetId),
    }),
  });
}
export function decodeRatingUpdatesPage(value: unknown): RatingUpdatesPage {
  exact(value, ['items', 'nextCursor', 'unreadCount']);
  if (
    !Array.isArray(value.items) ||
    value.items.length > 20 ||
    !(value.nextCursor === null || ratingCursor(value.nextCursor)) ||
    !count(value.unreadCount)
  )
    invalidRating();
  const items = value.items.map(decodeRatingNotice);
  if (new Set(items.map((item) => item.noticeId)).size !== items.length)
    invalidRating();
  return Object.freeze({
    items: Object.freeze(items),
    nextCursor: value.nextCursor,
    unreadCount: value.unreadCount,
  });
}
export function decodeRatingNoticeTarget(value: unknown): RatingNoticeTarget {
  if (!isRecord(value)) invalidRating();
  exact(value, [
    'noticeId',
    'status',
    ...(value.status === 'available' ? ['target'] : []),
  ]);
  if (!ratingId(value.noticeId)) invalidRating();
  if (value.status === 'unavailable')
    return Object.freeze({ noticeId: value.noticeId, status: 'unavailable' });
  if (value.status !== 'available') invalidRating();
  return Object.freeze({
    noticeId: value.noticeId,
    status: 'available',
    target: decodeRatingNoticeLocator(value.target),
  });
}
export function decodeRatingNoticeRead(value: unknown): RatingNoticeRead {
  exact(value, ['noticeId', 'readAt', 'unreadCount']);
  if (
    !ratingId(value.noticeId) ||
    !ratingTimestamp(value.readAt) ||
    !count(value.unreadCount)
  )
    invalidRating();
  return Object.freeze({
    noticeId: value.noticeId,
    readAt: value.readAt,
    unreadCount: value.unreadCount,
  });
}
