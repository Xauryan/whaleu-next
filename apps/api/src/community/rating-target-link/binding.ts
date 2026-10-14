import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import {
  reviewedRatingTargetLinkSchema,
  type ReviewedRatingTargetLink,
} from './contracts.js';
import type { SnapshotReadBudget } from '../content-review/count-snapshot.repository.js';

export async function readRatingTargetLinks(
  ids: readonly string[],
  tx: PoolClient,
  budget?: SnapshotReadBudget,
): Promise<Map<string, ReviewedRatingTargetLink>> {
  if (ids.length > 256 || new Set(ids).size !== ids.length)
    throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  if (!ids.length) return new Map();
  const sql =
    'SELECT post_id,component FROM whaleu_community.post_rating_target_links WHERE post_id=ANY($1::uuid[])';
  const rows = budget
    ? await budget.rows<{ post_id: string; component: unknown }>(
        tx,
        sql,
        [ids],
        ids.length,
      )
    : (
        await tx.query<{ post_id: string; component: unknown }>(
          sql + ' FOR SHARE',
          [ids],
        )
      ).rows;
  return new Map(
    rows.map((row) => [
      row.post_id,
      reviewedRatingTargetLinkSchema.parse(row.component),
    ]),
  );
}
