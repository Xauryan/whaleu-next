import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../../http/application-error.js';
import {
  currentRatingTargetRow,
  ratingCurrentTargetColumns,
  ratingCurrentTargetDefinitionJoins,
} from '../../target-definition.repository.js';
import type {
  CurrentTargetRead,
  RatingTargetIdentityRow,
} from '../../target-definition.repository.js';
/** Mutation snapshots intentionally register no old target/head/navigation fact.
 * The service must retain the final current tuple after deciding the outcome. */
@Injectable()
export class RatingTargetEditRepository {
  async identity(
    id: string,
    actor: string,
    tx: PoolClient,
    write = false,
  ): Promise<RatingTargetIdentityRow> {
    const row = (
      await tx.query<RatingTargetIdentityRow & { owner_deleted: boolean }>(
        `SELECT t.id,t.revision,t.category_id,t.creator_id,t.region_id,t.active,
       EXISTS(SELECT 1 FROM whaleu_ratings.target_owner_tombstones x WHERE x.target_id=t.id) owner_deleted
       FROM whaleu_ratings.targets t WHERE t.id=$1 FOR ${write ? 'UPDATE' : 'SHARE'} OF t`,
        [id],
      )
    ).rows[0];
    if (!row || row.creator_id !== actor || !row.active || row.owner_deleted)
      throw new ApplicationError('RATING_NOT_FOUND');
    return row;
  }
  async definition(identity: RatingTargetIdentityRow, tx: PoolClient) {
    const row = (
      await tx.query<CurrentTargetRead>(
        `SELECT ${ratingCurrentTargetColumns} FROM whaleu_ratings.targets t
       ${ratingCurrentTargetDefinitionJoins} WHERE t.id=$1`,
        [identity.id],
      )
    ).rows[0];
    if (
      !row ||
      row.revision !== identity.revision ||
      row.creator_id !== identity.creator_id
    )
      throw new ApplicationError('RATING_UNAVAILABLE');
    return currentRatingTargetRow(row);
  }
}
