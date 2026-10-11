import { CommunityMediaBatchPublicationProof } from './media/batch-publication-proof.js';
import type { MediaBatchPublicationCancellation } from '../media/batch-protocol.js';
import { TextReviewSubmission } from './text-review/contracts.js';
import type {
  TextReviewStatus,
  TextReviewCancellation,
} from './text-review/contracts.js';
import { TextReviewRuntime } from './text-review/runtime.js';
import { canonicalJson } from './content-review/contracts.js';
import {
  lockPublicationCommand,
  requirePublicationNotCancelled,
} from './publication-cancel-fence.js';
import { lockSafetyPolicy } from '../safety/locks.js';
import { enrollPublishedHotProcessing } from './hot-score/storage.js';
import { CommunityCommentEnrollment } from './comment-component/enrollment.js';
import { CommunityViewEnrollment } from './view-component/enrollment.js';
import { CommunityLikeEnrollment } from './like-component/enrollment.js';
import { CommunitySubscriptionEnrollment } from './subscription-component/enrollment.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../database/transaction-deadlines.js';
import { createHash } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
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
    @Inject(CommunityCommentEnrollment)
    private readonly comments: CommunityCommentEnrollment,
    @Optional()
    @Inject(TextReviewRuntime)
    private readonly reviews?: TextReviewRuntime,
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
  ): Promise<PublicationReceipt>;
  execute(
    token: string,
    requestId: string,
    operation: PublicationOperation,
    intent: unknown,
    create: (
      actor: string,
      tx: PoolClient,
    ) => Promise<{ resourceId: string; createdAt: string }>,
    reviewOnly: true,
  ): Promise<TextReviewStatus>;
  execute(
    token: string,
    requestId: string,
    operation: PublicationOperation,
    intent: unknown,
    create: (
      actor: string,
      tx: PoolClient,
    ) => Promise<{ resourceId: string; createdAt: string }>,
    reviewOnly: boolean,
  ): Promise<PublicationReceipt | TextReviewStatus>;
  execute(
    token: string,
    requestId: string,
    operation: PublicationOperation,
    intent: unknown,
    create: (
      actor: string,
      tx: PoolClient,
    ) => Promise<{ resourceId: string; createdAt: string }>,
    reviewOnly = false,
  ): Promise<PublicationReceipt | TextReviewStatus> {
    if (reviewOnly && !this.reviews?.configured())
      return Promise.reject(new ApplicationError('CONTENT_REVIEW_UNAVAILABLE'));
    return this.repository.database.transaction(async (tx) => {
      // Nonempty Media publication writes the Media owner and must take its
      // outer writer gate before actor/business locks, never upgrade afterwards.
      if (
        typeof intent === 'object' &&
        intent !== null &&
        'imageAssetIds' in intent &&
        Array.isArray(intent.imageAssetIds) &&
        intent.imageAssetIds.length
      )
        await lockSafetyPolicy(tx, true);
      // Authentication/active account lock precedes even successful replay.
      const actor = await this.access.actor(token, tx);
      const hash = publicationHash(operation, intent);
      await lockPublicationCommand(actor, requestId, tx);
      await requirePublicationNotCancelled(
        actor,
        requestId,
        operation,
        hash,
        tx,
      );
      if (reviewOnly)
        await tx.query(
          'INSERT INTO whaleu_community.publication_requests(account_id,client_request_id,payload_hash,operation,review_submission_transaction) VALUES ($1,$2,$3,$4,pg_current_xact_id()) ON CONFLICT(account_id,client_request_id) DO NOTHING',
          [actor, requestId, hash, operation],
        );
      else
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
        return reviewOnly
          ? { requestId, operation, status: 'settled' as const }
          : row.receipt;
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
        if (reviewOnly)
          throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      } catch (error) {
        if (
          reviewOnly &&
          error instanceof TextReviewSubmission &&
          this.reviews
        ) {
          await tx.query('ROLLBACK TO SAVEPOINT publication_work');
          restoreTransactionDeadlines(tx, deadlineCheckpoint);
          // The rollback released preparation locks and its required facts. Re-run
          // the exact preparation, retaining the fresh locks through queue commit.
          // Review-only preparation always stops before content/effect writes.
          await this.access.actor(token, tx);
          let current: TextReviewSubmission | null = null;
          try {
            await create(actor, tx);
          } catch (second) {
            if (!(second instanceof TextReviewSubmission)) throw second;
            current = second;
          }
          if (
            !current ||
            canonicalJson(current.envelope) !== canonicalJson(error.envelope)
          )
            throw new ApplicationError('COMMUNITY_UNAVAILABLE');
          const status = await this.reviews.submit(
            current.envelope,
            {
              clientRequestId: requestId,
              operation,
              intentHash: hash,
            },
            tx,
          );
          await this.access.actor(token, tx);
          await tx.query('RELEASE SAVEPOINT publication_work');
          return status;
        }
        if (reviewOnly) throw error;
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
        await this.comments.enrollPublishedPost(
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
        await enrollPublishedHotProcessing(receipt.resourceId, tx);
      }
      await this.access.actor(token, tx);
      return receipt;
    });
  }
  cancelReview(
    token: string,
    requestId: string,
    reference: TextReviewCancellation,
  ): Promise<MediaBatchPublicationCancellation> {
    return this.repository.database.transaction(async (tx) => {
      const actor = await this.access.actor(token, tx);
      await lockPublicationCommand(actor, requestId, tx);
      if (!this.reviews)
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      const row = await this.reviews.request(actor, requestId, tx);
      if (
        row &&
        (row.operation !== reference.operation ||
          row.intent_hash !== reference.intentHash)
      )
        throw new ApplicationError('REQUEST_CONFLICT');
      const result =
        await new CommunityMediaBatchPublicationProof().fenceNonCreated(
          actor,
          {
            clientRequestId: requestId,
            operation: reference.operation,
            intentHash: reference.intentHash,
          },
          tx,
        );
      await this.access.actor(token, tx);
      return result;
    });
  }
  reviewStatus(token: string, requestId: string): Promise<TextReviewStatus> {
    return this.repository.database.transaction(async (tx) => {
      const actor = await this.access.actor(token, tx);
      if (!this.reviews)
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      const row = await this.reviews.request(actor, requestId, tx);
      if (!row) throw new ApplicationError('REQUEST_NOT_FOUND');
      const result = await this.reviews.status(row, tx);
      await this.access.actor(token, tx);
      return result;
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
