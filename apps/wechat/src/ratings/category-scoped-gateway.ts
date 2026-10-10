import type { ApiClient } from '../api/client';
import type { Decoder } from '../api/envelopes';
import type { SessionStore } from '../auth/session';
import type { Cancellation, Json, Method } from '../platform/contracts';
import { invalidRating, ratingId } from './contract';
import {
  decodeRatingNavigationSelector,
  ratingNavigationKey,
  type RatingNavigationSelector,
} from './scoped-contract';
import {
  ratingCategoryScopedCommitEnvelope,
  decodeRatingCategoryScopedContext,
  decodeRatingCategoryScopedHistory,
  decodeRatingCategoryScopedIntent,
  decodeRatingCategoryScopedPrepared,
  decodeRatingCategoryScopedPreparation,
  decodeRatingCategoryScopedReceipt,
  decodeRatingCategorySystemOptions,
  decodeRatingManagedCategories,
  decodeRatingManagedCategory,
  matchRatingCategoryScopedPreparation,
  matchRatingCategoryScopedReceipt,
  type RatingCategoryScopedContext,
  type RatingCategoryScopedHistory,
  type RatingCategoryScopedIntent,
  type RatingCategoryScopedPrepared,
  type RatingCategoryScopedPreparation,
  type RatingCategoryScopedReceipt,
  type RatingCategorySystemOptions,
  type RatingManagedCategories,
  type RatingManagedCategory,
} from './category-scoped-contract';

