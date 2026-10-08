import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ApplicationError } from '../http/application-error.js';
import type { ErrandAdminQuery } from './admin-contracts.js';

export const errandAdminSeekSchema = z.strictObject({
  id: z.uuid(),
  createdAt: z.iso.datetime({ precision: 6 }),
});
export type ErrandAdminSeek = z.infer<typeof errandAdminSeekSchema>;
export interface ErrandAdminRow {
  id: string;
  revision: string;
  publisher_id: string;
  accepter_id: string | null;
  target_region_id: string;
  source_region_id: string;
  title: string;
  public_text: string;
  expected_time_text: string;
  reward: string;
  state: 'pending' | 'accepted' | 'completed' | 'cancelled';
  created_at: Date;
  scan_at: string;
  accepted_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  deleted_at: Date | null;
}
export const adminSeek = (row: ErrandAdminRow): ErrandAdminSeek =>
  errandAdminSeekSchema.parse({ id: row.id, createdAt: row.scan_at });

/** Administrative queries never join, select or hydrate private_details. */
@Injectable()
export class ErrandAdminRepository {
  async candidates(
    regionId: string,
    status: ErrandAdminQuery['status'],
    anchor: string,
    after: ErrandAdminSeek | null,
    limit: number,
    tx: PoolClient,
  ): Promise<ErrandAdminRow[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 257)
      throw new ApplicationError('ERRAND_UNAVAILABLE');
    const params: unknown[] = [regionId, anchor];
    const filters = ['target_region_id=$1', 'created_at<=$2::timestamptz'];
    if (status === 'deleted') filters.push('deleted_at IS NOT NULL');
    else if (status !== 'all') {
      params.push(status);
      filters.push(`deleted_at IS NULL AND state=$${params.length}`);
    }
    if (after) {
      params.push(after.createdAt, after.id);
      filters.push(
        `(created_at,id)<($${params.length - 1}::timestamptz,$${params.length}::uuid)`,
      );
    }
    params.push(limit);
    const rows = (
      await tx.query<ErrandAdminRow>(
        `SELECT id,revision,publisher_id,accepter_id,target_region_id,source_region_id,
       title,public_text,expected_time_text,reward::text,state,created_at,
       CASE WHEN isfinite(created_at) AND EXTRACT(YEAR FROM created_at AT TIME ZONE 'UTC') BETWEEN 1 AND 9999
       THEN to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS scan_at,
       accepted_at,completed_at,cancelled_at,deleted_at
       FROM whaleu_errands.orders WHERE ${filters.join(' AND ')}
       ORDER BY created_at DESC,id DESC LIMIT $${params.length}`,
        params,
      )
    ).rows;
    for (const row of rows) adminSeek(row);
    return rows;
  }
}
