import type { ApiClient } from '../api/client';
import { ClientError } from '../api/errors';
import type { Decoder } from '../api/envelopes';
import type { SessionStore } from '../auth/session';
import { exact } from '../community/contract';
import type { Cancellation, Json, Method } from '../platform/contracts';
import {
  decodeRatingTarget,
  decodeRatingComment,
  decodeRatingMyScore,
  decodeRatingSummary,
  invalidRating,
  ratingId,
  type RatingTarget,
  type RatingComment,
  type RatingMyScore,
  type RatingSummary,
} from './contract';
import { decodeRatingReply, type RatingReply } from './discussion-contract';
import { ratingPageQuery } from './discussion-gateway';
import { decodeRatingLikeState, type RatingLikeState } from './like-contract';
import {
  decodeRatingSubscriptionState,
  decodeRatingSubscriptionBatch,
  matchRatingSubscriptionBatch,
  type RatingSubscriptionState,
  type RatingSubscriptionBatch,
  type RatingSubscriptionTarget,
} from './subscription-contract';
import { ratingMinimumAverage } from './random-contract';
import {
  canonicalRatingScopedJson,
  decodeRatingScopedContext,
  decodeRatingScopedContextRequest,
  decodeRatingScopedIntent,
  decodeRatingScopedLocator,
  decodeRatingScopedPrepared,
  decodeRatingScopedReceipt,
  matchRatingScopedReceipt,
  ratingNavigationKey,
  ratingScopedIntentHash,
  type RatingScopedContext,
  type RatingScopedContextRequest,
  type RatingScopedIntent,
  type RatingScopedLocator,
  type RatingScopedPrepared,
  type RatingScopedReceipt,
} from './scoped-contract';
import {
  decodeRatingScopedCategoryPage,
  decodeRatingScopedTargetPage,
  decodeRatingScopedCommentPage,
  decodeRatingScopedDiscussion,
  decodeRatingScopedReplyPage,
  decodeRatingScopedReplyPosition,
  decodeRatingScopedSubscriptionPage,
  decodeRatingScopedRandomResult,
  decodeRatingScopedUpdatesPage,
  decodeRatingScopedNoticeTarget,
  decodeRatingScopedEditContext,
  matchRatingScopedPage,
  type RatingScopedCategoryPage,
  type RatingScopedTargetPage,
  type RatingScopedCommentPage,
  type RatingScopedDiscussion,
  type RatingScopedReplyPage,
  type RatingScopedReplyPosition,
  type RatingScopedSubscriptionPage,
  type RatingScopedRandomResult,
  type RatingScopedUpdatesPage,
  type RatingScopedNoticeKind,
  type RatingScopedNoticeTarget,
  type RatingScopedEditContext,
} from './scoped-read-contract';

