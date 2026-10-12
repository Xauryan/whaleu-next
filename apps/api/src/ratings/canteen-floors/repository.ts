import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { WindowRepository } from '../windows/repository.js';
import {
  floorSchema,
  floorSummarySchema,
  floorOwnSchema,
} from './contracts.js';
import { floorSource } from './proof.js';
@Injectable()
export class FloorRepository {
  async catalog(catalog: string, tx: PoolClient) {
    return new WindowRepository().catalog(catalog, tx);
  }
  async detail(catalog: string, id: string, tx: PoolClient) {
    const row = (
      await tx.query<{
        floor_id: string;
        revision: string;
        canteen_id: string;
        name: string;
        source_floor_key: string;
        label: string;
      }>(
        `SELECT f.floor_id,c.revision,f.canteen_id,c.name,i.source_floor_key,f.label FROM whaleu_ratings.window_floor_entries f JOIN whaleu_ratings.canteen_entries c ON c.catalog_id=f.catalog_id AND c.canteen_id=f.canteen_id JOIN whaleu_ratings.window_floor_identities i ON i.id=f.floor_id WHERE f.catalog_id=$1 AND f.floor_id=$2 AND f.is_active AND c.is_active`,
        [catalog, id],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('FLOOR_NOT_FOUND');
    return floorSchema.parse({
      id: row.floor_id,
      canteenRevision: row.revision,
      canteenId: row.canteen_id,
      canteenName: row.name,
      sourceFloorKey: row.source_floor_key,
      label: row.label,
      summary: await this.summary(id, tx),
    });
  }
  async summary(id: string, tx: PoolClient) {
    if (!(await floorSource(id, tx)).history)
      return floorSummarySchema.parse({ kind: 'unavailable' });
    const row = (
      await tx.query<{ count: string; mean: string | null }>(
        `SELECT count(*)::text count,round(avg(e.score),1)::text mean FROM whaleu_ratings.floor_score_heads h JOIN whaleu_ratings.floor_score_events e ON e.id=h.revision WHERE h.floor_id=$1`,
        [id],
      )
    ).rows[0]!;
    return floorSummarySchema.parse({
      kind: 'known',
      ratingCount: Number(row.count),
      mean: row.mean === null ? null : Number(row.mean),
    });
  }
  async score(id: string, actor: string, tx: PoolClient) {
    return (
      await tx.query<{ id: string; score: string; recorded_at: Date }>(
        `SELECT e.id,e.score::text,e.recorded_at FROM whaleu_ratings.floor_score_heads h JOIN whaleu_ratings.floor_score_events e ON e.id=h.revision WHERE h.floor_id=$1 AND h.actor_id=$2`,
        [id, actor],
      )
    ).rows[0];
  }
  async own(id: string, actor: string, tx: PoolClient) {
    const row = await this.score(id, actor, tx);
    return floorOwnSchema.parse(
      row
        ? {
            kind: 'recorded',
            score: Number(row.score),
            revision: row.id,
            recordedAt: row.recorded_at.toISOString(),
          }
        : {
            kind: (await floorSource(id, tx)).history
              ? 'not_submitted'
              : 'unavailable',
          },
    );
  }
}
