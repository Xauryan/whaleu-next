import { isRecord } from '../api/errors';
import { isUuid } from '../profile/contract';
import {
  cursor,
  decodeAuthor,
  decodeMedia,
  displayDiscussionText,
  exact,
  invalid,
  timestamp,
  type Author,
  type MediaView,
} from './contract';

export interface UpdateTarget {
  readonly postId: string;
  readonly commentId: string;
  readonly replyId: string | null;
}
interface UpdateBase {
  readonly noticeId: string;
  readonly createdAt: string;
  readonly readAt: string | null;
}
export type CommunityUpdate = UpdateBase &
  (
    | { readonly status: 'unavailable' }
    | {
        readonly status: 'available';
        readonly kind: 'root' | 'reply';
        readonly reason: 'direct' | 'saved';
        readonly target: UpdateTarget;
        readonly preview: {
          readonly text: string;
          readonly images: readonly MediaView[];
          readonly author: Author;
        };
      }
  );
export interface UpdatesList {
  readonly items: readonly CommunityUpdate[];
  readonly nextCursor: string | null;
  readonly unreadCount: number;
}
export interface UpdatesUnread {
  readonly unreadCount: number;
}
export interface UpdateRead extends UpdatesUnread {
  readonly noticeId: string;
  readonly readAt: string;
}
export type ResolvedUpdateTarget =
  | { readonly noticeId: string; readonly status: 'unavailable' }
  | {
      readonly noticeId: string;
      readonly status: 'available';
      readonly target: UpdateTarget;
    };
const count = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 2147483647;
export function decodeUpdateTarget(value: unknown): UpdateTarget {
  exact(value, ['postId', 'commentId', 'replyId']);
  if (
    !isUuid(value.postId) ||
    !isUuid(value.commentId) ||
    !(value.replyId === null || isUuid(value.replyId))
  )
    invalid();
  return Object.freeze({
    postId: value.postId,
    commentId: value.commentId,
    replyId: value.replyId,
  });
}
export function decodeCommunityUpdate(value: unknown): CommunityUpdate {
  if (!isRecord(value)) invalid();
  exact(value, [
    'noticeId',
    'createdAt',
    'readAt',
    'status',
    ...(value.status === 'available'
      ? ['kind', 'reason', 'target', 'preview']
      : []),
  ]);
  if (
    !isUuid(value.noticeId) ||
    !timestamp(value.createdAt) ||
    !(value.readAt === null || timestamp(value.readAt))
  )
    invalid();
  const base = {
    noticeId: value.noticeId,
    createdAt: value.createdAt,
    readAt: value.readAt,
  };
  if (value.status === 'unavailable')
    return Object.freeze({ ...base, status: 'unavailable' });
  if (
    value.status !== 'available' ||
    !['root', 'reply'].includes(value.kind as string) ||
    !['direct', 'saved'].includes(value.reason as string)
  )
    invalid();
  const target = decodeUpdateTarget(value.target);
  if (
    (value.kind === 'root') !== (target.replyId === null) ||
    (value.reason === 'saved' && value.kind !== 'root')
  )
    invalid();
  exact(value.preview, ['text', 'images', 'author']);
  if (
    !displayDiscussionText(value.preview.text) ||
    !Array.isArray(value.preview.images) ||
    value.preview.images.length > 3
  )
    invalid();
  const images = value.preview.images.map(decodeMedia);
  if (
    new Set(images.map((image) => image.assetId.toLowerCase())).size !==
      images.length ||
    (!value.preview.text.trim() && !images.length)
  )
    invalid();
  return Object.freeze({
    ...base,
    status: 'available',
    kind: value.kind as 'root' | 'reply',
    reason: value.reason as 'direct' | 'saved',
    target,
    preview: Object.freeze({
      text: value.preview.text,
      images: Object.freeze(images),
      author: decodeAuthor(value.preview.author),
    }),
  });
}
export function decodeUpdatesList(value: unknown): UpdatesList {
  exact(value, ['items', 'nextCursor', 'unreadCount']);
  if (
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    !cursor(value.nextCursor) ||
    !count(value.unreadCount)
  )
    invalid();
  const items = value.items.map(decodeCommunityUpdate);
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
export function decodeUpdatesUnread(value: unknown): UpdatesUnread {
  exact(value, ['unreadCount']);
  if (!count(value.unreadCount)) invalid();
  return Object.freeze({ unreadCount: value.unreadCount });
}
export function decodeUpdateRead(value: unknown): UpdateRead {
  exact(value, ['noticeId', 'readAt', 'unreadCount']);
  if (
    !isUuid(value.noticeId) ||
    !timestamp(value.readAt) ||
    !count(value.unreadCount)
  )
    invalid();
  return Object.freeze({
    noticeId: value.noticeId,
    readAt: value.readAt,
    unreadCount: value.unreadCount,
  });
}
export function decodeResolvedUpdateTarget(
  value: unknown,
): ResolvedUpdateTarget {
  if (!isRecord(value)) invalid();
  exact(value, [
    'noticeId',
    'status',
    ...(value.status === 'available' ? ['target'] : []),
  ]);
  if (!isUuid(value.noticeId)) invalid();
  if (value.status === 'unavailable')
    return Object.freeze({ noticeId: value.noticeId, status: 'unavailable' });
  if (value.status !== 'available') invalid();
  return Object.freeze({
    noticeId: value.noticeId,
    status: 'available',
    target: decodeUpdateTarget(value.target),
  });
}
