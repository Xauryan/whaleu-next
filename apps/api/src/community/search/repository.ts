import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { categorySchema } from '../contracts.js';
import { searchAnchorSchema } from './cursor.js';
import type { Category } from '../contracts.js';
import type { TradingSubtype } from '../trading/contracts.js';
import type { SearchAnchor } from './cursor.js';

export const SEARCH_SCAN_BATCH = 128;
interface SearchStructuralFilters {
  readonly category: Category | null;
  readonly tradingSubtype: TradingSubtype | null;
  readonly excludeUrgentTrading: boolean;
}
export type SearchStructuralScope = SearchStructuralFilters &
  (
    | { readonly spaceId: string }
    | {
        readonly regionalSpaceIds: readonly string[];
        readonly globalSpaceIds: readonly string[];
      }
  );
export const searchCandidateSchema = searchAnchorSchema.extend({
  spaceId: z.uuid().refine((id) => id === id.toLowerCase()),
});
export type SearchCandidate = z.infer<typeof searchCandidateSchema>;

/** Structural navigation only. No keyword, body, named relationship, contact,
 * resolution, matching-derived rank or cross-owner table enters this query. */
@Injectable()
export class SearchRepository {
  async candidates(
    scope: SearchStructuralScope,
    after: SearchAnchor | null,
    tx: PoolClient,
  ): Promise<SearchCandidate[]> {
    if (!('spaceId' in scope))
      return (
        await tx.query<SearchCandidate>(
          `SELECT p.id,p.space_id AS "spaceId",to_char(p.published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
         FROM whaleu_community.posts p
         WHERE ((p.space_id=ANY($1::uuid[]) AND p.category=ANY($2::text[]))
           OR (p.space_id=ANY($3::uuid[]) AND p.category='discussion'))
           AND ($4::text IS NULL OR p.category=$4)
           AND p.deleted_at IS NULL AND p.visibility='approved'
           AND ($5::text IS NULL OR EXISTS (
             SELECT 1 FROM whaleu_community.trading_listings t WHERE t.post_id=p.id AND t.subtype=$5))
           AND ($6::timestamptz IS NULL OR (p.published_at,p.id)<($6::timestamptz,$7::uuid))
         ORDER BY p.published_at DESC,p.id DESC LIMIT ${SEARCH_SCAN_BATCH + 1}`,
          [
            scope.regionalSpaceIds,
            categorySchema.options,
            scope.globalSpaceIds,
            scope.category,
            scope.tradingSubtype,
            after?.at ?? null,
            after?.id ?? null,
          ],
        )
      ).rows;
    return (
      await tx.query<SearchCandidate>(
        `SELECT p.id,p.space_id AS "spaceId",to_char(p.published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
         FROM whaleu_community.posts p
         WHERE p.space_id=$1 AND ($2::text IS NULL OR p.category=$2)
           AND p.deleted_at IS NULL AND p.visibility='approved'
           AND ($3::text IS NULL OR EXISTS (
             SELECT 1 FROM whaleu_community.trading_listings t WHERE t.post_id=p.id AND t.subtype=$3))
           AND (NOT $4::boolean OR NOT EXISTS (
             SELECT 1 FROM whaleu_community.trading_listings t WHERE t.post_id=p.id AND t.urgency='urgent'))
           AND ($5::timestamptz IS NULL OR (p.published_at,p.id)<($5::timestamptz,$6::uuid))
         ORDER BY p.published_at DESC,p.id DESC LIMIT ${SEARCH_SCAN_BATCH + 1}`,
        [
          scope.spaceId,
          scope.category,
          scope.tradingSubtype,
          scope.excludeUrgentTrading,
          after?.at ?? null,
          after?.id ?? null,
        ],
      )
    ).rows;
  }

  async lockCandidate(
    id: string,
    tx: PoolClient,
  ): Promise<SearchCandidate | null> {
    return (
      (
        await tx.query<SearchCandidate>(
          `SELECT id,space_id AS "spaceId",to_char(published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
       FROM whaleu_community.posts WHERE id=$1 FOR SHARE`,
          [id],
        )
      ).rows[0] ?? null
    );
  }

  async exactAnchor(anchor: SearchAnchor, tx: PoolClient): Promise<boolean> {
    return (
      (
        await tx.query<{ matches: boolean }>(
          'SELECT published_at=$2::timestamptz AS matches FROM whaleu_community.posts WHERE id=$1',
          [anchor.id, anchor.at],
        )
      ).rows[0]?.matches === true
    );
  }

  async tradingFilter(
    postId: string,
    tx: PoolClient,
  ): Promise<{
    subtype: string;
    urgency: 'normal' | 'urgent';
  } | null> {
    return (
      (
        await tx.query<{ subtype: string; urgency: 'normal' | 'urgent' }>(
          'SELECT subtype,urgency FROM whaleu_community.trading_listings WHERE post_id=$1 FOR SHARE',
          [postId],
        )
      ).rows[0] ?? null
    );
  }
}
