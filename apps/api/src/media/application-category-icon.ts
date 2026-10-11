import type { CategoryIconMediaDescriptor } from './contracts-category-icon.js';
import type { CategoryIconMediaReadRequest } from './category-icon-owner-proof.js';
import { lockSafetyPolicy } from '../safety/locks.js';
import type { MediaIngressClaim } from './application-v2.js';
import type { StoredObjectMeasurement } from './storage-port.js';
import type { MediaUploadObserved } from './contracts-v2.js';
import { ApplicationError } from '../http/application-error.js';
import {
  categoryIconMediaRequestHash,
  prepareCategoryIconMediaSchema,
  categoryIconMediaGrantSchema,
  categoryIconMediaUploadObservedSchema,
} from './contracts-category-icon.js';
import { CATEGORY_ICON_MEDIA_PROTOCOL } from './contracts-category-icon.js';
import type { PoolClient } from 'pg';
import type { CurrentMediaSession } from '../identity/current-media-session.js';
import type { MediaTransactionRunner } from './delivery.js';
import type { MediaIngressStorage } from './ingress-storage.js';
import type { MediaIngressPlanningPort } from './application-v2.js';
import type { ImmutableMediaStorage } from './storage-port.js';
import type { MediaIntentRepository } from './intent-repository.js';
import type { MediaPrepareScopes } from './prepare-scope.js';
import type { CategoryIconMediaRecoveryRepository } from './category-icon-recovery-repository.js';
import type { MediaIngressRepository } from './ingress-repository.js';
import type { MediaLifecycleRepository } from './lifecycle-repository.js';
import type { CategoryIconMediaDeliveryService } from './category-icon-delivery.js';
export const CATEGORY_ICON_MEDIA_OWNER = Symbol('CATEGORY_ICON_MEDIA_OWNER');
export interface CategoryIconMediaRuntime {
  readonly planning: MediaIngressPlanningPort;
  readonly storage: ImmutableMediaStorage;
  readonly ingressStorage: MediaIngressStorage;
}
export interface CategoryIconMediaOwner {
  readonly database: MediaTransactionRunner;
  readonly runtime: CategoryIconMediaRuntime | null;
  readonly scopes: MediaPrepareScopes;
  readonly intents: MediaIntentRepository;
  readonly recovery: CategoryIconMediaRecoveryRepository;
  readonly ingress: MediaIngressRepository | null;
  readonly lifecycle: MediaLifecycleRepository;
  readonly delivery: CategoryIconMediaDeliveryService | null;
  describe(
    credential: string,
    request: CategoryIconMediaReadRequest,
  ): Promise<CategoryIconMediaDescriptor>;
  authorized<T>(
    token: string,
    work: (session: CurrentMediaSession, tx: PoolClient) => Promise<T>,
    write?: boolean,
  ): Promise<T>;
}

