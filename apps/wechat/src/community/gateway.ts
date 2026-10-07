import { ApiClient, type Endpoint } from '../api/client';
import type { Cancellation } from '../platform/contracts';
import { isUuid } from '../profile/contract';
import {
  cursor,
  decodeCapabilities,
  decodeCommentCapabilities,
  decodeComment,
  decodeCommentIntent,
  decodeComments,
  decodeFeed,
  decodeLike,
  decodeOwnPublications,
  decodePost,
  decodePostIntent,
  decodeReceipt,
  decodeSpaces,
  invalid,
  exact,
  isCategory,
  uuid4,
  type Capabilities,
  type CommentCapabilities,
  type Category,
  type CommentIntent,
  type Comment,
  type Comments,
  type Feed,
  type Like,
  type OwnPublications,
  type Post,
  type PostIntent,
  type Receipt,
  type Spaces,
} from './contract';
import {
  decodeBallotIntent,
  decodeBallotReceipt,
  decodeOwnBallot,
  decodePoll,
  type BallotIntent,
  type BallotReceipt,
  type OwnBallot,
  type Poll,
} from './poll-contract';
import {
  decodeReply,
  decodeReplies,
  decodeReplyIntent,
  decodeDiscussionReceipt,
  decodeDiscussionContext,
  type Reply,
  type Replies,
  type ReplyIntent,
  type DiscussionReceipt,
  type DiscussionContext,
} from './discussion-contract';
export interface CommentQuery {
  readonly sort?: 'time' | 'likes';
  readonly order?: 'asc' | 'desc';
  readonly limit?: number;
  readonly previewLimit?: number;
}
export interface FeedQuery {
  readonly spaceId: string;
  readonly category?: Category;
  readonly cursor?: string;
}
export interface CommunityGateway {
  comment(commentId: string, cancel: Cancellation): Promise<Comment>;
  reply(replyId: string, cancel: Cancellation): Promise<Reply>;
  replies(
    commentId: string,
    after: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<Replies>;
  publishReply(
    commentId: string,
    intent: ReplyIntent,
    cancel: Cancellation,
  ): Promise<Receipt>;
  discussionLike(
    kind: 'comment' | 'reply',
    targetId: string,
    liked: boolean,
    requestId: string,
    cancel: Cancellation,
  ): Promise<DiscussionReceipt>;
  pinComment(
    postId: string,
    commentId: string,
    pinned: boolean,
    requestId: string,
    cancel: Cancellation,
  ): Promise<DiscussionReceipt>;
  deleteReply(replyId: string, cancel: Cancellation): Promise<void>;
  discussionReceipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<DiscussionReceipt>;
  discussionContext(
    postId: string,
    target: { commentId: string } | { replyId: string },
    cancel: Cancellation,
  ): Promise<DiscussionContext>;
  poll(postId: string, cancel: Cancellation): Promise<Poll>;
  castBallot(
    postId: string,
    intent: BallotIntent,
    cancel: Cancellation,
  ): Promise<BallotReceipt>;
  ballotReceipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<BallotReceipt>;
  ownBallot(postId: string, cancel: Cancellation): Promise<OwnBallot>;
  spaces(campusId: string, cancel: Cancellation): Promise<Spaces>;
  capabilities(
    spaceId: string,
    category: Category,
    cancel: Cancellation,
  ): Promise<Capabilities>;
  commentCapabilities(
    postId: string,
    cancel: Cancellation,
  ): Promise<CommentCapabilities>;
  feed(query: FeedQuery, cancel: Cancellation): Promise<Feed>;
  post(postId: string, cancel: Cancellation): Promise<Post>;
  comments(
    postId: string,
    after: string | null,
    cancel: Cancellation,
    query?: CommentQuery,
  ): Promise<Comments>;
  mine(after: string | null, cancel: Cancellation): Promise<OwnPublications>;
  publishPost(intent: PostIntent, cancel: Cancellation): Promise<Receipt>;
  publishComment(
    postId: string,
    intent: CommentIntent,
    cancel: Cancellation,
  ): Promise<Receipt>;
  receipt(requestId: string, cancel: Cancellation): Promise<Receipt>;
  like(postId: string, liked: boolean, cancel: Cancellation): Promise<Like>;
  deletePost(postId: string, cancel: Cancellation): Promise<void>;
  deleteComment(commentId: string, cancel: Cancellation): Promise<void>;
}
const endpoint = <T>(
  path: string,
  decode: Endpoint<T>['decode'],
  authentication: Endpoint<T>['authentication'] = 'required',
  method: Endpoint<T>['method'] = 'GET',
  successStatus = 200,
): Endpoint<T> => ({
  path,
  decode,
  authentication,
  method,
  successStatus,
  authReplay: 'once',
});
const id = (value: string): string => {
  if (!isUuid(value)) invalid();
  return value;
};
const page = (after: string | null) => {
  if (!cursor(after)) invalid();
  return { limit: 10, ...(after ? { cursor: after } : {}) };
};
export class HttpCommunityGateway implements CommunityGateway {
  constructor(private readonly api: ApiClient) {}
  async comment(commentId: string, cancel: Cancellation): Promise<Comment> {
    const result = await this.api.request(
      endpoint(`/v1/community/comments/${id(commentId)}`, decodeComment),
      { cancellation: cancel },
    );
    if (result.id !== commentId) invalid();
    return result;
  }
  async reply(replyId: string, cancel: Cancellation): Promise<Reply> {
    const result = await this.api.request(
      endpoint(`/v1/community/replies/${id(replyId)}`, decodeReply),
      { cancellation: cancel },
    );
    if (result.id !== replyId) invalid();
    return result;
  }
  async replies(
    commentId: string,
    after: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<Replies> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) invalid();
    const result = await this.api.request(
      endpoint(
        `/v1/community/comments/${id(commentId)}/replies`,
        decodeReplies,
      ),
      { query: { ...page(after), limit }, cancellation: cancel },
    );
    if (result.items.some((item) => item.rootCommentId !== commentId))
      invalid();
    return result;
  }
  async publishReply(
    commentId: string,
    intent: ReplyIntent,
    cancel: Cancellation,
  ): Promise<Receipt> {
    const checked = decodeReplyIntent(intent);
    const result = await this.api.request(
      endpoint(
        `/v1/community/comments/${id(commentId)}/replies`,
        decodeReceipt,
        'required',
        'POST',
        201,
      ),
      {
        body: { ...checked, imageAssetIds: [...checked.imageAssetIds] },
        cancellation: cancel,
      },
    );
    if (
      result.requestId !== checked.clientRequestId ||
      result.operation !== 'publish_reply'
    )
      invalid();
    return result;
  }
  async discussionLike(
    kind: 'comment' | 'reply',
    targetId: string,
    liked: boolean,
    requestId: string,
    cancel: Cancellation,
  ): Promise<DiscussionReceipt> {
    if (
      !['comment', 'reply'].includes(kind) ||
      typeof liked !== 'boolean' ||
      !uuid4(requestId)
    )
      invalid();
    const result = await this.api.request(
      endpoint(
        `/v1/community/${kind === 'comment' ? 'comments' : 'replies'}/${id(targetId)}/like`,
        decodeDiscussionReceipt,
        'required',
        liked ? 'PUT' : 'DELETE',
      ),
      { body: { clientRequestId: requestId }, cancellation: cancel },
    );
    this.checkDiscussionReceipt(
      result,
      requestId,
      kind === 'comment' ? 'set_comment_like' : 'set_reply_like',
      targetId,
      liked,
    );
    return result;
  }
  async pinComment(
    postId: string,
    commentId: string,
    pinned: boolean,
    requestId: string,
    cancel: Cancellation,
  ): Promise<DiscussionReceipt> {
    id(postId);
    if (typeof pinned !== 'boolean' || !uuid4(requestId)) invalid();
    const result = await this.api.request(
      endpoint(
        `/v1/community/comments/${id(commentId)}/pin`,
        decodeDiscussionReceipt,
        'required',
        pinned ? 'PUT' : 'DELETE',
      ),
      { body: { clientRequestId: requestId }, cancellation: cancel },
    );
    this.checkDiscussionReceipt(
      result,
      requestId,
      'set_comment_pin',
      commentId,
      pinned,
    );
    return result;
  }
  private checkDiscussionReceipt(
    result: DiscussionReceipt,
    requestId: string,
    operation: string,
    targetId: string,
    desired: boolean,
  ): void {
    if (
      result.requestId !== requestId ||
      result.operation !== operation ||
      (result.outcome === 'applied' &&
        (result.resourceId !== targetId || result.desired !== desired))
    )
      invalid();
  }
  async discussionReceipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<DiscussionReceipt> {
    if (!uuid4(requestId)) invalid();
    const result = await this.api.request(
      endpoint(
        `/v1/me/community/discussion-requests/${requestId}`,
        decodeDiscussionReceipt,
      ),
      { cancellation: cancel },
    );
    if (result.requestId !== requestId) invalid();
    return result;
  }
  async discussionContext(
    postId: string,
    target: { commentId: string } | { replyId: string },
    cancel: Cancellation,
  ): Promise<DiscussionContext> {
    exact(target, 'commentId' in target ? ['commentId'] : ['replyId']);
    const query =
      'commentId' in target
        ? { commentId: id(target.commentId) }
        : { replyId: id(target.replyId) };
    const result = await this.api.request(
      endpoint(
        `/v1/community/posts/${id(postId)}/discussion-context`,
        decodeDiscussionContext,
      ),
      { query, cancellation: cancel },
    );
    if (
      result.comment.postId !== postId ||
      ('commentId' in target
        ? result.comment.id !== target.commentId
        : result.reply?.id !== target.replyId)
    )
      invalid();
    return result;
  }
  deleteReply(replyId: string, cancel: Cancellation): Promise<void> {
    return this.remove(`/v1/community/replies/${id(replyId)}`, cancel);
  }
  async poll(postId: string, cancel: Cancellation): Promise<Poll> {
    const result = await this.api.request(
      endpoint(`/v1/community/posts/${id(postId)}/poll`, decodePoll),
      { cancellation: cancel },
    );
    if (result.postId !== postId) invalid();
    return result;
  }
  async castBallot(
    postId: string,
    intent: BallotIntent,
    cancel: Cancellation,
  ): Promise<BallotReceipt> {
    const checked = decodeBallotIntent(intent);
    const result = await this.api.request(
      endpoint(
        `/v1/community/posts/${id(postId)}/poll/ballots`,
        decodeBallotReceipt,
        'required',
        'POST',
        201,
      ),
      {
        body: { ...checked, optionIds: [...checked.optionIds] },
        cancellation: cancel,
      },
    );
    if (result.requestId !== checked.clientRequestId) invalid();
    return result;
  }
  async ballotReceipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<BallotReceipt> {
    if (!uuid4(requestId)) invalid();
    const result = await this.api.request(
      endpoint(
        `/v1/me/community/poll-requests/${requestId}`,
        decodeBallotReceipt,
      ),
      { cancellation: cancel },
    );
    if (result.requestId !== requestId) invalid();
    return result;
  }
  async ownBallot(postId: string, cancel: Cancellation): Promise<OwnBallot> {
    const result = await this.api.request(
      endpoint(`/v1/me/community/poll-ballots/${id(postId)}`, decodeOwnBallot),
      { cancellation: cancel },
    );
    if (result.postId !== postId) invalid();
    return result;
  }
  spaces(campusId: string, cancel: Cancellation): Promise<Spaces> {
    return this.api.request(
      endpoint('/v1/community/spaces', decodeSpaces, 'none'),
      { query: { campusId: id(campusId) }, cancellation: cancel },
    );
  }
  capabilities(
    spaceId: string,
    category: Category,
    cancel: Cancellation,
  ): Promise<Capabilities> {
    if (!isCategory(category)) invalid();
    return this.api.request(
      endpoint('/v1/community/capabilities', decodeCapabilities),
      { query: { spaceId: id(spaceId), category }, cancellation: cancel },
    );
  }
  commentCapabilities(
    postId: string,
    cancel: Cancellation,
  ): Promise<CommentCapabilities> {
    return this.api.request(
      endpoint(
        `/v1/community/posts/${id(postId)}/comment-capabilities`,
        decodeCommentCapabilities,
      ),
      { cancellation: cancel },
    );
  }
  async feed(query: FeedQuery, cancel: Cancellation): Promise<Feed> {
    if (query.category !== undefined && !isCategory(query.category)) invalid();
    const result = await this.api.request(
      endpoint('/v1/community/posts', decodeFeed, 'optional'),
      {
        query: {
          spaceId: id(query.spaceId),
          ...page(query.cursor ?? null),
          ...(query.category ? { category: query.category } : {}),
        },
        cancellation: cancel,
      },
    );
    if (
      result.items.some(
        (item) =>
          item.space.id !== query.spaceId ||
          (query.category && item.category !== query.category),
      )
    )
      invalid();
    return result;
  }
  async post(postId: string, cancel: Cancellation): Promise<Post> {
    const result = await this.api.request(
      endpoint(`/v1/community/posts/${id(postId)}`, decodePost),
      { cancellation: cancel },
    );
    if (result.id !== postId) invalid();
    return result;
  }
  async comments(
    postId: string,
    after: string | null,
    cancel: Cancellation,
    query?: CommentQuery,
  ): Promise<Comments> {
    const result = await this.api.request(
      endpoint(`/v1/community/posts/${id(postId)}/comments`, decodeComments),
      {
        query: { ...page(after), ...this.commentQuery(query) },
        cancellation: cancel,
      },
    );
    if (result.items.some((item) => item.postId !== postId)) invalid();
    return result;
  }
  private commentQuery(query: CommentQuery = {}): {
    sort: 'time' | 'likes';
    order: 'asc' | 'desc';
    previewLimit: number;
    limit: number;
  } {
    if (
      Object.keys(query).some(
        (key) => !['sort', 'order', 'limit', 'previewLimit'].includes(key),
      )
    )
      invalid();
    if (query.sort !== undefined && !['time', 'likes'].includes(query.sort))
      invalid();
    if (query.order !== undefined && !['asc', 'desc'].includes(query.order))
      invalid();
    const limit = query.limit ?? 10,
      previewLimit = query.previewLimit ?? 2;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 10 ||
      !Number.isInteger(previewLimit) ||
      previewLimit < 1 ||
      previewLimit > 5
    )
      invalid();
    return {
      sort: query.sort ?? 'likes',
      order: query.order ?? 'desc',
      previewLimit,
      limit,
    };
  }
  mine(after: string | null, cancel: Cancellation): Promise<OwnPublications> {
    return this.api.request(
      endpoint('/v1/me/community/posts', decodeOwnPublications),
      { query: page(after), cancellation: cancel },
    );
  }
  async publishPost(
    intent: PostIntent,
    cancel: Cancellation,
  ): Promise<Receipt> {
    const checked = decodePostIntent(intent);
    const { component, ...base } = checked;
    const result = await this.api.request(
      endpoint('/v1/community/posts', decodeReceipt, 'required', 'POST', 201),
      {
        body: {
          ...base,
          imageAssetIds: [...checked.imageAssetIds],
          ...(component
            ? {
                component:
                  component.kind === 'poll'
                    ? { ...component, options: [...component.options] }
                    : { kind: 'none' },
              }
            : {}),
        },
        cancellation: cancel,
      },
    );
    if (
      result.operation !== 'publish_post' ||
      result.requestId !== checked.clientRequestId
    )
      invalid();
    return result;
  }
  async publishComment(
    postId: string,
    intent: CommentIntent,
    cancel: Cancellation,
  ): Promise<Receipt> {
    const checked = decodeCommentIntent(intent);
    const result = await this.api.request(
      endpoint(
        `/v1/community/posts/${id(postId)}/comments`,
        decodeReceipt,
        'required',
        'POST',
        201,
      ),
      {
        body: { ...checked, imageAssetIds: [...checked.imageAssetIds] },
        cancellation: cancel,
      },
    );
    if (
      result.operation !== 'publish_comment' ||
      result.requestId !== checked.clientRequestId
    )
      invalid();
    return result;
  }
  async receipt(requestId: string, cancel: Cancellation): Promise<Receipt> {
    if (!uuid4(requestId)) invalid();
    const result = await this.api.request(
      endpoint(`/v1/me/community/requests/${requestId}`, decodeReceipt),
      { cancellation: cancel },
    );
    if (result.requestId !== requestId) invalid();
    return result;
  }
  async like(
    postId: string,
    liked: boolean,
    cancel: Cancellation,
  ): Promise<Like> {
    if (typeof liked !== 'boolean') invalid();
    const result = await this.api.request(
      endpoint(
        `/v1/community/posts/${id(postId)}/like`,
        decodeLike,
        'required',
        liked ? 'PUT' : 'DELETE',
      ),
      { cancellation: cancel },
    );
    if (result.postId !== postId || result.isLiked !== liked) invalid();
    return result;
  }
  deletePost(postId: string, cancel: Cancellation): Promise<void> {
    return this.remove(`/v1/community/posts/${id(postId)}`, cancel);
  }
  deleteComment(commentId: string, cancel: Cancellation): Promise<void> {
    return this.remove(`/v1/community/comments/${id(commentId)}`, cancel);
  }
  private remove(path: string, cancel: Cancellation): Promise<void> {
    return this.api.request(
      endpoint(
        path,
        (value) => {
          if (value !== undefined && value !== null && value !== '') invalid();
        },
        'required',
        'DELETE',
        204,
      ),
      { cancellation: cancel },
    );
  }
}
