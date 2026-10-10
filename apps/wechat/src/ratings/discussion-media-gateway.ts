import { decodeRatingLikeState } from './like-contract';
import { decodeDiscussionNotice } from './discussion-media-read-contract';
import type { ApiClient } from '../api/client';
import { ClientError, isRecord } from '../api/errors';
import type { Decoder } from '../api/envelopes';
import type { SessionStore } from '../auth/session';
import type { MediaSession } from '../media/contracts';
import type { Cancellation, Json, Method } from '../platform/contracts';
import { invalidRating } from './contract';
import {
  canonicalRatingScopedJson,
  decodeRatingScopedContextRequest,
  type RatingScopedContextRequest,
} from './scoped-contract';
import { ratingPageQuery } from './discussion-gateway';
import {
  decodeRatingDiscussionMediaContext,
  decodeRatingDiscussionMediaIntent,
  decodeRatingDiscussionMediaPreparation,
  decodeRatingDiscussionMediaReceipt,
  discussionMediaId as id,
  matchRatingDiscussionMediaReceipt,
  ratingDiscussionMediaIntentHash,
  type RatingDiscussionMediaContext,
  type RatingDiscussionMediaIntent,
  type RatingDiscussionMediaReceipt,
} from './discussion-media-contract';
import {
  decodeRatingDiscussionBatchIdentity,
  ratingDiscussionBatchIdentityHash,
  type RatingDiscussionBatchIdentity,
} from './discussion-media-batch-contract';
import {
  RATING_DISCUSSION_WIRE_PROTOCOL as protocol,
  decodeDiscussionBatchRecovery,
  decodeDiscussionBatchStatus,
  decodeDiscussionGrant,
  decodeDiscussionMemberRecovery,
  decodeDiscussionMemberStatus,
  type DiscussionBatchStatus,
  type DiscussionMemberPrepare,
} from './discussion-media-wire';
import {
  decodeDiscussionCommentPage,
  decodeDiscussionThread,
  decodeDiscussionReplyPage,
  decodeDiscussionRoot,
  decodeDiscussionReply,
  decodeDiscussionReplyPosition,
  decodeDiscussionComposerContext,
  type DiscussionContent,
} from './discussion-media-read-contract';
const commands = '/v4/ratings/discussion',
  media = '/v3/media/ratings-discussion';
/** Authentication and epoch checks surround every response. No context2/3 is
 * converted to context4; the server must explicitly issue the latter. */