export interface RatingScopedResolvedLocator {
  readonly locator: RatingScopedLocator;
  readonly context: RatingScopedContext;
}
export interface RatingScopedGateway {
  context(
    request: RatingScopedContextRequest,
    cancel: Cancellation,
  ): Promise<RatingScopedContext>;
  resolve(
    locator: RatingScopedLocator,
    purpose: 'read' | 'interact' | 'edit_target',
    cancel: Cancellation,
  ): Promise<RatingScopedResolvedLocator>;
  categories(
    context: RatingScopedContext,
    parentId: string | null,
    cursor: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<RatingScopedCategoryPage>;
  targets(
    context: RatingScopedContext,
    categoryId: string,
    cursor: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<RatingScopedTargetPage>;
  detail(
    context: RatingScopedContext,
    targetId: string,
    cancel: Cancellation,
  ): Promise<RatingTarget>;
  myScore(
    context: RatingScopedContext,
    targetId: string,
    cancel: Cancellation,
  ): Promise<RatingMyScore>;
  summary(
    context: RatingScopedContext,
    targetId: string,
    cancel: Cancellation,
  ): Promise<RatingSummary>;
  comments(
    context: RatingScopedContext,
    targetId: string,
    cursor: string | null,
    cancel: Cancellation,
    limit?: number,
    sort?: 'time' | 'likes',
    order?: 'asc' | 'desc',
  ): Promise<RatingScopedCommentPage>;
  comment(
    context: RatingScopedContext,
    rootId: string,
    cancel: Cancellation,
  ): Promise<RatingComment>;
  discussion(
    context: RatingScopedContext,
    rootId: string,
    cancel: Cancellation,
  ): Promise<RatingScopedDiscussion>;
  replies(
    context: RatingScopedContext,
    rootId: string,
    cursor: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<RatingScopedReplyPage>;
  reply(
    context: RatingScopedContext,
    replyId: string,
    cancel: Cancellation,
  ): Promise<RatingReply>;
  position(
    context: RatingScopedContext,
    replyId: string,
    cancel: Cancellation,
    limit?: number,
  ): Promise<RatingScopedReplyPosition>;
  commentLike(
    context: RatingScopedContext,
    rootId: string,
    cancel: Cancellation,
  ): Promise<RatingLikeState>;
  replyLike(
    context: RatingScopedContext,
    replyId: string,
    cancel: Cancellation,
  ): Promise<RatingLikeState>;
  subscription(
    context: RatingScopedContext,
    targetId: string,
    cancel: Cancellation,
  ): Promise<RatingSubscriptionState>;
  subscriptionStates(
    context: RatingScopedContext,
    targets: readonly RatingSubscriptionTarget[],
    cancel: Cancellation,
  ): Promise<RatingSubscriptionBatch>;
  subscriptions(
    context: RatingScopedContext,
    cursor: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<RatingScopedSubscriptionPage>;
  random(
    context: RatingScopedContext,
    categoryId: string,
    minimumAverage: number | null,
    cancel: Cancellation,
  ): Promise<RatingScopedRandomResult>;
  editContext(
    context: RatingScopedContext,
    targetId: string,
    cancel: Cancellation,
  ): Promise<RatingScopedEditContext>;
  prepare(
    intent: RatingScopedIntent,
    cancel: Cancellation,
  ): Promise<RatingScopedPrepared>;
  command(
    intent: RatingScopedIntent,
    cancel: Cancellation,
  ): Promise<RatingScopedReceipt>;
  cancel(
    intent: RatingScopedIntent,
    cancel: Cancellation,
  ): Promise<RatingScopedReceipt>;
  receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<RatingScopedReceipt>;
  updates(
    kind: RatingScopedNoticeKind,
    cursor: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<RatingScopedUpdatesPage>;
  noticeTarget(
    kind: RatingScopedNoticeKind,
    noticeId: string,
    context: RatingScopedContext,
    cancel: Cancellation,
  ): Promise<RatingScopedNoticeTarget>;
}
const body = (value: unknown): Json =>
  JSON.parse(JSON.stringify(value)) as Json;
const prefix = '/v2/ratings';
function id(value: unknown): string {
  if (!ratingId(value)) invalidRating();
  return value;
}
function query(context: RatingScopedContext): Record<string, string | number> {
  const c = decodeRatingScopedContext(context);
  return { contextId: c.id, contextToken: c.token };
}
function navigation(
  context: RatingScopedContext,
  purpose: 'read' | 'edit_target' = 'read',
): Record<string, string | number> {
  if (context.purpose !== purpose) invalidRating();
  return query(context);
}
function noticeKind(kind: RatingScopedNoticeKind): RatingScopedNoticeKind {
  if (!['updates', 'like-updates', 'subscription-updates'].includes(kind))
    invalidRating();
  return kind;
}
function pageMatch(
  context: RatingScopedContext,
  page:
    | RatingScopedCategoryPage
    | RatingScopedTargetPage
    | RatingScopedCommentPage
    | RatingScopedReplyPage
    | RatingScopedSubscriptionPage,
  cursor: string | null,
  limit: number,
): void {
  matchRatingScopedPage(context, page.context);
  if (
    page.items.length > limit ||
    (page.nextCursor !== null && page.nextCursor === cursor)
  )
    invalidRating();
}
export class HttpRatingScopedGateway implements RatingScopedGateway {
  constructor(
    private readonly api: ApiClient,
    private readonly sessions: SessionStore,
  ) {}
  private request<T>(
    path: string,
    method: Method,
    decode: Decoder<T>,
    cancel: Cancellation,
    value?: unknown,
    params?: Record<string, string | number>,
  ): Promise<T> {
    return this.api.request(
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
        ...(value === undefined ? {} : { body: body(value) }),
        ...(params ? { query: params } : {}),
      },
    );
  }
  async context(
    raw: RatingScopedContextRequest,
    cancel: Cancellation,
  ): Promise<RatingScopedContext> {
    const request = decodeRatingScopedContextRequest(raw),
      owner = this.sessions.snapshot();
    const context = await this.request(
      `${prefix}/contexts`,
      'POST',
      decodeRatingScopedContext,
      cancel,
      request,
    );
    this.sessions.assertCurrent(owner);
    if (
      context.actorId !== owner.credentials?.accountId ||
      context.purpose !== request.purpose ||
      context.mode !== request.mode ||
      canonicalRatingScopedJson(context.selector) !==
        canonicalRatingScopedJson(request.selector)
    )
      invalidRating();
    return context;
  }
  async resolve(
    raw: RatingScopedLocator,
    purpose: 'read' | 'interact' | 'edit_target',
    cancel: Cancellation,
  ): Promise<RatingScopedResolvedLocator> {
    const locator = decodeRatingScopedLocator(raw);
    if (!['read', 'interact', 'edit_target'].includes(purpose)) invalidRating();
    const result = await this.request(
      `${prefix}/locators/resolve`,
      'POST',
      (v): RatingScopedResolvedLocator => {
        exact(v, ['locator', 'context']);
        return Object.freeze({
          locator: decodeRatingScopedLocator(v.locator),
          context: decodeRatingScopedContext(v.context),
        });
      },
      cancel,
      { locator, purpose, mode: 'public' },
    );
    if (
      canonicalRatingScopedJson(result.locator) !==
        canonicalRatingScopedJson(locator) ||
      result.context.purpose === 'random' ||
      result.context.purpose !== purpose ||
      result.context.mode !== 'public' ||
      result.context.protocolGeneration !== locator.protocolGeneration ||
      ratingNavigationKey(result.context.selector) !==
        ratingNavigationKey(locator.selector) ||
      result.context.actorId !== this.sessions.snapshot().credentials?.accountId
    )
      invalidRating();
    return result;
  }
  async categories(
    context: RatingScopedContext,
    parentId: string | null,
    cursor: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<RatingScopedCategoryPage> {
    const page = await this.request(
      `${prefix}/categories`,
      'GET',
      decodeRatingScopedCategoryPage,
      cancel,
      undefined,
      {
        ...navigation(context),
        ...(parentId === null ? {} : { parentId: id(parentId) }),
        ...ratingPageQuery(cursor, limit),
      },
    );
    pageMatch(context, page, cursor, limit);
    if (page.context.parentId !== parentId) invalidRating();
    return page;
  }
  async targets(
    context: RatingScopedContext,
    categoryId: string,
    cursor: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<RatingScopedTargetPage> {
    const page = await this.request(
      `${prefix}/targets`,
      'GET',
      decodeRatingScopedTargetPage,
      cancel,
      undefined,
      {
        ...navigation(context),
        categoryId: id(categoryId),
        ...ratingPageQuery(cursor, limit),
      },
    );
    pageMatch(context, page, cursor, limit);
    if (page.context.categoryId !== categoryId) invalidRating();
    return page;
  }
  async detail(
    context: RatingScopedContext,
    targetId: string,
    cancel: Cancellation,
  ): Promise<RatingTarget> {
    const result = await this.request(
      `${prefix}/targets/${id(targetId)}`,
      'GET',
      decodeRatingTarget,
      cancel,
      undefined,
      navigation(context),
    );
    if (result.id !== targetId) invalidRating();
    return result;
  }
  myScore(
    context: RatingScopedContext,
    targetId: string,
    cancel: Cancellation,
  ): Promise<RatingMyScore> {
    return this.request(
      `${prefix}/targets/${id(targetId)}/my-score`,
      'GET',
      decodeRatingMyScore,
      cancel,
      undefined,
      navigation(context),
    );
  }
  summary(
    context: RatingScopedContext,
    targetId: string,
    cancel: Cancellation,
  ): Promise<RatingSummary> {
    return this.request(
      `${prefix}/targets/${id(targetId)}/score-summary`,
      'GET',
      decodeRatingSummary,
      cancel,
      undefined,
      navigation(context),
    );
  }
  async comments(
    context: RatingScopedContext,
    targetId: string,
    cursor: string | null,
    cancel: Cancellation,
    limit = 20,
    sort: 'time' | 'likes' = 'time',
    order: 'asc' | 'desc' = 'desc',
  ): Promise<RatingScopedCommentPage> {
    if (!['time', 'likes'].includes(sort) || !['asc', 'desc'].includes(order))
      invalidRating();
    const page = await this.request(
      `${prefix}/targets/${id(targetId)}/comments`,
      'GET',
      decodeRatingScopedCommentPage,
      cancel,
      undefined,
      {
        ...navigation(context),
        ...ratingPageQuery(cursor, limit),
        sort,
        order,
      },
    );
    pageMatch(context, page, cursor, limit);
    if (page.context.targetId !== targetId) invalidRating();
    return page;
  }
  async comment(
    context: RatingScopedContext,
    rootId: string,
    cancel: Cancellation,
  ): Promise<RatingComment> {
    const result = await this.request(
      `${prefix}/comments/${id(rootId)}`,
      'GET',
      decodeRatingComment,
      cancel,
      undefined,
      navigation(context),
    );
    if (result.id !== rootId) invalidRating();
    return result;
  }
  async discussion(
    context: RatingScopedContext,
    rootId: string,
    cancel: Cancellation,
  ): Promise<RatingScopedDiscussion> {
    const result = await this.request(
      `${prefix}/comments/${id(rootId)}/discussion`,
      'GET',
      decodeRatingScopedDiscussion,
      cancel,
      undefined,
      navigation(context),
    );
    matchRatingScopedPage(context, result.context);
    if (result.root.id !== rootId) invalidRating();
    return result;
  }
  async replies(
    context: RatingScopedContext,
    rootId: string,
    cursor: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<RatingScopedReplyPage> {
    const result = await this.request(
      `${prefix}/comments/${id(rootId)}/replies`,
      'GET',
      decodeRatingScopedReplyPage,
      cancel,
      undefined,
      { ...navigation(context), ...ratingPageQuery(cursor, limit) },
    );
    pageMatch(context, result, cursor, limit);
    if (result.context.rootId !== rootId) invalidRating();
    return result;
  }
  async reply(
    context: RatingScopedContext,
    replyId: string,
    cancel: Cancellation,
  ): Promise<RatingReply> {
    const result = await this.request(
      `${prefix}/replies/${id(replyId)}`,
      'GET',
      decodeRatingReply,
      cancel,
      undefined,
      navigation(context),
    );
    if (result.id !== replyId) invalidRating();
    return result;
  }
  async position(
    context: RatingScopedContext,
    replyId: string,
    cancel: Cancellation,
    limit = 20,
  ): Promise<RatingScopedReplyPosition> {
    const result = await this.request(
      `${prefix}/replies/${id(replyId)}/position`,
      'GET',
      decodeRatingScopedReplyPosition,
      cancel,
      undefined,
      { ...navigation(context), ...ratingPageQuery(null, limit) },
    );
    pageMatch(context, result.page, null, limit);
    if (result.anchorReplyId !== replyId) invalidRating();
    return result;
  }
  async commentLike(
    context: RatingScopedContext,
    rootId: string,
    cancel: Cancellation,
  ): Promise<RatingLikeState> {
    const result = await this.request(
      `${prefix}/comments/${id(rootId)}/like`,
      'GET',
      decodeRatingLikeState,
      cancel,
      undefined,
      navigation(context),
    );
    if (
      result.status === 'known' &&
      (result.rootId !== rootId || result.replyId !== null)
    )
      invalidRating();
    return result;
  }
  async replyLike(
    context: RatingScopedContext,
    replyId: string,
    cancel: Cancellation,
  ): Promise<RatingLikeState> {
    const result = await this.request(
      `${prefix}/replies/${id(replyId)}/like`,
      'GET',
      decodeRatingLikeState,
      cancel,
      undefined,
      navigation(context),
    );
    if (result.status === 'known' && result.replyId !== replyId)
      invalidRating();
    return result;
  }
  async subscription(
    context: RatingScopedContext,
    targetId: string,
    cancel: Cancellation,
  ): Promise<RatingSubscriptionState> {
    const result = await this.request(
      `${prefix}/targets/${id(targetId)}/subscription`,
      'GET',
      decodeRatingSubscriptionState,
      cancel,
      undefined,
      navigation(context),
    );
    if (result.status === 'known' && result.targetId !== targetId)
      invalidRating();
    return result;
  }
  async subscriptionStates(
    context: RatingScopedContext,
    targets: readonly RatingSubscriptionTarget[],
    cancel: Cancellation,
  ): Promise<RatingSubscriptionBatch> {
    if (
      !Array.isArray(targets) ||
      targets.length < 1 ||
      targets.length > 20 ||
      new Set(targets.map((target) => target.targetId)).size !== targets.length
    )
      invalidRating();
    targets.forEach((target) => {
      exact(target, ['targetId', 'expectedTargetRevision']);
      id(target.targetId);
      id(target.expectedTargetRevision);
    });
    const result = await this.request(
      `${prefix}/subscription-states/query`,
      'POST',
      decodeRatingSubscriptionBatch,
      cancel,
      { ...navigation(context), targets },
    );
    matchRatingSubscriptionBatch(targets, result);
    return result;
  }
  async subscriptions(
    context: RatingScopedContext,
    cursor: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<RatingScopedSubscriptionPage> {
    const result = await this.request(
      `${prefix}/subscriptions`,
      'GET',
      decodeRatingScopedSubscriptionPage,
      cancel,
      undefined,
      { ...navigation(context), ...ratingPageQuery(cursor, limit) },
    );
    pageMatch(context, result, cursor, limit);
    return result;
  }
  async random(
    context: RatingScopedContext,
    categoryId: string,
    minimumAverage: number | null,
    cancel: Cancellation,
  ): Promise<RatingScopedRandomResult> {
    if (
      context.purpose !== 'random' ||
      !(minimumAverage === null || ratingMinimumAverage(minimumAverage))
    )
      invalidRating();
    const result = await this.request(
      `${prefix}/random-target`,
      'GET',
      decodeRatingScopedRandomResult,
      cancel,
      undefined,
      {
        ...query(context),
        categoryId: id(categoryId),
        ...(minimumAverage === null ? {} : { minimumAverage }),
      },
    );
    if (
      result.context.contextId !== context.id ||
      result.context.categoryId !== categoryId ||
      result.context.minimumAverage !== minimumAverage ||
      result.context.protocolGeneration !== context.protocolGeneration ||
      canonicalRatingScopedJson(result.context.selector) !==
        canonicalRatingScopedJson(context.selector) ||
      (result.item !== null &&
        !context.heads.some(
          (head) =>
            head.scopeKey ===
            ratingNavigationKey(result.item!.locator.selector),
        ))
    )
      invalidRating();
    return result;
  }
  async editContext(
    context: RatingScopedContext,
    targetId: string,
    cancel: Cancellation,
  ): Promise<RatingScopedEditContext> {
    if (context.purpose !== 'edit_target' || context.mode !== 'public')
      invalidRating();
    const result = await this.request(
      `${prefix}/management/owner-edit/targets/${id(targetId)}/context`,
      'GET',
      decodeRatingScopedEditContext,
      cancel,
      undefined,
      navigation(context, 'edit_target'),
    );
    matchRatingScopedPage(context, result.context);
    if (result.targetId !== targetId) invalidRating();
    return result;
  }
  async prepare(
    raw: RatingScopedIntent,
    cancel: Cancellation,
  ): Promise<RatingScopedPrepared> {
    const intent = decodeRatingScopedIntent(raw);
    if (
      intent.operation !== 'create_target_scoped' &&
      intent.operation !== 'edit_target_scoped'
    )
      invalidRating();
    const path =
      intent.operation === 'create_target_scoped'
        ? 'management/prepare'
        : 'management/owner-edit/prepare';
    const result = await this.request(
      `${prefix}/${path}`,
      'POST',
      decodeRatingScopedPrepared,
      cancel,
      intent,
    );
    if ('outcome' in result) matchRatingScopedReceipt(intent, result);
    else if (
      ratingScopedIntentHash(result.intent) !== ratingScopedIntentHash(intent)
    )
      invalidRating();
    return result;
  }
  async command(
    raw: RatingScopedIntent,
    cancel: Cancellation,
  ): Promise<RatingScopedReceipt> {
    const intent = decodeRatingScopedIntent(raw),
      owner = this.sessions.snapshot();
    let path: string,
      method: Method = 'POST',
      transport: unknown = intent;
    let prepared:
      Exclude<RatingScopedPrepared, RatingScopedReceipt> | undefined;
    if (
      intent.operation === 'create_target_scoped' ||
      intent.operation === 'edit_target_scoped'
    ) {
      const result = await this.prepare(intent, cancel);
      this.sessions.assertCurrent(owner);
      if (cancel.isCancelled)
        throw new ClientError('cancelled', 'Cancelled before scoped commit');
      if ('outcome' in result) return result;
      if (Date.parse(result.validUntil) <= Date.now())
        throw new ClientError('business', 'Scoped preparation expired', {
          serverCode: 'RATING_SCOPED_CONTEXT_CHANGED',
        });
      prepared = result;
      transport = {
        ...intent,
        preparationContextRevision: result.contextRevision,
      };
      path =
        intent.operation === 'create_target_scoped'
          ? 'management/targets'
          : 'management/owner-edit/commit';
    } else if (intent.operation === 'set_score_scoped') {
      path = `targets/${intent.payload.targetId}/my-score`;
      method = 'PUT';
    } else if (intent.operation === 'create_comment_scoped')
      path = `targets/${intent.payload.targetId}/comments`;
    else if (intent.operation === 'create_reply_scoped')
      path = `comments/${intent.payload.rootId}/replies`;
    else if (intent.operation === 'set_comment_like_scoped') {
      path = `comments/${intent.payload.rootId}/like`;
      method = 'PUT';
    } else if (intent.operation === 'set_reply_like_scoped') {
      path = `replies/${intent.payload.replyId}/like`;
      method = 'PUT';
    } else {
      path = `targets/${intent.payload.targetId}/subscription`;
      method = 'PUT';
    }
    const receipt = await this.request(
      `${prefix}/${path}`,
      method,
      decodeRatingScopedReceipt,
      cancel,
      transport,
    );
    this.sessions.assertCurrent(owner);
    matchRatingScopedReceipt(intent, receipt);
    if (
      prepared &&
      receipt.outcome === 'applied' &&
      (receipt.result.targetId !== prepared.targetId ||
        receipt.result.revision !== prepared.targetRevision ||
        (receipt.operation === 'edit_target_scoped' &&
          (receipt.result.definitionRevision !== prepared.definitionRevision ||
            receipt.result.contentVersion !== prepared.contentVersion)))
    )
      invalidRating();
    return receipt;
  }
  async cancel(
    raw: RatingScopedIntent,
    cancel: Cancellation,
  ): Promise<RatingScopedReceipt> {
    const intent = decodeRatingScopedIntent(raw);
    if (
      intent.operation !== 'create_target_scoped' &&
      intent.operation !== 'edit_target_scoped'
    )
      invalidRating();
    const path =
      intent.operation === 'create_target_scoped'
        ? 'management/cancel'
        : 'management/owner-edit/cancel';
    const receipt = await this.request(
      `${prefix}/${path}`,
      'POST',
      decodeRatingScopedReceipt,
      cancel,
      intent,
    );
    matchRatingScopedReceipt(intent, receipt);
    return receipt;
  }
  async receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<RatingScopedReceipt> {
    const result = await this.request(
      `${prefix}/requests/${id(requestId)}`,
      'GET',
      decodeRatingScopedReceipt,
      cancel,
    );
    if (result.requestId !== requestId) invalidRating();
    return result;
  }
  async updates(
    kind: RatingScopedNoticeKind,
    cursor: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<RatingScopedUpdatesPage> {
    const result = await this.request(
      `/v2/me/ratings/${noticeKind(kind)}`,
      'GET',
      decodeRatingScopedUpdatesPage,
      cancel,
      undefined,
      ratingPageQuery(cursor, limit, 20),
    );
    if (
      result.items.length > limit ||
      (result.nextCursor !== null && result.nextCursor === cursor)
    )
      invalidRating();
    return result;
  }
  async noticeTarget(
    kind: RatingScopedNoticeKind,
    noticeId: string,
    context: RatingScopedContext,
    cancel: Cancellation,
  ): Promise<RatingScopedNoticeTarget> {
    const result = await this.request(
      `/v2/me/ratings/${noticeKind(kind)}/${id(noticeId)}/target`,
      'GET',
      decodeRatingScopedNoticeTarget,
      cancel,
      undefined,
      navigation(context),
    );
    if (
      result.noticeId !== noticeId ||
      (result.status === 'available' &&
        (context.purpose === 'random' ||
          result.target.protocolGeneration !== context.protocolGeneration ||
          ratingNavigationKey(result.target.selector) !==
            ratingNavigationKey(context.selector)))
    )
      invalidRating();
    return result;
  }
}
