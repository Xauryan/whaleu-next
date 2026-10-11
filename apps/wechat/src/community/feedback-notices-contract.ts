import { isRecord } from '../api/errors';
import { isUuid } from '../profile/contract';
import { cursor, exact, invalid, timestamp } from './contract';

/** Owner-only local metadata. The locator is resolved separately with fresh access. */
export interface FeedbackNotice {
  readonly noticeId: string;
  readonly kind: 'feedback_created';
  readonly createdAt: string;
  readonly readAt: string | null;
}
export interface FeedbackNoticesList {
  readonly items: readonly FeedbackNotice[];
  readonly nextCursor: string | null;
  readonly unreadCount: number;
}
export interface FeedbackNoticesUnread {
  readonly unreadCount: number;
}
export interface FeedbackNoticeRead extends FeedbackNoticesUnread {
  readonly noticeId: string;
  readonly readAt: string;
}
const count = (value: unknown, max = 2147483647): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= max;
const utcMilliseconds = (value: unknown): value is string =>
  timestamp(value) && new Date(value).toISOString() === value;

export function decodeFeedbackNotice(value: unknown): FeedbackNotice {
  exact(value, ['noticeId', 'kind', 'createdAt', 'readAt']);
  if (
    !isUuid(value.noticeId) ||
    value.kind !== 'feedback_created' ||
    !utcMilliseconds(value.createdAt) ||
    !(value.readAt === null || utcMilliseconds(value.readAt))
  )
    invalid();
  return Object.freeze({
    noticeId: value.noticeId,
    kind: 'feedback_created',
    createdAt: value.createdAt,
    readAt: value.readAt,
  });
}
export function decodeFeedbackNoticesList(value: unknown): FeedbackNoticesList {
  exact(value, ['items', 'nextCursor', 'unreadCount']);
  if (
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    !cursor(value.nextCursor) ||
    !count(value.unreadCount)
  )
    invalid();
  const items = value.items.map(decodeFeedbackNotice);
  if (
    new Set(items.map((item) => item.noticeId.toLowerCase())).size !==
      items.length ||
    (!items.length && value.nextCursor !== null) ||
    items.filter((item) => item.readAt === null).length > value.unreadCount
  )
    invalid();
  return Object.freeze({
    items: Object.freeze(items),
    nextCursor: value.nextCursor,
    unreadCount: value.unreadCount,
  });
}
export function decodeFeedbackNoticesUnread(
  value: unknown,
): FeedbackNoticesUnread {
  exact(value, ['unreadCount']);
  if (!count(value.unreadCount)) invalid();
  return Object.freeze({ unreadCount: value.unreadCount });
}
export function decodeFeedbackNoticeRead(value: unknown): FeedbackNoticeRead {
  exact(value, ['noticeId', 'readAt', 'unreadCount']);
  if (
    !isUuid(value.noticeId) ||
    !utcMilliseconds(value.readAt) ||
    !count(value.unreadCount)
  )
    invalid();
  return Object.freeze({
    noticeId: value.noticeId,
    readAt: value.readAt,
    unreadCount: value.unreadCount,
  });
}

export type FeedbackNoticeTarget =
  | { readonly noticeId: string; readonly status: 'unavailable' }
  | {
      readonly noticeId: string;
      readonly status: 'available';
      readonly postId: string;
    };
export function decodeFeedbackNoticeTarget(
  value: unknown,
): FeedbackNoticeTarget {
  if (!isRecord(value)) invalid();
  exact(value, [
    'noticeId',
    'status',
    ...(value.status === 'available' ? ['postId'] : []),
  ]);
  if (!isUuid(value.noticeId)) invalid();
  if (value.status === 'unavailable')
    return Object.freeze({ noticeId: value.noticeId, status: 'unavailable' });
  if (value.status !== 'available' || !isUuid(value.postId)) invalid();
  return Object.freeze({
    noticeId: value.noticeId,
    status: 'available',
    postId: value.postId,
  });
}
