import { PrivateMessageMediaRequiredProof } from '../../media/private-message-required-proof.js';
import { randomUUID, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { DatabaseService } from '../../database/database.js';
import type { IdentityService } from '../../identity/identity.service.js';
import { authenticateMediaSession } from '../../identity/current-media-session.js';
import type { CurrentMediaSession } from '../../identity/current-media-session.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { ApplicationError } from '../../http/application-error.js';
import type {
  PrivateMessageMediaAccessPort,
  PrivateMessageMediaReadTarget,
} from './access-port.js';
import { MediaPrivateMessagePrepareScopes } from '../../media/private-message-prepare-scope.js';
import { MediaIntentRepository } from '../../media/intent-repository.js';
import { MediaIngressRepository } from '../../media/ingress-repository.js';
import { MediaLifecycleRepository } from '../../media/lifecycle-repository.js';
import { PrivateMessageMediaRecoveryRepository } from '../../media/private-message-recovery-repository.js';
import { PrivateMessageMediaAssetRepository } from '../../media/private-message-asset-repository.js';
import { PrivateMessageOwnerProofRegistry } from '../../media/private-message-owner-proof.js';
import type { PrivateMessageReadRequest } from '../../media/private-message-owner-proof.js';
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
  PRIVATE_MESSAGE_MEDIA_PROTOCOL,
  preparePrivateMessageMediaSchema,
  privateMessageMediaRequestHash,
  privateMessageMediaGrantSchema,
  privateMessageMediaUploadObservedSchema,
  privateMessageReferenceSchema,
  privateMessageMediaBindingSchema,
} from '../../media/contracts-private-message.js';
import type {
  PrivateMessageMediaFact,
  PrivateMessageMediaBinding,
} from '../../media/contracts-private-message.js';
export const PRIVATE_MESSAGE_MEDIA_RUNTIME = Symbol(
  'PRIVATE_MESSAGE_MEDIA_RUNTIME',
);
/** Trusted injection only. Production is explicitly null until approved real adapters exist. */
export interface PrivateMessageMediaRuntime {
  readonly planning: MediaIngressPlanningPort;
  readonly storage: ImmutableMediaStorage;
  readonly ingressStorage: MediaIngressStorage;
}
export class PrivateMessageMediaService {
  readonly scopes: MediaPrivateMessagePrepareScopes;
  readonly intents: MediaIntentRepository;
  readonly lifecycle = new MediaLifecycleRepository();
  readonly assets: PrivateMessageMediaAssetRepository;
  readonly registry: PrivateMessageOwnerProofRegistry;
  readonly recovery: PrivateMessageMediaRecoveryRepository;
  readonly ingress: MediaIngressRepository | null;
  readonly delivery: ExactMediaDeliveryService | null;
  constructor(
    readonly database: DatabaseService,
    readonly identity: IdentityService,
    readonly access: PrivateMessageMediaAccessPort,
    readonly runtime: PrivateMessageMediaRuntime | null,
    budget: MediaDeliveryBudgetPool,
  ) {
    this.scopes = new MediaPrivateMessagePrepareScopes({
      authorizePrepare: async (actor, input, tx) => {
        const authority = await access.authorizePrepare(actor, input, tx);
        if (
          authority.actorAccountId !== actor ||
          authority.conversationId !== input.conversationId ||
          authority.messageRequestId !== input.messageRequestId ||
          !Number.isSafeInteger(authority.expiresAt)
        )
          throw new ApplicationError('MEDIA_UNAVAILABLE');
        const hash = privateMessageMediaRequestHash(actor, input);
        let row = (
          await tx.query<{
            id: string;
            scope_revision: string;
            expires_at: Date;
            context_digest: string;
          }>(
            'SELECT * FROM whaleu_media.private_message_scopes WHERE actor_id=$1 AND client_request_id=$2',
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
              `INSERT INTO whaleu_media.private_message_scopes(id,actor_id,client_request_id,conversation_id,message_request_id,scope_revision,input,context_digest,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,least(to_timestamp($9::double precision/1000),statement_timestamp()+interval '30 minutes')) RETURNING *`,
              [
                randomUUID(),
                actor,
                input.clientRequestId,
                input.conversationId,
                input.messageRequestId,
                hash,
                JSON.stringify(input),
                authority.contextDigest,
                authority.expiresAt,
              ],
            )
          ).rows[0];
        if (!row) throw new ApplicationError('MEDIA_UNAVAILABLE');
        await access.retainCurrent(tx);
        return {
          actorAccountId: actor,
          serverScopeId: row.id,
          scopeRevision: row.scope_revision,
          expiresAt: row.expires_at.getTime(),
          ownerKind: 'messaging',
          resourceKind: 'private_message_image',
          targetKind: 'edit',
          contentVersion: 1,
          audience: 'conversation-private',
          purpose: 'private-message-image',
          slot: 'image',
          ordinal: 0,
        };
      },
    });
    this.intents = new MediaIntentRepository(this.scopes);
    this.registry = new PrivateMessageOwnerProofRegistry({
      authorizeCurrent: (token, request, tx) =>
        this.authorizeRead(token, request, tx),
    });
    this.assets = new PrivateMessageMediaAssetRepository(this.registry);
    this.recovery = new PrivateMessageMediaRecoveryRepository(
      this.lifecycle,
      this.assets,
      (actor, target, tx) => access.assertSendFenced(actor, target, tx),
    );
    this.ingress = runtime
      ? new MediaIngressRepository(runtime.planning, 15)
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
  prepare(token: string, raw: unknown) {
    return this.authorized(token, async (session, tx) => {
      const input = preparePrivateMessageMediaSchema.parse(raw),
        hash = privateMessageMediaRequestHash(session.accountId, input),
        previous = await this.recovery.recover(
          session.accountId,
          input.clientRequestId,
          tx,
        );
      if (previous.state !== 'not_recorded') {
        await this.access.authorizePrepare(session.accountId, input, tx);
        await this.access.retainCurrent(tx);
        if (previous.requestHash !== hash)
          throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
        if (previous.state !== 'recorded')
          throw new ApplicationError('MEDIA_REQUEST_CANCELLED');
        return previous.status;
      }
      if (!this.runtime) throw new ApplicationError('MEDIA_UNAVAILABLE');
      const prepared = await this.intents.prepare(
        await this.scopes.authorizePrivateMessage(session.accountId, input, tx),
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
        await this.scopes.authorizePrivateMessage(
          s.accountId,
          await ingress.originalPrivateMessageInput(s.accountId, intentId, tx),
          tx,
        ),
        this.scopes,
        tx,
      );
    });
    if ('blocked' in result) throw new ApplicationError(result.blocked);
    const { version: _version, ...grant } = result;
    void _version;
    return privateMessageMediaGrantSchema.parse({
      ...grant,
      protocol: PRIVATE_MESSAGE_MEDIA_PROTOCOL,
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
      await this.scopes.authorizePrivateMessage(
        s.accountId,
        await ingress.originalPrivateMessageInput(s.accountId, intentId, tx),
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
        await this.scopes.authorizePrivateMessage(
          s.accountId,
          await ingress.originalPrivateMessageInput(s.accountId, intentId, tx),
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
        await this.scopes.authorizePrivateMessage(
          s.accountId,
          await ingress.originalPrivateMessageInput(
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
    return privateMessageMediaUploadObservedSchema.parse({
      ...observed,
      protocol: PRIVATE_MESSAGE_MEDIA_PROTOCOL,
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
      },
      { isolationLevel: 'read committed' },
    );
  }
  retainCurrent(tx: PoolClient) {
    return new PrivateMessageMediaRequiredProof().capture(tx);
  }
  draftFacts(
    actor: string,
    conversationId: string,
    messageRequestId: string,
    contextDigest: string,
    fact: PrivateMessageMediaFact,
    tx: PoolClient,
    deferProof = false,
  ) {
    return this.assets.draftFacts(
      actor,
      conversationId,
      messageRequestId,
      contextDigest,
      fact,
      tx,
      deferProof,
    );
  }
  acceptAndBind(
    messageId: string,
    actor: string,
    conversationId: string,
    messageRequestId: string,
    contextDigest: string,
    fact: PrivateMessageMediaFact,
    tx: PoolClient,
  ) {
    if (!this.runtime) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return this.assets.acceptAndBind(
      messageId,
      actor,
      conversationId,
      messageRequestId,
      contextDigest,
      fact,
      tx,
    );
  }
  retireMessage(messageId: string, tx: PoolClient) {
    return this.assets.retireMessage(messageId, tx);
  }
  async currentFacts(
    messageId: string,
    image: PrivateMessageMediaBinding,
    tx: PoolClient,
  ) {
    const {
      image: fact,
      safety,
      revision,
    } = await this.assets.currentFacts(messageId, image, tx);
    return { image: fact, safety, revision };
  }
  descriptor(token: string, target: PrivateMessageMediaReadTarget) {
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
  open(
    token: string,
    target: PrivateMessageMediaReadTarget,
    bindingId: string,
    variant: MediaVariantName,
    _connectionKey: string,
    range?: string,
  ) {
    mediaVariantSchema.parse(variant);
    mediaV2IdSchema.parse(bindingId);
    if (!this.delivery) throw new ApplicationError('MEDIA_UNAVAILABLE');
    const holdId = randomUUID();
    let enrolled = false;
    return this.delivery.open(
      async (tx) => {
        const request = await this.resolveRead(
          token,
          { ...target, bindingId },
          tx,
        );
        const plan = await this.assets.plan(
          await this.registry.authorize(token, request, tx),
          request,
          variant,
          tx,
        );
        const digest = createHash('sha256')
          .update(JSON.stringify(plan))
          .digest('hex');
        if (!enrolled) {
          await tx.query(
            `INSERT INTO whaleu_media.private_message_delivery_holds(id,binding_id,account_id,session_id,plan_digest) VALUES($1,$2,$3,$4,$5)`,
            [holdId, plan.bindingId, plan.accountId, plan.sessionId, digest],
          );
          enrolled = true;
        } else if (
          (
            await tx.query(
              `SELECT 1 FROM whaleu_media.private_message_delivery_holds WHERE id=$1 AND binding_id=$2 AND account_id=$3 AND session_id=$4 AND plan_digest=$5 AND closed_at IS NULL FOR SHARE NOWAIT`,
              [holdId, plan.bindingId, plan.accountId, plan.sessionId, digest],
            )
          ).rowCount !== 1
        )
          throw new ApplicationError('MEDIA_UNAVAILABLE');
        return plan;
      },
      (plan) => `account:${plan.accountId}`,
      range,
      async (plan) => {
        await this.database.transaction(
          async (tx) => {
            const digest = createHash('sha256')
              .update(JSON.stringify(plan))
              .digest('hex');
            await tx.query(
              `UPDATE whaleu_media.private_message_delivery_holds SET closed_at=clock_timestamp() WHERE id=$1 AND binding_id=$2 AND plan_digest=$3 AND closed_at IS NULL`,
              [holdId, plan.bindingId, digest],
            );
          },
          { isolationLevel: 'read committed' },
        );
      },
    );
  }
  private async resolveRead(
    token: string,
    target: PrivateMessageMediaReadTarget,
    tx: PoolClient,
  ): Promise<PrivateMessageReadRequest> {
    await lockSafetyPolicy(tx, false);
    const authority = await this.access.authorizeRead(token, target, tx),
      image = privateMessageMediaBindingSchema.parse(authority.image);
    if (
      authority.conversationId !== target.conversationId ||
      authority.messageId !== target.messageId ||
      (target.bindingId !== undefined && target.bindingId !== image.bindingId)
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return {
      reference: privateMessageReferenceSchema.parse({
        conversationId: target.conversationId,
        messageId: target.messageId,
        bindingId: image.bindingId,
      }),
    };
  }
  private async authorizeRead(
    token: string,
    request: PrivateMessageReadRequest,
    tx: PoolClient,
  ) {
    const ref = request.reference,
      authority = await this.access.authorizeRead(token, ref, tx);
    return { ...authority, reference: ref };
  }
  private requireIngress() {
    if (!this.ingress) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return this.ingress;
  }
}
