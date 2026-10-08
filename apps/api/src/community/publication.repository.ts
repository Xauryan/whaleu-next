import { CommunityViewEnrollment } from './view-component/enrollment.js';
import { CommunityLikeEnrollment } from './like-component/enrollment.js';
import { CommunitySubscriptionEnrollment } from './subscription-component/enrollment.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../database/transaction-deadlines.js';
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import type { ApplicationErrorCode } from '../http/application-error.js';
import { CommunityRepository } from './community.repository.js';
import { CommunityAccessService } from './community-access.service.js';
import type { PublicationOperation, PublicationReceipt } from './contracts.js';
const terminalCodes = new Set<ApplicationErrorCode>([
  'COMMUNITY_SCOPE_UNAVAILABLE',
  'PHONE_VERIFICATION_REQUIRED',
  'STUDENT_VERIFICATION_REQUIRED',
  'IDENTITY_CAMPUS_REQUIRED',
  'COMMUNITY_ACTION_RESTRICTED',
  'AUTHOR_MODE_NOT_ALLOWED',
  'COMMENTS_DISABLED',
  'CONTENT_REJECTED',
  'MEDIA_NOT_READY',
  'POST_NOT_FOUND',
  'POST_DELETED',
  'COMMENT_NOT_FOUND',
  'REPLY_NOT_FOUND',
]);
interface RequestRow {
  payload_hash: string;
  operation: PublicationOperation;
  receipt: PublicationReceipt | null;
}
export function publicationHash(
  operation: PublicationOperation,
  intent: unknown,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ operation, intent }))
    .digest('hex');
}
@Injectable()
export class PublicationRepository {
  constructor(
    @Inject(CommunityRepository)
    private readonly repository: CommunityRepository,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
    @Inject(CommunitySubscriptionEnrollment)
    private readonly subscriptions: CommunitySubscriptionEnrollment,
    @Inject(CommunityLikeEnrollment)
    private readonly likes: CommunityLikeEnrollment,
    @Inject(CommunityViewEnrollment)
    private readonly views: CommunityViewEnrollment,
  ) {}
  execute(
    token: string,
    requestId: string,
    operation: PublicationOperation,
    intent: unknown,
    create: (
      actor: string,
      tx: PoolClient,
    ) => Promise<{ resourceId: string; createdAt: string }>,
  ): Promise<PublicationReceipt> {
    return this.repository.database.transaction(async (tx) => {
      // Authentication/active account lock precedes even successful replay.
      const actor = await this.access.actor(token, tx);
      const hash = publicationHash(operation, intent);
      await tx.query(
        'INSERT INTO whaleu_community.publication_requests(account_id,client_request_id,payload_hash,operation) VALUES ($1,$2,$3,$4) ON CONFLICT(account_id,client_request_id) DO NOTHING',
        [actor, requestId, hash, operation],
      );
      const result = await tx.query<RequestRow>(
        'SELECT payload_hash,operation,receipt FROM whaleu_community.publication_requests WHERE account_id=$1 AND client_request_id=$2 FOR UPDATE',
        [actor, requestId],
      );
      const row = result.rows[0]!;
      if (row.payload_hash !== hash || row.operation !== operation)
        throw new ApplicationError('REQUEST_CONFLICT');
      if (row.receipt) {
        await this.access.actor(token, tx);
        return row.receipt;
      }
      const deadlineCheckpoint = checkpointTransactionDeadlines(tx);
      await tx.query('SAVEPOINT publication_work');
      let receipt: PublicationReceipt;
      try {
        receipt = {
          requestId,
          operation,
          outcome: 'created',
          ...(await create(actor, tx)),
        };
      } catch (error) {
        if (
          !(error instanceof ApplicationError) ||
          !terminalCodes.has(error.code)
        )
          throw error;
        await tx.query('ROLLBACK TO SAVEPOINT publication_work');
        restoreTransactionDeadlines(tx, deadlineCheckpoint);
        receipt = {
          requestId,
          operation,
          outcome: 'rejected',
          code: error.code,
        };
      }
      if (receipt.outcome === 'created')
        await tx.query(
          'INSERT INTO whaleu_community.report_origins(kind,target_id,owner_account_id,provenance,source_request_id) VALUES($1,$2,$3,$4,$5)',
          [
            operation === 'publish_post'
              ? 'post'
              : operation === 'publish_comment'
                ? 'comment'
                : 'reply',
            receipt.resourceId,
            actor,
            'native_publication',
            requestId,
          ],
        );
      await tx.query('RELEASE SAVEPOINT publication_work');
      await tx.query(
        'UPDATE whaleu_community.publication_requests SET receipt=$3::jsonb WHERE account_id=$1 AND client_request_id=$2',
        [actor, requestId, JSON.stringify(receipt)],
      );
      if (operation === 'publish_post' && receipt.outcome === 'created') {
        await this.subscriptions.enrollPublishedPost(
          {
            postId: receipt.resourceId,
            ownerId: actor,
            publicationRequestId: requestId,
          },
          tx,
        );
        await this.views.enrollPublishedPost(
          {
            postId: receipt.resourceId,
            ownerId: actor,
            publicationRequestId: requestId,
          },
          tx,
        );
        await this.likes.enrollPublishedPost(
          {
            postId: receipt.resourceId,
            ownerId: actor,
            publicationRequestId: requestId,
          },
          tx,
        );
      }
      await this.access.actor(token, tx);
      return receipt;
    });
  }
  receipt(token: string, requestId: string): Promise<PublicationReceipt> {
    return this.repository.database.transaction(async (tx) => {
      const actor = await this.access.actor(token, tx);
      const result = await tx.query<{ receipt: PublicationReceipt }>(
        'SELECT receipt FROM whaleu_community.publication_requests WHERE account_id=$1 AND client_request_id=$2 AND receipt IS NOT NULL',
        [actor, requestId],
      );
      if (!result.rows[0]) throw new ApplicationError('REQUEST_NOT_FOUND');
      return result.rows[0].receipt;
    });
  }
}
