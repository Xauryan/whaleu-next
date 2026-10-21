import { ClientError, isRecord } from '../../api/errors';
import { activityTimestamp } from '../../activities/contract';
import { isUuid } from '../../profile/contract';

export type SocialUpdateCategory = 'likes' | 'saves' | 'followers';
export type SocialUpdateTarget =
  | {
      readonly type: 'community';
      readonly postId: string;
      readonly commentId: string | null;
      readonly replyId: string | null;
    }
  | { readonly type: 'profile'; readonly profileId: string };
interface NoticeBase {
  readonly noticeId: string;
  readonly createdAt: string;
  readonly readAt: string | null;
}
export type SocialUpdate =
  | (NoticeBase & { readonly status: 'unavailable' })
  | (NoticeBase & {
      readonly status: 'available';
      readonly kind: 'like' | 'save';
      readonly target: Extract<SocialUpdateTarget, { type: 'community' }>;
    })
  | (NoticeBase & {
      readonly status: 'available';
      readonly kind: 'follow';
      readonly target: Extract<SocialUpdateTarget, { type: 'profile' }>;
      readonly actor: {
        readonly profileId: string;
        readonly displayName: string;
      };
    });
export type SocialUpdateUnread =
  | { readonly unreadCount: number; readonly unreadCountStatus: 'available' }
  | { readonly unreadCount: null; readonly unreadCountStatus: 'unavailable' };
export type SocialUpdatesPage = SocialUpdateUnread & {
  readonly items: readonly SocialUpdate[];
  readonly nextCursor: string | null;
};
export type SocialUpdateResolution =
  | { readonly noticeId: string; readonly status: 'unavailable' }
  | {
      readonly noticeId: string;
      readonly status: 'available';
      readonly target: SocialUpdateTarget;
    };
export type SocialUpdateRead = SocialUpdateUnread & {
  readonly noticeId: string;
  readonly readAt: string;
};
export function invalidSocialUpdate(): never {
  throw new ClientError('protocol', 'Invalid social update response');
}
function exact(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  )
    invalidSocialUpdate();
}
export const socialUpdateCategory = (
  value: unknown,
): value is SocialUpdateCategory =>
  value === 'likes' || value === 'saves' || value === 'followers';
export const socialUpdateId = isUuid;
export const socialUpdateCursor = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
export const socialUpdateTimestamp = (value: unknown): value is string =>
  activityTimestamp(value) && value.endsWith('Z');