export class HttpRatingDiscussionMediaGateway {
  constructor(
    private readonly api: ApiClient,
    private readonly sessions: SessionStore,
  ) {}
  private async request<T>(
    path: string,
    method: Method,
    decode: Decoder<T>,
    cancel: Cancellation,
    body?: unknown,
    query?: Record<string, string | number>,
    session?: MediaSession,
  ): Promise<T> {
    const owner = session?.current() ?? this.sessions.snapshot();
    if (!owner.credentials)
      throw new ClientError(
        'auth-required',
        'Original Ratings account required',
      );
    const value = await this.api.request(
      {
        path,
        method,
        decode,
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
      },
      {
        cancellation: cancel,
        ...(body === undefined
          ? {}
          : { body: JSON.parse(JSON.stringify(body)) as Json }),
        ...(query ? { query } : {}),
      },
    );
    this.sessions.assertCurrent(owner);
    session?.current();
    if (cancel.isCancelled)
      throw new ClientError('cancelled', 'Ratings discussion changed');
    return value;
  }
  async context(raw: RatingScopedContextRequest, cancel: Cancellation) {
    const request = decodeRatingScopedContextRequest(raw),
      actor = this.sessions.snapshot().credentials?.accountId;
    if (request.purpose !== 'read' && request.purpose !== 'interact')
      invalidRating();
    const value = await this.request(
      `${commands}/contexts`,
      'POST',
      decodeRatingDiscussionMediaContext,
      cancel,
      request,
    );
    if (
      value.actorId !== actor ||
      value.purpose !== request.purpose ||
      value.mode !== request.mode ||
      canonicalRatingScopedJson(value.selector) !==
        canonicalRatingScopedJson(request.selector)
    )
      invalidRating();
    return value;
  }
  private query(
    raw: RatingDiscussionMediaContext,
    purpose: 'read' | 'interact' = 'read',
  ) {
    const context = decodeRatingDiscussionMediaContext(raw);
    if (
      context.purpose !== purpose ||
      context.mode !== 'public' ||
      context.actorId !== this.sessions.snapshot().credentials?.accountId
    )
      invalidRating();
    return { contextId: context.id, contextToken: context.token };
  }
  private matchPage(
    context: RatingDiscussionMediaContext,
    page: {
      readonly context: {
        readonly contextId: string;
        readonly catalogRevision: string;
        readonly protocolGeneration: string;
        readonly selector: unknown;
      };
    },
    items: readonly DiscussionContent[],
  ) {
    if (
      context.heads.length !== 1 ||
      page.context.contextId !== context.id ||
      page.context.catalogRevision !== context.heads[0]!.catalogRevision ||
      page.context.protocolGeneration !== context.protocolGeneration ||
      canonicalRatingScopedJson(page.context.selector) !==
        canonicalRatingScopedJson(context.selector)
    )
      invalidRating();
    for (const item of items)
      if (
        item.images.some(
          (image) =>
            image.contextId !== context.id ||
            image.contextToken !== context.token,
        )
      )
        invalidRating();
  }
  async like(
    context: RatingDiscussionMediaContext,
    subjectId: string,
    kind: 'comment' | 'reply',
    cancel: Cancellation,
  ) {
    const value = await this.request(
      `${commands}/likes/${kind}/${id(subjectId)}`,
      'GET',
      decodeRatingLikeState,
      cancel,
      undefined,
      this.query(context),
    );
    if (
      value.status === 'known' &&
      (kind === 'comment'
        ? value.rootId !== subjectId || value.replyId !== null
        : value.replyId !== subjectId)
    )
      invalidRating();
    return value;
  }
  async notice(
    context: RatingDiscussionMediaContext,
    noticeId: string,
    kind: 'updates' | 'like-updates' | 'subscription-updates',
    cancel: Cancellation,
  ) {
    const value = await this.request(
      `${commands}/notices/${kind}/${id(noticeId)}`,
      'GET',
      decodeDiscussionNotice,
      cancel,
      undefined,
      this.query(context),
    );
    if (
      value.noticeId !== noticeId ||
      (value.status === 'available' &&
        (canonicalRatingScopedJson(value.target.selector) !==
          canonicalRatingScopedJson(context.selector) ||
          value.target.protocolGeneration !== context.protocolGeneration ||
          (value.preview.thumbnail &&
            (value.preview.thumbnail.contextId !== context.id ||
              value.preview.thumbnail.contextToken !== context.token))))
    )
      invalidRating();
    return value;
  }
  async composer(
    context: RatingDiscussionMediaContext,
    targetId: string,
    rootId: string | null,
    cancel: Cancellation,
  ) {
    const value = await this.request(
      `${commands}/targets/${id(targetId)}/composer-context`,
      'GET',
      decodeDiscussionComposerContext,
      cancel,
      undefined,
      {
        ...this.query(context, 'interact'),
        ...(rootId ? { rootId: id(rootId) } : {}),
      },
    );
    if (
      value.contextId !== context.id ||
      value.targetId !== targetId ||
      (value.root?.id ?? null) !== rootId
    )
      invalidRating();
    return value;
  }
  async comments(
    context: RatingDiscussionMediaContext,
    targetId: string,
    cursor: string | null,
    cancel: Cancellation,
    sort: 'time' | 'likes' = 'time',
    order: 'asc' | 'desc' = 'desc',
  ) {
    if (!['time', 'likes'].includes(sort) || !['asc', 'desc'].includes(order))
      invalidRating();
    const page = await this.request(
      `${commands}/targets/${id(targetId)}/comments`,
      'GET',
      decodeDiscussionCommentPage,
      cancel,
      undefined,
      { ...this.query(context), ...ratingPageQuery(cursor, 20), sort, order },
    );
    this.matchPage(context, page, page.items);
    if (
      page.context.targetId !== targetId ||
      (cursor !== null && page.nextCursor === cursor)
    )
      invalidRating();
    return page;
  }
  async thread(
    context: RatingDiscussionMediaContext,
    rootId: string,
    cancel: Cancellation,
  ) {
    const value = await this.request(
      `${commands}/comments/${id(rootId)}/thread`,
      'GET',
      decodeDiscussionThread,
      cancel,
      undefined,
      this.query(context),
    );
    this.matchPage(context, value, [value.root]);
    if (value.root.id !== rootId) invalidRating();
    return value;
  }
  async replies(
    context: RatingDiscussionMediaContext,
    rootId: string,
    cursor: string | null,
    cancel: Cancellation,
  ) {
    const page = await this.request(
      `${commands}/comments/${id(rootId)}/replies`,
      'GET',
      decodeDiscussionReplyPage,
      cancel,
      undefined,
      { ...this.query(context), ...ratingPageQuery(cursor, 20) },
    );
    this.matchPage(context, page, page.items);
    if (
      page.context.rootId !== rootId ||
      (cursor !== null && page.nextCursor === cursor)
    )
      invalidRating();
    return page;
  }
  async position(
    context: RatingDiscussionMediaContext,
    replyId: string,
    cancel: Cancellation,
  ) {
    const value = await this.request(
      `${commands}/replies/${id(replyId)}/position`,
      'GET',
      decodeDiscussionReplyPosition,
      cancel,
      undefined,
      { ...this.query(context), limit: 20 },
    );
    this.matchPage(context, value.page, value.page.items);
    if (value.anchorReplyId !== replyId) invalidRating();
    return value;
  }
  async subject(
    context: RatingDiscussionMediaContext,
    subjectId: string,
    kind: 'root' | 'reply',
    cancel: Cancellation,
  ) {
    const value =
      kind === 'root'
        ? await this.request(
            `${commands}/comments/${id(subjectId)}`,
            'GET',
            decodeDiscussionRoot,
            cancel,
            undefined,
            this.query(context),
          )
        : await this.request(
            `${commands}/replies/${id(subjectId)}`,
            'GET',
            decodeDiscussionReply,
            cancel,
            undefined,
            this.query(context),
          );
    if (
      value.id !== subjectId ||
      value.images.some(
        (image) =>
          image.contextId !== context.id ||
          image.contextToken !== context.token,
      )
    )
      invalidRating();
    return value;
  }
  async receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<RatingDiscussionMediaReceipt> {
    const value = await this.request(
      `${commands}/receipts/${id(requestId)}`,
      'GET',
      decodeRatingDiscussionMediaReceipt,
      cancel,
    );
    if (value.requestId !== requestId) invalidRating();
    return value;
  }
  async command(
    raw: RatingDiscussionMediaIntent,
    cancel: Cancellation,
  ): Promise<RatingDiscussionMediaReceipt> {
    const intent = decodeRatingDiscussionMediaIntent(raw);
    const preparation = await this.request(
      `${commands}/prepare`,
      'POST',
      (v) =>
        isRecord(v) && 'outcome' in v
          ? decodeRatingDiscussionMediaReceipt(v)
          : decodeRatingDiscussionMediaPreparation(v),
      cancel,
      intent,
    );
    if ('outcome' in preparation) {
      matchRatingDiscussionMediaReceipt(intent, preparation);
      return preparation;
    }
    if (
      ratingDiscussionMediaIntentHash(preparation.intent) !==
        ratingDiscussionMediaIntentHash(intent) ||
      Date.parse(preparation.validUntil) <= Date.now()
    )
      invalidRating();
    const receipt = await this.request(
      `${commands}/commit`,
      'POST',
      decodeRatingDiscussionMediaReceipt,
      cancel,
      { ...intent, preparationContextRevision: preparation.contextRevision },
    );
    matchRatingDiscussionMediaReceipt(intent, receipt);
    if (
      receipt.outcome === 'applied' &&
      (receipt.result.revision !== preparation.subjectRevision ||
        (receipt.operation === 'create_comment_scoped'
          ? receipt.result.subjectId
          : receipt.result.replyId) !== preparation.subjectId)
    )
      invalidRating();
    return receipt;
  }
  async cancelByHash(
    requestId: string,
    operation: 'create_comment_scoped' | 'create_reply_scoped',
    intentHash: string,
    cancel: Cancellation,
  ): Promise<RatingDiscussionMediaReceipt> {
    const receipt = await this.request(
      `${commands}/requests/${id(requestId)}/cancel`,
      'POST',
      decodeRatingDiscussionMediaReceipt,
      cancel,
      { protocolVersion: 4, operation, intentHash },
    );
    if (
      receipt.requestId !== requestId ||
      receipt.operation !== operation ||
      receipt.intentHash !== intentHash
    )
      invalidRating();
    return receipt;
  }
  async cancelCommand(raw: RatingDiscussionMediaIntent, cancel: Cancellation) {
    const intent = decodeRatingDiscussionMediaIntent(raw),
      receipt = await this.request(
        `${commands}/cancel`,
        'POST',
        decodeRatingDiscussionMediaReceipt,
        cancel,
        intent,
      );
    matchRatingDiscussionMediaReceipt(intent, receipt);
    return receipt;
  }
  async batch(
    identity: RatingDiscussionBatchIdentity,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    const value = await this.request(
      `${media}/batches`,
      'POST',
      decodeDiscussionBatchStatus,
      cancel,
      decodeRatingDiscussionBatchIdentity(identity),
      undefined,
      session,
    );
    this.matchBatch(identity, value, session);
    return value;
  }
  matchBatch(
    identity: RatingDiscussionBatchIdentity,
    status: DiscussionBatchStatus,
    session: MediaSession,
  ): void {
    if (
      canonicalRatingScopedJson(identity) !==
        canonicalRatingScopedJson(status.identity) ||
      status.batchIdentityHash !==
        ratingDiscussionBatchIdentityHash(
          session.current().credentials!.accountId,
          identity,
        )
    )
      invalidRating();
  }
  recoverBatch(requestId: string, session: MediaSession, cancel: Cancellation) {
    return this.request(
      `${media}/batch-requests/${id(requestId)}`,
      'GET',
      decodeDiscussionBatchRecovery,
      cancel,
      undefined,
      undefined,
      session,
    );
  }
  cancelBatchRequest(
    requestId: string,
    identityHash: string,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    return this.request(
      `${media}/batch-requests/${id(requestId)}/cancel`,
      'POST',
      decodeDiscussionBatchRecovery,
      cancel,
      { protocol, identityHash },
      undefined,
      session,
    );
  }
  statusBatch(batchId: string, session: MediaSession, cancel: Cancellation) {
    return this.request(
      `${media}/batches/${id(batchId)}`,
      'GET',
      decodeDiscussionBatchStatus,
      cancel,
      undefined,
      undefined,
      session,
    );
  }
  mutateBatch(
    status: DiscussionBatchStatus,
    action: 'seal' | 'remove' | 'cancel',
    session: MediaSession,
    cancel: Cancellation,
    orderedMemberIds?: readonly string[],
    memberId?: string,
  ) {
    return this.request(
      `${media}/batches/${status.batchId}/${action}`,
      'POST',
      decodeDiscussionBatchStatus,
      cancel,
      {
        protocol,
        batchIdentityHash: status.batchIdentityHash,
        expectedRevision: status.revision,
        ...(action === 'seal'
          ? { batchId: status.batchId, orderedMemberIds }
          : {}),
        ...(action === 'remove' ? { memberId } : {}),
      },
      undefined,
      session,
    );
  }
  prepareMember(
    value: DiscussionMemberPrepare,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    return this.request(
      `${media}/members`,
      'POST',
      decodeDiscussionMemberStatus,
      cancel,
      value,
      undefined,
      session,
    );
  }
  recoverMember(
    requestId: string,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    return this.request(
      `${media}/upload-requests/${id(requestId)}`,
      'GET',
      decodeDiscussionMemberRecovery,
      cancel,
      undefined,
      undefined,
      session,
    );
  }
  cancelMemberRequest(
    requestId: string,
    requestHash: string,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    return this.request(
      `${media}/upload-requests/${id(requestId)}/cancel`,
      'POST',
      decodeDiscussionMemberRecovery,
      cancel,
      { protocol, requestHash },
      undefined,
      session,
    );
  }
  member(memberId: string, session: MediaSession, cancel: Cancellation) {
    return this.request(
      `${media}/members/${id(memberId)}`,
      'GET',
      decodeDiscussionMemberStatus,
      cancel,
      undefined,
      undefined,
      session,
    );
  }
  grant(memberId: string, session: MediaSession, cancel: Cancellation) {
    return this.request(
      `${media}/members/${id(memberId)}/grant`,
      'POST',
      decodeDiscussionGrant,
      cancel,
      {},
      undefined,
      session,
    );
  }
  finalize(memberId: string, session: MediaSession, cancel: Cancellation) {
    return this.request(
      `${media}/members/${id(memberId)}/finalize`,
      'POST',
      decodeDiscussionMemberStatus,
      cancel,
      {},
      undefined,
      session,
    );
  }
}
export type RatingDiscussionMediaGateway = Pick<
  HttpRatingDiscussionMediaGateway,
  keyof HttpRatingDiscussionMediaGateway
>;
