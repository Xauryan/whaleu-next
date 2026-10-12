import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { registerTransactionExactDeadline } from '../../database/transaction-deadlines.js';
import {
  windowCatalogSchema,
  windowSchema,
  windowOwnSchema,
  windowSummarySchema,
} from './contracts.js';
import type { WindowQuery } from './contracts.js';
import type { WindowPosition } from './cursor.js';
import { windowSource } from './proof.js';
interface WindowRow {
  window_id: string;
  revision: string;
  name: string;
  canteen_id: string;
  canteen_name: string;
  floor_id: string;
  floor_label: string;
  source_floor_key: string;
  rank: number;
  mean: string | null;
  count: string;
}
const topology = `FROM whaleu_ratings.window_entries e JOIN whaleu_ratings.canteen_entries c ON c.catalog_id=e.catalog_id AND c.canteen_id=e.canteen_id JOIN whaleu_ratings.window_floor_entries f ON f.catalog_id=e.catalog_id AND f.floor_id=e.floor_id JOIN whaleu_ratings.window_floor_identities fi ON fi.id=f.floor_id`;
const fields = `e.window_id,e.revision,e.name,e.canteen_id,c.name canteen_name,e.floor_id,f.label floor_label,fi.source_floor_key`;
const active = `e.is_active AND c.is_active AND f.is_active`;
@Injectable()
export class WindowRepository {
  async catalog(catalog: string, tx: PoolClient) {
    const rows = (
      await tx.query<{ value: unknown }>(
        `SELECT jsonb_build_object('id',e.canteen_id,'revision',e.revision,'name',e.name,'sourceCanteenKey',i.source_canteen_key,'campusId',e.campus_id,'campusLabel',e.campus_label,'sourceCampusKey',e.source_campus_key,'floors',coalesce((SELECT jsonb_agg(jsonb_build_object('id',f.floor_id,'sourceFloorKey',fi.source_floor_key,'label',f.label) ORDER BY f.floor_id) FROM whaleu_ratings.window_floor_entries f JOIN whaleu_ratings.window_floor_identities fi ON fi.id=f.floor_id WHERE f.catalog_id=e.catalog_id AND f.canteen_id=e.canteen_id AND f.is_active),'[]'::jsonb)) value FROM whaleu_ratings.canteen_entries e JOIN whaleu_ratings.canteen_identities i ON i.id=e.canteen_id WHERE e.catalog_id=$1 AND e.is_active ORDER BY e.canteen_id`,
        [catalog],
      )
    ).rows;
    return windowCatalogSchema.parse({
      catalogRevision: catalog,
      canteens: rows.map((r) => r.value),
    });
  }
  async orderingDeadline(catalog: string, q: WindowQuery, tx: PoolClient) {
    // Bound every candidate that could enter/leave the filtered ranking at a time
    // boundary, including currently unknown and positive-minimum-excluded rows.
    const until = (
      await tx.query<{ until: string | null }>(
        `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now) SELECT min(boundary.value)::text until ${topology} JOIN whaleu_ratings.window_history_heads h ON h.window_id=e.window_id JOIN whaleu_ratings.window_history_assertions a ON a.id=h.assertion_id CROSS JOIN instant CROSS JOIN LATERAL(VALUES(a.accepted_at),(a.valid_until)) boundary(value) WHERE e.catalog_id=$1 AND ${active} AND ($2::uuid[] IS NULL OR e.canteen_id=ANY($2)) AND ($3::uuid IS NULL OR e.floor_id=$3) AND a.coverage='accepted_empty' AND boundary.value>instant.now`,
        [catalog, q.canteenIds ?? null, q.floorId ?? null],
      )
    ).rows[0]!.until;
    registerTransactionExactDeadline(tx, until, 'DISCOVERY_RESTART_REQUIRED');
    return until;
  }
  async page(
    catalog: string,
    q: WindowQuery,
    after: WindowPosition | null,
    tx: PoolClient,
  ) {
    return (
      await tx.query<WindowRow>(
        `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now),directory AS(SELECT ${fields},CASE WHEN whaleu_ratings.window_history(e.window_id,instant.now) IS NULL THEN 2 WHEN totals.count=0 THEN 1 ELSE 0 END rank,CASE WHEN whaleu_ratings.window_history(e.window_id,instant.now) IS NOT NULL THEN totals.mean END mean,CASE WHEN whaleu_ratings.window_history(e.window_id,instant.now) IS NOT NULL THEN totals.count ELSE 0 END count ${topology} CROSS JOIN instant LEFT JOIN LATERAL(SELECT count(*) count,round(avg(s.score)::numeric,1) mean FROM whaleu_ratings.window_score_heads h JOIN whaleu_ratings.window_score_events s ON s.id=h.revision WHERE h.window_id=e.window_id) totals ON true WHERE e.catalog_id=$1 AND ${active} AND ($2::uuid[] IS NULL OR e.canteen_id=ANY($2)) AND ($3::uuid IS NULL OR e.floor_id=$3)) SELECT *,mean::text,count::text FROM directory WHERE ($4::numeric IS NULL OR $4<=0 OR (rank=0 AND mean>=$4)) AND ($5::uuid IS NULL OR rank>$6 OR (rank=$6 AND (mean<$7 OR (mean IS NOT DISTINCT FROM $7::numeric AND (count<$8 OR (count=$8 AND window_id>$5)))))) ORDER BY directory.rank ASC,directory.mean DESC NULLS LAST,directory.count DESC,directory.window_id ASC LIMIT $9`,
        [
          catalog,
          q.canteenIds ?? null,
          q.floorId ?? null,
          q.minRating ?? null,
          after?.id ?? null,
          after?.rank ?? null,
          after?.mean ?? null,
          after?.count ?? null,
          q.limit + 1,
        ],
      )
    ).rows;
  }
  project(row: WindowRow) {
    return windowSchema.parse({
      id: row.window_id,
      revision: row.revision,
      name: row.name,
      canteenId: row.canteen_id,
      canteenName: row.canteen_name,
      floor: {
        id: row.floor_id,
        sourceFloorKey: row.source_floor_key,
        label: row.floor_label,
      },
      summary:
        row.rank === 2
          ? { kind: 'unavailable' }
          : {
              kind: 'known',
              ratingCount: Number(row.count),
              mean: row.mean === null ? null : Number(row.mean),
            },
    });
  }
  async detail(catalog: string, id: string, tx: PoolClient) {
    const row = (
      await tx.query<WindowRow>(
        `SELECT ${fields} ${topology} WHERE e.catalog_id=$1 AND e.window_id=$2 AND ${active}`,
        [catalog, id],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('WINDOW_NOT_FOUND');
    return windowSchema.parse({
      ...this.project({ ...row, rank: 2, mean: null, count: '0' }),
      summary: await this.summary(id, tx),
    });
  }
  async summary(id: string, tx: PoolClient) {
    const source = await windowSource(id, tx);
    if (source.history === null)
      return windowSummarySchema.parse({ kind: 'unavailable' });
    const row = (
      await tx.query<{ count: string; mean: string | null }>(
        `SELECT count(*)::text count,round(avg(e.score)::numeric,1)::text mean FROM whaleu_ratings.window_score_heads h JOIN whaleu_ratings.window_score_events e ON e.id=h.revision WHERE h.window_id=$1`,
        [id],
      )
    ).rows[0]!;
    return windowSummarySchema.parse({
      kind: 'known',
      ratingCount: Number(row.count),
      mean: row.mean === null ? null : Number(row.mean),
    });
  }
  async score(id: string, actor: string, tx: PoolClient) {
    return (
      await tx.query<{ id: string; score: number; recorded_at: Date }>(
        'SELECT e.id,e.score,e.recorded_at FROM whaleu_ratings.window_score_heads h JOIN whaleu_ratings.window_score_events e ON e.id=h.revision WHERE h.window_id=$1 AND h.actor_id=$2',
        [id, actor],
      )
    ).rows[0];
  }
  async own(id: string, actor: string, tx: PoolClient) {
    const row = await this.score(id, actor, tx);
    if (row)
      return windowOwnSchema.parse({
        kind: 'recorded',
        score: row.score,
        revision: row.id,
        recordedAt: row.recorded_at.toISOString(),
      });
    return windowOwnSchema.parse({
      kind: (await windowSource(id, tx)).history
        ? 'not_submitted'
        : 'unavailable',
    });
  }
}
