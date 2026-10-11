import { exact } from '../community/contract';
import type { ApiClient } from '../api/client';
import type { SessionStore } from '../auth/session';
import type { Cancellation, Json } from '../platform/contracts';
import { invalidRating } from './contract';
import {
  canonicalRatingScopedJson,
  decodeRatingScopedContext,
  type RatingScopedContext,
  decodeRatingScopedContextRequest,
  type RatingScopedContextRequest,
} from './scoped-contract';
import { ratingPageQuery } from './discussion-gateway';
import {
  decodeCategoryIconPublicContext,
  decodeCategoryIconPublicPage,
  type CategoryIconPublicContext,
  type CategoryIconPublicPage,
} from './category-icon-public-contract';
export type CategoryIconPublicEntry =
  | { readonly kind: 'icon'; readonly context: CategoryIconPublicContext }
  | { readonly kind: 'legacy'; readonly context: RatingScopedContext };
export function decodeCategoryIconPublicEntry(
  value: unknown,
): CategoryIconPublicEntry {
  exact(value, ['kind', 'context']);
  if (value.kind === 'icon')
    return {
      kind: 'icon',
      context: decodeCategoryIconPublicContext(value.context),
    };
  if (value.kind === 'legacy')
    return {
      kind: 'legacy',
      context: decodeRatingScopedContext(value.context),
    };
  return invalidRating();
}
export interface CategoryIconPublicGateway {
  entryContext(
    request: RatingScopedContextRequest,
    cancel: Cancellation,
  ): Promise<CategoryIconPublicEntry>;
  context(
    request: RatingScopedContextRequest,
    cancel: Cancellation,
  ): Promise<CategoryIconPublicContext>;
  categories(
    context: CategoryIconPublicContext,
    parentId: string | null,
    cursor: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<CategoryIconPublicPage>;
}
export class HttpCategoryIconPublicGateway implements CategoryIconPublicGateway {
  constructor(
    private readonly api: ApiClient,
    private readonly sessions: SessionStore,
  ) {}
  async entryContext(
    raw: RatingScopedContextRequest,
    cancel: Cancellation,
  ): Promise<CategoryIconPublicEntry> {
    const ticket = this.sessions.snapshot(),
      request = decodeRatingScopedContextRequest(raw);
    const result = await this.api.request(
      {
        path: '/v5/ratings/entry-context',
        method: 'POST',
        decode: decodeCategoryIconPublicEntry,
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
      },
      { cancellation: cancel, body: request as unknown as Json },
    );
    this.sessions.assertCurrent(ticket);
    const context = result.context;
    if (
      context.actorId !== ticket.credentials?.accountId ||
      context.mode !== request.mode ||
      context.purpose !== request.purpose ||
      canonicalRatingScopedJson(context.selector) !==
        canonicalRatingScopedJson(request.selector)
    )
      invalidRating();
    return result;
  }
  async context(
    raw: RatingScopedContextRequest,
    cancel: Cancellation,
  ): Promise<CategoryIconPublicContext> {
    const ticket = this.sessions.snapshot(),
      request = decodeRatingScopedContextRequest(raw);
    const result = await this.api.request(
      {
        path: '/v5/ratings/contexts',
        method: 'POST',
        decode: decodeCategoryIconPublicContext,
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
      },
      { cancellation: cancel, body: request as unknown as Json },
    );
    this.sessions.assertCurrent(ticket);
    if (
      result.actorId !== ticket.credentials?.accountId ||
      result.mode !== request.mode ||
      result.purpose !== request.purpose ||
      canonicalRatingScopedJson(result.selector) !==
        canonicalRatingScopedJson(request.selector)
    )
      invalidRating();
    return result;
  }
  async categories(
    raw: CategoryIconPublicContext,
    parentId: string | null,
    cursor: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<CategoryIconPublicPage> {
    const ticket = this.sessions.snapshot(),
      context = decodeCategoryIconPublicContext(raw);
    if (
      context.purpose !== 'read' ||
      context.mode !== 'public' ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      invalidRating();
    const result = await this.api.request(
      {
        path: '/v5/ratings/categories',
        method: 'GET',
        decode: decodeCategoryIconPublicPage,
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
      },
      {
        cancellation: cancel,
        query: {
          contextId: context.id,
          contextToken: context.token,
          ...(parentId === null ? {} : { parentId }),
          ...ratingPageQuery(cursor, limit),
        },
      },
    );
    this.sessions.assertCurrent(ticket);
    if (
      result.items.length > limit ||
      (result.nextCursor !== null && result.nextCursor === cursor) ||
      result.context.contextId !== context.id ||
      result.context.parentId !== parentId ||
      result.context.protocolGeneration !== context.protocolGeneration ||
      result.context.catalogRevision !== context.heads[0]?.catalogRevision ||
      canonicalRatingScopedJson(result.context.selector) !==
        canonicalRatingScopedJson(context.selector) ||
      result.items.some(
        (item) =>
          item.icon !== null && item.icon.contextToken !== context.token,
      )
    )
      invalidRating();
    return result;
  }
}
