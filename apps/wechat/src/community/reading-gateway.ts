/** Detail/thread-only transport: no additional session, journal or authorization owner. */
import { ApiClient, type Endpoint } from '../api/client';
import { isUuid } from '../profile/contract';
import type { Cancellation } from '../platform/contracts';
import { HttpCommunityGateway, type CommentQuery } from './gateway';
import { cursor, exact, invalid } from './contract';
import {
  decodeReadingPost,
  decodeReadingComment,
  decodeReadingReply,
  decodeReadingComments,
  decodeReadingReplies,
  decodeReadingContext,
} from './reading-contract';
import { decodeSourcePresentation } from './text-source-read-contract';
import type { SourceKind } from './text-source-contract';
import type { CommunityRuntime } from './runtime';
const endpoint = <T>(
  path: string,
  decode: Endpoint<T>['decode'],
): Endpoint<T> => ({
  path,
  decode,
  authentication: 'required',
  method: 'GET',
  successStatus: 200,
  authReplay: 'once',
});
const id = (value: string): string => {
  if (!isUuid(value)) invalid();
  return value;
};
const page = (after: string | null) => {
  if (!cursor(after)) invalid();
  return after ? { cursor: after } : {};
};
export class HttpReadingCommunityGateway extends HttpCommunityGateway {
  constructor(private readonly readingApi: ApiClient) {
    super(readingApi);
  }
  async textSource(kind: SourceKind, contentId: string, cancel: Cancellation) {
    if (
      !['post', 'comment', 'reply'].includes(kind) ||
      contentId !== contentId.toLowerCase()
    )
      invalid();
    const result = await this.readingApi.request(
      endpoint(
        `/v2/community/text-sources/${kind}/${id(contentId)}`,
        decodeSourcePresentation,
      ),
      { cancellation: cancel },
    );
    if (result.source.kind !== kind || result.source.id !== contentId)
      invalid();
    return result;
  }
  async readingPost(
    postId: string,
    cancel: Cancellation,
    viewSpaceId?: string,
  ) {
    const result = await this.readingApi.request(
      endpoint(`/v2/community/posts/${id(postId)}`, decodeReadingPost),
      {
        cancellation: cancel,
        ...(viewSpaceId !== undefined
          ? { query: { viewSpaceId: id(viewSpaceId) } }
          : {}),
      },
    );
    if (result.id !== postId) invalid();
    return result;
  }
  async readingComments(
    postId: string,
    after: string | null,
    cancel: Cancellation,
    query: CommentQuery = {},
  ) {
    if (
      Object.keys(query).some(
        (key) => !['sort', 'order', 'limit', 'previewLimit'].includes(key),
      ) ||
      (query.sort !== undefined && !['time', 'likes'].includes(query.sort)) ||
      (query.order !== undefined && !['asc', 'desc'].includes(query.order))
    )
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
    const result = await this.readingApi.request(
      endpoint(
        `/v2/community/posts/${id(postId)}/comments`,
        decodeReadingComments,
      ),
      {
        query: {
          ...page(after),
          limit,
          previewLimit,
          sort: query.sort ?? 'likes',
          order: query.order ?? 'desc',
        },
        cancellation: cancel,
      },
    );
    if (result.items.some((item) => item.postId !== postId)) invalid();
    return result;
  }
  async readingComment(commentId: string, cancel: Cancellation) {
    const result = await this.readingApi.request(
      endpoint(`/v2/community/comments/${id(commentId)}`, decodeReadingComment),
      { cancellation: cancel },
    );
    if (result.id !== commentId) invalid();
    return result;
  }
  async readingReply(replyId: string, cancel: Cancellation) {
    const result = await this.readingApi.request(
      endpoint(`/v2/community/replies/${id(replyId)}`, decodeReadingReply),
      { cancellation: cancel },
    );
    if (result.id !== replyId) invalid();
    return result;
  }
  async readingReplies(
    commentId: string,
    after: string | null,
    cancel: Cancellation,
    limit = 20,
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) invalid();
    const result = await this.readingApi.request(
      endpoint(
        `/v2/community/comments/${id(commentId)}/replies`,
        decodeReadingReplies,
      ),
      { query: { ...page(after), limit }, cancellation: cancel },
    );
    if (result.items.some((item) => item.rootCommentId !== commentId))
      invalid();
    return result;
  }
  async readingContext(
    postId: string,
    target: { commentId: string } | { replyId: string },
    cancel: Cancellation,
  ) {
    exact(target, 'commentId' in target ? ['commentId'] : ['replyId']);
    const query =
      'commentId' in target
        ? { commentId: id(target.commentId) }
        : { replyId: id(target.replyId) };
    const result = await this.readingApi.request(
      endpoint(
        `/v2/community/posts/${id(postId)}/discussion-context`,
        decodeReadingContext,
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
  override post(...args: Parameters<HttpCommunityGateway['post']>) {
    return this.readingPost(...args);
  }
  override comments(...args: Parameters<HttpCommunityGateway['comments']>) {
    return this.readingComments(...args);
  }
  override comment(...args: Parameters<HttpCommunityGateway['comment']>) {
    return this.readingComment(...args);
  }
  override replies(...args: Parameters<HttpCommunityGateway['replies']>) {
    return this.readingReplies(...args);
  }
  override reply(...args: Parameters<HttpCommunityGateway['reply']>) {
    return this.readingReply(...args);
  }
  override discussionContext(
    ...args: Parameters<HttpCommunityGateway['discussionContext']>
  ) {
    return this.readingContext(...args);
  }
}
/** Feature facade shares every store/lifecycle and the original authenticated ApiClient.
 * API denial is terminal; no retry through a legacy or guest reader. */
export function withReadingSources(
  runtime: CommunityRuntime,
  api: ApiClient | undefined,
): CommunityRuntime {
  return api && runtime.gateway
    ? { ...runtime, gateway: new HttpReadingCommunityGateway(api) }
    : runtime;
}
