import { exact } from '../community/contract';
import {
  decodeRatingCategoryScopedContext,
  type RatingCategoryScopedContext,
  decodeRatingCategoryScopedHistory as decodeRatingCategoryIconHistory,
  decodeRatingCategorySystemOptions,
  type RatingCategoryScopedHistory as RatingCategoryIconHistory,
  type RatingCategorySystemOptions,
} from './category-scoped-contract';
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
  decodeRatingCategoryIconContext,
  decodeRatingCategoryIconIntent,
  decodeRatingCategoryIconPrepared,
  decodeRatingCategoryIconPreparation,
  decodeRatingCategoryIconReceipt,
  decodeRatingManagedIconCategories,
  decodeRatingManagedIconCategory,
  matchRatingCategoryIconPreparation,
  matchRatingCategoryIconReceipt,
  decodeRatingCategoryIconRetirementRequest,
  decodeRatingCategoryIconRetirementStatusRequest,
  decodeRatingCategoryIconRetirementStatus,
  decodeRatingCategoryIconRetirementCleanup,
  matchRatingCategoryIconRetirementIds,
  type RatingCategoryIconRetirementRequest,
  type RatingCategoryIconRetirementStatusRequest,
  type RatingCategoryIconRetirementStatus,
  type RatingCategoryIconRetirementCleanup,
  type RatingCategoryIconContext,
  type RatingCategoryIconIntent,
  type RatingCategoryIconPrepared,
  type RatingCategoryIconPreparation,
  type RatingCategoryIconReceipt,
  type RatingManagedIconCategories,
  type RatingManagedIconCategory,
} from './category-icon-contract';

export type CategoryIconEntryContext =
  | { readonly kind: 'icon'; readonly context: RatingCategoryIconContext }
  | { readonly kind: 'legacy'; readonly context: RatingCategoryScopedContext };
