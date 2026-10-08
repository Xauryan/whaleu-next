import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';
import { enableSafetyRelationshipProof } from '../../safety/relationship-proof.js';
import { CommunityAccessService } from '../community-access.service.js';
import { CommunityRepository } from '../community.repository.js';
import { ViewComponentRepository } from './repository.js';
import { ViewComponentCleanup } from './cleanup.js';
import {
  VIEW_LIMITS,
  viewPayloadFingerprint,
  viewPostMultiset,
  viewReportingEpochSchema,
  viewReportReceiptSchema,
} from './contracts.js';
import type {
  ViewReport,
  ViewReportReceipt,
  ViewReportingEpoch,
} from './contracts.js';
@Injectable()
export class ViewReportingService {
  constructor(
    @Inject(CommunityRepository)
    private readonly community: CommunityRepository,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
    @Inject(ViewComponentRepository)
    private readonly records: ViewComponentRepository,
    @Inject(ViewComponentCleanup)
    private readonly cleanup: ViewComponentCleanup,
  ) {}
  private async transaction<T>(
    operation: (tx: PoolClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.community.database.transaction(
        async (tx) => {
          await this.records.budget(tx);
          enableSafetyRelationshipProof(tx);
          return operation(tx);
        },
        { isolationLevel: 'read committed' },
      );
    } catch (error) {
      if (error instanceof ApplicationError && error.getStatus() < 500)
        throw error;
      // Infrastructure/owner unavailability is whole-batch retryable. No raw
      // SQL, identifiers, fingerprints or exception text reaches logs/clients.
      throw new ApplicationError('VIEW_REPORTING_UNAVAILABLE');
    }
  }
  issueEpoch(token: string): Promise<ViewReportingEpoch> {
    return this.transaction(async (tx) => {
      const actor = await this.access.actor(token, tx);
      await this.records.lockOwner(actor, tx);
      let epoch = await this.records.collecting(actor, tx);
      await this.access.actor(token, tx);
      let now = await this.records.now(tx);
      if (!epoch || epoch.collection_until.getTime() <= now.getTime()) {
        await this.cleanup.assertAdmission(tx);
        const capacity = await this.records.capacity(actor, tx);
        if (capacity.epochs >= VIEW_LIMITS.liveEpochs)
          throw new ApplicationError('RATE_LIMITED');
        now = await this.records.now(tx);
        epoch = await this.records.createEpoch(actor, now, tx);
      }
      registerTransactionDeadline(
        tx,
        epoch.expires_at.getTime(),
        'VIEW_REPORTING_EPOCH_CLOSED',
      );
      // A collection boundary crossed during deferred waits is unavailable,
      // never a successful descriptor the native decoder must reject.
      registerTransactionDeadline(
        tx,
        epoch.collection_until.getTime(),
        'VIEW_REPORTING_UNAVAILABLE',
      );
      return viewReportingEpochSchema.parse({
        version: 1,
        epochId: epoch.id,
        issuedAt: epoch.issued_at.toISOString(),
        collectionUntil: epoch.collection_until.toISOString(),
        expiresAt: epoch.expires_at.toISOString(),
        serverNow: now.toISOString(),
      });
    });
  }
  report(token: string, input: ViewReport): Promise<ViewReportReceipt> {
    const epochId = input.epochId.toLowerCase(),
      batchId = input.batchId.toLowerCase();
    const fingerprint = viewPayloadFingerprint(input.kind, input.postIds);
    return this.transaction(async (tx) => {
      const actor = await this.access.actor(token, tx);
      await this.records.lockOwner(actor, tx);
      const epoch = await this.records.epoch(actor, epochId, tx);
      const now = await this.records.now(tx);
      if (!epoch || epoch.expires_at.getTime() <= now.getTime())
        throw new ApplicationError('VIEW_REPORTING_EPOCH_CLOSED');
      registerTransactionDeadline(
        tx,
        epoch.expires_at.getTime(),
        'VIEW_REPORTING_EPOCH_CLOSED',
      );
      const previous = await this.records.receipt(epochId, batchId, tx);
      if (previous) {
        if (
          previous.kind !== input.kind ||
          previous.payloadFingerprint !== fingerprint
        )
          throw new ApplicationError('VIEW_REPORT_CONFLICT');
        await this.access.actor(token, tx);
        return viewReportReceiptSchema.parse(previous);
      }
      if (
        epoch.expires_at.getTime() - now.getTime() <
        VIEW_LIMITS.transactionMs
      )
        throw new ApplicationError('VIEW_REPORTING_UNAVAILABLE');
      await this.cleanup.assertAdmission(tx);
      const capacity = await this.records.capacity(actor, tx);
      if (
        capacity.batches >= VIEW_LIMITS.receipts ||
        capacity.events + input.postIds.length > VIEW_LIMITS.events
      )
        throw new ApplicationError('RATE_LIMITED');
      const multiset = viewPostMultiset(input.postIds);
      const posts = new Map(
        (
          await this.records.posts(
            multiset.map(([id]) => id),
            tx,
          )
        ).map((post) => [post.id, post]),
      );
      let acceptedCount = 0;
      for (const [postId, multiplicity] of multiset) {
        const post = posts.get(postId);
        if (
          !post ||
          post.deleted_at ||
          post.visibility !== 'approved' ||
          !(await this.records.known(postId, tx))
        )
          continue;
        try {
          await this.community.space(post.space_id, tx);
        } catch (error) {
          if (
            error instanceof ApplicationError &&
            error.code === 'COMMUNITY_SCOPE_UNAVAILABLE'
          )
            continue;
          throw error;
        }
        const decision = await this.access.visibilityDecision(
          actor,
          post,
          tx,
          input.kind === 'list_exposure' ? 'list_projection' : 'direct_post',
        );
        if (decision.kind === 'unavailable')
          throw new ApplicationError('VIEW_REPORTING_UNAVAILABLE');
        if (decision.kind === 'deny') continue;
        const delta =
          input.kind === 'list_exposure'
            ? multiplicity
            : (await this.records.countDetail(actor, postId, tx))
              ? 1
              : 0;
        if (delta > 0) {
          await this.records.increment(postId, delta, tx);
          acceptedCount += delta;
        }
      }
      const receipt = viewReportReceiptSchema.parse({
        version: 1,
        epochId,
        batchId,
        kind: input.kind,
        payloadFingerprint: fingerprint,
        acceptedCount,
      });
      await this.records.accept(receipt, input.postIds.length, tx);
      await this.access.actor(token, tx);
      return receipt;
    });
  }
}
