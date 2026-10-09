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
export interface RatingSubscriptionNoticeLocator {
  readonly regionId: string | null;
  readonly targetId: string;
  readonly rootId: string;
  readonly replyId: string | null;
}
interface Base {
  readonly noticeId: string;
  readonly createdAt: string;
  readonly readAt: string | null;
}
export type RatingSubscriptionNotice =
  | (Base & { readonly status: 'unavailable' })
  | (Base & {
      readonly status: 'available';
      readonly domain: 'ratings';
      readonly kind: 'subscription';
      readonly reason: 'target_subscription';
      readonly activity: 'root' | 'reply';
      readonly target: RatingSubscriptionNoticeLocator;
      readonly preview: {
        readonly text: string;
        readonly author: RatingAuthor;
      };
    });
export interface RatingSubscriptionUpdatesPage {
  readonly items: readonly RatingSubscriptionNotice[];
  readonly nextCursor: string | null;
  readonly unreadCount: number;
}
export type RatingSubscriptionNoticeTarget =
  | { readonly noticeId: string; readonly status: 'unavailable' }
  | {
      readonly noticeId: string;
      readonly status: 'available';
      readonly target: RatingSubscriptionNoticeLocator;
    };
export interface RatingSubscriptionNoticeRead {
  readonly noticeId: string;
  readonly readAt: string;
  readonly unreadCount: number;
}
export function decodeRatingSubscriptionNoticeLocator(
  value: unknown,
): RatingSubscriptionNoticeLocator {
  exact(value, ['regionId', 'targetId', 'rootId', 'replyId']);
  if (
    !ratingNullableId(value.regionId) ||
    !ratingId(value.targetId) ||
    !ratingId(value.rootId) ||
    !ratingNullableId(value.replyId)
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
export function decodeRatingSubscriptionUnread(value: unknown): {
  readonly unreadCount: number;
} {
  exact(value, ['unreadCount']);
  if (!count(value.unreadCount)) invalidRating();
  return Object.freeze({ unreadCount: value.unreadCount });
}
export function decodeRatingSubscriptionNotice(
  value: unknown,
): RatingSubscriptionNotice {
  if (!isRecord(value)) invalidRating();
  exact(value, [
    'noticeId',
    'createdAt',
    'readAt',
    'status',
    ...(value.status === 'available'
      ? ['domain', 'kind', 'reason', 'activity', 'target', 'preview']
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
    value.kind !== 'subscription' ||
    value.reason !== 'target_subscription' ||
    !['root', 'reply'].includes(String(value.activity))
  )
    invalidRating();
  const target = decodeRatingSubscriptionNoticeLocator(value.target);
  if ((value.activity === 'root') !== (target.replyId === null))
    invalidRating();
  exact(value.preview, ['text', 'author']);
  return Object.freeze({
    ...base,
    status: 'available',
    domain: 'ratings',
    kind: 'subscription',
    reason: 'target_subscription',
    activity: value.activity as 'root' | 'reply',
    target,
    preview: Object.freeze({
      text: ratingOutputText(value.preview.text),
      author: decodeRatingAuthor(value.preview.author, target.targetId),
    }),
  });
}
export function decodeRatingSubscriptionUpdatesPage(
  value: unknown,
): RatingSubscriptionUpdatesPage {
  exact(value, ['items', 'nextCursor', 'unreadCount']);
  if (
    !Array.isArray(value.items) ||
    value.items.length > 20 ||
    !(value.nextCursor === null || ratingCursor(value.nextCursor)) ||
    !count(value.unreadCount)
  )
    invalidRating();
  const items = value.items.map(decodeRatingSubscriptionNotice);
  if (new Set(items.map((item) => item.noticeId)).size !== items.length)
    invalidRating();
  return Object.freeze({
    items: Object.freeze(items),
    nextCursor: value.nextCursor,
    unreadCount: value.unreadCount,
  });
}
export function decodeRatingSubscriptionNoticeTarget(
  value: unknown,
): RatingSubscriptionNoticeTarget {
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
    target: decodeRatingSubscriptionNoticeLocator(value.target),
  });
}
export function decodeRatingSubscriptionNoticeRead(
  value: unknown,
): RatingSubscriptionNoticeRead {
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
