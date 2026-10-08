import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../database/transaction-deadlines.js';
import { ApplicationError } from '../http/application-error.js';
import { canonicalJson } from '../community/content-review/contracts.js';
import { ErrandAccessService } from './access.js';
import { errandReceiptSchema, errandRejectionSchema } from './contracts.js';
import type { ErrandReceipt, ErrandOperation } from './contracts.js';
@Injectable()
export class ErrandRequests {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ErrandAccessService) private readonly access: ErrandAccessService,
  ) {}
  execute(
    token: string,
    requestId: string,
    operation: ErrandOperation,
    intent: unknown,
    apply: (
      actor: string,
      tx: PoolClient,
    ) => Promise<{ orderId: string; revision: string; occurredAt: string }>,
  ): Promise<ErrandReceipt> {
    return this.database.transaction(
      async (tx) => {
        const session = await this.access.authenticate(token, tx),
          actor = session.accountId;
        const hash = createHash('sha256')
          .update(
            'whaleu:errand-command:v1\n' + canonicalJson({ operation, intent }),
          )
          .digest('hex');
        await tx.query(
          'INSERT INTO whaleu_errands.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [actor, requestId, operation, hash],
        );
        const row = (
          await tx.query<{
            intent_hash: string;
            operation: ErrandOperation;
            receipt: unknown;
          }>(
            'SELECT intent_hash,operation,receipt FROM whaleu_errands.requests WHERE account_id=$1 AND request_id=$2 FOR UPDATE',
            [actor, requestId],
          )
        ).rows[0]!;
        if (row.intent_hash !== hash || row.operation !== operation)
          throw new ApplicationError('REQUEST_CONFLICT');
        if (row.receipt !== null) {
          const result = errandReceiptSchema.parse(row.receipt);
          await this.access.recheck(token, tx);
          return result;
        }
        const checkpoint = checkpointTransactionDeadlines(tx);
        await tx.query('SAVEPOINT errand_command');
        let receipt: ErrandReceipt;
        try {
          await this.access.common(token, tx);
          receipt = {
            requestId,
            operation,
            outcome: 'applied',
            ...(await apply(actor, tx)),
          };
        } catch (error) {
          if (
            !(error instanceof ApplicationError) ||
            !errandRejectionSchema.safeParse(error.code).success
          )
            throw error;
          await tx.query('ROLLBACK TO SAVEPOINT errand_command');
          restoreTransactionDeadlines(tx, checkpoint);
          receipt = {
            requestId,
            operation,
            outcome: 'rejected',
            code: errandRejectionSchema.parse(error.code),
          };
        }
        await tx.query('RELEASE SAVEPOINT errand_command');
        receipt = errandReceiptSchema.parse(receipt);
        await tx.query(
          'UPDATE whaleu_errands.requests SET receipt=$3 WHERE account_id=$1 AND request_id=$2',
          [actor, requestId, JSON.stringify(receipt)],
        );
        await this.access.recheck(token, tx);
        return receipt;
      },
      { isolationLevel: 'read committed' },
    );
  }
  receipt(token: string, requestId: string): Promise<ErrandReceipt> {
    return this.database.transaction(
      async (tx) => {
        const { accountId } = await this.access.authenticate(token, tx);
        const row = (
          await tx.query<{ receipt: unknown }>(
            "SELECT receipt FROM whaleu_errands.requests WHERE account_id=$1 AND request_id=$2 AND receipt IS NOT NULL AND operation IN ('publish','accept','cancel','complete','delete')",
            [accountId, requestId],
          )
        ).rows[0];
        if (!row) throw new ApplicationError('REQUEST_NOT_FOUND');
        const receipt = errandReceiptSchema.parse(row.receipt);
        await this.access.recheck(token, tx);
        return receipt;
      },
      { isolationLevel: 'read committed' },
    );
  }
}
