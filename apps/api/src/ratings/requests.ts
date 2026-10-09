import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../database/transaction-deadlines.js';
import { canonicalJson } from '../community/content-review/contracts.js';
import { ApplicationError } from '../http/application-error.js';
import { RatingsAccessService } from './access.js';
import { ratingReceiptSchema, ratingRejectionSchema } from './contracts.js';
import type { RatingOperation, RatingReceipt } from './contracts.js';
@Injectable()
export class RatingsRequests {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RatingsAccessService) private readonly access: RatingsAccessService,
  ) {}
  execute(
    token: string,
    requestId: string,
    operation: RatingOperation,
    intent: unknown,
    apply: (
      actor: string,
      tx: PoolClient,
    ) => Promise<{
      outcome: 'applied' | 'noop';
      targetId: string;
      subjectId: string;
      revision: string;
      occurredAt: string;
    }>,
  ): Promise<RatingReceipt> {
    return this.database.transaction(
      async (tx) => {
        const { accountId: actor } = await this.access.authenticate(token, tx),
          hash = createHash('sha256')
            .update(
              'whaleu:rating-command:v1\n' +
                canonicalJson({ operation, intent }),
            )
            .digest('hex');
        await tx.query(
          'INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [actor, requestId, operation, hash],
        );
        const row = (
          await tx.query<{
            intent_hash: string;
            operation: RatingOperation;
            receipt: unknown;
          }>(
            'SELECT intent_hash,operation,receipt FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2 FOR UPDATE',
            [actor, requestId],
          )
        ).rows[0]!;
        if (row.intent_hash !== hash || row.operation !== operation)
          throw new ApplicationError('REQUEST_CONFLICT');
        if (row.receipt !== null) {
          await this.access.recheck(token, tx);
          return ratingReceiptSchema.parse(row.receipt);
        }
        const checkpoint = checkpointTransactionDeadlines(tx);
        await tx.query('SAVEPOINT rating_command');
        let receipt: RatingReceipt;
        try {
          receipt = ratingReceiptSchema.parse({
            requestId,
            operation,
            ...(await apply(actor, tx)),
          });
        } catch (error) {
          if (
            !(error instanceof ApplicationError) ||
            !ratingRejectionSchema.safeParse(error.code).success
          )
            throw error;
          await tx.query('ROLLBACK TO SAVEPOINT rating_command');
          restoreTransactionDeadlines(tx, checkpoint);
          receipt = {
            requestId,
            operation,
            outcome: 'rejected',
            code: ratingRejectionSchema.parse(error.code),
          };
        }
        await tx.query('RELEASE SAVEPOINT rating_command');
        await tx.query(
          'UPDATE whaleu_ratings.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2',
          [actor, requestId, JSON.stringify(receipt)],
        );
        await this.access.recheck(token, tx);
        return receipt;
      },
      { isolationLevel: 'read committed' },
    );
  }
  receipt(token: string, id: string): Promise<RatingReceipt> {
    return this.database.transaction(
      async (tx) => {
        const { accountId } = await this.access.authenticate(token, tx),
          row = (
            await tx.query<{ receipt: unknown }>(
              "SELECT receipt FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2 AND receipt IS NOT NULL AND operation IN ('set_score','create_comment','delete_comment')",
              [accountId, id],
            )
          ).rows[0];
        if (!row) throw new ApplicationError('REQUEST_NOT_FOUND');
        const result = ratingReceiptSchema.parse(row.receipt);
        await this.access.recheck(token, tx);
        return result;
      },
      { isolationLevel: 'read committed' },
    );
  }
}
