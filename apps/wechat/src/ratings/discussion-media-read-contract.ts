import { isRecord } from '../api/errors';
import { exact } from '../community/contract';
import {
  canonicalRatingText,
  decodeRatingComment,
  invalidRating,
  type RatingComment,
} from './contract';
import { decodeRatingReply, type RatingReply } from './discussion-contract';
import {
  decodeRatingScopedCommentPage,
  decodeRatingScopedDiscussion,
  decodeRatingScopedReplyPage,
  decodeRatingScopedReplyPosition,
  type RatingScopedCommentPage,
  type RatingScopedDiscussion,
  type RatingScopedReplyPage,
  type RatingScopedReplyPosition,
} from './scoped-read-contract';
import {
  discussionMediaDigest as digest,
  discussionMediaId as id,
} from './discussion-media-contract';
import {
  decodeDiscussionDescriptor,
  type DiscussionDescriptor,
} from './discussion-media-wire';
export interface DiscussionContent {
  readonly protocolVersion: 4;
  readonly attachmentSetDigest: string;
  readonly images: readonly DiscussionDescriptor[];
}
export type DiscussionRoot = RatingComment & DiscussionContent;
export type DiscussionReply = RatingReply & DiscussionContent;
function content(raw: unknown, reply: boolean) {
  if (!isRecord(raw) || raw.protocolVersion !== 4) invalidRating();
  const {
    protocolVersion: _version,
    attachmentSetDigest,
    images,
    ...base
  } = raw;
  void _version;
  if (!Array.isArray(images) || images.length > (reply ? 3 : 9))
    invalidRating();
  const body = canonicalRatingText(base.body, 500, false),
    set = digest(attachmentSetDigest);
  if (body !== base.body || (!body && images.length === 0)) invalidRating();
  // Only reuse legacy identity/action validation. A pure-image body's final
  // projection is its actual empty canonical body, never this decoder sentinel.
  const subject = reply
    ? decodeRatingReply({ ...base, body: body || 'image' })
    : decodeRatingComment({ ...base, body: body || 'image' });
  const rootId = reply ? (subject as RatingReply).rootId : subject.id;
  const descriptors = images.map(decodeDiscussionDescriptor);
  if (
    new Set(descriptors.map((image) => image.bindingId)).size !==
      descriptors.length ||
    descriptors.some(
      (image, ordinal) =>
        image.ordinal !== ordinal ||
        image.attachmentSetDigest !== set ||
        image.targetId !== subject.targetId ||
        image.rootId !== rootId ||
        image.replyId !== (reply ? subject.id : null) ||
        image.subjectRevision !== subject.revision ||
        image.contextId !== descriptors[0]!.contextId ||
        image.contextToken !== descriptors[0]!.contextToken,
    )
  )
    invalidRating();
  return Object.freeze({
    ...subject,
    body,
    protocolVersion: 4 as const,
    attachmentSetDigest: set,
    images: Object.freeze(descriptors),
  });
}
export const decodeDiscussionRoot = (raw: unknown): DiscussionRoot =>
  content(raw, false) as DiscussionRoot;
export const decodeDiscussionReply = (raw: unknown): DiscussionReply =>
  content(raw, true) as DiscussionReply;
function legacy(subject: DiscussionRoot | DiscussionReply) {
  const {
    protocolVersion: _p,
    attachmentSetDigest: _d,
    images: _i,
    ...base
  } = subject;
  void _p;
  void _d;
  void _i;
  return { ...base, body: base.body || 'image' };
}
export type DiscussionCommentPage = Omit<RatingScopedCommentPage, 'items'> & {
  readonly items: readonly DiscussionRoot[];
};
export type DiscussionThread = Omit<RatingScopedDiscussion, 'root'> & {
  readonly root: DiscussionRoot;
};
export type DiscussionReplyPage = Omit<RatingScopedReplyPage, 'items'> & {
  readonly items: readonly DiscussionReply[];
};
export type DiscussionReplyPosition = Omit<
  RatingScopedReplyPosition,
  'page'