export function decodeCategoryIconEntryContext(
  value: unknown,
): CategoryIconEntryContext {
  exact(value, ['kind', 'context']);
  if (value.kind === 'icon')
    return Object.freeze({
      kind: 'icon',
      context: decodeRatingCategoryIconContext(value.context),
    });
  if (value.kind === 'legacy')
    return Object.freeze({
      kind: 'legacy',
      context: decodeRatingCategoryScopedContext(value.context),
    });
  return invalidRating();
}
export interface RatingCategoryIconGateway {
  entryContext(
    selector: RatingNavigationSelector,
    cancel: Cancellation,
  ): Promise<CategoryIconEntryContext>;
  context(
    selector: RatingNavigationSelector,
    cancel: Cancellation,
  ): Promise<RatingCategoryIconContext>;
  categories(
    context: RatingCategoryIconContext,
    cancel: Cancellation,
  ): Promise<RatingManagedIconCategories>;
  category(
    context: RatingCategoryIconContext,
    categoryId: string,
    cancel: Cancellation,
  ): Promise<RatingManagedIconCategory>;
  history(
    context: RatingCategoryIconContext,
    categoryId: string,
    cursor: string | null,
    cancel: Cancellation,
  ): Promise<RatingCategoryIconHistory>;
  systemOptions(
    context: RatingCategoryIconContext,
    cancel: Cancellation,
  ): Promise<RatingCategorySystemOptions>;
  prepare(
    intent: RatingCategoryIconIntent,
    cancel: Cancellation,
  ): Promise<RatingCategoryIconPrepared>;
  commit(
    intent: RatingCategoryIconIntent,
    prepared: RatingCategoryIconPreparation,
    cancel: Cancellation,
  ): Promise<RatingCategoryIconReceipt>;
  cancel(
    intent: RatingCategoryIconIntent,
    cancel: Cancellation,
  ): Promise<RatingCategoryIconReceipt>;
  cancelByHash(
    requestId: string,
    operation: RatingCategoryIconIntent['operation'],
    intentHash: string,
    cancel: Cancellation,
  ): Promise<RatingCategoryIconReceipt>;
  receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<RatingCategoryIconReceipt>;
  retirementStatus(
    request: RatingCategoryIconRetirementStatusRequest,
    cancel: Cancellation,
  ): Promise<RatingCategoryIconRetirementStatus>;
  cleanupRetirement(
    request: RatingCategoryIconRetirementRequest,
    cancel: Cancellation,
  ): Promise<RatingCategoryIconRetirementCleanup>;
}
const prefix = '/v5/ratings/category-management';
const id = (value: string): string => {
  if (!ratingId(value)) invalidRating();
  return value;
};
function query(raw: RatingCategoryIconContext): Record<string, string> {
  const context = decodeRatingCategoryIconContext(raw);
  return {
    contextId: context.commandContext.id,
    contextToken: context.commandContext.token,
  };
}
/** Preparation never implies consent to commit. Recovery cannot refresh an intent or invent a closure. */
export class HttpRatingCategoryIconGateway implements RatingCategoryIconGateway {
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
  async entryContext(
    raw: RatingNavigationSelector,
    cancel: Cancellation,
  ): Promise<CategoryIconEntryContext> {
    const selector = decodeRatingNavigationSelector(raw),
      result = await this.request(
        `${prefix}/entry-context`,
        'POST',
        decodeCategoryIconEntryContext,
        cancel,
        { selector },
      );
    if (
      ratingNavigationKey(result.context.commandContext.selector) !==
      ratingNavigationKey(selector)
    )
      invalidRating();
    return result;
  }
  async context(
    raw: RatingNavigationSelector,
    cancel: Cancellation,
  ): Promise<RatingCategoryIconContext> {
    const selector = decodeRatingNavigationSelector(raw);
    const result = await this.request(
      `${prefix}/contexts`,
      'POST',
      decodeRatingCategoryIconContext,
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
    context: RatingCategoryIconContext,
    cancel: Cancellation,
  ): Promise<RatingManagedIconCategories> {
    const result = await this.request(
      `${prefix}/categories`,
      'GET',
      decodeRatingManagedIconCategories,
      cancel,
      undefined,
      query(context),
    );
    if (
      result.snapshotRevision !== context.snapshotRevision ||
      result.mediaSnapshot !== context.mediaSnapshot
    )
      invalidRating();
    return result;
  }
  async category(
    context: RatingCategoryIconContext,
    categoryId: string,
    cancel: Cancellation,
  ): Promise<RatingManagedIconCategory> {
    const result = await this.request(
      `${prefix}/categories/${id(categoryId)}`,
      'GET',
      decodeRatingManagedIconCategory,
      cancel,
      undefined,
      query(context),
    );
    if (result.id !== categoryId) invalidRating();
    return result;
  }
  async history(
    context: RatingCategoryIconContext,
    categoryId: string,
    cursor: string | null,
    cancel: Cancellation,
  ): Promise<RatingCategoryIconHistory> {
    const result = await this.request(
      `${prefix}/categories/${id(categoryId)}/history`,
      'GET',
      decodeRatingCategoryIconHistory,
      cancel,
      undefined,
      { ...query(context), ...(cursor === null ? {} : { cursor: id(cursor) }) },
    );
    if (cursor !== null && result.nextCursor === cursor) invalidRating();
    return result;
  }
  systemOptions(
    context: RatingCategoryIconContext,
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
    raw: RatingCategoryIconIntent,
    cancel: Cancellation,
  ): Promise<RatingCategoryIconPrepared> {
    const intent = decodeRatingCategoryIconIntent(raw);
    const result = await this.request(
      `${prefix}/prepare`,
      'POST',
      decodeRatingCategoryIconPrepared,
      cancel,
      intent,
    );
    if ('outcome' in result) matchRatingCategoryIconReceipt(intent, result);
    else matchRatingCategoryIconPreparation(intent, result);
    return result;
  }
  async commit(
    raw: RatingCategoryIconIntent,
    preview: RatingCategoryIconPreparation,
    cancel: Cancellation,
  ): Promise<RatingCategoryIconReceipt> {
    const intent = decodeRatingCategoryIconIntent(raw),
      prepared = decodeRatingCategoryIconPreparation(preview);
    matchRatingCategoryIconPreparation(intent, prepared);
    const result = await this.request(
      `${prefix}/commit`,
      'POST',
      decodeRatingCategoryIconReceipt,
      cancel,
      { intent, preparationContextRevision: prepared.contextRevision },
    );
    matchRatingCategoryIconReceipt(intent, result);
    return result;
  }
  async cancel(
    raw: RatingCategoryIconIntent,
    cancel: Cancellation,
  ): Promise<RatingCategoryIconReceipt> {
    const intent = decodeRatingCategoryIconIntent(raw);
    const result = await this.request(
      `${prefix}/cancel`,
      'POST',
      decodeRatingCategoryIconReceipt,
      cancel,
      intent,
    );
    matchRatingCategoryIconReceipt(intent, result);
    return result;
  }
  async cancelByHash(
    requestId: string,
    operation: RatingCategoryIconIntent['operation'],
    intentHash: string,
    cancel: Cancellation,
  ): Promise<RatingCategoryIconReceipt> {
    if (!/^[a-f0-9]{64}$/.test(intentHash)) invalidRating();
    const receipt = await this.request(
      `${prefix}/cancel-by-hash`,
      'POST',
      decodeRatingCategoryIconReceipt,
      cancel,
      { protocolVersion: 5, requestId: id(requestId), operation, intentHash },
    );
    if (
      receipt.requestId !== requestId ||
      receipt.operation !== operation ||
      receipt.intentHash !== intentHash
    )
      invalidRating();
    return receipt;
  }
  async receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<RatingCategoryIconReceipt> {
    const result = await this.request(
      `/v5/ratings/requests/${id(requestId)}`,
      'GET',
      decodeRatingCategoryIconReceipt,
      cancel,
    );
    if (result.requestId !== requestId) invalidRating();
    return result;
  }
  async retirementStatus(
    raw: RatingCategoryIconRetirementStatusRequest,
    cancel: Cancellation,
  ): Promise<RatingCategoryIconRetirementStatus> {
    const request = decodeRatingCategoryIconRetirementStatusRequest(raw);
    const result = await this.request(
      `${prefix}/retirement/status`,
      'POST',
      decodeRatingCategoryIconRetirementStatus,
      cancel,
      request,
    );
    if ('appearanceIds' in request)
      matchRatingCategoryIconRetirementIds(
        request.appearanceIds,
        result.items.map((item) => item.appearanceId),
      );
    return result;
  }
  async cleanupRetirement(
    raw: RatingCategoryIconRetirementRequest,
    cancel: Cancellation,
  ): Promise<RatingCategoryIconRetirementCleanup> {
    const request = decodeRatingCategoryIconRetirementRequest(raw);
    const result = await this.request(
      `${prefix}/retirement/cleanup`,
      'POST',
      decodeRatingCategoryIconRetirementCleanup,
      cancel,
      request,
    );
    matchRatingCategoryIconRetirementIds(
      request.appearanceIds,
      result.appearanceIds,
    );
    return result;
  }
}
