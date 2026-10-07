import { isUuid } from '../profile/contract';
import { cursor, exact, invalid, timestamp } from './contract';

/** Owner-only outcome metadata, deliberately without a source, author or preview. */
export interface SystemNotice {
  readonly noticeId: string;
  readonly kind: 'post_jury_removed';
  readonly createdAt: string;
  readonly readAt: string | null;
  readonly keepVotes: number;
  readonly removeVotes: number;
}
export interface SystemNoticesList {
  readonly items: readonly SystemNotice[];
  readonly nextCursor: string | null;
  readonly unreadCount: number;
}
export interface SystemNoticesUnread {
  readonly unreadCount: number;
}
export interface SystemNoticeRead extends SystemNoticesUnread {
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

export function decodeSystemNotice(value: unknown): SystemNotice {
  exact(value, [
    'noticeId',
    'kind',
    'createdAt',
    'readAt',
    'keepVotes',
    'removeVotes',
  ]);
  if (
    !isUuid(value.noticeId) ||
    value.kind !== 'post_jury_removed' ||
    !utcMilliseconds(value.createdAt) ||
    !(value.readAt === null || utcMilliseconds(value.readAt)) ||
    !count(value.keepVotes, 5) ||
    !count(value.removeVotes, 6) ||
    value.keepVotes + value.removeVotes > 11 ||
    value.removeVotes <= value.keepVotes
  )
    invalid();
  return Object.freeze({
    noticeId: value.noticeId,
    kind: 'post_jury_removed',
    createdAt: value.createdAt,
    readAt: value.readAt,
    keepVotes: value.keepVotes,
    removeVotes: value.removeVotes,
  });
}
export function decodeSystemNoticesList(value: unknown): SystemNoticesList {
  exact(value, ['items', 'nextCursor', 'unreadCount']);
  if (
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    !cursor(value.nextCursor) ||
    !count(value.unreadCount)
  )
    invalid();
  const items = value.items.map(decodeSystemNotice);
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
export function decodeSystemNoticesUnread(value: unknown): SystemNoticesUnread {
  exact(value, ['unreadCount']);
  if (!count(value.unreadCount)) invalid();
  return Object.freeze({ unreadCount: value.unreadCount });
}
export function decodeSystemNoticeRead(value: unknown): SystemNoticeRead {
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