> & { readonly page: DiscussionReplyPage };
export function decodeDiscussionCommentPage(
  raw: unknown,
): DiscussionCommentPage {
  if (!isRecord(raw) || !Array.isArray(raw.items)) invalidRating();
  const items = raw.items.map(decodeDiscussionRoot);
  return Object.freeze({
    ...decodeRatingScopedCommentPage({ ...raw, items: items.map(legacy) }),
    items,
  });
}
export function decodeDiscussionThread(raw: unknown): DiscussionThread {
  if (!isRecord(raw)) invalidRating();
  const root = decodeDiscussionRoot(raw.root);
  return Object.freeze({
    ...decodeRatingScopedDiscussion({ ...raw, root: legacy(root) }),
    root,
  });
}
export function decodeDiscussionReplyPage(raw: unknown): DiscussionReplyPage {
  if (!isRecord(raw) || !Array.isArray(raw.items)) invalidRating();
  const items = raw.items.map(decodeDiscussionReply);
  return Object.freeze({
    ...decodeRatingScopedReplyPage({ ...raw, items: items.map(legacy) }),
    items,
  });
}
export function decodeDiscussionReplyPosition(
  raw: unknown,
): DiscussionReplyPosition {
  if (!isRecord(raw)) invalidRating();
  const page = decodeDiscussionReplyPage(raw.page);
  return Object.freeze({
    ...decodeRatingScopedReplyPosition({
      ...raw,
      page: { ...page, items: page.items.map(legacy) },
    }),
    page,
  });
}
export interface DiscussionComposerContext {
  readonly protocolVersion: 4;
  readonly contextId: string;
  readonly targetId: string;
  readonly targetRevision: string;
  readonly categoryId: string;
  readonly categoryRevision: string;
  readonly definitionRevision: string;
  readonly contentVersion: number;
  readonly root: { readonly id: string; readonly revision: string } | null;
  readonly allowedActions: {
    readonly createComment: boolean;
    readonly createReply: boolean;
  };
  readonly authorModes: readonly ('named' | 'anonymous')[];
}
export function decodeDiscussionComposerContext(
  raw: unknown,
): DiscussionComposerContext {
  exact(raw, [
    'protocolVersion',
    'contextId',
    'targetId',
    'targetRevision',
    'categoryId',
    'categoryRevision',
    'definitionRevision',
    'contentVersion',
    'root',
    'allowedActions',
    'authorModes',
  ]);
  exact(raw.allowedActions, ['createComment', 'createReply']);
  if (
    raw.protocolVersion !== 4 ||
    typeof raw.contentVersion !== 'number' ||
    !Number.isSafeInteger(raw.contentVersion) ||
    raw.contentVersion < 1 ||
    raw.contentVersion > 2147483647 ||
    typeof raw.allowedActions.createComment !== 'boolean' ||
    typeof raw.allowedActions.createReply !== 'boolean' ||
    !Array.isArray(raw.authorModes) ||
    raw.authorModes.length < 1 ||
    raw.authorModes.length > 2 ||
    raw.authorModes[0] !== 'named' ||
    (raw.authorModes.length === 2 && raw.authorModes[1] !== 'anonymous')
  )
    invalidRating();
  let root: DiscussionComposerContext['root'] = null;
  if (raw.root !== null) {
    exact(raw.root, ['id', 'revision']);
    root = { id: id(raw.root.id), revision: id(raw.root.revision) };
  }
  return Object.freeze({
    protocolVersion: 4,
    contextId: id(raw.contextId),
    targetId: id(raw.targetId),
    targetRevision: id(raw.targetRevision),
    categoryId: id(raw.categoryId),
    categoryRevision: id(raw.categoryRevision),
    definitionRevision: id(raw.definitionRevision),
    contentVersion: raw.contentVersion,
    root,
    allowedActions: {
      createComment: raw.allowedActions.createComment,
      createReply: raw.allowedActions.createReply,
    },
    authorModes: raw.authorModes as ('named' | 'anonymous')[],
  });
}

