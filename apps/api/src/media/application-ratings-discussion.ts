import type { PoolClient } from 'pg';
import type { CurrentMediaSession } from '../identity/current-media-session.js';
import { ApplicationError } from '../http/application-error.js';
import { lockSafetyPolicy } from '../safety/locks.js';
import type { MediaTransactionRunner } from './delivery.js';
import type { MediaIngressPlanningPort } from './application-v2.js';
import type { ImmutableMediaStorage } from './storage-port.js';
import type { MediaIngressStorage } from './ingress-storage.js';
import type { MediaIngressClaim } from './application-v2.js';
import type { MediaUploadObserved } from './contracts-v2.js';
import type { StoredObjectMeasurement } from './storage-port.js';
import type { MediaPrepareScopes } from './prepare-scope.js';
import type { MediaIntentRepository } from './intent-repository.js';
import type { MediaIngressRepository } from './ingress-repository.js';
import type { MediaLifecycleRepository } from './lifecycle-repository.js';
import type { RatingsDiscussionMediaBatchRepository } from './ratings-discussion-batch-repository.js';
import type { RatingsDiscussionMediaRecoveryRepository } from './ratings-discussion-recovery-repository.js';
import type { RatingsDiscussionMediaDeliveryService } from './ratings-discussion-delivery.js';
import {
  ratingsDiscussionBatchCancelRequestSchema,
  ratingsDiscussionCancelRequestSchema,
  ratingsDiscussionMediaGrantSchema,
  ratingsDiscussionMediaUploadObservedSchema,
} from './contracts-ratings-discussion.js';
export const RATINGS_DISCUSSION_MEDIA_OWNER = Symbol(
  'RATINGS_DISCUSSION_MEDIA_OWNER',
);
export interface RatingsDiscussionMediaRuntime {
  readonly planning: MediaIngressPlanningPort;
  readonly storage: ImmutableMediaStorage;
  readonly ingressStorage: MediaIngressStorage;
}
export interface RatingsDiscussionMediaOwner {
  readonly database: MediaTransactionRunner;
  /** Null in ordinary AppModule. No environment variable enables a provider. */
  readonly runtime: RatingsDiscussionMediaRuntime | null;
  readonly scopes: MediaPrepareScopes;
  readonly intents: MediaIntentRepository;
  readonly batches: RatingsDiscussionMediaBatchRepository;
  readonly recovery: RatingsDiscussionMediaRecoveryRepository;
  readonly ingress: MediaIngressRepository | null;
  readonly lifecycle: MediaLifecycleRepository;
  readonly delivery: RatingsDiscussionMediaDeliveryService | null;
  reserveMemberRequest(
    actor: string,
    requestId: string,
    requestHash: string,
    tx: PoolClient,
  ): Promise<void>;
  reserveBatchRequest(
    actor: string,
    requestId: string,
    identityHash: string,
    tx: PoolClient,
  ): Promise<void>;
  authorized<T>(
    token: string,
    work: (session: CurrentMediaSession, tx: PoolClient) => Promise<T>,
    write?: boolean,
  ): Promise<T>;
}
export class RatingsDiscussionUploadApplication {
  constructor(readonly owner: RatingsDiscussionMediaOwner) {}
  prepareBatch(token: string, raw: unknown) {
    return this.owner.authorized(token, (session, tx) => {
      this.requireRuntime();
      return this.owner.batches.prepare(session.accountId, raw, tx);
    });
  }
  batchStatus(token: string, id: string) {
    return this.owner.authorized(
      token,
      (session, tx) => this.owner.batches.status(session.accountId, id, tx),
      false,
    );
  }
  cancelBatchRequest(token: string, id: string, raw: unknown) {
    return this.owner.authorized(token, async (session, tx) => {
      const input = ratingsDiscussionBatchCancelRequestSchema.parse(raw);
      await this.owner.reserveBatchRequest(
        session.accountId,
        id,
        input.identityHash,
        tx,
      );
      return this.owner.batches.cancelRequest(session.accountId, id, input, tx);
    });
  }
  recoverBatch(token: string, id: string) {
    return this.owner.authorized(
      token,
      (session, tx) => this.owner.batches.recover(session.accountId, id, tx),
      false,
    );
  }
  seal(token: string, raw: unknown) {
    return this.owner.authorized(token, (session, tx) => {
      this.requireRuntime();
      return this.owner.batches.seal(session.accountId, raw, tx);
    });
  }
  remove(token: string, id: string, raw: unknown) {
    return this.owner.authorized(token, (session, tx) =>
      this.owner.batches.remove(session.accountId, id, raw, tx),
    );
  }
  cancelBatch(token: string, id: string, raw: unknown) {
    return this.owner.authorized(token, (session, tx) =>
      this.owner.batches.cancel(session.accountId, id, raw, tx),
    );
  }
  prepare(token: string, raw: unknown) {
    return this.owner.authorized(token, async (session, tx) => {
      this.requireRuntime();
      const id = await this.owner.batches.prepareMember(
        session.accountId,
        raw,
        tx,
      );
      return this.owner.recovery.status(session.accountId, id, tx);
    });
  }
  recover(token: string, id: string) {
    return this.owner.authorized(
      token,
      (session, tx) => this.owner.recovery.recover(session.accountId, id, tx),
      false,
    );
  }
  cancelRequest(token: string, id: string, raw: unknown) {
    return this.owner.authorized(token, async (session, tx) => {
      const input = ratingsDiscussionCancelRequestSchema.parse(raw);
      await this.owner.reserveMemberRequest(
        session.accountId,
        id,
        input.requestHash,
        tx,
      );
      return this.owner.recovery.cancelRequest(
        session.accountId,
        id,
        input,
        tx,
      );
    });
  }
  status(token: string, memberId: string) {
    return this.owner.authorized(
      token,
      async (session, tx) =>
        this.owner.recovery.status(
          session.accountId,
          await this.owner.recovery.resolveMemberIntent(
            session.accountId,
            memberId,
            tx,
          ),
          tx,
        ),
      false,
    );
  }
  cancel(token: string, memberId: string) {
    return this.owner.authorized(token, async (session, tx) =>
      this.owner.recovery.cancel(
        session.accountId,
        await this.owner.recovery.resolveMemberIntent(
          session.accountId,
          memberId,
          tx,
        ),
        tx,
      ),
    );
  }
  async finalize(token: string, memberId: string) {
    const status = await this.status(token, memberId);
    if (
      ['bound_history', 'terminal', 'ready_unbound', 'unavailable'].includes(
        status.status,
      )
    )
      return status;
    return this.owner.authorized(token, async (session, tx) => {
      const ingress = this.requireIngress(),
        id = await this.owner.recovery.resolveMemberIntent(
          session.accountId,
          memberId,
          tx,
        );
      await this.owner.scopes.authorizeRatingsDiscussion(
        session.accountId,
        await ingress.originalRatingsDiscussionInput(session.accountId, id, tx),
        tx,
      );
      await this.owner.lifecycle.finalize(session.accountId, id, tx);
      return this.owner.recovery.status(session.accountId, id, tx);
    });
  }
  async grant(token: string, memberId: string) {
    const returned = await this.owner.authorized(token, async (session, tx) => {
      const ingress = this.requireIngress(),
        id = await this.owner.recovery.resolveMemberIntent(
          session.accountId,
          memberId,
          tx,
        );
      const scope = await this.owner.scopes.authorizeRatingsDiscussion(
        session.accountId,
        await ingress.originalRatingsDiscussionInput(session.accountId, id, tx),
        tx,
      );
      return {
        result: await ingress.grant(session, id, scope, this.owner.scopes, tx),
        identity: await this.owner.recovery.identity(session.accountId, id, tx),
      };
    });
    if ('blocked' in returned.result)
      throw new ApplicationError(returned.result.blocked);
    const { version: _version, ...grant } = returned.result;
    void _version;
    return ratingsDiscussionMediaGrantSchema.parse({
      ...grant,
      protocol: 'ratings-discussion-media-v1',
      ...returned.identity,
    });
  }
  admit(
    token: string,
    memberId: string,
    grantId: string,
  ): Promise<MediaIngressClaim> {
    return this.owner.authorized(token, async (session, tx) => {
      const ingress = this.requireIngress(),
        id = await this.owner.recovery.resolveMemberIntent(
          session.accountId,
          memberId,
          tx,
        );
      const scope = await this.owner.scopes.authorizeRatingsDiscussion(
        session.accountId,
        await ingress.originalRatingsDiscussionInput(session.accountId, id, tx),
        tx,
      );
      return ingress.admit(session, id, grantId, scope, this.owner.scopes, tx);
    });
  }
  observe(
    token: string,
    claim: MediaIngressClaim,
    measurement: StoredObjectMeasurement,
  ): Promise<MediaUploadObserved> {
    return this.owner.authorized(token, async (session, tx) => {
      const ingress = this.requireIngress();
      const scope = await this.owner.scopes.authorizeRatingsDiscussion(
        session.accountId,
        await ingress.originalRatingsDiscussionInput(
          session.accountId,
          claim.intentId,
          tx,
        ),
        tx,
      );
      return ingress.observe(
        session,
        claim,
        measurement,
        scope,
        this.owner.scopes,
        tx,
      );
    });
  }
  observed(token: string, memberId: string, result: MediaUploadObserved) {
    return this.owner.authorized(
      token,
      async (session, tx) => {
        const identity = await this.owner.recovery.identity(
          session.accountId,
          result.intentId,
          tx,
        );
        if (identity.memberId !== memberId)
          throw new ApplicationError('MEDIA_UNAVAILABLE');
        const { version: _version, ...observation } = result;
        void _version;
        return ratingsDiscussionMediaUploadObservedSchema.parse({
          ...observation,
          protocol: 'ratings-discussion-media-v1',
          ...identity,
        });
      },
      false,
    );
  }
  retire(
    claim: MediaIngressClaim,
    proof?: unknown,
    transferredBytes = 0,
  ): Promise<void> {
    return this.owner.database.transaction(
      async (tx) => {
        await lockSafetyPolicy(tx, true);
        if (
          await this.requireIngress().retire(claim, proof, transferredBytes, tx)
        )
          await this.owner.recovery.cancel(
            claim.actorAccountId,
            claim.intentId,
            tx,
          );
      },
      { isolationLevel: 'read committed' },
    );
  }
  private requireRuntime() {
    if (!this.owner.runtime) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return this.owner.runtime;
  }
  private requireIngress() {
    this.requireRuntime();
    if (!this.owner.ingress) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return this.owner.ingress;
  }
}
