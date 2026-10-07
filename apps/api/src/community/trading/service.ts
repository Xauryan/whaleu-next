import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../../database/transaction-deadlines.js';
import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ApplicationError } from '../../http/application-error.js';
import type { ApplicationErrorCode } from '../../http/application-error.js';
import { CommunityRepository } from '../community.repository.js';
import { CommunityAccessService } from '../community-access.service.js';
import { requireAction } from '../community-policy.js';
import { TradingRepository } from './repository.js';
import type { SetTradingResolution, TradingReceipt } from './contracts.js';
const terminal = new Set<ApplicationErrorCode>([
  'POST_NOT_FOUND',
  'COMMUNITY_SCOPE_UNAVAILABLE',
  'PHONE_VERIFICATION_REQUIRED',
  'COMMUNITY_ACTION_RESTRICTED',
]);
@Injectable()
export class TradingService {
  constructor(
    @Inject(CommunityRepository)
    private readonly repository: CommunityRepository,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
    @Inject(TradingRepository) private readonly trading: TradingRepository,
  ) {}
  contacts(token: string, postId: string) {
    return this.repository.database.transaction(async (tx) => {
      const actor = await this.access.actor(token, tx);
      const { post } = await this.access.accessiblePost(postId, actor, tx);
      if (post.category !== 'trading')
        throw new ApplicationError('POST_NOT_FOUND');
      return {
        postId: post.id,
        contacts: await this.trading.contacts(post.id, tx),
      };
    });
  }
  setResolution(
    token: string,
    postId: string,
    input: SetTradingResolution,
  ): Promise<TradingReceipt> {
    const requestId = input.clientRequestId.toLowerCase();
    const id = postId.toLowerCase();
    const operation = 'set_trading_resolution' as const;
    const hash = createHash('sha256')
      .update(JSON.stringify({ operation, id, resolution: input.resolution }))
      .digest('hex');
    return this.repository.database.transaction(async (tx) => {
      const actor = await this.access.actor(token, tx);
      await tx.query(
        'INSERT INTO whaleu_community.trading_requests(account_id,client_request_id,payload_hash) VALUES($1,$2,$3) ON CONFLICT(account_id,client_request_id) DO NOTHING',
        [actor, requestId, hash],
      );
      const row = (
        await tx.query<{
          payload_hash: string;
          receipt: TradingReceipt | null;
        }>(
          'SELECT payload_hash,receipt FROM whaleu_community.trading_requests WHERE account_id=$1 AND client_request_id=$2 FOR UPDATE',
          [actor, requestId],
        )
      ).rows[0]!;
      if (row.payload_hash !== hash)
        throw new ApplicationError('REQUEST_CONFLICT');
      // Immutable replay is BEFORE current parent/authority. Never reapply old intent.
      if (row.receipt) return row.receipt;
      const deadlineCheckpoint = checkpointTransactionDeadlines(tx);
      await tx.query('SAVEPOINT trading_work');
      let receipt: TradingReceipt;
      try {
        const { post, space } = await this.access.accessiblePost(
          id,
          actor,
          tx,
          true,
        );
        if (post.category !== 'trading' || post.account_id !== actor)
          throw new ApplicationError('POST_NOT_FOUND');
        const authority = await this.access.authority(actor, space, tx);
        requireAction(authority, 'resolve_trading');
        const listing = await this.trading.find(post.id, tx, true);
        if (!listing) throw new ApplicationError('POST_NOT_FOUND');
        if (listing.resolution !== input.resolution) {
          await tx.query(
            'UPDATE whaleu_community.trading_listings SET resolution=$2 WHERE post_id=$1',
            [post.id, input.resolution],
          );
          await this.repository.event(
            `trading:${randomUUID()}`,
            'trading_resolution_changed',
            post.id,
            tx,
            { resolution: input.resolution },
          );
        }
        receipt = {
          requestId,
          operation,
          outcome: 'applied',
          resourceId: id,
          resolution: input.resolution,
        };
      } catch (error) {
        if (!(error instanceof ApplicationError) || !terminal.has(error.code))
          throw error;
        await tx.query('ROLLBACK TO SAVEPOINT trading_work');
        restoreTransactionDeadlines(tx, deadlineCheckpoint);
        receipt = {
          requestId,
          operation,
          outcome: 'rejected',
          code: error.code,
        };
      }
      await tx.query('RELEASE SAVEPOINT trading_work');
      await tx.query(
        'UPDATE whaleu_community.trading_requests SET receipt=$3::jsonb WHERE account_id=$1 AND client_request_id=$2',
        [actor, requestId, JSON.stringify(receipt)],
      );
      return receipt;
    });
  }
  receipt(token: string, requestId: string): Promise<TradingReceipt> {
    return this.repository.database.transaction(async (tx) => {
      const actor = await this.access.actor(token, tx);
      const row = (
        await tx.query<{ receipt: TradingReceipt }>(
          'SELECT receipt FROM whaleu_community.trading_requests WHERE account_id=$1 AND client_request_id=$2 AND receipt IS NOT NULL',
          [actor, requestId],
        )
      ).rows[0];
      if (!row) throw new ApplicationError('REQUEST_NOT_FOUND');
      return row.receipt;
    });
  }
}