import { decodeRatingAuthor, type RatingAuthor } from './contract';
import { ratingTimestamp } from './discussion-contract';
import {
  decodeRatingScopedLocator,
  type RatingScopedLocator,
} from './scoped-contract';
export type DiscussionNotice = {
  readonly protocolVersion: 4;
  readonly noticeId: string;
  readonly createdAt: string;
  readonly readAt: string | null;
} & (
  | { readonly status: 'unavailable' }
  | {
      readonly status: 'available';
      readonly domain: 'ratings';
      readonly kind: 'reply' | 'like' | 'subscription';
      readonly reason:
        'direct_root' | 'direct_reply' | 'like' | 'target_subscription';
      readonly target: RatingScopedLocator;
      readonly preview: {
        readonly body: string;
        readonly author: RatingAuthor;
        readonly imageCount: number;
        readonly thumbnail: DiscussionDescriptor | null;
      };
      readonly actor?: RatingAuthor;
      readonly activity?: 'root' | 'reply';
    }
);
export function decodeDiscussionNotice(raw: unknown): DiscussionNotice {
  if (!isRecord(raw)) invalidRating();
  const base = ['protocolVersion', 'noticeId', 'createdAt', 'readAt', 'status'];
  if (
    raw.protocolVersion !== 4 ||
    !ratingTimestamp(raw.createdAt) ||
    (raw.readAt !== null && !ratingTimestamp(raw.readAt))
  )
    invalidRating();
  const common = {
    protocolVersion: 4 as const,
    noticeId: id(raw.noticeId),
    createdAt: raw.createdAt,
    readAt: raw.readAt,
  };
  if (raw.status === 'unavailable') {
    exact(raw, base);
    return Object.freeze({ ...common, status: 'unavailable' });
  }
  exact(raw, [
    ...base,
    'domain',
    'kind',
    'reason',
    'target',
    'preview',
    ...(raw.kind === 'like' ? ['actor'] : []),
    ...(raw.kind === 'subscription' ? ['activity'] : []),
  ]);
  exact(raw.preview, ['body', 'author', 'imageCount', 'thumbnail']);
  const target = decodeRatingScopedLocator(raw.target),
    p = raw.preview,
    body = canonicalRatingText(p.body, 500, false),
    thumbnail =
      p.thumbnail === null ? null : decodeDiscussionDescriptor(p.thumbnail);
  if (
    raw.status !== 'available' ||
    raw.domain !== 'ratings' ||
    !target.rootId ||
    body !== p.body ||
    typeof p.imageCount !== 'number' ||
    !Number.isSafeInteger(p.imageCount) ||
    p.imageCount < 0 ||
    p.imageCount > (target.replyId ? 3 : 9) ||
    (!body && !p.imageCount) ||
    (p.imageCount === 0
      ? thumbnail !== null
      : thumbnail === null || thumbnail.ordinal !== 0) ||
    (thumbnail &&
      (thumbnail.targetId !== target.targetId ||
        thumbnail.rootId !== target.rootId ||
        thumbnail.replyId !== target.replyId)) ||
    !(
      (raw.kind === 'reply' &&
        ['direct_root', 'direct_reply'].includes(String(raw.reason))) ||
      (raw.kind === 'like' && raw.reason === 'like') ||
      (raw.kind === 'subscription' && raw.reason === 'target_subscription')
    )
  )
    invalidRating();
  const actor =
    raw.kind === 'like' ? decodeRatingAuthor(raw.actor, target.targetId) : null;
  if (
    (actor && actor.mode !== 'named') ||
    (raw.kind === 'reply' && target.replyId === null) ||
    (raw.kind === 'subscription' &&
      ((raw.activity !== 'root' && raw.activity !== 'reply') ||
        (raw.activity === 'root') !== (target.replyId === null)))
  )
    invalidRating();
  return Object.freeze({
    ...common,
    ...(actor ? { actor } : {}),
    ...(raw.kind === 'subscription'
      ? { activity: raw.activity as 'root' | 'reply' }
      : {}),
    status: 'available',
    domain: 'ratings',
    kind: raw.kind as 'reply' | 'like' | 'subscription',
    reason: raw.reason as
      'direct_root' | 'direct_reply' | 'like' | 'target_subscription',
    target,
    preview: {
      body,
      author: decodeRatingAuthor(p.author, target.targetId),
      imageCount: p.imageCount,
      thumbnail,
    },
  });
}
