import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { RatingsRepository, ratingIso } from './repository.js';
import type { CommentRow } from './repository.js';
export interface ReplyRow extends CommentRow {
  root_id: string;
  reply_to_id: string | null;
}
@Injectable()
export class RatingDiscussionRepository {
  constructor(
    @Inject(RatingsRepository) private readonly ratings: RatingsRepository,
  ) {}
  async ancestry(id: string, tx: PoolClient) {
    const row = (
      await tx.query<{ target_id: string; root_id: string }>(
        'SELECT target_id,root_id FROM whaleu_ratings.replies WHERE id=$1',
        [id],
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
    write = false,
    includeDeleted = false,
  ): Promise<ReplyRow> {
    const row = (
      await tx.query<ReplyRow>(
        `SELECT r.*,r.ordinal::text,${ratingIso('r.created_at')} created_at,${ratingIso('r.deleted_at')} deleted_at,p.display_name persona_name FROM whaleu_ratings.replies r LEFT JOIN whaleu_ratings.personas p ON p.target_id=r.target_id AND p.account_id=r.account_id AND p.public_id=r.persona_id WHERE r.id=$1 AND r.root_id=$2 AND r.target_id=$3 FOR ${write ? 'UPDATE' : 'SHARE'} OF r`,
        [id, rootId, targetId],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('RATING_NOT_FOUND');
    if (!write) this.ratings.retainReply(row, tx);
    if (!includeDeleted && row.deleted_at !== null)
      throw new ApplicationError('RATING_NOT_FOUND');
    return row;
  }
  async navigation(rootId: string, tx: PoolClient) {
    return (
      (
        await tx.query<{ epoch: string }>(
          'SELECT sequence::text epoch FROM whaleu_ratings.reply_heads WHERE root_id=$1',
          [rootId],
        )
      ).rows[0]?.epoch ?? '0'
    );
  }
  async page(
    rootId: string,
    targetId: string,
    after: string | null,
    limit: number,
    tx: PoolClient,
    inclusive = false,
  ) {
    return (
      await tx.query<{ id: string; ordinal: string }>(
        `SELECT r.id,r.ordinal::text FROM whaleu_ratings.replies r WHERE root_id=$1 AND target_id=$2 AND deleted_at IS NULL AND ($3::bigint IS NULL OR ordinal${inclusive ? '>=' : '>'}$3::bigint) ORDER BY r.ordinal LIMIT $4`,
        [rootId, targetId, after, limit + 1],
      )
    ).rows;
  }
  async insert(
    input: {
      id: string;
      targetId: string;
      rootId: string;
      replyToId: string | null;
      actor: string;
      authorMode: 'named' | 'anonymous';
      personaId: string | null;
      body: string;
      revision: string;
      requestId: string;
      envelope: unknown;
    },
    tx: PoolClient,
  ) {
    const row = (
      await tx.query<{ created_at: string }>(
        `INSERT INTO whaleu_ratings.replies(id,target_id,root_id,reply_to_id,account_id,author_mode,persona_id,body,revision,request_id,envelope) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING ${ratingIso('created_at')} created_at`,
        [
          input.id,
          input.targetId,
          input.rootId,
          input.replyToId,
          input.actor,
          input.authorMode,
          input.personaId,
          input.body,
          input.revision,
          input.requestId,
          JSON.stringify(input.envelope),
        ],
      )
    ).rows[0]!;
    this.ratings.retainReply(
      { id: input.id, revision: input.revision, deleted_at: null },
      tx,
    );
    return {
      outcome: 'applied' as const,
      targetId: input.targetId,
      rootId: input.rootId,
      replyId: input.id,
      revision: input.revision,
      occurredAt: row.created_at,
    };
  }
  async delete(
    row: Pick<
      ReplyRow,
      'id' | 'target_id' | 'root_id' | 'account_id' | 'revision' | 'deleted_at'
    >,
    actor: string,
    requestId: string,
    revision: string,
    tx: PoolClient,
  ) {
    if (row.account_id !== actor)
      throw new ApplicationError('RATING_NOT_FOUND');
    if (row.revision !== revision)
      throw new ApplicationError('RATING_REVISION_CONFLICT');
    if (row.deleted_at !== null) {
      this.ratings.retainReply(row, tx);
      return {
        outcome: 'noop' as const,
        targetId: row.target_id,
        rootId: row.root_id,
        replyId: row.id,
        revision: row.revision,
        occurredAt: row.deleted_at,
      };
    }
    const next = randomUUID(),
      deleted = (
        await tx.query<{ deleted_at: string }>(
          `UPDATE whaleu_ratings.replies SET deleted_at=clock_timestamp(),delete_request_id=$2,revision=$3 WHERE id=$1 RETURNING ${ratingIso('deleted_at')} deleted_at`,
          [row.id, requestId, next],
        )
      ).rows[0]!;
    this.ratings.retainReply(
      { id: row.id, revision: next, deleted_at: deleted.deleted_at },
      tx,
    );
    return {
      outcome: 'applied' as const,
      targetId: row.target_id,
      rootId: row.root_id,
      replyId: row.id,
      revision: next,
      occurredAt: deleted.deleted_at,
    };
  }
}
