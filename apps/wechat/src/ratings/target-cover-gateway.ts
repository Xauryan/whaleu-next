import { ratingMinimumAverage } from './random-contract';
import {
  decodeRatingTargetCoverContext,
  type RatingTargetCoverContext,
} from './target-cover-context';
import { exact } from '../community/contract';
import {
  decodeRatingCoverDescriptor,
  type RatingCoverDescriptor,
} from './target-cover-media-contract';
import { ratingPageQuery } from './discussion-gateway';
import type { ApiClient } from '../api/client';
import { ClientError, isRecord } from '../api/errors';
import type { Decoder } from '../api/envelopes';
import type { SessionStore } from '../auth/session';
import type { Cancellation, Json, Method } from '../platform/contracts';
import {
  invalidRating,
  ratingId,
  decodeRatingTarget,
  type RatingTarget,
} from './contract';
import {
  decodeRatingScopedContextRequest,
  canonicalRatingScopedJson,
  decodeRatingNavigationSelector,
  ratingNavigationKey,
  type RatingScopedContextRequest,
} from './scoped-contract';
import {
  decodeRatingScopedEditContext,
  decodeRatingScopedTargetPage,
  decodeRatingScopedRandomResult,
  decodeRatingScopedSubscriptionPage,
  type RatingScopedRandomResult,
  type RatingScopedEditContext,
  type RatingScopedPageContext,
  type RatingScopedTargetPage,
  type RatingScopedSubscriptionPage,
} from './scoped-read-contract';
import {
  decodeRatingTargetCoverIdentity,
  decodeRatingTargetCoverIntent,
  decodeRatingTargetCoverPrepared,
  decodeRatingTargetCoverReceipt,
  matchRatingTargetCoverReceipt,
  ratingTargetCoverContext,
  ratingTargetCoverIntentHash,
  type RatingTargetCoverIdentity,
  type RatingTargetCoverIntent,
  type RatingTargetCoverPrepared,
  type RatingTargetCoverReceipt,
} from './target-cover-contract';
function matchCoverPage(
  context: RatingTargetCoverContext,
  page: RatingScopedPageContext,
): void {
  if (
    context.purpose === 'random' ||
    context.heads.length !== 1 ||
    page.contextId !== context.id ||
    canonicalRatingScopedJson(page.selector) !==
      canonicalRatingScopedJson(context.selector) ||
    page.catalogRevision !== context.heads[0]!.catalogRevision ||
    page.protocolGeneration !== context.protocolGeneration
  )
    invalidRating();
}
export interface RatingTargetCoverEditContext extends RatingScopedEditContext {
  readonly cover: RatingTargetCoverIdentity | null;
}
export function decodeRatingTargetCoverEditContext(
  value: unknown,
): RatingTargetCoverEditContext {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'cover'))
    invalidRating();
  const { cover, ...legacy } = value;
  return Object.freeze({
    ...decodeRatingScopedEditContext(legacy),
    cover: decodeRatingTargetCoverIdentity(cover),
  });
}
export interface RatingTargetCoverDetail {
  readonly context: RatingScopedPageContext;
  readonly target: RatingTarget;
  readonly cover: RatingCoverDescriptor | null;
}
export type RatingTargetCoverPage = Omit<RatingScopedTargetPage, 'items'> & {
  readonly items: readonly (RatingTarget & {
    readonly cover: RatingCoverDescriptor | null;
  })[];
};
export function decodeRatingTargetCoverDetail(
  value: unknown,
): RatingTargetCoverDetail {
  exact(value, ['context', 'target', 'cover']);
  exact(value.context, [
    'contextId',
    'selector',
    'catalogRevision',
    'protocolGeneration',
  ]);
  const c = value.context;
  if (
    !ratingId(c.contextId) ||
    !ratingId(c.catalogRevision) ||
    !ratingId(c.protocolGeneration)
  )
    invalidRating();
  const target = decodeRatingTarget(value.target),
    cover =
      value.cover === null ? null : decodeRatingCoverDescriptor(value.cover);
  if (cover && cover.targetId !== target.id) invalidRating();
  return Object.freeze({
    target,
    cover,
    context: Object.freeze({
      contextId: c.contextId,
      selector: decodeRatingNavigationSelector(c.selector),
      catalogRevision: c.catalogRevision,
      protocolGeneration: c.protocolGeneration,
    }),
  });
}
export function decodeRatingTargetCoverPage(
  value: unknown,
): RatingTargetCoverPage {
  exact(value, ['context', 'items', 'nextCursor', 'continuation']);
  if (!Array.isArray(value.items)) invalidRating();
  const items = value.items.map((v: unknown) => {
    if (!isRecord(v) || !('cover' in v)) invalidRating();
    const { cover: raw, ...rest } = v;
    const target = decodeRatingTarget(rest),
      cover = raw === null ? null : decodeRatingCoverDescriptor(raw);
    if (cover && cover.targetId !== target.id) invalidRating();
    return Object.freeze({ ...target, cover });
  });
  const page = decodeRatingScopedTargetPage({
    ...value,
    items: items.map(({ cover: _cover, ...target }) => target),
  });
  return Object.freeze({ ...page, items: Object.freeze(items) });
}
export type RatingTargetCoverSubscriptionPage = Omit<
  RatingScopedSubscriptionPage,
  'items'
