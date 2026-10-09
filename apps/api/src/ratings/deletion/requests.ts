import { assertRatingCommandClaim } from '../management/requests.js';
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.js';
import { canonicalJson } from '../../community/content-review/contracts.js';
import { ApplicationError } from '../../http/application-error.js';
import type { SessionView } from '../../identity/contracts.js';
import { RatingsAccessService } from '../access.js';
import {
  ratingAdminDeletionReceiptSchema,
  ratingAdminDeletionRejectionSchema,
} from './contracts.js';
import type {
  RatingAdminDeletionOperation,
  RatingAdminDeletionReceipt,
} from './contracts.js';

type Result = Omit<
  Extract<RatingAdminDeletionReceipt, { outcome: 'applied' | 'noop' }>,
  'requestId' | 'operation'
>;
export function ratingAdminDeletionIntentHash(
  operation: RatingAdminDeletionOperation,
  intent: unknown,
) {
  return createHash('sha256')
    .update(
      'whaleu:rating-admin-delete-command:v1\n' +
        canonicalJson({ operation, intent }),
    )
    .digest('hex');
}
@Injectable()
export class RatingAdminDeletionRequests {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RatingsAccessService) private readonly access: RatingsAccessService,
  ) {}
  execute(
    token: string,
    requestId: string,
    operation: RatingAdminDeletionOperation,
    intent: unknown,
    apply: (
      session: SessionView,
      intentHash: string,
      tx: PoolClient,
    ) => Promise<Result>,
  ): Promise<RatingAdminDeletionReceipt> {
    return this.database.transaction(
      async (tx) => {
        const session = await this.access.authenticate(token, tx);
        const hash = ratingAdminDeletionIntentHash(operation, intent);
        await assertRatingCommandClaim(
          session.accountId,
          requestId,
          operation,
          hash,
          tx,
        );
        await tx.query(
          'INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [session.accountId, requestId, operation, hash],
        );
        const row = (
          await tx.query<{
            intent_hash: string;
            operation: string;
            receipt: unknown;
          }>(
            'SELECT intent_hash,operation,receipt FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2 FOR UPDATE',
            [session.accountId, requestId],
          )
        ).rows[0];
        if (!row || row.intent_hash !== hash || row.operation !== operation)
          throw new ApplicationError('REQUEST_CONFLICT');
        if (row.receipt !== null) {
          await this.access.recheck(token, tx);
          return ratingAdminDeletionReceiptSchema.parse(row.receipt);
        }
        let receipt: RatingAdminDeletionReceipt;
        try {
          receipt = ratingAdminDeletionReceiptSchema.parse({
            requestId,
            operation,
            ...(await apply(session, hash, tx)),
          });
        } catch (error) {
          if (
            !(error instanceof ApplicationError) ||
            !ratingAdminDeletionRejectionSchema.safeParse(error.code).success
          )
            throw error;
          // The service finishes every terminal check before its first mutation.
          // Keep ALL locked authority facts/deadlines for rejected final proofs;
          // the SQL causal guard independently prohibits any rejected audit/effect.
          receipt = {
            requestId,
            operation,
            outcome: 'rejected',
            code: ratingAdminDeletionRejectionSchema.parse(error.code),
          };
        }
        await tx.query(
          'UPDATE whaleu_ratings.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2',
          [session.accountId, requestId, JSON.stringify(receipt)],
        );
        await this.access.recheck(token, tx);
        return receipt;
      },
      { isolationLevel: 'read committed' },
    );
  }
  receipt(token: string, id: string): Promise<RatingAdminDeletionReceipt> {
    return this.database.transaction(
      async (tx) => {
        const { accountId } = await this.access.authenticate(token, tx);
        const row = (
          await tx.query<{ receipt: unknown }>(
            "SELECT receipt FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2 AND receipt IS NOT NULL AND operation IN ('admin_delete_comment','admin_delete_reply')",
            [accountId, id],
          )
        ).rows[0];
        if (!row) throw new ApplicationError('REQUEST_NOT_FOUND');
        const receipt = ratingAdminDeletionReceiptSchema.parse(row.receipt);
        await this.access.recheck(token, tx);
        return receipt;
      },
      { isolationLevel: 'read committed' },
    );
  }
}
