import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import type { ApplicationErrorCode } from '../../http/application-error.js';
import { CommunityRepository } from '../community.repository.js';
import { CommunityAccessService } from '../community-access.service.js';
import type { BallotReceipt } from './contracts.js';
export const ballotTerminalCodes = new Set<ApplicationErrorCode>([
  'POST_NOT_FOUND',
  'POLL_NOT_FOUND',
  'POLL_EXPIRED',
  'POLL_ALREADY_VOTED',
  'POLL_OPTIONS_INVALID',
  'PHONE_VERIFICATION_REQUIRED',
  'COMMUNITY_ACTION_RESTRICTED',
  'COMMUNITY_SCOPE_UNAVAILABLE',
]);
export function ballotHash(postId: string, optionIds: string[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        operation: 'cast_poll_ballot',
        postId: postId.toLowerCase(),
        optionIds: optionIds.map((id) => id.toLowerCase()).sort(),
      }),
    )
    .digest('hex');
}
@Injectable()
export class BallotRequestsRepository {
  constructor(
    @Inject(CommunityRepository)
    private readonly community: CommunityRepository,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
  ) {}
  execute(
    token: string,
    requestId: string,
    hash: string,
    create: (
      actor: string,
      tx: PoolClient,
    ) => Promise<{ resourceId: string; createdAt: string }>,
  ): Promise<BallotReceipt> {
    return this.community.database.transaction(async (tx) => {
      const actor = await this.access.actor(token, tx);
      await tx.query(
        'INSERT INTO whaleu_community.poll_ballot_requests(account_id,client_request_id,payload_hash) VALUES ($1,$2,$3) ON CONFLICT(account_id,client_request_id) DO NOTHING',
        [actor, requestId, hash],
      );
      const rows = await tx.query<{
        payload_hash: string;
        receipt: BallotReceipt | null;
      }>(
        'SELECT payload_hash,receipt FROM whaleu_community.poll_ballot_requests WHERE account_id=$1 AND client_request_id=$2 FOR UPDATE',
        [actor, requestId],
      );
      const row = rows.rows[0]!;
      if (row.payload_hash !== hash)
        throw new ApplicationError('REQUEST_CONFLICT');
      if (row.receipt) return row.receipt;
      await tx.query('SAVEPOINT ballot_work');
      let receipt: BallotReceipt;
      try {
        receipt = {
          requestId: requestId.toLowerCase(),
          operation: 'cast_poll_ballot',
          outcome: 'created',
          ...(await create(actor, tx)),
        };
      } catch (error) {
        if (
          !(error instanceof ApplicationError) ||
          !ballotTerminalCodes.has(error.code)
        )
          throw error;
        await tx.query('ROLLBACK TO SAVEPOINT ballot_work');
        receipt = {
          requestId: requestId.toLowerCase(),
          operation: 'cast_poll_ballot',
          outcome: 'rejected',
          code: error.code,
        };
      }
      await tx.query('RELEASE SAVEPOINT ballot_work');
      await tx.query(
        'UPDATE whaleu_community.poll_ballot_requests SET receipt=$3::jsonb WHERE account_id=$1 AND client_request_id=$2',
        [actor, requestId, JSON.stringify(receipt)],
      );
      return receipt;
    });
  }
  receipt(token: string, requestId: string): Promise<BallotReceipt> {
    return this.community.database.transaction(async (tx) => {
      const actor = await this.access.actor(token, tx);
      const rows = await tx.query<{ receipt: BallotReceipt }>(
        'SELECT receipt FROM whaleu_community.poll_ballot_requests WHERE account_id=$1 AND client_request_id=$2 AND receipt IS NOT NULL',
        [actor, requestId],
      );
      if (!rows.rows[0]) throw new ApplicationError('REQUEST_NOT_FOUND');
      return rows.rows[0].receipt;
    });
  }
}
