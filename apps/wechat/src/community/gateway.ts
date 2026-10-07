import { ApiClient, type Endpoint } from '../api/client';
import type { Cancellation } from '../platform/contracts';
import { isUuid } from '../profile/contract';
import {
  cursor,
  decodeCapabilities,
  decodeCommentCapabilities,
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
  isCategory,
  uuid4,
  type Capabilities,
  type CommentCapabilities,
  type Category,
  type CommentIntent,
  type Comments,
  type Feed,
  type Like,
  type OwnPublications,
  type Post,
  type PostIntent,
  type Receipt,
  type Spaces,
} from './contract';
export interface FeedQuery {
  readonly spaceId: string;
  readonly category?: Category;
  readonly cursor?: string;
}
export interface CommunityGateway {
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
  ): Promise<Comments> {
    const result = await this.api.request(
      endpoint(`/v1/community/posts/${id(postId)}/comments`, decodeComments),
      { query: page(after), cancellation: cancel },
    );
    if (result.items.some((item) => item.postId !== postId)) invalid();
    return result;
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
    const result = await this.api.request(
      endpoint('/v1/community/posts', decodeReceipt, 'required', 'POST', 201),
      {
        body: { ...checked, imageAssetIds: [...checked.imageAssetIds] },
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