export class CategoryIconUploadApplication {
  constructor(readonly owner: CategoryIconMediaOwner) {}
  prepare(token: string, raw: unknown) {
    return this.owner.authorized(token, async (session, tx) => {
      const input = prepareCategoryIconMediaSchema.parse(raw),
        hash = categoryIconMediaRequestHash(session.accountId, input);
      const previous = await this.owner.recovery.recover(
        session.accountId,
        input.clientRequestId,
        tx,
      );
      if (previous.state !== 'not_recorded') {
        if (previous.requestHash !== hash)
          throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
        if (previous.state !== 'recorded')
          throw new ApplicationError('MEDIA_REQUEST_CANCELLED');
        return previous.status;
      }
      if (!this.owner.runtime) throw new ApplicationError('MEDIA_UNAVAILABLE');
      const scope = await this.owner.scopes.authorizeCategoryIcon(
        session.accountId,
        input,
        tx,
      );
      const receipt = await this.owner.intents.prepare(scope, tx);
      return this.owner.recovery.status(
        session.accountId,
        receipt.intentId,
        tx,
      );
    });
  }
  recover(token: string, requestId: string) {
    return this.owner.authorized(
      token,
      (session, tx) =>
        this.owner.recovery.recover(session.accountId, requestId, tx),
      false,
    );
  }
  cancelRequest(token: string, requestId: string, raw: unknown) {
    return this.owner.authorized(token, (session, tx) =>
      this.owner.recovery.cancelRequest(session.accountId, requestId, raw, tx),
    );
  }
  status(token: string, editScopeId: string) {
    return this.owner.authorized(
      token,
      async (session, tx) =>
        this.owner.recovery.status(
          session.accountId,
          await this.owner.recovery.resolveCategoryIconIntent(
            session.accountId,
            editScopeId,
            tx,
          ),
          tx,
        ),
      false,
    );
  }
  cancel(token: string, editScopeId: string) {
    return this.owner.authorized(token, async (session, tx) =>
      this.owner.recovery.cancel(
        session.accountId,
        await this.owner.recovery.resolveCategoryIconIntent(
          session.accountId,
          editScopeId,
          tx,
        ),
        tx,
      ),
    );
  }
  async finalize(token: string, editScopeId: string) {
    const status = await this.status(token, editScopeId);
    if (
      ['bound_history', 'terminal', 'ready_unbound', 'unavailable'].includes(
        status.status,
      )
    )
      return status;
    return this.owner.authorized(token, async (session, tx) => {
      const ingress = this.requireIngress();
      const id = await this.owner.recovery.resolveCategoryIconIntent(
        session.accountId,
        editScopeId,
        tx,
      );
      await this.owner.scopes.authorizeCategoryIcon(
        session.accountId,
        await ingress.originalCategoryIconInput(session.accountId, id, tx),
        tx,
      );
      await this.owner.lifecycle.finalize(session.accountId, id, tx);
      return this.owner.recovery.status(session.accountId, id, tx);
    });
  }
  async grant(token: string, editScopeId: string) {
    const result = await this.owner.authorized(token, async (session, tx) => {
      const ingress = this.requireIngress(),
        id = await this.owner.recovery.resolveCategoryIconIntent(
          session.accountId,
          editScopeId,
          tx,
        );
      return ingress.grant(
        session,
        id,
        await this.owner.scopes.authorizeCategoryIcon(
          session.accountId,
          await ingress.originalCategoryIconInput(session.accountId, id, tx),
          tx,
        ),
        this.owner.scopes,
        tx,
      );
    });
    if ('blocked' in result) throw new ApplicationError(result.blocked);
    const { version: _version, ...grant } = result;
    void _version;
    return categoryIconMediaGrantSchema.parse({
      ...grant,
      protocol: CATEGORY_ICON_MEDIA_PROTOCOL,
      editScopeId,
    });
  }
  admit(
    token: string,
    editScopeId: string,
    grantId: string,
  ): Promise<MediaIngressClaim> {
    return this.owner.authorized(token, async (session, tx) => {
      const ingress = this.requireIngress(),
        id = await this.owner.recovery.resolveCategoryIconIntent(
          session.accountId,
          editScopeId,
          tx,
        );
      return ingress.admit(
        session,
        id,
        grantId,
        await this.owner.scopes.authorizeCategoryIcon(
          session.accountId,
          await ingress.originalCategoryIconInput(session.accountId, id, tx),
          tx,
        ),
        this.owner.scopes,
        tx,
      );
    });
  }
  observe(
    token: string,
    claim: MediaIngressClaim,
    measurement: StoredObjectMeasurement,
  ): Promise<MediaUploadObserved> {
    return this.owner.authorized(token, async (session, tx) => {
      const ingress = this.requireIngress();
      return ingress.observe(
        session,
        claim,
        measurement,
        await this.owner.scopes.authorizeCategoryIcon(
          session.accountId,
          await ingress.originalCategoryIconInput(
            session.accountId,
            claim.intentId,
            tx,
          ),
          tx,
        ),
        this.owner.scopes,
        tx,
      );
    });
  }
  observed(editScopeId: string, result: MediaUploadObserved) {
    const { version: _version, ...observation } = result;
    void _version;
    return categoryIconMediaUploadObservedSchema.parse({
      ...observation,
      protocol: CATEGORY_ICON_MEDIA_PROTOCOL,
      editScopeId,
    });
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
  private requireIngress() {
    if (!this.owner.ingress) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return this.owner.ingress;
  }
}
