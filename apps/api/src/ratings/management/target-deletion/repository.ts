import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../../http/application-error.js';
import type { TargetOwnerMetadata } from './proof.js';
/** No eager before-state proof: this caller may change the parent lifecycle. */
@Injectable()
export class RatingTargetOwnerDeletionRepository {
  async metadata(id: string, actor: string, tx: PoolClient) {
    const target = (
      await tx.query<Omit<TargetOwnerMetadata, 'delete_audit_id'>>(
        `SELECT id,creator_id,revision,active FROM whaleu_ratings.targets
         WHERE id=$1 FOR UPDATE`,
        [id],
      )
    ).rows[0];
    if (!target || target.creator_id !== actor)
      throw new ApplicationError('RATING_NOT_FOUND');
    const tombstone = (
      await tx.query<{ delete_audit_id: string; after_revision: string }>(
        `SELECT delete_audit_id,after_revision FROM whaleu_ratings.target_owner_tombstones
         WHERE target_id=$1 FOR SHARE`,
        [id],
      )
    ).rows[0];
    if (
      tombstone &&
      (target.active || tombstone.after_revision !== target.revision)
    )
      throw new ApplicationError('RATING_UNAVAILABLE');
    return { ...target, delete_audit_id: tombstone?.delete_audit_id ?? null };
  }
}
