import {
  checkFormationCreator,
  decodeFormationComponent,
  type FormationComponent,
} from './formation-contract';
import {
  decodeTradingIntent,
  decodeTradingView,
  type TradingIntent,
  type TradingView,
} from './trading-contract';
import { decodeReplies, type Replies } from './discussion-contract';
import { ClientError, isRecord } from '../api/errors';
import { isUuid } from '../profile/contract';
import {
  decodePublicExperienceDisplay,
  type PublicExperienceDisplay,
} from '../experience/public-display';
import {
  decodePollComponent,
  decodePostComponent,
  type PollComponent,
  type PostComponent,
} from './poll-contract';

export const categories = [
  'discussion',
  'confession',
  'companions',
  'pets',
  'internships',
  'scenery',
  'dorms',
  'research',
  'deep_sea',
  'trading',
] as const;
export type Category = (typeof categories)[number];
export type AuthorMode = 'named' | 'anonymous';
export type Operation = 'publish_post' | 'publish_comment' | 'publish_reply';
export type CommentsPolicy = 'open' | 'restricted';
export interface CommunitySpace {
  readonly id: string;
  readonly kind: 'regional' | 'global';
  readonly name: string;
  readonly isActive: boolean;
  readonly operatingRegionId: string | null;
}
export interface Spaces {
  readonly regional: CommunitySpace | null;
  readonly global: readonly CommunitySpace[];
}
export interface MediaView {
  readonly assetId: string;
  readonly width: number;
  readonly height: number;
  readonly displayUrl: string;
  readonly thumbnailUrl: string;
  readonly expiresAt: string | null;
}
export type Author =
  | {
      readonly kind: 'named';
      readonly profileId: string;
      readonly displayName: string;
      readonly avatar: MediaView | null;
      readonly experienceDisplay: PublicExperienceDisplay;
    }
  | {
      readonly kind: 'anonymous';
      readonly personaId: string;
      readonly displayName: string;
      readonly avatar: MediaView | null;
      readonly isPostAuthor: boolean;
    };
export interface Post {
  /** Missing legacy projection is never an opt-in. */
  readonly allowAnonymousDm?: boolean;
  readonly trading: TradingView | null;
  readonly component: PostComponent;
  readonly id: string;
  readonly space: {
    readonly id: string;
    readonly kind: 'regional' | 'global';
    readonly name: string;
  };
  readonly category: Category;
  readonly text: string;
  readonly images: readonly MediaView[];
  readonly author: Author;
  readonly publishedAt: string;
  readonly likeCount: number;
  readonly saveCount: number;
  readonly commentCount: number;
  readonly replyCount: number;
  readonly discussionCount: number;
  readonly viewer: {
    readonly isSelf: boolean;
    readonly isLiked: boolean;
    readonly isSaved: boolean;
    readonly canSave: boolean;
    readonly canSetUpdatePreference: boolean;
    readonly canDelete: boolean;
    readonly canComment: boolean;
  };
  readonly commentsPolicy: CommentsPolicy;
}
export interface Comment {
  readonly id: string;
  readonly postId: string;
  readonly text: string;
  readonly images: readonly MediaView[];
  readonly author: Author;
  readonly createdAt: string;
  readonly likeCount: number;
  readonly replyCount: number;
  readonly isPinned: boolean;
  readonly replyPreview: Replies;
  readonly viewer: {
    readonly isSelf: boolean;
    readonly canDelete: boolean;
    readonly isLiked: boolean;
    readonly canPin: boolean;
  };
}
export type Continuation =
  'available' | 'end' | 'login_required' | 'phone_verification_required';
