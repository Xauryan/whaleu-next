import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { CommunitySpace } from '../contracts.js';
import { categorySchema } from '../contracts.js';
import { HOT_CURRENT_JOINS, HOT_CURRENT_HINT } from '../hot-score/storage.js';
import { hotAnchorSchema, hotVisibleSchema } from './cursor.js';
import type { HotAnchor, HotVisible } from './cursor.js';
import type { HotQuery } from './contracts.js';
import { HOT_RANGES } from './contracts.js';
export const HOT_SCAN_BATCH = 128;
export const hotCandidateSchema = hotAnchorSchema.extend({
  spaceId: z.uuid().refine((id) => id === id.toLowerCase()),
  at: z.iso.datetime({ precision: 6 }),
});
export type HotCandidate = z.infer<typeof hotCandidateSchema>;
const published =
  'to_char(p.published_at AT TIME ZONE \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\')';
@Injectable()
export class HotRepository {
  async clock(tx: PoolClient): Promise<string> {
    const row = (
      await tx.query<{ now: string }>(
        `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`,
      )
    ).rows[0];
    return z.iso.datetime({ precision: 6 }).parse(row?.now);
  }
  async candidates(
    space: CommunitySpace,
    query: HotQuery,
    clock: string,
    after: HotAnchor | null,
    tx: PoolClient,
  ): Promise<HotCandidate[]> {
    return (
      await tx.query<HotCandidate>(
        `SELECT p.id,p.space_id AS "spaceId",${published} AS at,hs.score::text
      FROM whaleu_post_hotness.scores hs JOIN whaleu_community.posts p ON p.id=hs.post_id ${HOT_CURRENT_JOINS}
      WHERE p.space_id=$1 AND p.category=ANY($2::text[]) AND p.deleted_at IS NULL AND p.visibility='approved'
      AND p.published_at<=$3::timestamptz AND ($4::integer IS NULL OR p.published_at>=$3::timestamptz-make_interval(hours=>$4::integer*24))
      AND (p.category<>'trading' OR EXISTS(SELECT 1 FROM whaleu_community.trading_listings t WHERE t.post_id=p.id AND t.urgency='normal' AND t.resolution='open'))
      AND (${HOT_CURRENT_HINT}) AND ($5::numeric IS NULL OR (hs.score,p.id)<($5::numeric,$6::uuid))
      ORDER BY hs.score DESC,p.id DESC LIMIT ${HOT_SCAN_BATCH + 1}`,
        [
          space.id,
          space.kind === 'global' ? ['discussion'] : categorySchema.options,
          clock,
          HOT_RANGES[query.range].days,
          after?.score ?? null,
          after?.id ?? null,
        ],
      )
    ).rows;
  }
  /** Metadata only, including lookahead. Lock all parents by UUID before states. */
  async lockCandidate(id: string, tx: PoolClient): Promise<HotVisible | null> {
    const row = (
      await tx.query<HotVisible>(
        `SELECT p.id,p.space_id AS "spaceId",${published} AS at FROM whaleu_community.posts p WHERE p.id=$1 FOR SHARE`,
        [id],
      )
    ).rows[0];
    return row ? hotVisibleSchema.parse(row) : null;
  }
  async structurallyAllowed(
    id: string,
    space: CommunitySpace,
    query: HotQuery,
    clock: string,
    tx: PoolClient,
  ): Promise<boolean> {
    return (
      (
        await tx.query(
          `SELECT p.id FROM whaleu_community.posts p
      WHERE p.id=$1 AND p.space_id=$2 AND p.category=ANY($3::text[]) AND p.deleted_at IS NULL AND p.visibility='approved'
      AND p.published_at<=$4::timestamptz AND ($5::integer IS NULL OR p.published_at>=$4::timestamptz-make_interval(hours=>$5::integer*24))`,
          [
            id,
            space.id,
            space.kind === 'global' ? ['discussion'] : categorySchema.options,
            clock,
            HOT_RANGES[query.range].days,
          ],
        )
      ).rows.length === 1
    );
  }
  async tradingAllowed(postId: string, tx: PoolClient): Promise<boolean> {
    const row = (
      await tx.query<{ urgency: string; resolution: string }>(
        'SELECT urgency,resolution FROM whaleu_community.trading_listings WHERE post_id=$1 FOR SHARE',
        [postId],
      )
    ).rows[0];
    return row?.urgency === 'normal' && row.resolution === 'open';
  }
}
