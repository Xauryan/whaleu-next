import { isRecord } from '../api/errors';
import { isUuid } from '../profile/contract';
import {
  cursor,
  decodeAuthor,
  decodeComment,
  decodeCommentIntent,
  exact,
  invalid,
  type Author,
  type CommentIntent,
  type MediaView,
  type Post,
} from './contract';
export interface ReplyIntent extends CommentIntent {
  readonly targetReplyId: string | null;
}
export interface Reply {
  readonly id: string;
  readonly postId: string;
  readonly rootCommentId: string;
  readonly target:
    | {
        readonly kind: 'comment' | 'reply';
        readonly id: string;
        readonly status: 'available';
        readonly author: Author;
      }
    | { readonly status: 'unavailable' };
  readonly text: string;
  readonly images: readonly MediaView[];
  readonly author: Author;
  readonly createdAt: string;
  readonly likeCount: number;
  readonly viewer: {
    readonly isSelf: boolean;
    readonly canDelete: boolean;
    readonly isLiked: boolean;
  };
}
export interface Replies {
  readonly items: readonly Reply[];
  readonly nextCursor: string | null;
}
export interface DiscussionContext {
  readonly comment: import('./contract').Comment;
  readonly reply: Reply | null;
  readonly replies: Replies;
}
export type DiscussionOperation =
  'set_comment_like' | 'set_reply_like' | 'set_comment_pin';
export type DiscussionReceipt =
  | {
      readonly requestId: string;
      readonly operation: DiscussionOperation;
      readonly outcome: 'applied';
      readonly resourceId: string;
      readonly desired: boolean;
    }
  | {
      readonly requestId: string;
      readonly operation: DiscussionOperation;
      readonly outcome: 'rejected';
      readonly code: string;
    };
export function decodeReplyIntent(value: unknown): ReplyIntent {
  exact(value, [
    'clientRequestId',
    'text',
    'imageAssetIds',
    'authorMode',
    'targetReplyId',
  ]);
  if (!(value.targetReplyId === null || isUuid(value.targetReplyId))) invalid();
  const { targetReplyId, ...base } = value;
  return Object.freeze({ ...decodeCommentIntent(base), targetReplyId });
}
export function decodeReply(value: unknown): Reply {
  exact(value, [
    'id',
    'postId',
    'rootCommentId',
    'target',
    'text',
    'images',
    'author',
    'createdAt',
    'likeCount',
    'viewer',
  ]);
  exact(value.viewer, ['isSelf', 'canDelete', 'isLiked']);
  if (!isRecord(value.target)) invalid();
  const available = value.target.status === 'available';
  exact(
    value.target,
    available ? ['kind', 'id', 'status', 'author'] : ['status'],
  );
  if (!available && value.target.status !== 'unavailable') invalid();
  if (
    !isUuid(value.rootCommentId) ||
    value.id === value.rootCommentId ||
    (available &&
      (!isUuid(value.target.id) ||
        !['comment', 'reply'].includes(String(value.target.kind)) ||
        (value.target.kind === 'comment' &&
          value.target.id !== value.rootCommentId) ||
        value.target.id === value.id))
  )
    invalid();
  const base = decodeComment({
    id: value.id,
    postId: value.postId,
    text: value.text,
    images: value.images,
    author: value.author,
    createdAt: value.createdAt,
    likeCount: value.likeCount,
    replyCount: 0,
    isPinned: false,
    replyPreview: { items: [], nextCursor: null },
    viewer: { ...value.viewer, canPin: false },
  });
  return Object.freeze({
    id: base.id,
    postId: base.postId,
    rootCommentId: value.rootCommentId,
    target: available
      ? Object.freeze({
          kind: value.target.kind as 'comment' | 'reply',
          id: value.target.id as string,
          status: 'available' as const,
          author: decodeAuthor(value.target.author),
        })
      : Object.freeze({ status: 'unavailable' as const }),
    text: base.text,
    images: base.images,
    author: base.author,
    createdAt: base.createdAt,
    likeCount: base.likeCount,
    viewer: Object.freeze({
      isSelf: base.viewer.isSelf,
      canDelete: base.viewer.canDelete,
      isLiked: base.viewer.isLiked,
    }),
  });
}
export function decodeReplies(value: unknown): Replies {
  exact(value, ['items', 'nextCursor']);
  if (
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    !cursor(value.nextCursor)
  )
    invalid();
  const items = value.items.map(decodeReply);
  if (new Set(items.map((item) => item.id)).size !== items.length) invalid();
  return Object.freeze({
    items: Object.freeze(items),
    nextCursor: value.nextCursor,
  });
}
export function decodeDiscussionReceipt(value: unknown): DiscussionReceipt {
  if (!isRecord(value)) invalid();
  const applied = value.outcome === 'applied';
  exact(
    value,
    applied
      ? ['requestId', 'operation', 'outcome', 'resourceId', 'desired']
      : ['requestId', 'operation', 'outcome', 'code'],
  );
  if (
    !isUuid(value.requestId) ||
    value.requestId[14] !== '4' ||
    !['set_comment_like', 'set_reply_like', 'set_comment_pin'].includes(
      String(value.operation),
    )
  )
    invalid();
  if (applied) {
    if (!isUuid(value.resourceId) || typeof value.desired !== 'boolean')
      invalid();
    return Object.freeze({
      requestId: value.requestId,
      operation: value.operation as DiscussionOperation,
      outcome: 'applied',
      resourceId: value.resourceId,
      desired: value.desired,
    });
  }
  if (
    value.outcome !== 'rejected' ||
    ![
      'COMMUNITY_SCOPE_UNAVAILABLE',
      'PHONE_VERIFICATION_REQUIRED',
      'COMMUNITY_ACTION_RESTRICTED',
      'POST_NOT_FOUND',
      'POST_DELETED',
      'COMMENT_NOT_FOUND',
      'REPLY_NOT_FOUND',
      'COMMENT_PIN_CONFLICT',
      'COMMENT_PIN_FORBIDDEN',
    ].includes(String(value.code))
  )
    invalid();
  return Object.freeze({
    requestId: value.requestId,
    operation: value.operation as DiscussionOperation,
    outcome: 'rejected',
    code: value.code as string,
  });
}
export function decodeDiscussionContext(value: unknown): DiscussionContext {
  exact(value, ['comment', 'reply', 'replies']);
  const comment = decodeComment(value.comment),
    reply = value.reply === null ? null : decodeReply(value.reply),
    replies = decodeReplies(value.replies);
  if (
    (reply &&
      (reply.rootCommentId !== comment.id ||
        reply.postId !== comment.postId)) ||
    replies.items.some(
      (item) =>
        item.rootCommentId !== comment.id || item.postId !== comment.postId,
    )
  )
    invalid();
  return Object.freeze({ comment, reply, replies });
}
export function checkDiscussionPrivacy(
  post: Post,
  authors: readonly Author[],
): void {
  if (
    post.author.kind === 'named' &&
    authors.some((author) => author.kind === 'anonymous' && author.isPostAuthor)
  )
    invalid();
}