export interface Feed {
  readonly items: readonly Post[];
  readonly nextCursor: string | null;
  readonly continuation: Continuation;
}
export interface Comments {
  readonly items: readonly Comment[];
  readonly nextCursor: string | null;
}
export interface OwnPublication {
  readonly id: string;
  readonly spaceId: string;
  readonly category: Category;
  readonly status: 'published' | 'hidden' | 'deleted';
  readonly publishedAt: string;
}
export interface OwnPublications {
  readonly items: readonly OwnPublication[];
  readonly nextCursor: string | null;
}
export interface Capabilities {
  readonly publish: {
    readonly availability: 'allowed' | 'denied' | 'unavailable';
    readonly reason: string | null;
  };
  readonly authorModes: readonly AuthorMode[];
  readonly canDisableComments: boolean;
  readonly postImageLimit: 9;
  readonly commentImageLimit: 3;
  readonly mediaAvailability: 'unavailable';
  readonly commentRules: {
    readonly unverifiedRequiresNamed: true;
    readonly ownAnonymousPostForcesAnonymous: true;
  };
}
export interface PostIntent {
  readonly allowAnonymousDm?: boolean;
  readonly trading?: TradingIntent;
  readonly component?: PollComponent | FormationComponent;
  readonly clientRequestId: string;
  readonly spaceId: string;
  readonly category: Category;
  readonly text: string;
  readonly imageAssetIds: readonly string[];
  readonly authorMode: AuthorMode;
  readonly commentsPolicy: CommentsPolicy;
}
export interface CommentIntent {
  readonly clientRequestId: string;
  readonly text: string;
  readonly imageAssetIds: readonly string[];
  readonly authorMode: AuthorMode;
}
export type Receipt =
  | {
      readonly requestId: string;
      readonly operation: Operation;
      readonly outcome: 'created';
      readonly resourceId: string;
      readonly createdAt: string;
    }
  | {
      readonly requestId: string;
      readonly operation: Operation;
      readonly outcome: 'rejected';
      readonly code: string;
    };
export function invalid(): never {
  throw new ClientError('protocol', 'Invalid community data');
}
export function exact(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  )
    invalid();
}
export function boundedText(
  value: unknown,
  min: number,
  max: number,
): value is string {
  return (
    typeof value === 'string' &&
    [...value].length >= min &&
    [...value].length <= max &&
    ![...value].some((character) => {
      const code = character.codePointAt(0)!;
      return (
        (code < 32 && code !== 9 && code !== 10) ||
        (code >= 127 && code <= 159) ||
        (code >= 0xd800 && code <= 0xdfff)
      );
    })
  );
}
const integer = (value: unknown, min = 0, max = 2147483647): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= min &&
  value <= max;
export const uuid4 = (value: unknown): value is string =>
  isUuid(value) && value[14] === '4';
export const isCategory = (value: unknown): value is Category =>
  typeof value === 'string' && categories.includes(value as Category);
const mode = (value: unknown): value is AuthorMode =>
  value === 'named' || value === 'anonymous';
const policy = (value: unknown): value is CommentsPolicy =>
  value === 'open' || value === 'restricted';
export const timestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
const terminalCodes = [
  'COMMUNITY_SCOPE_UNAVAILABLE',
  'PHONE_VERIFICATION_REQUIRED',
  'STUDENT_VERIFICATION_REQUIRED',
  'IDENTITY_CAMPUS_REQUIRED',
  'COMMUNITY_ACTION_RESTRICTED',
  'AUTHOR_MODE_NOT_ALLOWED',
  'COMMENTS_DISABLED',
  'CONTENT_REJECTED',
  'MEDIA_NOT_READY',
  'POST_NOT_FOUND',
  'POST_DELETED',
  'COMMENT_NOT_FOUND',
  'REPLY_NOT_FOUND',
];
const code = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[A-Z]/.test(value) &&
  value.length <= 64 &&
  !/[^A-Z0-9_]/.test(value);
