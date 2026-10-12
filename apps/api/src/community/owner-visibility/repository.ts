import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.js';
import { ApplicationError } from '../../http/application-error.js';
import type {
  OwnerVisibilityCommand,
  OwnerVisibilityReceipt,
} from './contracts.js';

export interface OwnerVisibilityTarget {
  id: string;
  account_id: string;
  deleted_at: Date | null;
}
export interface OwnerVisibilityState {
  owner_hidden: boolean;
  version: number;
}
@Injectable()
export class OwnerVisibilityRepository {
  constructor(@Inject(DatabaseService) readonly database: DatabaseService) {}

  async target(
    actor: string,
    postId: string,
    tx: PoolClient,
    write = false,
  ): Promise<OwnerVisibilityTarget> {
    const target = (
      await tx.query<OwnerVisibilityTarget>(
        `SELECT id,account_id,deleted_at FROM whaleu_community.posts WHERE id=$1 FOR ${write ? 'UPDATE' : 'SHARE'}`,
        [postId],
      )
    ).rows[0];
    // No administrator override, anonymous-owner lookup or content gate.
    if (!target || target.account_id !== actor)
      throw new ApplicationError('POST_NOT_FOUND');
    return target;
  }
  async state(postId: string, tx: PoolClient): Promise<OwnerVisibilityState> {
    return (
      (
        await tx.query<OwnerVisibilityState>(
          'SELECT owner_hidden,version FROM whaleu_community.post_owner_visibility WHERE post_id=$1',
          [postId],
        )
      ).rows[0] ?? { owner_hidden: false, version: 0 }
    );
  }
  async lockRequest(
    actor: string,
    requestId: string,
    tx: PoolClient,
  ): Promise<void> {
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:post-owner-visibility-request:v1:'||$1||':'||$2,0))",
      [actor, requestId],
    );
  }
  async receipt(actor: string, requestId: string, tx: PoolClient) {
    return (
      (
        await tx.query<{
          intent_hash: string;
          receipt: OwnerVisibilityReceipt;
        }>(
          'SELECT intent_hash,receipt FROM whaleu_community.post_owner_visibility_commands WHERE actor_id=$1 AND request_id=$2',
          [actor, requestId],
        )
      ).rows[0] ?? null
    );
  }
  async record(
    actor: string,
    sessionId: string,
    hash: string,
    command: OwnerVisibilityCommand,
    receipt: OwnerVisibilityReceipt,
    tx: PoolClient,
  ): Promise<void> {
    const result = await tx.query(
      `INSERT INTO whaleu_community.post_owner_visibility_commands(actor_id,request_id,post_id,session_id,intent_hash,command,receipt) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
      [
        actor,
        command.clientRequestId,
        command.postId,
        sessionId,
        hash,
        JSON.stringify(command),
        JSON.stringify(receipt),
      ],
    );
    if (result.rowCount !== 1)
      throw new ApplicationError('POST_OWNER_VISIBILITY_UNAVAILABLE');
  }
  async apply(
    actor: string,
    command: OwnerVisibilityCommand,
    recordedAt: string,
    tx: PoolClient,
  ): Promise<void> {
    // Exact CAS also guards a raw writer. The canonical post UPDATE lock protects
    // first insert and serializes all dependent readers, without touching posts.
    const result = await tx.query(
      command.expectedVersion === 0
        ? `INSERT INTO whaleu_community.post_owner_visibility(post_id,actor_id,request_id,owner_hidden,version,updated_at)
           VALUES($1,$2,$3,$4,$5+1,$6::timestamptz)`
        : `UPDATE whaleu_community.post_owner_visibility SET actor_id=$2,request_id=$3,owner_hidden=$4,version=$5+1,updated_at=$6::timestamptz,mutation_transaction=pg_current_xact_id()
           WHERE post_id=$1 AND version=$5`,
      [
        command.postId,
        actor,
        command.clientRequestId,
        command.ownerHidden,
        command.expectedVersion,
        recordedAt,
      ],
    );
    if (result.rowCount !== 1)
      throw new ApplicationError('POST_OWNER_VISIBILITY_UNAVAILABLE');
  }
}
