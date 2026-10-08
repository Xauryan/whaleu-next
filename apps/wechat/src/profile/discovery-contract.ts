import { isRecord } from '../api/errors';
import { decodeBlockState, type BlockState } from '../community/block-contract';
import {
  boundedText,
  cursor,
  decodeAuthor,
  decodeMedia,
  decodePost,
  displayDiscussionText,
  exact,
  invalid,
  timestamp,
  type Author,
  type MediaView,
  type Post,
} from '../community/contract';
import { bioError, isUuid } from './contract';
import {
  decodePublicExperienceDisplay,
  type PublicExperienceDisplay,
} from '../experience/public-display';

export type DiscoveryCountStatus = 'known' | 'unavailable';
export type DiscoveryContinuation = 'more' | 'scan_pending' | 'end';
export type ProfileUnavailable =
  | { readonly status: 'unavailable'; readonly profileId: string }
  | {
      readonly status: 'blocked_by_you';
      readonly profileId: string;
      readonly relationship: BlockState & { readonly blocked: true };
    };
export interface AvailableProfile {
  readonly status: 'available';
  readonly profileId: string;
  readonly isOwn: boolean;
  readonly displayName: string;
  readonly bio: string;
  readonly avatar: null;
  readonly affiliation: null;
  readonly publicUid: null;
  readonly experienceDisplay: PublicExperienceDisplay;
  readonly totalInteractions: null;
  readonly totalInteractionsStatus: 'unavailable';
  readonly postsHidden: boolean;
  readonly postCount: number | null;
  readonly postCountStatus: DiscoveryCountStatus;
  readonly tradeCount: number | null;
  readonly tradeCountStatus: DiscoveryCountStatus;
}
export type PublicProfile = AvailableProfile | ProfileUnavailable;
export type ProfileList =
  | ProfileUnavailable
  | {
      readonly status: 'available' | 'hidden';
      readonly profileId: string;
      readonly items: readonly Post[];
      readonly total: number | null;
      readonly totalStatus: DiscoveryCountStatus;
      readonly nextCursor: string | null;
      readonly continuation: DiscoveryContinuation;
    };
export interface OwnProfileRef {
  readonly profileId: string | null;
}
export interface LikedItem {
  readonly kind: 'post' | 'comment' | 'reply';
  readonly targetId: string;
  readonly postId: string;
  readonly rootCommentId: string | null;
  readonly likedAt: string | null;
  readonly likeId: string;
  readonly preview: {
    readonly text: string;
    readonly images: readonly MediaView[];
    readonly author: Author;
    readonly createdAt: string;
    readonly isSelf: boolean;
  };
}
export interface LikedList {
  readonly items: readonly LikedItem[];
  readonly visibleLikedCount: number | null;
  readonly visibleLikedCountStatus: DiscoveryCountStatus;
  readonly nextCursor: string | null;
  readonly continuation: DiscoveryContinuation;
}
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const countState = (value: unknown, status: unknown): boolean =>
  status === 'known'
    ? count(value)
    : status === 'unavailable' && value === null;