export function cursor(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' &&
      value.length >= 1 &&
      value.length <= 1024 &&
      !/[^A-Za-z0-9_-]/.test(value))
  );
}
function https(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 4096 &&
    /^https:\/\/[a-z0-9.-]+(?::443)?(?:\/[^\s\\]*)?$/i.test(value) &&
    [...value].every((character) => {
      const code = character.codePointAt(0)!;
      return code > 32 && code !== 127;
    })
  );
}
function unique<T extends { readonly id: string }>(items: readonly T[]): void {
  if (new Set(items.map((item) => item.id)).size !== items.length) invalid();
}
export function decodeSpace(value: unknown): CommunitySpace {
  exact(value, ['id', 'kind', 'name', 'isActive', 'operatingRegionId']);
  if (
    !isUuid(value.id) ||
    !boundedText(value.name, 1, 200) ||
    typeof value.isActive !== 'boolean' ||
    !(
      (value.kind === 'regional' && isUuid(value.operatingRegionId)) ||
      (value.kind === 'global' && value.operatingRegionId === null)
    )
  )
    invalid();
  return Object.freeze({
    id: value.id,
    kind: value.kind,
    name: value.name,
    isActive: value.isActive,
    operatingRegionId: value.operatingRegionId,
  });
}
export function decodeSpaces(value: unknown): Spaces {
  exact(value, ['regional', 'global']);
  if (!Array.isArray(value.global) || value.global.length > 100) invalid();
  const regional = value.regional === null ? null : decodeSpace(value.regional),
    global = value.global.map(decodeSpace);
  if (
    regional?.kind === 'global' ||
    global.some((item) => item.kind !== 'global')
  )
    invalid();
  unique([...(regional ? [regional] : []), ...global]);
  return Object.freeze({ regional, global: Object.freeze(global) });
}
export function decodeMedia(value: unknown): MediaView {
  exact(value, [
    'assetId',
    'width',
    'height',
    'displayUrl',
    'thumbnailUrl',
    'expiresAt',
  ]);
  if (
    !isUuid(value.assetId) ||
    !integer(value.width, 1, 32768) ||
    !integer(value.height, 1, 32768) ||
    !https(value.displayUrl) ||
    !https(value.thumbnailUrl) ||
    !(value.expiresAt === null || timestamp(value.expiresAt))
  )
    invalid();
  return Object.freeze({
    assetId: value.assetId,
    width: value.width,
    height: value.height,
    displayUrl: value.displayUrl,
    thumbnailUrl: value.thumbnailUrl,
    expiresAt: value.expiresAt,
  });
}
function mediaList(value: unknown, max: number): readonly MediaView[] {
  if (!Array.isArray(value) || value.length > max) invalid();
  const items = value.map(decodeMedia);
  if (new Set(items.map((item) => item.assetId)).size !== items.length)
    invalid();
  return Object.freeze(items);
}
export function decodeAuthor(value: unknown): Author {
  if (!isRecord(value)) invalid();
  if (value.kind === 'named') {
    exact(value, [
      'kind',
      'profileId',
      'displayName',
      'avatar',
      'experienceDisplay',
    ]);
    if (!isUuid(value.profileId) || !boundedText(value.displayName, 1, 100))
      invalid();
    return Object.freeze({
      kind: 'named',
      profileId: value.profileId,
      displayName: value.displayName,
      avatar: value.avatar === null ? null : decodeMedia(value.avatar),
      experienceDisplay: decodePublicExperienceDisplay(value.experienceDisplay),
    });
  }
  exact(value, ['kind', 'personaId', 'displayName', 'avatar', 'isPostAuthor']);
  if (
    value.kind !== 'anonymous' ||
    !isUuid(value.personaId) ||
    !boundedText(value.displayName, 1, 100) ||
    typeof value.isPostAuthor !== 'boolean'
  )
    invalid();
  return Object.freeze({
    kind: 'anonymous',
    personaId: value.personaId,
    displayName: value.displayName,
    avatar: value.avatar === null ? null : decodeMedia(value.avatar),
    isPostAuthor: value.isPostAuthor,
  });
}
export function decodePost(value: unknown): Post {
  if (!isRecord(value)) invalid();
  const hasAnonymousDm = Object.prototype.hasOwnProperty.call(
    value,
    'allowAnonymousDm',
  );
  exact(value, [
    ...(hasAnonymousDm ? ['allowAnonymousDm'] : []),
    'trading',
    'id',
    'space',
    'category',
    'text',
    'images',
    'author',
    'publishedAt',
    'likeCount',
    'saveCount',
    'commentCount',
    'replyCount',
    'discussionCount',
    'viewer',
    'commentsPolicy',
    'component',
  ]);
  exact(value.space, ['id', 'kind', 'name']);
  exact(value.viewer, [
    'isSelf',
    'isLiked',
    'canDelete',
    'canComment',
    'isSaved',
    'canSave',
    'canSetUpdatePreference',
  ]);
  if (
    (hasAnonymousDm && typeof value.allowAnonymousDm !== 'boolean') ||
    !isUuid(value.id) ||
    !isUuid(value.space.id) ||
    !['regional', 'global'].includes(String(value.space.kind)) ||
    !boundedText(value.space.name, 1, 200) ||
    !isCategory(value.category) ||
    (value.space.kind === 'global' && value.category !== 'discussion') ||
    !boundedText(value.text, 1, 2500) ||
    !value.text.trim() ||
    !timestamp(value.publishedAt) ||
    !integer(value.likeCount) ||
    !integer(value.saveCount) ||
    (value.viewer.isSaved && value.saveCount < 1) ||
    !integer(value.commentCount) ||
    !integer(value.replyCount) ||
    !integer(value.discussionCount) ||
    value.discussionCount !== value.commentCount + value.replyCount ||
    !policy(value.commentsPolicy) ||
    Object.values(value.viewer).some((item) => typeof item !== 'boolean') ||
    (value.viewer.canDelete && !value.viewer.isSelf)
  )
    invalid();
  const component = decodePostComponent(value.component, value.id),
    author = decodeAuthor(value.author),
    trading = value.trading === null ? null : decodeTradingView(value.trading);
  if (
    (value.category === 'trading') !== !!trading ||
    (trading &&
      (value.space.kind !== 'regional' ||
        author.kind !== 'named' ||
        component.kind !== 'none' ||
        (trading.viewer.canSetResolution && !value.viewer.isSelf)))
  )
    invalid();
  if (component.kind === 'formation')
    checkFormationCreator(component.formation, author);
  if (value.allowAnonymousDm === true && author.kind !== 'named') invalid();
  return Object.freeze({
    ...(hasAnonymousDm
      ? { allowAnonymousDm: value.allowAnonymousDm === true }
      : {}),
    trading,
    component,
    id: value.id,
    space: Object.freeze({
      id: value.space.id,
      kind: value.space.kind as 'regional' | 'global',
      name: value.space.name,
    }),
    category: value.category,
    text: value.text,
    images: mediaList(value.images, 9),
    author: decodeAuthor(value.author),
    publishedAt: value.publishedAt,
    likeCount: value.likeCount,
    saveCount: value.saveCount,
    commentCount: value.commentCount,
    replyCount: value.replyCount,
    discussionCount: value.discussionCount,
    viewer: Object.freeze(value.viewer) as Post['viewer'],
    commentsPolicy: value.commentsPolicy,
  });
}
export function displayDiscussionText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 1048576 &&
    [...value].every((character) => {
      const code = character.codePointAt(0)!;
      return code < 0xd800 || code > 0xdfff;
    })
  );
}
export function decodeComment(value: unknown): Comment {
  exact(value, [
    'id',
    'postId',
    'text',
    'images',
    'author',
    'createdAt',
    'likeCount',
    'replyCount',
    'isPinned',
    'replyPreview',
    'viewer',
  ]);
  exact(value.viewer, ['isSelf', 'canDelete', 'isLiked', 'canPin']);
  if (
    !isUuid(value.id) ||
    !isUuid(value.postId) ||
    !displayDiscussionText(value.text) ||
    !timestamp(value.createdAt) ||
    !integer(value.likeCount) ||
    !integer(value.replyCount) ||
    typeof value.isPinned !== 'boolean' ||
    Object.values(value.viewer).some((item) => typeof item !== 'boolean') ||
    (value.viewer.canDelete && !value.viewer.isSelf)
  )
    invalid();
  const replyPreview = decodeReplies(value.replyPreview);
  if (
    replyPreview.items.length > 5 ||
    replyPreview.items.some(
      (item) => item.rootCommentId !== value.id || item.postId !== value.postId,
    ) ||
    replyPreview.items.length > value.replyCount
  )
    invalid();
  const images = mediaList(value.images, 3);
  if (!value.text.trim() && !images.length) invalid();
  return Object.freeze({
    id: value.id,
    postId: value.postId,
    text: value.text,
    images,
    author: decodeAuthor(value.author),
    createdAt: value.createdAt,
    likeCount: value.likeCount,
    replyCount: value.replyCount,
    isPinned: value.isPinned,
    replyPreview,
    viewer: Object.freeze(value.viewer) as Comment['viewer'],
  });
}
export function decodeFeed(value: unknown): Feed {
  exact(value, ['items', 'nextCursor', 'continuation']);
  if (
    !Array.isArray(value.items) ||
    value.items.length > 10 ||
    !cursor(value.nextCursor) ||
    ![
      'available',
      'end',
      'login_required',
      'phone_verification_required',
    ].includes(String(value.continuation)) ||
    (value.continuation === 'available') !== (value.nextCursor !== null)
  )
    invalid();
  const items = value.items.map(decodePost);
  unique(items);
  return Object.freeze({
    items: Object.freeze(items),
    nextCursor: value.nextCursor,
    continuation: value.continuation as Continuation,
  });
}
export function decodeComments(value: unknown): Comments {
  exact(value, ['items', 'nextCursor']);
  if (
    !Array.isArray(value.items) ||
    value.items.length > 10 ||
    !cursor(value.nextCursor)
  )
    invalid();
  const items = value.items.map(decodeComment);
  unique(items);
  return Object.freeze({
    items: Object.freeze(items),
    nextCursor: value.nextCursor,
  });
}
export function decodeOwnPublications(value: unknown): OwnPublications {
  exact(value, ['items', 'nextCursor']);
  if (
    !Array.isArray(value.items) ||
    value.items.length > 10 ||
    !cursor(value.nextCursor)
  )
    invalid();
  const items = value.items.map((item) => {
    exact(item, ['id', 'spaceId', 'category', 'status', 'publishedAt']);
    if (
      !isUuid(item.id) ||
      !isUuid(item.spaceId) ||
      !isCategory(item.category) ||
      !['published', 'hidden', 'deleted'].includes(String(item.status)) ||
      !timestamp(item.publishedAt)
    )
      invalid();
    return Object.freeze({
      id: item.id,
      spaceId: item.spaceId,
      category: item.category,
      status: item.status as OwnPublication['status'],
      publishedAt: item.publishedAt,
    });
  });
  unique(items);
  return Object.freeze({
    items: Object.freeze(items),
    nextCursor: value.nextCursor,
  });
}
export function decodeCapabilities(value: unknown): Capabilities {
  exact(value, [
    'publish',
    'authorModes',
    'canDisableComments',
    'postImageLimit',
    'commentImageLimit',
    'mediaAvailability',
    'commentRules',
  ]);
  exact(value.publish, ['availability', 'reason']);
  exact(value.commentRules, [
    'unverifiedRequiresNamed',
    'ownAnonymousPostForcesAnonymous',
  ]);
  if (
    !['allowed', 'denied', 'unavailable'].includes(
      String(value.publish.availability),
    ) ||
    !(value.publish.reason === null || code(value.publish.reason)) ||
    (value.publish.availability === 'allowed') !==
      (value.publish.reason === null) ||
    !Array.isArray(value.authorModes) ||
    !value.authorModes.every(mode) ||
    new Set(value.authorModes).size !== value.authorModes.length ||
    (value.publish.availability === 'allowed' && !value.authorModes.length) ||
    typeof value.canDisableComments !== 'boolean' ||
    value.postImageLimit !== 9 ||
    value.commentImageLimit !== 3 ||
    value.mediaAvailability !== 'unavailable' ||
    value.commentRules.unverifiedRequiresNamed !== true ||
    value.commentRules.ownAnonymousPostForcesAnonymous !== true
  )
    invalid();
  return Object.freeze({
    publish: Object.freeze({
      availability: value.publish
        .availability as Capabilities['publish']['availability'],
      reason: value.publish.reason,
    }),
    authorModes: Object.freeze(value.authorModes),
    canDisableComments: value.canDisableComments,
    postImageLimit: 9,
    commentImageLimit: 3,
    mediaAvailability: 'unavailable',
    commentRules: Object.freeze({
      unverifiedRequiresNamed: true,
      ownAnonymousPostForcesAnonymous: true,
    }),
  });
}
export function decodeReceipt(value: unknown): Receipt {
  if (!isRecord(value)) invalid();
  if (value.outcome === 'created') {
    exact(value, [
      'requestId',
      'operation',
      'outcome',
      'resourceId',
      'createdAt',
    ]);
    if (
      !uuid4(value.requestId) ||
      !['publish_post', 'publish_comment', 'publish_reply'].includes(
        String(value.operation),
      ) ||
      !isUuid(value.resourceId) ||
      !timestamp(value.createdAt)
    )
      invalid();
    return Object.freeze({
      requestId: value.requestId,
      operation: value.operation as Operation,
      outcome: 'created',
      resourceId: value.resourceId,
      createdAt: value.createdAt,
    });
  }
  exact(value, ['requestId', 'operation', 'outcome', 'code']);
  if (
    value.outcome !== 'rejected' ||
    !uuid4(value.requestId) ||
    !['publish_post', 'publish_comment', 'publish_reply'].includes(
      String(value.operation),
    ) ||
    !code(value.code) ||
    !terminalCodes.includes(value.code)
  )
    invalid();
  return Object.freeze({
    requestId: value.requestId,
    operation: value.operation as Operation,
    outcome: 'rejected',
    code: value.code,
  });
}
function assets(value: unknown, max: number): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > max ||
    !value.every(isUuid) ||
    new Set(value).size !== value.length
  )
    invalid();
  return Object.freeze([...value]);
}
export function decodePostIntent(value: unknown): PostIntent {
  if (!isRecord(value)) invalid();
  const hasAnonymousDm = Object.prototype.hasOwnProperty.call(
    value,
    'allowAnonymousDm',
  );
  const hasTrading = Object.prototype.hasOwnProperty.call(value, 'trading');
  const hasComponent = Object.prototype.hasOwnProperty.call(value, 'component');
  exact(value, [
    'clientRequestId',
    'spaceId',
    'category',
    'text',
    'imageAssetIds',
    'authorMode',
    'commentsPolicy',
    ...(hasComponent ? ['component'] : []),
    ...(hasTrading ? ['trading'] : []),
    ...(hasAnonymousDm ? ['allowAnonymousDm'] : []),
  ]);
  if (
    (hasAnonymousDm &&
      (typeof value.allowAnonymousDm !== 'boolean' ||
        value.authorMode !== 'named')) ||
    !uuid4(value.clientRequestId) ||
    !isUuid(value.spaceId) ||
    !isCategory(value.category) ||
    !boundedText(value.text, 1, 2500) ||
    !value.text.trim() ||
    value.text.includes('\r') ||
    !mode(value.authorMode) ||
    !policy(value.commentsPolicy)
  )
    invalid();
  const component = hasComponent
    ? isRecord(value.component) && value.component.kind === 'formation'
      ? decodeFormationComponent(value.component)
      : decodePollComponent(value.component)
    : undefined;
  if (
    (value.category === 'trading') !== hasTrading ||
    (hasTrading &&
      (value.authorMode !== 'named' ||
        (component && component.kind !== 'none')))
  )
    invalid();
  return Object.freeze({
    ...(hasAnonymousDm
      ? { allowAnonymousDm: value.allowAnonymousDm as boolean }
      : {}),
    ...(hasTrading ? { trading: decodeTradingIntent(value.trading) } : {}),
    ...(hasComponent ? { component: component! } : {}),
    clientRequestId: value.clientRequestId,
    spaceId: value.spaceId,
    category: value.category,
    text: value.text,
    imageAssetIds: assets(value.imageAssetIds, 9),
    authorMode: value.authorMode,
    commentsPolicy: value.commentsPolicy,
  });
}
export function decodeCommentIntent(value: unknown): CommentIntent {
  exact(value, ['clientRequestId', 'text', 'imageAssetIds', 'authorMode']);
  if (
    !uuid4(value.clientRequestId) ||
    !boundedText(value.text, 0, 500) ||
    value.text.includes('\r') ||
    !mode(value.authorMode)
  )
    invalid();
  const images = assets(value.imageAssetIds, 3);
  if (!value.text.trim() && !images.length) invalid();
  return Object.freeze({
    clientRequestId: value.clientRequestId,
    text: value.text,
    imageAssetIds: images,
    authorMode: value.authorMode,
  });
}

