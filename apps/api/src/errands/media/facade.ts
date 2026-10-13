import { AccountPolicy } from '../../safety/account-policy/decorator.js';
import { ErrandMediaRequiredProof } from '../../media/errand-required-proof.js';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { DatabaseService } from '../../database/database.js';
import type { IdentityService } from '../../identity/identity.service.js';
import { authenticateMediaSession } from '../../identity/current-media-session.js';
import type { CurrentMediaSession } from '../../identity/current-media-session.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { ApplicationError } from '../../http/application-error.js';
import type {
  ErrandMediaAccessPort,
  ErrandMediaReadTarget,
} from './access-port.js';
import { MediaErrandPrepareScopes } from '../../media/errand-prepare-scope.js';
import { MediaIntentRepository } from '../../media/intent-repository.js';
import { MediaIngressRepository } from '../../media/ingress-repository.js';
import { MediaLifecycleRepository } from '../../media/lifecycle-repository.js';
import { ErrandMediaRecoveryRepository } from '../../media/errand-recovery-repository.js';
import { ErrandMediaAssetRepository } from '../../media/errand-asset-repository.js';
import { ErrandOwnerProofRegistry } from '../../media/errand-owner-proof.js';
import type { ErrandReadRequest } from '../../media/errand-owner-proof.js';
import { ExactMediaDeliveryService } from '../../media/delivery.js';
import type { MediaDeliveryBudgetPool } from '../../media/delivery-budget.js';
import type {
  MediaIngressClaim,
  MediaIngressPlanningPort,
} from '../../media/application-v2.js';
import type {
  ImmutableMediaStorage,
  StoredObjectMeasurement,
} from '../../media/storage-port.js';
import type { MediaIngressStorage } from '../../media/ingress-storage.js';
import type { MediaUploadObserved } from '../../media/contracts-v2.js';
import { mediaV2IdSchema } from '../../media/contracts-v2.js';
import { mediaVariantSchema } from '../../media/contracts.js';
import type { MediaVariantName } from '../../media/contracts.js';
import {
  ERRAND_MEDIA_PROTOCOL,
  prepareErrandMediaSchema,
  errandMediaRequestHash,
  errandMediaGrantSchema,
  errandMediaUploadObservedSchema,
  errandReferenceSchema,
  errandMediaAudience,
  errandMediaPurpose,
  errandMediaBindingsSchema,
} from '../../media/contracts-errand.js';
import type {
  ErrandMediaFact,
  ErrandMediaBinding,
} from '../../media/contracts-errand.js';
export const ERRAND_MEDIA_RUNTIME = Symbol('ERRAND_MEDIA_RUNTIME');
/** Trusted injection only. Production is explicitly null until approved real adapters exist. */
export interface ErrandMediaRuntime {
  readonly planning: MediaIngressPlanningPort;
  readonly storage: ImmutableMediaStorage;
  readonly ingressStorage: MediaIngressStorage;
}
export class ErrandMediaService {
  readonly scopes: MediaErrandPrepareScopes;
  readonly intents: MediaIntentRepository;
  readonly lifecycle = new MediaLifecycleRepository();
  readonly assets: ErrandMediaAssetRepository;
  readonly registry: ErrandOwnerProofRegistry;
  readonly recovery: ErrandMediaRecoveryRepository;
  readonly ingress: MediaIngressRepository | null;
  readonly delivery: ExactMediaDeliveryService | null;
  constructor(
    readonly database: DatabaseService,
    readonly identity: IdentityService,
    readonly access: ErrandMediaAccessPort,
    readonly runtime: ErrandMediaRuntime | null,
    budget: MediaDeliveryBudgetPool,
  ) {
    this.scopes = new MediaErrandPrepareScopes({
      authorizePrepare: async (actor, input, tx) => {
        const authority = await access.authorizePrepare(actor, input, tx);
        if (
          authority.actorAccountId !== actor ||
          authority.draftId !== input.draftId ||
          authority.draftRevision !== input.draftRevision ||
          authority.targetRegionId !== input.targetRegionId ||
          !Number.isSafeInteger(authority.expiresAt)
        )
          throw new ApplicationError('MEDIA_UNAVAILABLE');
        const hash = errandMediaRequestHash(actor, input);
        let row = (
          await tx.query<{
            id: string;
            scope_revision: string;
            expires_at: Date;
            authority_version: string;
          }>(
            'SELECT * FROM whaleu_media.errand_scopes WHERE actor_id=$1 AND client_request_id=$2',
            [actor, input.clientRequestId],
          )
        ).rows[0];
        if (
          row &&
          (row.scope_revision !== hash ||
            row.authority_version !== authority.authorityVersion)
        )
          throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
        if (!row)
          row = (
            await tx.query<{
              id: string;
              scope_revision: string;
              expires_at: Date;
              authority_version: string;
            }>(
              `INSERT INTO whaleu_media.errand_scopes(id,actor_id,client_request_id,draft_id,draft_revision,target_region_id,slot,scope_revision,input,authority_version,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,least(to_timestamp($11::double precision/1000),statement_timestamp()+interval '30 minutes')) RETURNING *`,
              [
                randomUUID(),
                actor,
                input.clientRequestId,
                input.draftId,
                input.draftRevision,
                input.targetRegionId,
                input.slot,
                hash,
                JSON.stringify(input),
                authority.authorityVersion,
                authority.expiresAt,
              ],
            )
          ).rows[0];
        if (!row) throw new ApplicationError('MEDIA_UNAVAILABLE');
        await access.retainDraftCurrent(input.draftId, tx);
        return {
          actorAccountId: actor,
          serverScopeId: row.id,
          scopeRevision: row.scope_revision,
          expiresAt: row.expires_at.getTime(),
          ownerKind: 'errands',
          resourceKind: 'errand_image',
          targetKind: 'edit',
          contentVersion: 1,
          audience: errandMediaAudience(input.slot),
          purpose: errandMediaPurpose(input.slot),
          slot: input.slot,
          ordinal: 0,
        };
      },
    });
    this.intents = new MediaIntentRepository(this.scopes);
    this.registry = new ErrandOwnerProofRegistry({
      authorizeCurrent: (token, request, tx) =>
        this.authorizeRead(token, request, tx),
    });
    this.assets = new ErrandMediaAssetRepository(this.registry);
    this.recovery = new ErrandMediaRecoveryRepository(
      this.lifecycle,
      this.assets,
    );
    this.ingress = runtime
      ? new MediaIngressRepository(runtime.planning, 14)
      : null;
    this.delivery = runtime
      ? new ExactMediaDeliveryService(database, runtime.storage, budget)
      : null;
  }
  authorized<T>(
    token: string,
    work: (session: CurrentMediaSession, tx: PoolClient) => Promise<T>,
    write = true,
  ) {
    return this.database.transaction(
      async (tx) => {
        await lockSafetyPolicy(tx, write);
        return work(
          await authenticateMediaSession(this.identity, token, tx),
          tx,
        );
      },
      { isolationLevel: 'read committed' },
    );
  }
  @AccountPolicy('interaction', 'owner_after_recovery')
  prepare(token: string, raw: unknown) {
    return this.authorized(token, async (session, tx) => {
      const input = prepareErrandMediaSchema.parse(raw),
        hash = errandMediaRequestHash(session.accountId, input),
        previous = await this.recovery.recover(
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
      if (!this.runtime) throw new ApplicationError('MEDIA_UNAVAILABLE');
      const prepared = await this.intents.prepare(
        await this.scopes.authorizeErrand(session.accountId, input, tx),
        tx,
      );
      return this.recovery.status(session.accountId, prepared.intentId, tx);
    });
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  recover(token: string, requestId: string) {
    return this.authorized(
      token,
      (s, tx) => this.recovery.recover(s.accountId, requestId, tx),
      false,
    );
  }
  @AccountPolicy('browse', 'entry')
  status(token: string, intentId: string) {
    return this.authorized(
      token,
      (s, tx) => this.recovery.status(s.accountId, intentId, tx),
      false,
    );
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  cancelRequest(token: string, requestId: string, raw: unknown) {
    return this.authorized(token, (s, tx) =>
      this.recovery.cancelRequest(s.accountId, requestId, raw, tx),
    );
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  cancel(token: string, intentId: string) {
    return this.authorized(token, (s, tx) =>
      this.recovery.cancel(s.accountId, intentId, tx),
    );
  }
  @AccountPolicy('interaction', 'owner_after_recovery')
  async grant(token: string, intentId: string) {
    const result = await this.authorized(token, async (s, tx) => {
      const ingress = this.requireIngress();
      return ingress.grant(
        s,
        intentId,
        await this.scopes.authorizeErrand(
          s.accountId,
          await ingress.originalErrandInput(s.accountId, intentId, tx),
          tx,
        ),
        this.scopes,
        tx,
      );
    });
    if ('blocked' in result) throw new ApplicationError(result.blocked);
    const { version: _version, ...grant } = result;
    void _version;
    return errandMediaGrantSchema.parse({
      ...grant,
      protocol: ERRAND_MEDIA_PROTOCOL,
    });
  }
  @AccountPolicy('interaction', 'owner_after_recovery')
  async finalize(token: string, intentId: string) {
    const before = await this.status(token, intentId);
    if (
      ['bound_history', 'terminal', 'ready_unbound', 'unavailable'].includes(
        before.status,
      )
    )
      return before;
    return this.authorized(token, async (s, tx) => {
      const ingress = this.requireIngress();
      await this.scopes.authorizeErrand(
        s.accountId,
        await ingress.originalErrandInput(s.accountId, intentId, tx),
        tx,
      );
      await this.lifecycle.finalize(s.accountId, intentId, tx);
      return this.recovery.status(s.accountId, intentId, tx);
    });
  }
  admit(
    token: string,
    intentId: string,
    grantId: string,
  ): Promise<MediaIngressClaim> {
    return this.authorized(token, async (s, tx) => {
      const ingress = this.requireIngress();
      return ingress.admit(
        s,
        intentId,
        grantId,
        await this.scopes.authorizeErrand(
          s.accountId,
          await ingress.originalErrandInput(s.accountId, intentId, tx),
          tx,
        ),
        this.scopes,
        tx,
      );
    });
  }
  observe(
    token: string,
    claim: MediaIngressClaim,
    measurement: StoredObjectMeasurement,
  ): Promise<MediaUploadObserved> {
    return this.authorized(token, async (s, tx) => {
      const ingress = this.requireIngress();
      return ingress.observe(
        s,
        claim,
        measurement,
        await this.scopes.authorizeErrand(
          s.accountId,
          await ingress.originalErrandInput(s.accountId, claim.intentId, tx),
          tx,
        ),
        this.scopes,
        tx,
      );
    });
  }
  @AccountPolicy('interaction', 'owner_after_recovery')
  observed(result: MediaUploadObserved) {
    const { version: _version, ...observed } = result;
    void _version;
    return errandMediaUploadObservedSchema.parse({
      ...observed,
      protocol: ERRAND_MEDIA_PROTOCOL,
    });
  }
  retire(
    claim: MediaIngressClaim,
    proof?: unknown,
    transferredBytes = 0,
  ): Promise<void> {
    return this.database.transaction(
      async (tx) => {
        await lockSafetyPolicy(tx, true);
        if (
          await this.requireIngress().retire(claim, proof, transferredBytes, tx)
        )
          await this.recovery.cancel(claim.actorAccountId, claim.intentId, tx);
      },
      { isolationLevel: 'read committed' },
    );
  }
  retainCurrent(tx: PoolClient) {
    return new ErrandMediaRequiredProof().capture(tx);
  }
  draftFacts(
    actor: string,
    draftId: string,
    draftRevision: number,
    authorityVersion: string,
    items: readonly ErrandMediaFact[],
    tx: PoolClient,
    deferProof = false,
  ) {
    return this.assets.draftFacts(
      actor,
      draftId,
      draftRevision,
      authorityVersion,
      items,
      tx,
      deferProof,
    );
  }
  acceptAndBindMany(
    actor: string,
    draftId: string,
    draftRevision: number,
    orderId: string,
    authorityVersion: string,
    items: readonly ErrandMediaFact[],
    tx: PoolClient,
  ) {
    if (items.length && !this.runtime)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return this.assets.acceptAndBindMany(
      actor,
      draftId,
      draftRevision,
      orderId,
      authorityVersion,
      items,
      tx,
    );
  }
  retireMany(
    orderId: string,
    bindings: readonly ErrandMediaBinding[],
    tx: PoolClient,
  ) {
    return this.assets.retireMany(orderId, bindings, tx);
  }
  async currentFacts(
    orderId: string,
    mediaRevision: number,
    expectedBindings: readonly ErrandMediaBinding[],
    tx: PoolClient,
  ) {
    const { media, safety, revision } = await this.assets.currentFacts(
      orderId,
      mediaRevision,
      expectedBindings,
      tx,
    );
    return { media, safety, revision };
  }
  @AccountPolicy('browse', 'entry')
  descriptor(token: string, target: ErrandMediaReadTarget) {
    return this.database.transaction(
      async (tx) => {
        const request = await this.resolveRead(token, target, tx);
        return this.assets.describe(
          await this.registry.authorize(token, request, tx),
          request,
          tx,
        );
      },
      { isolationLevel: 'read committed' },
    );
  }
  @AccountPolicy('browse', 'entry')
  open(
    token: string,
    target: ErrandMediaReadTarget,
    bindingId: string,
    variant: MediaVariantName,
    _connectionKey: string,
    range?: string,
  ) {
    mediaVariantSchema.parse(variant);
    mediaV2IdSchema.parse(bindingId);
    if (!this.delivery) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return this.delivery.open(
      async (tx) => {
        const request = await this.resolveRead(
          token,
          { ...target, bindingId },
          tx,
        );
        return this.assets.plan(
          await this.registry.authorize(token, request, tx),
          request,
          variant,
          tx,
        );
      },
      (plan) => `account:${plan.accountId}`,
      range,
    );
  }
  private async resolveRead(
    token: string,
    target: ErrandMediaReadTarget,
    tx: PoolClient,
  ): Promise<ErrandReadRequest> {
    await lockSafetyPolicy(tx, false);
    const authority = await this.access.authorizeRead(token, target, tx);
    const item = errandMediaBindingsSchema
      .parse(authority.media)
      .find((x) => x.slot === target.slot);
    if (
      !item ||
      authority.orderId !== target.orderId ||
      authority.mediaRevision !== target.mediaRevision ||
      (target.bindingId !== undefined && target.bindingId !== item.bindingId)
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return {
      reference: errandReferenceSchema.parse({
        orderId: target.orderId,
        revision: target.mediaRevision,
        slot: target.slot,
        bindingId: item.bindingId,
      }),
    };
  }
  private async authorizeRead(
    token: string,
    request: ErrandReadRequest,
    tx: PoolClient,
  ) {
    const ref = request.reference;
    const authority = await this.access.authorizeRead(
      token,
      {
        orderId: ref.orderId,
        mediaRevision: ref.revision,
        slot: ref.slot,
        bindingId: ref.bindingId,
      },
      tx,
    );
    return { ...authority, reference: ref };
  }
  private requireIngress() {
    if (!this.ingress) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return this.ingress;
  }
}