export interface RatingCategoryScopedGateway {
  context(
    selector: RatingNavigationSelector,
    cancel: Cancellation,
  ): Promise<RatingCategoryScopedContext>;
  categories(
    context: RatingCategoryScopedContext,
    cancel: Cancellation,
  ): Promise<RatingManagedCategories>;
  category(
    context: RatingCategoryScopedContext,
    categoryId: string,
    cancel: Cancellation,
  ): Promise<RatingManagedCategory>;
  history(
    context: RatingCategoryScopedContext,
    categoryId: string,
    cursor: string | null,
    cancel: Cancellation,
  ): Promise<RatingCategoryScopedHistory>;
  systemOptions(
    context: RatingCategoryScopedContext,
    cancel: Cancellation,
  ): Promise<RatingCategorySystemOptions>;
  prepare(
    intent: RatingCategoryScopedIntent,
    cancel: Cancellation,
  ): Promise<RatingCategoryScopedPrepared>;
  commit(
    intent: RatingCategoryScopedIntent,
    prepared: RatingCategoryScopedPreparation,
    cancel: Cancellation,
  ): Promise<RatingCategoryScopedReceipt>;
  cancel(
    intent: RatingCategoryScopedIntent,
    cancel: Cancellation,
  ): Promise<RatingCategoryScopedReceipt>;
  receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<RatingCategoryScopedReceipt>;
}
const prefix = '/v2/ratings/category-management';
const id = (value: string): string => {
  if (!ratingId(value)) invalidRating();
  return value;
};
function query(raw: RatingCategoryScopedContext): Record<string, string> {
  const context = decodeRatingCategoryScopedContext(raw);
  return {
    contextId: context.commandContext.id,
    contextToken: context.commandContext.token,
  };
}
/** Preparation never implies consent to commit. Recovery cannot refresh an intent or invent a closure. */
export class HttpRatingCategoryScopedGateway implements RatingCategoryScopedGateway {
  constructor(
    private readonly api: ApiClient,
    private readonly sessions: SessionStore,
  ) {}
  private async request<T>(
    path: string,
    method: Method,
    decode: Decoder<T>,
    cancel: Cancellation,
    value?: unknown,
    params?: Record<string, string>,
  ): Promise<T> {
    const owner = this.sessions.snapshot();
    const result = await this.api.request(
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
        ...(value === undefined
          ? {}
          : { body: JSON.parse(JSON.stringify(value)) as Json }),
        ...(params === undefined ? {} : { query: params }),
      },
    );
    this.sessions.assertCurrent(owner);
    return result;
  }
  async context(
    raw: RatingNavigationSelector,
    cancel: Cancellation,
  ): Promise<RatingCategoryScopedContext> {
    const selector = decodeRatingNavigationSelector(raw);
    const result = await this.request(
      `${prefix}/contexts`,
      'POST',
      decodeRatingCategoryScopedContext,
      cancel,
      { selector },
    );
    if (
      ratingNavigationKey(result.commandContext.selector) !==
      ratingNavigationKey(selector)
    )
      invalidRating();
    return result;
  }
  async categories(
    context: RatingCategoryScopedContext,
    cancel: Cancellation,
  ): Promise<RatingManagedCategories> {
    const result = await this.request(
      `${prefix}/categories`,
      'GET',
      decodeRatingManagedCategories,
      cancel,
      undefined,
      query(context),
    );
    if (result.snapshotRevision !== context.snapshotRevision) invalidRating();
    return result;
  }
  async category(
    context: RatingCategoryScopedContext,
    categoryId: string,
    cancel: Cancellation,
  ): Promise<RatingManagedCategory> {
    const result = await this.request(
      `${prefix}/categories/${id(categoryId)}`,
      'GET',
      decodeRatingManagedCategory,
      cancel,
      undefined,
      query(context),
    );
    if (result.id !== categoryId) invalidRating();
    return result;
  }
  async history(
    context: RatingCategoryScopedContext,
    categoryId: string,
    cursor: string | null,
    cancel: Cancellation,
  ): Promise<RatingCategoryScopedHistory> {
    const result = await this.request(
      `${prefix}/categories/${id(categoryId)}/history`,
      'GET',
      decodeRatingCategoryScopedHistory,
      cancel,
      undefined,
      { ...query(context), ...(cursor === null ? {} : { cursor: id(cursor) }) },
    );
    if (cursor !== null && result.nextCursor === cursor) invalidRating();
    return result;
  }
  systemOptions(
    context: RatingCategoryScopedContext,
    cancel: Cancellation,
  ): Promise<RatingCategorySystemOptions> {
    return this.request(
      `${prefix}/system-options`,
      'GET',
      decodeRatingCategorySystemOptions,
      cancel,
      undefined,
      query(context),
    );
  }
  async prepare(
    raw: RatingCategoryScopedIntent,
    cancel: Cancellation,
  ): Promise<RatingCategoryScopedPrepared> {
    const intent = decodeRatingCategoryScopedIntent(raw);
    const result = await this.request(
      `${prefix}/prepare`,
      'POST',
      decodeRatingCategoryScopedPrepared,
      cancel,
      intent,
    );
    if ('outcome' in result) matchRatingCategoryScopedReceipt(intent, result);
    else matchRatingCategoryScopedPreparation(intent, result);
    return result;
  }
  async commit(
    raw: RatingCategoryScopedIntent,
    preview: RatingCategoryScopedPreparation,
    cancel: Cancellation,
  ): Promise<RatingCategoryScopedReceipt> {
    const intent = decodeRatingCategoryScopedIntent(raw),
      prepared = decodeRatingCategoryScopedPreparation(preview);
    matchRatingCategoryScopedPreparation(intent, prepared);
    const result = await this.request(
      `${prefix}/commit`,
      'POST',
      decodeRatingCategoryScopedReceipt,
      cancel,
      ratingCategoryScopedCommitEnvelope(intent, prepared.contextRevision),
    );
    matchRatingCategoryScopedReceipt(intent, result);
    return result;
  }
  async cancel(
    raw: RatingCategoryScopedIntent,
    cancel: Cancellation,
  ): Promise<RatingCategoryScopedReceipt> {
    const intent = decodeRatingCategoryScopedIntent(raw);
    const result = await this.request(
      `${prefix}/cancel`,
      'POST',
      decodeRatingCategoryScopedReceipt,
      cancel,
      intent,
    );
    matchRatingCategoryScopedReceipt(intent, result);
    return result;
  }
  async receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<RatingCategoryScopedReceipt> {
    const result = await this.request(
      `/v2/ratings/requests/${id(requestId)}`,
      'GET',
      decodeRatingCategoryScopedReceipt,
      cancel,
    );
    if (result.requestId !== requestId) invalidRating();
    return result;
  }
}