export interface CommentCapabilities {
  readonly availability: 'allowed' | 'denied' | 'unavailable';
  readonly reason: string | null;
  readonly authorModes: readonly AuthorMode[];
  readonly forcedAuthorMode: 'anonymous' | null;
  readonly lastAuthorMode: AuthorMode | null;
}
export function decodeCommentCapabilities(value: unknown): CommentCapabilities {
  exact(value, [
    'availability',
    'reason',
    'authorModes',
    'forcedAuthorMode',
    'lastAuthorMode',
  ]);
  if (
    !['allowed', 'denied', 'unavailable'].includes(
      String(value.availability),
    ) ||
    !(value.reason === null || code(value.reason)) ||
    (value.availability === 'allowed') !== (value.reason === null) ||
    !Array.isArray(value.authorModes) ||
    !value.authorModes.every(mode) ||
    new Set(value.authorModes).size !== value.authorModes.length ||
    (value.availability === 'allowed' && !value.authorModes.length) ||
    !(value.lastAuthorMode === null || mode(value.lastAuthorMode)) ||
    !(
      value.forcedAuthorMode === null || value.forcedAuthorMode === 'anonymous'
    ) ||
    (value.forcedAuthorMode === 'anonymous' &&
      value.authorModes.includes('named'))
  )
    invalid();
  return Object.freeze({
    availability: value.availability as CommentCapabilities['availability'],
    reason: value.reason,
    authorModes: Object.freeze(value.authorModes),
    forcedAuthorMode: value.forcedAuthorMode,
    lastAuthorMode: value.lastAuthorMode,
  });
}

export interface TradingList {
  readonly items: readonly Post[];
  readonly nextCursor: string | null;
}
export function decodeTradingList(value: unknown): TradingList {
  exact(value, ['items', 'nextCursor']);
  if (
    !Array.isArray(value.items) ||
    value.items.length > 10 ||
    !cursor(value.nextCursor)
  )
    invalid();
  const items = value.items.map(decodePost);
  if (items.some((item) => item.category !== 'trading')) invalid();
  unique(items);
  return Object.freeze({
    items: Object.freeze(items),
    nextCursor: value.nextCursor,
  });
}