function continuationState(
  value: unknown,
  next: unknown,
  itemCount: number,
): boolean {
  if (!cursor(next)) return false;
  if (value === 'end') return next === null;
  if (value === 'scan_pending') return next !== null;
  return value === 'more' && next !== null && itemCount > 0;
}
function unavailable(value: unknown): ProfileUnavailable {
  if (!isRecord(value) || !isUuid(value.profileId)) invalid();
  if (value.status === 'unavailable') {
    exact(value, ['status', 'profileId']);
    return Object.freeze({ status: 'unavailable', profileId: value.profileId });
  }
  exact(value, ['status', 'profileId', 'relationship']);
  const relationship = decodeBlockState(value.relationship);
  if (value.status !== 'blocked_by_you' || !relationship.blocked) invalid();
  return Object.freeze({
    status: 'blocked_by_you',
    profileId: value.profileId,
    relationship: Object.freeze({ ...relationship, blocked: true as const }),
  });
}
export function decodePublicProfile(value: unknown): PublicProfile {
  if (!isRecord(value)) invalid();
  if (value.status !== 'available') return unavailable(value);
  exact(value, [
    'status',
    'profileId',
    'isOwn',
    'displayName',
    'bio',
    'avatar',
    'affiliation',
    'publicUid',
    'experienceDisplay',
    'totalInteractions',
    'totalInteractionsStatus',
    'postsHidden',
    'postCount',
    'postCountStatus',
    'tradeCount',
    'tradeCountStatus',
  ]);
  if (
    !isUuid(value.profileId) ||
    typeof value.isOwn !== 'boolean' ||
    !boundedText(value.displayName, 1, 100) ||
    typeof value.bio !== 'string' ||
    !!bioError(value.bio) ||
    value.avatar !== null ||
    value.affiliation !== null ||
    value.publicUid !== null ||
    value.totalInteractions !== null ||
    value.totalInteractionsStatus !== 'unavailable' ||
    typeof value.postsHidden !== 'boolean' ||
    !countState(value.postCount, value.postCountStatus) ||
    !countState(value.tradeCount, value.tradeCountStatus) ||
    (value.postsHidden &&
      (value.isOwn || value.postCount !== 0 || value.tradeCount !== 0))
  )
    invalid();
  return Object.freeze({
    ...value,
    experienceDisplay: decodePublicExperienceDisplay(value.experienceDisplay),
  }) as unknown as AvailableProfile;
}
export function decodeProfileList(value: unknown): ProfileList {
  if (!isRecord(value)) invalid();
  if (!['available', 'hidden'].includes(value.status as string))
    return unavailable(value);
  exact(value, [
    'status',
    'profileId',
    'items',
    'total',
    'totalStatus',
    'nextCursor',
    'continuation',
  ]);
  if (
    !isUuid(value.profileId) ||
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    !countState(value.total, value.totalStatus) ||
    (count(value.total) && value.items.length > value.total) ||
    !continuationState(
      value.continuation,
      value.nextCursor,
      value.items.length,
    ) ||
    (value.status === 'hidden' &&
      (value.items.length !== 0 ||
        value.total !== 0 ||
        value.nextCursor !== null))
  )
    invalid();
  const items = value.items.map(decodePost);
  if (
    new Set(items.map((item) => item.id)).size !== items.length ||
    items.some(
      (item) =>
        item.author.kind !== 'named' ||
        item.author.profileId !== value.profileId,
    )
  )
    invalid();
  return Object.freeze({
    status: value.status as 'available' | 'hidden',
    profileId: value.profileId,
    items: Object.freeze(items),
    total: value.total as number | null,
    totalStatus: value.totalStatus as DiscoveryCountStatus,
    nextCursor: value.nextCursor as string | null,
    continuation: value.continuation as DiscoveryContinuation,
  });
}
export function decodeOwnProfileRef(value: unknown): OwnProfileRef {
  exact(value, ['profileId']);
  if (value.profileId !== null && !isUuid(value.profileId)) invalid();
  return Object.freeze({ profileId: value.profileId });
}
export function decodeLikedItem(value: unknown): LikedItem {
  exact(value, [
    'kind',
    'targetId',
    'postId',
    'rootCommentId',
    'likedAt',
    'likeId',
    'preview',
  ]);
  if (
    !['post', 'comment', 'reply'].includes(value.kind as string) ||
    !isUuid(value.targetId) ||
    !isUuid(value.postId) ||
    !isUuid(value.likeId) ||
    (value.likedAt !== null && !timestamp(value.likedAt))
  )
    invalid();
  if (
    value.kind === 'post'
      ? value.targetId !== value.postId || value.rootCommentId !== null
      : !isUuid(value.rootCommentId) ||
        value.targetId === value.postId ||
        value.rootCommentId === value.postId ||
        (value.kind === 'comment'
          ? value.rootCommentId !== value.targetId
          : value.rootCommentId === value.targetId)
  )
    invalid();
  const preview = value.preview;
  exact(preview, ['text', 'images', 'author', 'createdAt', 'isSelf']);
  if (
    !displayDiscussionText(preview.text) ||
    !Array.isArray(preview.images) ||
    preview.images.length > (value.kind === 'post' ? 9 : 3) ||
    !timestamp(preview.createdAt) ||
    typeof preview.isSelf !== 'boolean'
  )
    invalid();
  const images = preview.images.map(decodeMedia);
  if (
    new Set(images.map((item) => item.assetId)).size !== images.length ||
    (!preview.text.trim() && !images.length)
  )
    invalid();
  return Object.freeze({
    kind: value.kind as LikedItem['kind'],
    targetId: value.targetId,
    postId: value.postId,
    rootCommentId: value.rootCommentId as string | null,
    likedAt: value.likedAt,
    likeId: value.likeId,
    preview: Object.freeze({
      text: preview.text,
      images: Object.freeze(images),
      author: decodeAuthor(preview.author),
      createdAt: preview.createdAt,
      isSelf: preview.isSelf,
    }),
  });
}
export function decodeLikedList(value: unknown): LikedList {
  exact(value, [
    'items',
    'visibleLikedCount',
    'visibleLikedCountStatus',
    'nextCursor',
    'continuation',
  ]);
  if (
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    !countState(value.visibleLikedCount, value.visibleLikedCountStatus) ||
    (count(value.visibleLikedCount) &&
      value.items.length > value.visibleLikedCount) ||
    !continuationState(value.continuation, value.nextCursor, value.items.length)
  )
    invalid();
  const items = value.items.map(decodeLikedItem);
  if (
    new Set(items.map((item) => item.likeId)).size !== items.length ||
    new Set(items.map((item) => `${item.kind}:${item.targetId}`)).size !==
      items.length
  )
    invalid();
  return Object.freeze({
    items: Object.freeze(items),
    visibleLikedCount: value.visibleLikedCount as number | null,
    visibleLikedCountStatus:
      value.visibleLikedCountStatus as DiscoveryCountStatus,
    nextCursor: value.nextCursor as string | null,
    continuation: value.continuation as DiscoveryContinuation,
  });
}
