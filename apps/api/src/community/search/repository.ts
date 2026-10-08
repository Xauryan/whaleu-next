import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ApplicationError } from '../../http/application-error.js';
import { categorySchema } from '../contracts.js';
import { searchAnchorSchema, SEARCH_KIND_ORDER } from './cursor.js';
import type { Category } from '../contracts.js';
import type { TradingSubtype } from '../trading/contracts.js';
import type { SearchAnchor } from './cursor.js';
import type { SearchKind } from './contracts.js';

export const SEARCH_SCAN_BATCH = 128;
// One structural window, its sentinel, and the previous visible cursor guard.
export const SEARCH_METADATA_LOCK_LIMIT = SEARCH_SCAN_BATCH + 2;
interface SearchStructuralFilters {
  readonly category: Category | null;
  readonly tradingSubtype: TradingSubtype | null;
  readonly excludeUrgentTrading: boolean;
  readonly types: readonly SearchKind[];
  readonly from: string | null;
  readonly to: string | null;
  readonly postId: string | null;
}
export type SearchStructuralScope = SearchStructuralFilters &
  (
    | { readonly spaceId: string }
    | {
        readonly regionalSpaceIds: readonly string[];
        readonly globalSpaceIds: readonly string[];
      }
  );
const uuid = z.uuid().refine((id) => id === id.toLowerCase());
export const searchCandidateSchema = searchAnchorSchema
  .extend({
    spaceId: uuid,
    postId: uuid,
    rootCommentId: uuid.nullable(),
  })
  .refine((item) =>
    item.kind === 'post'
      ? item.postId === item.id && item.rootCommentId === null
      : item.rootCommentId !== null &&
        (item.kind !== 'comment' || item.rootCommentId === item.id),
  );
export type SearchCandidate = z.infer<typeof searchCandidateSchema>;
export const searchCandidateKey = (
  item: Pick<SearchAnchor, 'kind' | 'id'>,
): string => `${item.kind}:${item.id}`;

const sources = {
  post: { table: 'posts', alias: 'p', time: 'published_at' },
  comment: { table: 'root_comments', alias: 'c', time: 'created_at' },
  reply: { table: 'replies', alias: 'r', time: 'created_at' },
} as const;
function columns(kind: SearchKind): string {
  const { alias, time } = sources[kind];
  return `${alias}.id,'${kind}'::text AS kind,p.space_id AS "spaceId",p.id AS "postId",
    ${kind === 'post' ? 'NULL::uuid' : kind === 'comment' ? 'c.id' : 'r.root_comment_id'} AS "rootCommentId",
    to_char(${alias}.${time} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`;
}
function from(kind: SearchKind): string {
  const { table, alias } = sources[kind];
  return `whaleu_community.${table} ${alias}${kind === 'post' ? '' : ` JOIN whaleu_community.posts p ON p.id=${alias}.post_id`}`;
}

/** Structural navigation only. No keyword, body, named relationship, contact,
 * resolution, matching-derived rank or cross-owner table enters this query. */
