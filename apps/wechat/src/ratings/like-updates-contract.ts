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
export interface RatingLikeNoticeLocator {
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
export type RatingLikeNotice =
  | (Base & { readonly status: 'unavailable' })
  | (Base & {
      readonly status: 'available';
      readonly domain: 'ratings';
      readonly kind: 'like';
      readonly reason: 'like';
      readonly actor: Extract<RatingAuthor, { mode: 'named' }>;
      readonly target: RatingLikeNoticeLocator;
      readonly preview: {
        readonly text: string;
      };
    });
export interface RatingLikeUpdatesPage {
  readonly items: readonly RatingLikeNotice[];
  readonly nextCursor: string | null;
  readonly unreadCount: number;
}
export type RatingLikeNoticeTarget =
  | { readonly noticeId: string; readonly status: 'unavailable' }
  | {
      readonly noticeId: string;
      readonly status: 'available';
      readonly target: RatingLikeNoticeLocator;
    };
export interface RatingLikeNoticeRead {
  readonly noticeId: string;
  readonly readAt: string;
  readonly unreadCount: number;
}
export function decodeRatingLikeNoticeLocator(
  value: unknown,
): RatingLikeNoticeLocator {
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
export function decodeRatingLikeUnread(value: unknown): {
  readonly unreadCount: number;
} {
  exact(value, ['unreadCount']);
  if (!count(value.unreadCount)) invalidRating();
  return Object.freeze({ unreadCount: value.unreadCount });
}
export function decodeRatingLikeNotice(value: unknown): RatingLikeNotice {
  if (!isRecord(value)) invalidRating();
  exact(value, [
    'noticeId',
    'createdAt',
    'readAt',
    'status',
    ...(value.status === 'available'
      ? ['domain', 'kind', 'reason', 'actor', 'target', 'preview']
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
    value.kind !== 'like' ||
    value.reason !== 'like'
  )
    invalidRating();
  const target = decodeRatingLikeNoticeLocator(value.target);
  exact(value.preview, ['text']);
  const actor = decodeRatingAuthor(value.actor, target.targetId);
  if (actor.mode !== 'named') invalidRating();
  return Object.freeze({
    ...base,
    status: 'available',
    domain: 'ratings',
    kind: 'like',
    reason: 'like',
    actor,
    target,
    preview: Object.freeze({
      text: ratingOutputText(value.preview.text),
    }),
  });
}
export function decodeRatingLikeUpdatesPage(
  value: unknown,
): RatingLikeUpdatesPage {
  exact(value, ['items', 'nextCursor', 'unreadCount']);
  if (
    !Array.isArray(value.items) ||
    value.items.length > 20 ||
    !(value.nextCursor === null || ratingCursor(value.nextCursor)) ||
    !count(value.unreadCount)
  )
    invalidRating();
  const items = value.items.map(decodeRatingLikeNotice);
  if (new Set(items.map((item) => item.noticeId)).size !== items.length)
    invalidRating();
  return Object.freeze({
    items: Object.freeze(items),
    nextCursor: value.nextCursor,
    unreadCount: value.unreadCount,
  });
}
export function decodeRatingLikeNoticeTarget(
  value: unknown,
): RatingLikeNoticeTarget {
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
    target: decodeRatingLikeNoticeLocator(value.target),
  });
}
export function decodeRatingLikeNoticeRead(
  value: unknown,
): RatingLikeNoticeRead {
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
