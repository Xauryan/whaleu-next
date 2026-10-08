import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { Category } from '../contracts.js';
import type { TradingSubtype } from '../trading/contracts.js';
import type { SearchAnchor } from './cursor.js';

export const SEARCH_SCAN_BATCH = 128;
export interface SearchStructuralScope {
  readonly spaceId: string;
  readonly category: Category | null;
  readonly tradingSubtype: TradingSubtype | null;
  readonly excludeUrgentTrading: boolean;
}
export type SearchCandidate = SearchAnchor;

/** Structural navigation only. No keyword, body, named relationship, contact,
 * resolution, matching-derived rank or cross-owner table enters this query. */
@Injectable()
export class SearchRepository {
  async candidates(
    scope: SearchStructuralScope,
    after: SearchAnchor | null,
    tx: PoolClient,
  ): Promise<SearchCandidate[]> {
    return (
      await tx.query<SearchCandidate>(
        `SELECT p.id,to_char(p.published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
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