@Injectable()
export class SearchRepository {
  async candidates(
    scope: SearchStructuralScope,
    after: SearchAnchor | null,
    tx: PoolClient,
  ): Promise<SearchCandidate[]> {
    const branches = (['post', 'comment', 'reply'] as const).map((kind) => {
      const { alias, time } = sources[kind];
      const ordinal = SEARCH_KIND_ORDER[kind];
      return `(SELECT ${columns(kind)},${alias}.${time} AS sort_at,${ordinal} AS sort_kind
        FROM ${from(kind)}
        WHERE '${kind}'=ANY($13::text[])
          AND (($1::uuid IS NOT NULL AND p.space_id=$1)
            OR ($1::uuid IS NULL AND ((p.space_id=ANY($2::uuid[]) AND p.category=ANY($14::text[]))
              OR (p.space_id=ANY($3::uuid[]) AND p.category='discussion'))))
          AND ($4::text IS NULL OR p.category=$4)
          AND p.deleted_at IS NULL AND p.visibility='approved'
          ${kind === 'post' ? '' : `AND ${alias}.deleted_at IS NULL AND ${alias}.visibility='approved'`}
          AND ($5::text IS NULL OR EXISTS (SELECT 1 FROM whaleu_community.trading_listings t WHERE t.post_id=p.id AND t.subtype=$5))
          AND (NOT $6::boolean OR NOT EXISTS (SELECT 1 FROM whaleu_community.trading_listings t WHERE t.post_id=p.id AND t.urgency='urgent'))
          AND ($7::uuid IS NULL OR p.id=$7)
          AND ($8::timestamptz IS NULL OR ${alias}.${time}>=$8::timestamptz)
          AND ($9::timestamptz IS NULL OR ${alias}.${time}<$9::timestamptz)
          AND ($10::timestamptz IS NULL OR ${alias}.${time}<$10::timestamptz
            OR (${alias}.${time}=$10::timestamptz AND (${ordinal}>$11::integer OR (${ordinal}=$11::integer AND ${alias}.id<$12::uuid))))
        ORDER BY ${alias}.${time} DESC,${alias}.id DESC LIMIT ${SEARCH_SCAN_BATCH + 1})`;
    });
    return (
      await tx.query<SearchCandidate>(
        `SELECT id,kind,"spaceId","postId","rootCommentId",at FROM (${branches.join('\nUNION ALL\n')}) candidates
       ORDER BY sort_at DESC,sort_kind ASC,id DESC LIMIT ${SEARCH_SCAN_BATCH + 1}`,
        [
          'spaceId' in scope ? scope.spaceId : null,
          'spaceId' in scope ? [] : scope.regionalSpaceIds,
          'spaceId' in scope ? [] : scope.globalSpaceIds,
          scope.category,
          scope.tradingSubtype,
          scope.excludeUrgentTrading,
          scope.postId,
          scope.from,
          scope.to,
          after?.at ?? null,
          after ? SEARCH_KIND_ORDER[after.kind] : null,
          after?.id ?? null,
          scope.types,
          categorySchema.options,
        ],
      )
    ).rows;
  }

  /** Resolve a cursor's ancestry without reading its body or acquiring child
   * locks before its parent. All coordinates are rechecked after ordered locks. */
  async reference(
    anchor: Pick<SearchAnchor, 'kind' | 'id'>,
    tx: PoolClient,
  ): Promise<SearchCandidate | null> {
    return (
      (
        await tx.query<SearchCandidate>(
          `SELECT ${columns(anchor.kind)} FROM ${from(anchor.kind)} WHERE ${sources[anchor.kind].alias}.id=$1`,
          [anchor.id],
        )
      ).rows[0] ?? null
    );
  }

  /** Bounded metadata only. SQL, not caller order, acquires each kind's locks
   * in immutable UUID order. The service orders kinds across the whole window. */
  async lockCandidates(
    kind: SearchKind,
    ids: readonly string[],
    tx: PoolClient,
  ): Promise<SearchCandidate[]> {
    if (
      ids.length > SEARCH_METADATA_LOCK_LIMIT ||
      ids.some((id) => !uuid.safeParse(id).success)
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const distinct = [...new Set(ids)].sort();
    if (!distinct.length) return [];
    const { alias } = sources[kind];
    return (
      await tx.query<SearchCandidate>(
        `SELECT ${columns(kind)} FROM ${from(kind)} WHERE ${alias}.id=ANY($1::uuid[]) ORDER BY ${alias}.id ASC FOR SHARE OF ${alias}`,
        [distinct],
      )
    ).rows;
  }

  async exactAnchor(anchor: SearchAnchor, tx: PoolClient): Promise<boolean> {
    const { table, time } = sources[anchor.kind];
    return (
      (
        await tx.query<{ matches: boolean }>(
          `SELECT ${time}=$2::timestamptz AS matches FROM whaleu_community.${table} WHERE id=$1`,
          [anchor.id, anchor.at],
        )
      ).rows[0]?.matches === true
    );
  }

  async tradingFilter(
    postId: string,
    tx: PoolClient,
  ): Promise<{ subtype: string; urgency: 'normal' | 'urgent' } | null> {
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
