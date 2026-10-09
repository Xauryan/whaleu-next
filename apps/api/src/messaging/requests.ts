import { retainDmDenial } from './denial-proof.js';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.js';
import { ApplicationError } from '../http/application-error.js';
import { MessagingAccess } from './access.js';
import { dmReceiptSchema, dmRejection } from './contracts.js';
import type {
  DmOperation,
  DmReceipt,
  DmCancellationResult,
} from './contracts.js';
import { dmDigest } from './repository.js';
type Applied = {
  outcome: 'applied' | 'noop';
  conversationId: string;
  messageId: string | null;
  occurredAt: string;
};
@Injectable()
export class MessagingRequests {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(MessagingAccess) private readonly access: MessagingAccess,
  ) {}
  execute(
    token: string,
    requestId: string,
    operation: DmOperation,
    intent: unknown,
    apply: (actor: string, tx: PoolClient) => Promise<Applied>,
  ): Promise<DmReceipt> {
    return this.database.transaction(
      async (tx) => {
        const { accountId: actor } = await this.access.authenticate(
            token,
            tx,
            operation === 'block',
          ),
          hash = dmDigest({ operation, intent });
        await tx.query(
          'INSERT INTO whaleu_messaging.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [actor, requestId, operation, hash],
        );
        const row = (
          await tx.query<{
            operation: string;
            intent_hash: string;
            receipt: unknown;
          }>(
            'SELECT operation,intent_hash,receipt FROM whaleu_messaging.requests WHERE account_id=$1 AND request_id=$2 FOR UPDATE',
            [actor, requestId],
          )
        ).rows[0]!;
        if (row.operation !== operation || row.intent_hash !== hash)
          throw new ApplicationError('REQUEST_CONFLICT');
        if (row.receipt !== null) {
          await this.access.final(token, tx);
          return dmReceiptSchema.parse(row.receipt);
        }
        await tx.query('SAVEPOINT dm_command');
        let receipt: DmReceipt;
        try {
          await this.access.require(actor, tx);
          receipt = dmReceiptSchema.parse({
            requestId,
            operation,
            ...(await apply(actor, tx)),
          });
        } catch (error) {
          if (
            !(error instanceof ApplicationError) ||
            !dmRejection.safeParse(error.code).success
          )
            throw error;
          // Retain negative owner facts/deadlines through final proof. No stale denial
          // becomes durable merely because the savepoint restored domain writes.
          await retainDmDenial(actor, intent, tx);
          await tx.query('ROLLBACK TO SAVEPOINT dm_command');
          receipt = {
            requestId,
            operation,
            outcome: 'rejected',
            code: dmRejection.parse(error.code),
          };
        }
        await tx.query('RELEASE SAVEPOINT dm_command');
        await tx.query(
          'INSERT INTO whaleu_messaging.transitions(account_id,request_id,conversation_id,message_id,receipt) VALUES($1,$2,$3,$4,$5::jsonb)',
          [
            actor,
            requestId,
            receipt.outcome === 'rejected' ? null : receipt.conversationId,
            receipt.outcome === 'rejected' ? null : receipt.messageId,
            JSON.stringify(receipt),
          ],
        );
        await tx.query(
          'UPDATE whaleu_messaging.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2',
          [actor, requestId, JSON.stringify(receipt)],
        );
        await this.access.final(token, tx);
        return receipt;
      },
      { isolationLevel: 'read committed' },
    );
  }
  /** Session-only original-intent closure. A late original command can only
   * recover this receipt; a command already committed wins and is returned. */
  cancel(
    token: string,
    id: string,
    operation: DmOperation,
    intentHash: string,
  ): Promise<DmCancellationResult> {
    return this.database.transaction(
      async (tx) => {
        const { accountId: actor } = await this.access.authenticate(token, tx);
        await tx.query(
          'INSERT INTO whaleu_messaging.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [actor, id, operation, intentHash],
        );
        const row = (
          await tx.query<{
            operation: string;
            intent_hash: string;
            receipt: unknown;
          }>(
            'SELECT operation,intent_hash,receipt FROM whaleu_messaging.requests WHERE account_id=$1 AND request_id=$2 FOR UPDATE',
            [actor, id],
          )
        ).rows[0]!;
        if (row.operation !== operation || row.intent_hash !== intentHash)
          throw new ApplicationError('REQUEST_CONFLICT');
        if (row.receipt !== null) {
          await this.access.final(token, tx);
          const receipt = dmReceiptSchema.parse(row.receipt);
          return {
            outcome:
              receipt.outcome === 'rejected' &&
              receipt.code === 'DM_COMMAND_CANCELLED'
                ? 'cancelled'
                : 'already_terminal',
            receipt,
          };
        }
        const receipt: DmReceipt = {
          requestId: id,
          operation,
          outcome: 'rejected',
          code: 'DM_COMMAND_CANCELLED',
        };
        await tx.query(
          'INSERT INTO whaleu_messaging.transitions(account_id,request_id,conversation_id,message_id,receipt) VALUES($1,$2,NULL,NULL,$3::jsonb)',
          [actor, id, JSON.stringify(receipt)],
        );
        await tx.query(
          'UPDATE whaleu_messaging.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2',
          [actor, id, JSON.stringify(receipt)],
        );
        await this.access.final(token, tx);
        return { outcome: 'cancelled', receipt };
      },
      { isolationLevel: 'read committed' },
    );
  }
  receipt(token: string, id: string) {
    return this.database.transaction(
      async (tx) => {
        const { accountId } = await this.access.authenticate(token, tx);
        const row = (
          await tx.query<{ receipt: unknown }>(
            'SELECT receipt FROM whaleu_messaging.requests WHERE account_id=$1 AND request_id=$2 AND receipt IS NOT NULL',
            [accountId, id],
          )
        ).rows[0];
        if (!row) throw new ApplicationError('REQUEST_NOT_FOUND');
        await this.access.final(token, tx);
        return dmReceiptSchema.parse(row.receipt);
      },
      { isolationLevel: 'read committed' },
    );
  }
}
