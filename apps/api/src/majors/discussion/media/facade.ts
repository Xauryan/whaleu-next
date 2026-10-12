import { MajorDiscussionMediaRequiredProof } from '../../../media/major-discussion-required-proof.js';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { DatabaseService } from '../../../database/database.js';
import type { IdentityService } from '../../../identity/identity.service.js';
import { authenticateMediaSession } from '../../../identity/current-media-session.js';
import type { CurrentMediaSession } from '../../../identity/current-media-session.js';
import { lockSafetyPolicy } from '../../../safety/locks.js';
import { ApplicationError } from '../../../http/application-error.js';
import type {
  MajorDiscussionMediaAccessPort,
  MajorDiscussionMediaReadTarget,
} from './access-port.js';
import { MediaMajorDiscussionPrepareScopes } from '../../../media/major-discussion-prepare-scope.js';
import { MediaIntentRepository } from '../../../media/intent-repository.js';
import { MediaIngressRepository } from '../../../media/ingress-repository.js';
import { MediaLifecycleRepository } from '../../../media/lifecycle-repository.js';
import { MajorDiscussionMediaRecoveryRepository } from '../../../media/major-discussion-recovery-repository.js';
import { MajorDiscussionMediaAssetRepository } from '../../../media/major-discussion-asset-repository.js';
import { MajorDiscussionOwnerProofRegistry } from '../../../media/major-discussion-owner-proof.js';
import type { MajorDiscussionReadRequest } from '../../../media/major-discussion-owner-proof.js';
import { ExactMediaDeliveryService } from '../../../media/delivery.js';
import type { MediaDeliveryBudgetPool } from '../../../media/delivery-budget.js';
import type {
  MediaIngressClaim,
  MediaIngressPlanningPort,
} from '../../../media/application-v2.js';
import type {
  ImmutableMediaStorage,
  StoredObjectMeasurement,
} from '../../../media/storage-port.js';
import type { MediaIngressStorage } from '../../../media/ingress-storage.js';
import type { MediaUploadObserved } from '../../../media/contracts-v2.js';
import { mediaVariantSchema } from '../../../media/contracts.js';
import type { MediaVariantName } from '../../../media/contracts.js';
import {
  MAJOR_DISCUSSION_MEDIA_PROTOCOL,
  prepareMajorDiscussionMediaSchema,
  majorDiscussionMediaRequestHash,
  majorDiscussionMediaGrantSchema,
  majorDiscussionMediaUploadObservedSchema,
  majorDiscussionReferenceSchema,
} from '../../../media/contracts-major-discussion.js';
import type {
  MajorDiscussionMediaFact,
  MajorDiscussionMediaBinding,
  MajorDiscussionMediaContext,
} from '../../../media/contracts-major-discussion.js';
export const MAJOR_DISCUSSION_MEDIA_RUNTIME = Symbol(
  'MAJOR_DISCUSSION_MEDIA_RUNTIME',
);
/** Trusted injection only. Production is explicitly null until approved real adapters exist. */
export interface MajorDiscussionMediaRuntime {
  readonly planning: MediaIngressPlanningPort;
  readonly storage: ImmutableMediaStorage;
  readonly ingressStorage: MediaIngressStorage;
}
export class MajorDiscussionMediaService {
  readonly scopes: MediaMajorDiscussionPrepareScopes;
  readonly intents: MediaIntentRepository;
  readonly lifecycle = new MediaLifecycleRepository();
  readonly assets: MajorDiscussionMediaAssetRepository;
  readonly registry: MajorDiscussionOwnerProofRegistry;
  readonly recovery: MajorDiscussionMediaRecoveryRepository;
  readonly ingress: MediaIngressRepository | null;
  readonly delivery: ExactMediaDeliveryService | null;
  constructor(
    readonly database: DatabaseService,
    readonly identity: IdentityService,
    readonly access: MajorDiscussionMediaAccessPort,
    readonly runtime: MajorDiscussionMediaRuntime | null,
    budget: MediaDeliveryBudgetPool,
  ) {
    this.scopes = new MediaMajorDiscussionPrepareScopes({
      authorizePrepare: async (actor, input, tx) => {
        const authority = await access.authorizePrepare(actor, input, tx);
        if (
          authority.actorAccountId !== actor ||
          !Number.isSafeInteger(authority.expiresAt)
        )
          throw new ApplicationError('MEDIA_UNAVAILABLE');
        const hash = majorDiscussionMediaRequestHash(actor, input);
        let row = (
          await tx.query<{
            id: string;
            scope_revision: string;
            expires_at: Date;
            context_digest: string;
          }>(
            'SELECT * FROM whaleu_media.major_discussion_scopes WHERE actor_id=$1 AND client_request_id=$2',
            [actor, input.clientRequestId],
          )
        ).rows[0];
        if (
          row &&
          (row.scope_revision !== hash ||
            row.context_digest !== authority.contextDigest)
        )
          throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
        if (!row)
          row = (
            await tx.query<{
              id: string;
              scope_revision: string;
              expires_at: Date;
              context_digest: string;
            }>(
              `INSERT INTO whaleu_media.major_discussion_scopes(id,actor_id,client_request_id,major_id,publication_request_id,catalog_revision,major_revision,root_id,reply_to_reply_id,ordinal,scope_revision,input,context_digest,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,least(to_timestamp($14::double precision/1000),statement_timestamp()+interval '30 minutes')) RETURNING *`,
              [
                randomUUID(),
                actor,
                input.clientRequestId,
                input.majorId,
                input.publicationRequestId,
                input.catalogRevision,
                input.majorRevision,
                input.rootId,
                input.replyToReplyId,
                input.ordinal,
                hash,
                JSON.stringify(input),
                authority.contextDigest,
                authority.expiresAt,
              ],
            )
          ).rows[0];
        if (!row) throw new ApplicationError('MEDIA_UNAVAILABLE');
        return {
          actorAccountId: actor,
          serverScopeId: row.id,
          scopeRevision: row.scope_revision,
          expiresAt: row.expires_at.getTime(),
          ownerKind: 'majors',
          resourceKind: 'major_discussion_image',
          targetKind: 'edit',
          contentVersion: 1,
          audience: 'content-gated',
          purpose: 'major-discussion-image',
          slot: 'images',
          ordinal: input.ordinal,
        };
      },
    });
    this.intents = new MediaIntentRepository(this.scopes);
    this.registry = new MajorDiscussionOwnerProofRegistry({
      authorizeCurrent: (token, request, tx) =>
        this.authorizeRead(token, request, tx),
    });
    this.assets = new MajorDiscussionMediaAssetRepository(this.registry);
    this.recovery = new MajorDiscussionMediaRecoveryRepository(
      this.lifecycle,
      this.assets,
    );
    this.ingress = runtime
      ? new MediaIngressRepository(runtime.planning, 17)
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
        // Receipt absence is a read fact too. Read-only paths can capture before
        // observing it; write paths must wait until all their own changes finish.
        if (!write) await new MajorDiscussionMediaRequiredProof().capture(tx);
        const result = await work(
          await authenticateMediaSession(this.identity, token, tx),
          tx,
        );
        await this.access.retainCurrent(tx);
        await new MajorDiscussionMediaRequiredProof().capture(tx);
        return result;
      },
      { isolationLevel: 'read committed' },
    );
  }
  prepare(token: string, raw: unknown) {
    return this.authorized(token, async (session, tx) => {
      const input = prepareMajorDiscussionMediaSchema.parse(raw),
        hash = majorDiscussionMediaRequestHash(session.accountId, input),
        previous = await this.recovery.recover(
          session.accountId,
          input.clientRequestId,
          tx,
        );
      if (previous.state !== 'not_recorded') {
        await this.access.authorizePrepare(session.accountId, input, tx);
        if (previous.requestHash !== hash)
          throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
        if (previous.state !== 'recorded')
          throw new ApplicationError('MEDIA_REQUEST_CANCELLED');
        return previous.status;
      }
      if (!this.runtime) throw new ApplicationError('MEDIA_UNAVAILABLE');
      const prepared = await this.intents.prepare(
        await this.scopes.authorizeMajorDiscussion(
          session.accountId,
          input,
          tx,
        ),
        tx,
      );
      return this.recovery.status(session.accountId, prepared.intentId, tx);
    });
  }
  recover(token: string, requestId: string) {
    return this.authorized(
      token,
      (s, tx) => this.recovery.recover(s.accountId, requestId, tx),
      false,
    );
  }
  status(token: string, intentId: string) {
    return this.authorized(
      token,
      (s, tx) => this.recovery.status(s.accountId, intentId, tx),
      false,
    );
  }
  cancelRequest(token: string, requestId: string, raw: unknown) {
    return this.authorized(token, (s, tx) =>
      this.recovery.cancelRequest(s.accountId, requestId, raw, tx),
    );
  }
  cancel(token: string, intentId: string) {
    return this.authorized(token, (s, tx) =>
      this.recovery.cancel(s.accountId, intentId, tx),
    );
  }
  async grant(token: string, intentId: string) {
    const result = await this.authorized(token, async (s, tx) => {
      const ingress = this.requireIngress();
      return ingress.grant(
        s,
        intentId,
        await this.scopes.authorizeMajorDiscussion(
          s.accountId,
          await ingress.originalMajorDiscussionInput(s.accountId, intentId, tx),
          tx,
        ),
        this.scopes,
        tx,
      );
    });
    if ('blocked' in result) throw new ApplicationError(result.blocked);
    const { version: _version, ...grant } = result;
    void _version;
    return majorDiscussionMediaGrantSchema.parse({
      ...grant,
      protocol: MAJOR_DISCUSSION_MEDIA_PROTOCOL,
    });
  }
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
      await this.scopes.authorizeMajorDiscussion(
        s.accountId,
        await ingress.originalMajorDiscussionInput(s.accountId, intentId, tx),
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
        await this.scopes.authorizeMajorDiscussion(
          s.accountId,
          await ingress.originalMajorDiscussionInput(s.accountId, intentId, tx),
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
        await this.scopes.authorizeMajorDiscussion(
          s.accountId,
          await ingress.originalMajorDiscussionInput(
            s.accountId,
            claim.intentId,
            tx,
          ),
          tx,
        ),
        this.scopes,
        tx,
      );
    });
  }
  observed(result: MediaUploadObserved) {
    const { version: _version, ...observed } = result;
    void _version;
    return majorDiscussionMediaUploadObservedSchema.parse({
      ...observed,
      protocol: MAJOR_DISCUSSION_MEDIA_PROTOCOL,
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
        await this.requireIngress().retire(claim, proof, transferredBytes, tx);
        await new MajorDiscussionMediaRequiredProof().capture(tx);
      },
      { isolationLevel: 'read committed' },
    );
  }
  retainCurrent(tx: PoolClient) {
    return new MajorDiscussionMediaRequiredProof().capture(tx);
  }
  draftFacts(
    actor: string,
    context: MajorDiscussionMediaContext,
    images: readonly MajorDiscussionMediaFact[],
    tx: PoolClient,
    deferProof = false,
  ) {
    return this.assets.draftFacts(actor, context, images, tx, deferProof);
  }
  acceptAndBind(
    commentId: string,
    actor: string,
    context: MajorDiscussionMediaContext,
    images: readonly MajorDiscussionMediaFact[],
    tx: PoolClient,
  ) {
    if (images.length && !this.runtime)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return this.assets.acceptAndBind(commentId, actor, context, images, tx);
  }
  async currentFacts(
    commentId: string,
    expected: readonly MajorDiscussionMediaBinding[],
    tx: PoolClient,
  ) {
    const { images, safety, revision } = await this.assets.currentFacts(
      commentId,
      expected,
      tx,
    );
    return { images, safety, revision };
  }
  descriptor(token: string, reference: MajorDiscussionMediaReadTarget) {
    return this.database.transaction(
      async (tx) => {
        await lockSafetyPolicy(tx, false);
        const request = {
          reference: majorDiscussionReferenceSchema.parse(reference),
        };
        return this.assets.describe(
          await this.registry.authorize(token, request, tx),
          request,
          tx,
        );
      },
      { isolationLevel: 'read committed' },
    );
  }
  open(
    token: string,
    reference: MajorDiscussionMediaReadTarget,
    variant: MediaVariantName,
    range?: string,
  ) {
    mediaVariantSchema.parse(variant);
    const request = {
      reference: majorDiscussionReferenceSchema.parse(reference),
    };
    if (!this.delivery) throw new ApplicationError('MEDIA_UNAVAILABLE');
    // ExactMediaDeliveryService rejects Range before storage, re-runs this entire
    // owner + complete-set authorization after openExact, and waits for final proof
    // before exposing its paused stream. All owners share the injected budget.
    return this.delivery.open(
      async (tx) => {
        await lockSafetyPolicy(tx, false);
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
  private async authorizeRead(
    token: string,
    request: MajorDiscussionReadRequest,
    tx: PoolClient,
  ) {
    const authority = await this.access.authorizeRead(
      token,
      request.reference,
      tx,
    );
    return { ...authority, reference: request.reference };
  }
  private requireIngress() {
    if (!this.ingress) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return this.ingress;
  }
}
