import { z } from 'zod';
import type { SessionView } from '../../identity/contracts.js';
import { discoveryScopeHash } from '../discovery-cursors.js';
import type { SearchQuery } from './contracts.js';
import { SEARCH_MATCHER_ID } from './matching.js';

export const searchAnchorSchema = z.strictObject({
  at: z.iso.datetime({ precision: 6 }),
  id: z.uuid().refine((value) => value === value.toLowerCase()),
});
export type SearchAnchor = z.infer<typeof searchAnchorSchema>;
export function searchAnchorFollows(a: SearchAnchor, b: SearchAnchor): boolean {
  return a.at < b.at || (a.at === b.at && a.id < b.id);
}
export const searchPositionSchema = z
  .strictObject({
    v: z.literal(1),
    kind: z.literal('search'),
    matcherId: z.literal(SEARCH_MATCHER_ID),
    after: searchAnchorSchema,
    visible: searchAnchorSchema.nullable(),
  })
  .refine(
    ({ after, visible }) =>
      visible === null ||
      searchAnchorFollows(after, visible) ||
      (after.at === visible.at && after.id === visible.id),
  );
export type SearchPosition = z.infer<typeof searchPositionSchema>;

export function searchCursorScope(
  query: SearchQuery,
  session: SessionView | null,
): string {
  return discoveryScopeHash([
    'community-search',
    1,
    SEARCH_MATCHER_ID,
    query.q,
    query.spaceId,
    query.category ?? null,
    query.tradingSubtype ?? null,
    query.limit,
    session?.accountId ?? null,
    session?.sessionId ?? null,
  ]);
}
