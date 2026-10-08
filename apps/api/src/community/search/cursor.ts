import { SEARCH_ENROLLMENT_VERSION } from './scope.js';
import { z } from 'zod';
import type { SessionView } from '../../identity/contracts.js';
import { discoveryScopeHash } from '../discovery-cursors.js';
import { searchKindSchema } from './contracts.js';
import type { SearchQuery, SearchKind } from './contracts.js';
import { SEARCH_MATCHER_ID } from './matching.js';

export const SEARCH_KIND_ORDER: Readonly<Record<SearchKind, number>> = {
  post: 0,
  comment: 1,
  reply: 2,
};
export const SEARCH_ORDER_ID = 'created-desc-kind-asc-id-desc-v1';
export const searchAnchorSchema = z.strictObject({
  at: z.iso.datetime({ precision: 6 }),
  kind: searchKindSchema,
  id: z.uuid().refine((value) => value === value.toLowerCase()),
});
export type SearchAnchor = z.infer<typeof searchAnchorSchema>;
export function searchAnchorFollows(a: SearchAnchor, b: SearchAnchor): boolean {
  return (
    a.at < b.at ||
    (a.at === b.at &&
      (SEARCH_KIND_ORDER[a.kind] > SEARCH_KIND_ORDER[b.kind] ||
        (a.kind === b.kind && a.id < b.id)))
  );
}
export const searchPositionSchema = z
  .strictObject({
    v: z.literal(3),
    kind: z.literal('search'),
    matcherId: z.literal(SEARCH_MATCHER_ID),
    orderId: z.literal(SEARCH_ORDER_ID),
    after: searchAnchorSchema,
    visible: searchAnchorSchema.nullable(),
  })
  .refine(
    ({ after, visible }) =>
      visible === null ||
      searchAnchorFollows(after, visible) ||
      (after.at === visible.at &&
        after.kind === visible.kind &&
        after.id === visible.id),
  );
export type SearchPosition = z.infer<typeof searchPositionSchema>;

export const federatedSearchPositionSchema = z
  .strictObject({
    v: z.literal(4),
    kind: z.literal('search'),
    matcherId: z.literal(SEARCH_MATCHER_ID),
    orderId: z.literal(SEARCH_ORDER_ID),
    membershipFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    after: searchAnchorSchema,
    visible: searchAnchorSchema.nullable(),
  })
  .refine(
    ({ after, visible }) =>
      visible === null ||
      searchAnchorFollows(after, visible) ||
      (after.at === visible.at &&
        after.kind === visible.kind &&
        after.id === visible.id),
  );
export type FederatedSearchPosition = z.infer<
  typeof federatedSearchPositionSchema
>;

export function searchCursorScope(
  query: SearchQuery,
  session: SessionView | null,
): string {
  if ('scope' in query)
    return discoveryScopeHash([
      'community-search',
      4,
      SEARCH_MATCHER_ID,
      SEARCH_ORDER_ID,
      query.type,
      query.from ?? null,
      query.to ?? null,
      query.postId ?? null,
      query.q,
      query.scope,
      SEARCH_ENROLLMENT_VERSION,
      query.category ?? null,
      query.tradingSubtype ?? null,
      query.limit,
      session?.accountId ?? null,
      session?.sessionId ?? null,
    ]);
  return discoveryScopeHash([
    'community-search',
    3,
    SEARCH_MATCHER_ID,
    SEARCH_ORDER_ID,
    query.type,
    query.from ?? null,
    query.to ?? null,
    query.postId ?? null,
    query.q,
    query.spaceId,
    query.category ?? null,
    query.tradingSubtype ?? null,
    query.limit,
    session?.accountId ?? null,
    session?.sessionId ?? null,
  ]);
}
