import type { PoolClient } from 'pg';
import { homeDistributionCandidateSql } from '../community/home-distribution/candidate-sql.js';
import { ApplicationError } from '../http/application-error.js';
import { captureOfficialRoots, OFFICIAL_TIME_FRONTIER } from './coverage.js';
import { compareOfficialScore, OFFICIAL_PROFILE } from './profile.js';
import type { OfficialSourceFact, OfficialSourcePort } from './source.js';
import { requireOfficialSource } from './source.js';

export interface OfficialSelection {
  selectionAt: string;
  facts: OfficialSourceFact[];
  examined: number;
  sourceState: 'complete' | 'known_empty';
}
export class OfficialSourceSelector {
  constructor(private readonly source: OfficialSourcePort) {}
  async select(
    input: {
      schoolSpaceId: string;
      citySpaceId: string | null;
      kind: 'daily_hot' | 'manual_newest';
      limit?: number;
    },
    tx: PoolClient,
  ): Promise<OfficialSelection> {
    const daily = input.kind === 'daily_hot';
    const home = homeDistributionCandidateSql('p', null, 'official', []);
    const limit = input.limit ?? (daily ? 30 : 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > (daily ? 30 : 10))
      throw new ApplicationError('OFFICIAL_REQUEST_INVALID');
    const selectionAt = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() now')
    ).rows[0]!.now.toISOString();
    const spaces = [
      ...new Set([
        input.schoolSpaceId,
        ...(daily && input.citySpaceId ? [input.citySpaceId] : []),
      ]),
    ];
    await captureOfficialRoots(spaces, tx, daily);
    let examined = 0;
    const chosen: OfficialSourceFact[] = [];
    const seen = new Set<string>();
    for (const space of spaces) {
      if (daily) {
        const unknown = (
          await tx.query(
            `SELECT r.post_id FROM whaleu_official.source_ranks r JOIN whaleu_community.posts p ON p.id=r.post_id
      WHERE r.space_id=$1 AND r.daily_active AND r.decision='unknown' AND r.published_at>$2::timestamptz-interval '26 hours' AND r.published_at<=$2 AND ${home} LIMIT 1`,
            [space, selectionAt],
          )
        ).rows;
        const dirty = (
          await tx.query(
            'SELECT post_id FROM whaleu_official.source_dirty WHERE space_id=$1 LIMIT 1',
            [space],
          )
        ).rows;
        const windowPending = (
          await tx.query(OFFICIAL_TIME_FRONTIER, [[space], selectionAt])
        ).rows;
        if (unknown.length || dirty.length || windowPending.length)
          throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
      }
      const target =
        space === input.schoolSpaceId ? limit : Math.min(10, limit);
      let picked = 0,
        after: { id: string; at: string; score: string | null } | null = null;
      while (picked < target) {
        const remaining = OFFICIAL_PROFILE.examined - examined;
        if (remaining <= 0)
          throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
        const count = Math.min(32, remaining);
        const rows: { id: string; at: string; score: string | null }[] = (
          await tx.query<{ id: string; at: string; score: string | null }>(
            daily
              ? `SELECT r.post_id id,to_char(r.published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at,r.score::text FROM whaleu_official.source_ranks r JOIN whaleu_community.posts p ON p.id=r.post_id
         WHERE r.space_id=$1 AND r.daily_active AND $2::timestamptz IS NOT NULL AND ${home}
         AND r.decision='allow' AND ($3::numeric IS NULL OR (r.score,r.post_id)<($3::numeric,$4::uuid)) ORDER BY r.score DESC,r.post_id DESC LIMIT $5`
              : `SELECT p.id,to_char(p.published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at,NULL::text score FROM whaleu_community.posts p
         WHERE p.space_id=$1 AND p.published_at<=$2 AND ${home} AND ($3::timestamptz IS NULL OR (p.published_at,p.id)<($3::timestamptz,$4::uuid)) ORDER BY p.published_at DESC,p.id DESC LIMIT $5`,
            [
              space,
              selectionAt,
              daily ? (after?.score ?? null) : (after?.at ?? null),
              after?.id ?? null,
              count,
            ],
          )
        ).rows;
        for (const row of rows) {
          after = row;
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          examined++;
          const fact = requireOfficialSource(
            await this.source.inspect(row.id, daily, tx),
          );
          if (
            fact.spaceId !== space ||
            new Date(fact.publishedAt).getTime() >
              new Date(selectionAt).getTime()
          )
            throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
          if (
            daily &&
            (fact.score !== row.score ||
              new Date(fact.publishedAt).getTime() <=
                new Date(selectionAt).getTime() -
                  OFFICIAL_PROFILE.dailyWindowMs)
          )
            throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
          if (fact.decision === 'allow') {
            chosen.push(fact);
            picked++;
          }
          if (picked === target) break; // kth at 128 succeeds; no older suffix scan.
        }
        if (picked === target || rows.length < count) break;
        if (examined === OFFICIAL_PROFILE.examined) {
          const lookahead = (
            await tx.query(
              daily
                ? `SELECT r.post_id FROM whaleu_official.source_ranks r JOIN whaleu_community.posts p ON p.id=r.post_id WHERE r.space_id=$1 AND r.daily_active AND $2::timestamptz IS NOT NULL AND ${home} AND r.decision='allow' AND (r.score,r.post_id)<($3::numeric,$4::uuid) ORDER BY r.score DESC,r.post_id DESC LIMIT 1`
                : `SELECT p.id FROM whaleu_community.posts p WHERE p.space_id=$1 AND p.published_at<=$2 AND ${home} AND (p.published_at,p.id)<($3::timestamptz,$4::uuid) ORDER BY p.published_at DESC,p.id DESC LIMIT 1`,
              [space, selectionAt, daily ? after!.score : after!.at, after!.id],
            )
          ).rows;
          if (lookahead.length)
            throw new ApplicationError('OFFICIAL_SOURCE_UNAVAILABLE');
          break;
        }
      }
    }
    if (daily)
      chosen.sort(
        (a, b) =>
          compareOfficialScore(b.score!, a.score!) ||
          (a.postId > b.postId ? -1 : a.postId < b.postId ? 1 : 0),
      );
    const facts = chosen.slice(0, limit);
    return {
      selectionAt,
      facts,
      examined,
      sourceState: facts.length ? 'complete' : 'known_empty',
    };
  }
}
