import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../../database/database.js';
import { ApplicationError } from '../../../http/application-error.js';
import { lockSafetyPolicy } from '../../../safety/locks.js';
import { canonicalJson } from '../../../community/content-review/contracts.js';
import { RatingsAccessService } from '../../access.js';
import { ratingIso } from '../../repository.js';
import { RatingTargetOwnerDeletionRepository } from './repository.js';
import { retainTargetOwnerMetadata } from './proof.js';
import { ratingTargetOwnerDeletionIntentHash } from './requests.js';
import {
  ratingTargetOwnerDeletionContextSchema,
  ratingTargetOwnerDeletionReceiptSchema,
  ratingTargetOwnerDeletionRejectionSchema,
} from './contracts.js';
import type {
  DeleteRatingTarget,
  RatingTargetDeletionIntent,
  RatingTargetOwnerDeletionReceipt,
} from './contracts.js';
@Injectable()
export class RatingTargetOwnerDeletionService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RatingsAccessService) private readonly access: RatingsAccessService,
    @Inject(RatingTargetOwnerDeletionRepository)
    private readonly records: RatingTargetOwnerDeletionRepository,
  ) {}
  context(token: string, id: string) {
    return this.database.transaction(
      async (tx) => {
        const session = await this.access.authenticate(token, tx);
        await this.access.requireDeletionActor(session.accountId, tx);
        const row = await this.records.metadata(id, session.accountId, tx);
        retainTargetOwnerMetadata(row, tx);
        await this.access.recheck(token, tx);
        return ratingTargetOwnerDeletionContextSchema.parse({
          targetId: row.id,
          revision: row.revision,
          deletion: {
            kind: row.delete_audit_id ? 'owner_deleted' : 'not_owner_deleted',
          },
        });
      },
      { isolationLevel: 'read committed' },
    );
  }
  private async enter(token: string, tx: PoolClient) {
    // Target/tombstone writers need exclusive Safety. Acquire before ANY row lock.
    await lockSafetyPolicy(tx, true);
    // Fence a pending lifecycle writer before request, identity or target row locks.
    // This does not advance either epoch for replay, cancellation or noop.
    await tx.query(
      'LOCK TABLE whaleu_ratings.random_pool_epoch,whaleu_ratings.navigation_epoch IN ROW EXCLUSIVE MODE',
    );
    return this.access.authenticate(token, tx);
  }
  private async claim(
    actor: string,
    intent: RatingTargetDeletionIntent,
    hash: string,
    tx: PoolClient,
  ) {
    const claimed = (
      await tx.query<{ operation: string; intent_hash: string }>(
        `SELECT operation,intent_hash FROM whaleu_ratings.command_claims
         WHERE account_id=$1 AND request_id=$2 FOR UPDATE`,
        [actor, intent.clientRequestId],
      )
    ).rows[0];
    if (
      claimed &&
      (claimed.operation !== 'delete_target' || claimed.intent_hash !== hash)
    )
      throw new ApplicationError('REQUEST_CONFLICT');
    await tx.query(
      `INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash)
       VALUES($1,$2,'delete_target',$3) ON CONFLICT DO NOTHING`,
      [actor, intent.clientRequestId, hash],
    );
    const row = (
      await tx.query<{
        operation: string;
        intent_hash: string;
        receipt: unknown;
      }>(
        `SELECT operation,intent_hash,receipt FROM whaleu_ratings.requests
         WHERE account_id=$1 AND request_id=$2 FOR UPDATE`,
        [actor, intent.clientRequestId],
      )
    ).rows[0];
    if (!row || row.operation !== 'delete_target' || row.intent_hash !== hash)
      throw new ApplicationError('REQUEST_CONFLICT');
    return row.receipt === null
      ? null
      : ratingTargetOwnerDeletionReceiptSchema.parse(row.receipt);
  }
  private async close(
    actor: string,
    intent: RatingTargetDeletionIntent,
    hash: string,
    code: Extract<
      RatingTargetOwnerDeletionReceipt,
      { outcome: 'rejected' }
    >['code'],
    tx: PoolClient,
  ) {
    await tx.query(
      `INSERT INTO whaleu_ratings.target_owner_delete_closures
       (actor_account_id,request_id,intent_hash,intent,code)
       VALUES($1,$2,$3,$4::jsonb,$5)`,
      [actor, intent.clientRequestId, hash, canonicalJson(intent), code],
    );
    return ratingTargetOwnerDeletionReceiptSchema.parse({
      requestId: intent.clientRequestId,
      operation: 'delete_target',
      outcome: 'rejected',
      code,
    });
  }
  private async save(
    actor: string,
    intent: RatingTargetDeletionIntent,
    receipt: RatingTargetOwnerDeletionReceipt,
    tx: PoolClient,
  ) {
    await tx.query(
      `UPDATE whaleu_ratings.requests SET receipt=$3::jsonb
       WHERE account_id=$1 AND request_id=$2`,
      [actor, intent.clientRequestId, canonicalJson(receipt)],
    );
  }
  delete(token: string, targetId: string, command: DeleteRatingTarget) {
    const intent: RatingTargetDeletionIntent = { targetId, ...command };
    return this.database.transaction(
      async (tx) => {
        const session = await this.enter(token, tx),
          actor = session.accountId,
          hash = ratingTargetOwnerDeletionIntentHash(intent),
          prior = await this.claim(actor, intent, hash, tx);
        if (prior) {
          await this.access.recheck(token, tx);
          return prior;
        }
        // Terminal checks all precede mutation. Unknown authority/infra failures
        // escape this block and roll back the request instead of faking rejection.
        let target: Awaited<
          ReturnType<RatingTargetOwnerDeletionRepository['metadata']>
        >;
        try {
          await this.access.requireDeletionActor(actor, tx);
          target = await this.records.metadata(targetId, actor, tx);
          if (target.revision !== command.expectedTargetRevision) {
            retainTargetOwnerMetadata(target, tx);
            throw new ApplicationError('RATING_REVISION_CONFLICT');
          }
        } catch (error) {
          if (
            !(error instanceof ApplicationError) ||
            !ratingTargetOwnerDeletionRejectionSchema.safeParse(error.code)
              .success
          )
            throw error;
          const receipt = await this.close(
            actor,
            intent,
            hash,
            ratingTargetOwnerDeletionRejectionSchema.parse(error.code),
            tx,
          );
          await this.save(actor, intent, receipt, tx);
          await this.access.recheck(token, tx);
          return receipt;
        }
        const outcome = target.delete_audit_id ? 'noop' : 'applied',
          revision = outcome === 'noop' ? target.revision : randomUUID(),
          auditId = randomUUID();
        const audit = (
          await tx.query<{ occurred_at: string }>(
            `INSERT INTO whaleu_ratings.target_owner_delete_audits
             (id,actor_account_id,request_id,intent_hash,intent,target_id,before_revision,after_revision,before_active,outcome,source_delete_audit_id)
             VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11)
             RETURNING ${ratingIso('occurred_at')} occurred_at`,
            [
              auditId,
              actor,
              intent.clientRequestId,
              hash,
              canonicalJson(intent),
              targetId,
              target.revision,
              revision,
              target.active,
              outcome,
              target.delete_audit_id,
            ],
          )
        ).rows[0]!;
        if (outcome === 'applied') {
          const changed = await tx.query(
            `UPDATE whaleu_ratings.targets SET active=false,revision=$3
             WHERE id=$1 AND revision=$2`,
            [targetId, target.revision, revision],
          );
          if (changed.rowCount !== 1)
            throw new ApplicationError('RATING_UNAVAILABLE');
          await tx.query(
            `INSERT INTO whaleu_ratings.target_owner_tombstones
             (target_id,delete_audit_id,cause,actor_account_id,request_id,after_revision,deleted_at)
             SELECT target_id,id,'owner_deleted',actor_account_id,request_id,after_revision,occurred_at
             FROM whaleu_ratings.target_owner_delete_audits WHERE id=$1`,
            [auditId],
          );
        }
        const receipt = ratingTargetOwnerDeletionReceiptSchema.parse({
          requestId: intent.clientRequestId,
          operation: 'delete_target',
          outcome,
          targetId,
          revision,
          occurredAt: audit.occurred_at,
        });
        await this.save(actor, intent, receipt, tx);
        retainTargetOwnerMetadata(
          {
            ...target,
            revision,
            active: false,
            delete_audit_id: target.delete_audit_id ?? auditId,
          },
          tx,
          { requestId: intent.clientRequestId, auditId },
        );
        await this.access.recheck(token, tx);
        return receipt;
      },
      { isolationLevel: 'read committed' },
    );
  }
  cancel(token: string, intent: RatingTargetDeletionIntent) {
    return this.database.transaction(
      async (tx) => {
        const session = await this.enter(token, tx),
          hash = ratingTargetOwnerDeletionIntentHash(intent),
          prior = await this.claim(session.accountId, intent, hash, tx);
        if (prior) {
          await this.access.recheck(token, tx);
          return prior;
        }
        const receipt = await this.close(
          session.accountId,
          intent,
          hash,
          'RATING_TARGET_DELETION_CANCELLED',
          tx,
        );
        await this.save(session.accountId, intent, receipt, tx);
        await this.access.recheck(token, tx);
        return receipt;
      },
      { isolationLevel: 'read committed' },
    );
  }
  receipt(token: string, id: string) {
    return this.database.transaction(
      async (tx) => {
        const session = await this.access.authenticate(token, tx);
        const row = (
          await tx.query<{ receipt: unknown }>(
            `SELECT receipt FROM whaleu_ratings.requests WHERE account_id=$1
             AND request_id=$2 AND operation='delete_target' AND receipt IS NOT NULL`,
            [session.accountId, id],
          )
        ).rows[0];
        if (!row) throw new ApplicationError('REQUEST_NOT_FOUND');
        const receipt = ratingTargetOwnerDeletionReceiptSchema.parse(
          row.receipt,
        );
        await this.access.recheck(token, tx);
        return receipt;
      },
      { isolationLevel: 'read committed' },
    );
  }
}
