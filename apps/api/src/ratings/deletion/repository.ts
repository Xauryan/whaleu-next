import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { ratingIso } from '../repository.js';
import { retainDeletionTarget } from './proof.js';
import type { DeletionTarget } from './proof.js';
export interface DeletionRoot {
  id: string;
  target_id: string;
  account_id: string;
  revision: string;
  deleted_at: string | null;
}
export interface DeletionReply extends DeletionRoot {
  root_id: string;
}
/** Parent-first metadata access only. Never a content visibility exemption. */
@Injectable()
export class RatingDeletionRepository {
  async locator(kind: 'comment' | 'reply', id: string, tx: PoolClient) {
    const row = (
      await tx.query<{ target_id: string; root_id: string }>(
        kind === 'comment'
          ? 'SELECT target_id,id root_id FROM whaleu_ratings.comments WHERE id=$1'
          : 'SELECT target_id,root_id FROM whaleu_ratings.replies WHERE id=$1',
        [id],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('RATING_NOT_FOUND');
    return row;
  }
  async target(id: string, tx: PoolClient): Promise<DeletionTarget> {
    const row = (
      await tx.query<DeletionTarget>(
        'SELECT id,revision,active,region_id FROM whaleu_ratings.targets WHERE id=$1 FOR UPDATE',
        [id],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('RATING_NOT_FOUND');
    retainDeletionTarget(row, tx);
    return row;
  }
  async root(
    id: string,
    targetId: string,
    tx: PoolClient,
  ): Promise<DeletionRoot> {
    const row = (
      await tx.query<DeletionRoot>(
        `SELECT id,target_id,account_id,revision,${ratingIso('deleted_at')} deleted_at FROM whaleu_ratings.comments WHERE id=$1 AND target_id=$2 FOR UPDATE`,
        [id, targetId],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('RATING_NOT_FOUND');
    return row;
  }
  async reply(
    id: string,
    rootId: string,
    targetId: string,
    tx: PoolClient,
  ): Promise<DeletionReply> {
    const row = (
      await tx.query<DeletionReply>(
        `SELECT id,target_id,root_id,account_id,revision,${ratingIso('deleted_at')} deleted_at FROM whaleu_ratings.replies WHERE id=$1 AND root_id=$2 AND target_id=$3 FOR UPDATE`,
        [id, rootId, targetId],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('RATING_NOT_FOUND');
    return row;
  }
}