/** Preserve server microseconds when checking chronology; Date.parse alone truncates them. */
export function compareSocialUpdateTime(left: string, right: string): number {
  return (
    Date.parse(left) - Date.parse(right) ||
    (left.match(/\.(\d+)Z$/)?.[1] ?? '')
      .padEnd(6, '0')
      .localeCompare((right.match(/\.(\d+)Z$/)?.[1] ?? '').padEnd(6, '0'))
  );
}
function unreadFields(value: Record<string, unknown>): SocialUpdateUnread {
  if (value.unreadCountStatus === 'unavailable' && value.unreadCount === null)
    return Object.freeze({
      unreadCount: null,
      unreadCountStatus: 'unavailable',
    });
  if (
    value.unreadCountStatus !== 'available' ||
    typeof value.unreadCount !== 'number' ||
    !Number.isSafeInteger(value.unreadCount) ||
    value.unreadCount < 0 ||
    value.unreadCount > 2147483647
  )
    invalidSocialUpdate();
  return Object.freeze({
    unreadCount: value.unreadCount,
    unreadCountStatus: 'available',
  });
}
export function decodeSocialUpdateUnread(value: unknown): SocialUpdateUnread {
  exact(value, ['unreadCount', 'unreadCountStatus']);
  return unreadFields(value);
}
export function decodeSocialUpdateTarget(
  value: unknown,
  category: SocialUpdateCategory,
): SocialUpdateTarget {
  if (!socialUpdateCategory(category)) invalidSocialUpdate();
  if (category === 'followers') {
    exact(value, ['type', 'profileId']);
    if (value.type !== 'profile' || !socialUpdateId(value.profileId))
      invalidSocialUpdate();
    return Object.freeze({ type: 'profile', profileId: value.profileId });
  }
  exact(value, ['type', 'postId', 'commentId', 'replyId']);
  if (
    value.type !== 'community' ||
    !socialUpdateId(value.postId) ||
    !(value.commentId === null || socialUpdateId(value.commentId)) ||
    !(value.replyId === null || socialUpdateId(value.replyId)) ||
    (value.replyId !== null && value.commentId === null) ||
    value.postId === value.commentId ||
    value.postId === value.replyId ||
    (value.replyId !== null && value.replyId === value.commentId) ||
    (category === 'saves' &&
      (value.commentId !== null || value.replyId !== null))
  )
    invalidSocialUpdate();
  return Object.freeze({
    type: 'community',
    postId: value.postId,
    commentId: value.commentId,
    replyId: value.replyId,
  });
}
export function decodeSocialUpdate(
  value: unknown,
  category: SocialUpdateCategory,
): SocialUpdate {
  if (!socialUpdateCategory(category) || !isRecord(value))
    invalidSocialUpdate();
  exact(value, [
    'noticeId',
    'createdAt',
    'readAt',
    'status',
    ...(value.status === 'available'
      ? ['kind', 'target', ...(category === 'followers' ? ['actor'] : [])]
      : []),
  ]);
  if (
    !socialUpdateId(value.noticeId) ||
    !socialUpdateTimestamp(value.createdAt) ||
    !(value.readAt === null || socialUpdateTimestamp(value.readAt)) ||
    (value.readAt !== null &&
      compareSocialUpdateTime(value.readAt, value.createdAt) < 0)
  )
    invalidSocialUpdate();
  const base = {
    noticeId: value.noticeId,
    createdAt: value.createdAt,
    readAt: value.readAt,
  };
  if (value.status === 'unavailable')
    return Object.freeze({ ...base, status: 'unavailable' });
  if (
    value.status !== 'available' ||
    value.kind !==
      ({ likes: 'like', saves: 'save', followers: 'follow' } as const)[category]
  )
    invalidSocialUpdate();
  const target = decodeSocialUpdateTarget(value.target, category);
  if (value.kind === 'follow') {
    exact(value.actor, ['profileId', 'displayName']);
    if (
      target.type !== 'profile' ||
      value.actor.profileId !== target.profileId ||
      typeof value.actor.displayName !== 'string' ||
      !value.actor.displayName.trim() ||
      value.actor.displayName.length > 100 ||
      Array.from(value.actor.displayName).some((character) => {
        const code = character.codePointAt(0)!;
        return code < 32 || code === 127 || (code >= 0xd800 && code <= 0xdfff);
      })
    )
      invalidSocialUpdate();
    return Object.freeze({
      ...base,
      status: 'available',
      kind: 'follow',
      target,
      actor: Object.freeze({
        profileId: target.profileId,
        displayName: value.actor.displayName,
      }),
    });
  }
  if (
    target.type !== 'community' ||
    (value.kind !== 'like' && value.kind !== 'save')
  )
    invalidSocialUpdate();
  return Object.freeze({
    ...base,
    status: 'available',
    kind: value.kind,
    target,
  });
}
export function decodeSocialUpdatesPage(
  value: unknown,
  category: SocialUpdateCategory,
): SocialUpdatesPage {
  exact(value, ['items', 'nextCursor', 'unreadCount', 'unreadCountStatus']);
  if (
    !socialUpdateCategory(category) ||
    !Array.isArray(value.items) ||
    value.items.length > 20 ||
    !(value.nextCursor === null || socialUpdateCursor(value.nextCursor))
  )
    invalidSocialUpdate();
  const items = value.items.map((item) => decodeSocialUpdate(item, category));
  if (new Set(items.map((item) => item.noticeId)).size !== items.length)
    invalidSocialUpdate();
  return Object.freeze({
    items: Object.freeze(items),
    nextCursor: value.nextCursor,
    ...unreadFields(value),
  });
}
export function decodeSocialUpdateResolution(
  value: unknown,
  category: SocialUpdateCategory,
): SocialUpdateResolution {
  if (!socialUpdateCategory(category) || !isRecord(value))
    invalidSocialUpdate();
  exact(value, [
    'noticeId',
    'status',
    ...(value.status === 'available' ? ['target'] : []),
  ]);
  if (!socialUpdateId(value.noticeId)) invalidSocialUpdate();
  if (value.status === 'unavailable')
    return Object.freeze({ noticeId: value.noticeId, status: 'unavailable' });
  if (value.status !== 'available') invalidSocialUpdate();
  return Object.freeze({
    noticeId: value.noticeId,
    status: 'available',
    target: decodeSocialUpdateTarget(value.target, category),
  });
}
export function decodeSocialUpdateRead(value: unknown): SocialUpdateRead {
  exact(value, ['noticeId', 'readAt', 'unreadCount', 'unreadCountStatus']);
  if (!socialUpdateId(value.noticeId) || !socialUpdateTimestamp(value.readAt))
    invalidSocialUpdate();
  return Object.freeze({
    noticeId: value.noticeId,
    readAt: value.readAt,
    ...unreadFields(value),
  });
}