> & { readonly items: RatingTargetCoverPage['items'] };
export function decodeRatingTargetCoverSubscriptions(
  value: unknown,
): RatingTargetCoverSubscriptionPage {
  exact(value, ['context', 'items', 'nextCursor', 'continuation']);
  if (!Array.isArray(value.items)) invalidRating();
  const items = value.items.map((raw: unknown) => {
    if (!isRecord(raw) || !('cover' in raw)) invalidRating();
    const { cover, ...body } = raw;
    const target = decodeRatingTarget(body),
      descriptor = cover === null ? null : decodeRatingCoverDescriptor(cover);
    if (descriptor && descriptor.targetId !== target.id) invalidRating();
    return Object.freeze({ ...target, cover: descriptor });
  });
  const page = decodeRatingScopedSubscriptionPage({
    ...value,
    items: items.map(({ cover: _cover, ...body }) => body),
  });
  return Object.freeze({ ...page, items: Object.freeze(items) });
}
export type RatingTargetCoverRandomResult = Omit<
  RatingScopedRandomResult,
  'item'
> & {
  readonly item:
    | (NonNullable<RatingScopedRandomResult['item']> & {
        readonly cover: RatingCoverDescriptor | null;
        readonly coverContext: RatingTargetCoverContext;
      })
    | null;
};
export function decodeRatingTargetCoverRandom(
  value: unknown,
): RatingTargetCoverRandomResult {
  exact(value, ['context', 'candidateCount', 'item']);
  if (value.item === null)
    return { ...decodeRatingScopedRandomResult(value), item: null };
  exact(value.item, ['locator', 'target', 'summary', 'cover', 'coverContext']);
  const { cover: raw, coverContext: rawContext, ...legacy } = value.item;
  const result = decodeRatingScopedRandomResult({ ...value, item: legacy });
  const item = result.item!;
  const cover = raw === null ? null : decodeRatingCoverDescriptor(raw),
    coverContext = decodeRatingTargetCoverContext(rawContext);
  if (
    coverContext.purpose !== 'read' ||
    coverContext.mode !== 'public' ||
    canonicalRatingScopedJson(coverContext.selector) !==
      canonicalRatingScopedJson(item.locator.selector) ||
    coverContext.protocolGeneration !== item.locator.protocolGeneration ||
    (cover &&
      (cover.contextId !== coverContext.id ||
        cover.contextToken !== coverContext.token ||
        cover.targetId !== item.target.id ||
        !coverContext.capabilities.includes('target_cover')))
  )
    invalidRating();
  return Object.freeze({
    ...result,
    item: Object.freeze({ ...item, cover, coverContext }),
  });
}
export interface RatingTargetCoverGateway {
  random(
    context: RatingTargetCoverContext,
    categoryId: string,
    minimumAverage: number | null,
    cancel: Cancellation,
  ): Promise<RatingTargetCoverRandomResult>;
  subscriptions(
    context: RatingTargetCoverContext,
    cursor: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<RatingTargetCoverSubscriptionPage>;
  context(
    request: RatingScopedContextRequest,
    cancel: Cancellation,
  ): Promise<RatingTargetCoverContext>;
  detail(
    context: RatingTargetCoverContext,
    targetId: string,
    cancel: Cancellation,
  ): Promise<RatingTargetCoverDetail>;
  targets(
    context: RatingTargetCoverContext,
    categoryId: string,
    cursor: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<RatingTargetCoverPage>;
  editContext(
    context: RatingTargetCoverContext,
    targetId: string,
    cancel: Cancellation,
  ): Promise<RatingTargetCoverEditContext>;
  prepare(
    intent: RatingTargetCoverIntent,
    cancel: Cancellation,
  ): Promise<RatingTargetCoverPrepared>;
  command(
    intent: RatingTargetCoverIntent,
    cancel: Cancellation,
  ): Promise<RatingTargetCoverReceipt>;
  cancel(
    intent: RatingTargetCoverIntent,
    cancel: Cancellation,
  ): Promise<RatingTargetCoverReceipt>;
  receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<RatingTargetCoverReceipt>;
}
const prefix = '/v3/ratings/target-cover';
export class HttpRatingTargetCoverGateway implements RatingTargetCoverGateway {
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
  ): Promise<T> {
    const owner = this.sessions.snapshot();
    if (!owner.credentials)
      throw new ClientError('auth-required', 'Ratings cover requires sign in');
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
    if (cancel.isCancelled)
      throw new ClientError('cancelled', 'Ratings cover operation interrupted');
    return value;
  }
  async context(
    raw: RatingScopedContextRequest,
    cancel: Cancellation,
  ): Promise<RatingTargetCoverContext> {
    const request = decodeRatingScopedContextRequest(raw),
      actor = this.sessions.snapshot().credentials?.accountId;
    const context = await this.request(
      `${prefix}/contexts`,
      'POST',
      decodeRatingTargetCoverContext,
      cancel,
      request,
    );
    if (
      context.actorId !== actor ||
      context.purpose !== request.purpose ||
      context.mode !== request.mode ||
      canonicalRatingScopedJson(context.selector) !==
        canonicalRatingScopedJson(request.selector)
    )
      invalidRating();
    return context;
  }
  async random(
    raw: RatingTargetCoverContext,
    categoryId: string,
    minimumAverage: number | null,
    cancel: Cancellation,
  ): Promise<RatingTargetCoverRandomResult> {
    const context = decodeRatingTargetCoverContext(raw);
    if (
      context.purpose !== 'random' ||
      context.mode !== 'public' ||
      !ratingId(categoryId) ||
      context.actorId !== this.sessions.snapshot().credentials?.accountId ||
      !(minimumAverage === null || ratingMinimumAverage(minimumAverage))
    )
      invalidRating();
    const value = await this.request(
      `${prefix}/random-target`,
      'GET',
      decodeRatingTargetCoverRandom,
      cancel,
      undefined,
      {
        contextId: context.id,
        contextToken: context.token,
        categoryId,
        ...(minimumAverage === null ? {} : { minimumAverage }),
      },
    );
    if (
      value.context.contextId !== context.id ||
      value.context.categoryId !== categoryId ||
      value.context.minimumAverage !== minimumAverage ||
      value.context.protocolGeneration !== context.protocolGeneration ||
      canonicalRatingScopedJson(value.context.selector) !==
        canonicalRatingScopedJson(context.selector)
    )
      invalidRating();
    if (value.item) {
      const selected = value.item.coverContext;
      if (
        !context.heads.some(
          (head) =>
            head.scopeKey === ratingNavigationKey(value.item!.locator.selector),
        ) ||
        selected.id === context.id ||
        selected.actorId !== context.actorId ||
        selected.sessionGeneration !== context.sessionGeneration ||
        selected.identityCampusId !== context.identityCampusId
      )
        invalidRating();
    }
    return value;
  }
  async subscriptions(
    context: RatingTargetCoverContext,
    cursor: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<RatingTargetCoverSubscriptionPage> {
    const page = await this.request(
      `${prefix}/subscriptions`,
      'GET',
      decodeRatingTargetCoverSubscriptions,
      cancel,
      undefined,
      { ...this.readContext(context), ...ratingPageQuery(cursor, limit) },
    );
    matchCoverPage(context, page.context);
    if (
      page.items.some(
        (item) =>
          item.cover &&
          (item.cover.contextId !== context.id ||
            item.cover.contextToken !== context.token),
      )
    )
      invalidRating();
    if (
      page.items.length > limit ||
      (page.nextCursor !== null && page.nextCursor === cursor)
    )
      invalidRating();
    return page;
  }
  private readContext(raw: RatingTargetCoverContext): Record<string, string> {
    const context = decodeRatingTargetCoverContext(raw);
    if (
      context.purpose !== 'read' ||
      context.mode !== 'public' ||
      context.actorId !== this.sessions.snapshot().credentials?.accountId
    )
      invalidRating();
    return { contextId: context.id, contextToken: context.token };
  }
  async detail(
    context: RatingTargetCoverContext,
    targetId: string,
    cancel: Cancellation,
  ): Promise<RatingTargetCoverDetail> {
    if (!ratingId(targetId)) invalidRating();
    const value = await this.request(
      `${prefix}/targets/${targetId}`,
      'GET',
      decodeRatingTargetCoverDetail,
      cancel,
      undefined,
      this.readContext(context),
    );
    matchCoverPage(context, value.context);
    if (
      value.cover &&
      (value.cover.contextId !== context.id ||
        value.cover.contextToken !== context.token)
    )
      invalidRating();
    if (value.target.id !== targetId) invalidRating();
    return value;
  }
  async targets(
    context: RatingTargetCoverContext,
    categoryId: string,
    cursor: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<RatingTargetCoverPage> {
    if (!ratingId(categoryId)) invalidRating();
    const value = await this.request(
      `${prefix}/targets`,
      'GET',
      decodeRatingTargetCoverPage,
      cancel,
      undefined,
      {
        ...this.readContext(context),
        categoryId,
        ...ratingPageQuery(cursor, limit),
      },
    );
    matchCoverPage(context, value.context);
    if (
      value.items.some(
        (item) =>
          item.cover &&
          (item.cover.contextId !== context.id ||
            item.cover.contextToken !== context.token),
      )
    )
      invalidRating();
    if (
      value.context.categoryId !== categoryId ||
      value.items.length > limit ||
      (value.nextCursor !== null && value.nextCursor === cursor)
    )
      invalidRating();
    return value;
  }
  async editContext(
    context: RatingTargetCoverContext,
    targetId: string,
    cancel: Cancellation,
  ): Promise<RatingTargetCoverEditContext> {
    ratingTargetCoverContext(context);
    if (
      context.purpose !== 'edit_target' ||
      !ratingId(targetId) ||
      context.actorId !== this.sessions.snapshot().credentials?.accountId
    )
      invalidRating();
    const result = await this.request(
      `${prefix}/targets/${targetId}/edit-context`,
      'GET',
      decodeRatingTargetCoverEditContext,
      cancel,
      undefined,
      { contextId: context.id, contextToken: context.token },
    );
    matchCoverPage(context, result.context);
    if (result.targetId !== targetId) invalidRating();
    return result;
  }
  async prepare(
    raw: RatingTargetCoverIntent,
    cancel: Cancellation,
  ): Promise<RatingTargetCoverPrepared> {
    const intent = decodeRatingTargetCoverIntent(raw);
    const result = await this.request(
      `${prefix}/prepare`,
      'POST',
      decodeRatingTargetCoverPrepared,
      cancel,
      intent,
    );
    if ('outcome' in result) matchRatingTargetCoverReceipt(intent, result);
    else if (
      ratingTargetCoverIntentHash(intent) !==
      ratingTargetCoverIntentHash(result.intent)
    )
      invalidRating();
    return result;
  }
  async command(
    raw: RatingTargetCoverIntent,
    cancel: Cancellation,
  ): Promise<RatingTargetCoverReceipt> {
    const intent = decodeRatingTargetCoverIntent(raw),
      owner = this.sessions.snapshot();
    const prepared = await this.prepare(intent, cancel);
    this.sessions.assertCurrent(owner);
    if ('outcome' in prepared) return prepared;
    if (cancel.isCancelled || Date.parse(prepared.validUntil) <= Date.now())
      throw new ClientError('business', 'Original cover preparation expired');
    const receipt = await this.request(
      `${prefix}/commit`,
      'POST',
      decodeRatingTargetCoverReceipt,
      cancel,
      { ...intent, preparationContextRevision: prepared.contextRevision },
    );
    matchRatingTargetCoverReceipt(intent, receipt);
    if (
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
    raw: RatingTargetCoverIntent,
    cancel: Cancellation,
  ): Promise<RatingTargetCoverReceipt> {
    const intent = decodeRatingTargetCoverIntent(raw);
    const receipt = await this.request(
      `${prefix}/cancel`,
      'POST',
      decodeRatingTargetCoverReceipt,
      cancel,
      intent,
    );
    matchRatingTargetCoverReceipt(intent, receipt);
    return receipt;
  }
  async receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<RatingTargetCoverReceipt> {
    if (!ratingId(requestId)) invalidRating();
    const result = await this.request(
      `${prefix}/receipts/${requestId}`,
      'GET',
      decodeRatingTargetCoverReceipt,
      cancel,
    );
    if (result.requestId !== requestId) invalidRating();
    return result;
  }
}
