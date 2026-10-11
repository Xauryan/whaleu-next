import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { DatabaseService } from '../../database/database.js';
import type { IdentityService } from '../../identity/identity.service.js';
import { authenticateMediaSession } from '../../identity/current-media-session.js';
import type { CurrentMediaSession } from '../../identity/current-media-session.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { ApplicationError } from '../../http/application-error.js';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';
import type {
  VerificationEvidenceAccessPort,
  VerificationEvidenceReadTarget,
} from './access-port.js';
import { MediaVerificationEvidencePrepareScopes } from '../../media/verification-evidence-prepare-scope.js';
import { MediaIntentRepository } from '../../media/intent-repository.js';
import { MediaIngressRepository } from '../../media/ingress-repository.js';
import { MediaLifecycleRepository } from '../../media/lifecycle-repository.js';
import { VerificationEvidenceMediaRecoveryRepository } from '../../media/verification-evidence-recovery-repository.js';
import {
  VerificationEvidenceAssetRepository,
  VERIFICATION_EVIDENCE_RETIREMENT_BATCH_LIMIT,
} from '../../media/verification-evidence-asset-repository.js';
import type { VerificationEvidenceRetirement } from '../../media/verification-evidence-asset-repository.js';
import { VerificationEvidenceOwnerProofRegistry } from '../../media/verification-evidence-owner-proof.js';
import type {
  VerificationEvidenceReadAuthority,
  VerificationEvidenceReadRequest,
} from '../../media/verification-evidence-owner-proof.js';
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
  prepareVerificationEvidenceMediaSchema,
  verificationEvidenceMediaRequestHash,
  verificationEvidenceMediaGrantSchema,
  verificationEvidenceMediaUploadObservedSchema,
  verificationEvidenceReferenceSchema,
  verificationEvidenceUploadDescriptorSchema,
  VERIFICATION_EVIDENCE_MEDIA_PROTOCOL,
} from '../../media/contracts-verification-evidence.js';
export const VERIFICATION_EVIDENCE_MEDIA_RUNTIME = Symbol(
  'VERIFICATION_EVIDENCE_MEDIA_RUNTIME',
);
export interface VerificationEvidenceRetentionPolicy {
  readonly policyRef: string;
  readonly evidenceTtlSeconds: number;
  readonly cleanupEnabled: boolean;
}
/** Explicit DI only. There is no environment/default production retention. The
 * processor/Review worker uses the existing isolated static re-encoding path. */
export interface VerificationEvidenceMediaRuntime {
  readonly planning: MediaIngressPlanningPort;
  readonly storage: ImmutableMediaStorage;
  readonly ingressStorage: MediaIngressStorage;
  readonly retention: VerificationEvidenceRetentionPolicy;
}
export function verificationEvidenceRetention(
  raw: VerificationEvidenceRetentionPolicy,
): VerificationEvidenceRetentionPolicy {
  if (
    !raw ||
    !/^[A-Za-z0-9._:-]{1,200}$/.test(raw.policyRef) ||
    !Number.isSafeInteger(raw.evidenceTtlSeconds) ||
    raw.evidenceTtlSeconds < 1 ||
    raw.evidenceTtlSeconds > 31_536_000 ||
    typeof raw.cleanupEnabled !== 'boolean'
  )
    throw new ApplicationError('MEDIA_UNAVAILABLE');
  return Object.freeze({ ...raw });
}
interface ScopeRow {
  id: string;
  scope_revision: string;
  expires_at: Date;
  authority_version: string;
  evidence_expires_at: Date;
  evidence_policy_ref: string;
}
export class VerificationEvidenceMediaService {
  readonly scopes: MediaVerificationEvidencePrepareScopes;
  readonly intents: MediaIntentRepository;
  readonly lifecycle = new MediaLifecycleRepository();
  readonly assets: VerificationEvidenceAssetRepository;
  readonly registry: VerificationEvidenceOwnerProofRegistry;
  readonly recovery: VerificationEvidenceMediaRecoveryRepository;
  readonly ingress: MediaIngressRepository | null;
  readonly delivery: ExactMediaDeliveryService | null;
  readonly retention: VerificationEvidenceRetentionPolicy | null;
  constructor(
    readonly database: DatabaseService,
    readonly identity: IdentityService,
    readonly access: VerificationEvidenceAccessPort,
    readonly runtime: VerificationEvidenceMediaRuntime | null,
    budget: MediaDeliveryBudgetPool,
  ) {
    this.retention = runtime
      ? verificationEvidenceRetention(runtime.retention)
      : null;
    this.scopes = new MediaVerificationEvidencePrepareScopes({
      authorizePrepare: async (actor, input, tx) => {
        if (!this.retention) throw new ApplicationError('MEDIA_UNAVAILABLE');
        const authority = await access.authorizePrepare(
          actor,
          input.applicationId,
          input.revision,
          tx,
        );
        if (
          authority.actorAccountId !== actor ||
          authority.applicationId !== input.applicationId ||
          authority.revision !== input.revision
        )
          throw new ApplicationError('MEDIA_UNAVAILABLE');
        const hash = verificationEvidenceMediaRequestHash(actor, input);
        let row = (
          await tx.query<ScopeRow>(
            'SELECT * FROM whaleu_media.verification_evidence_scopes WHERE actor_id=$1 AND client_request_id=$2 FOR SHARE NOWAIT',
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
            await tx.query<ScopeRow>(
              `INSERT INTO whaleu_media.verification_evidence_scopes(id,actor_id,client_request_id,application_id,revision,scope_revision,input,authority_version,evidence_expires_at,evidence_policy_ref,cleanup_enabled,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,statement_timestamp()+$9*interval '1 second',$10,$11,statement_timestamp()+least($9,1800)*interval '1 second') RETURNING *`,
              [
                randomUUID(),
                actor,
                input.clientRequestId,
                input.applicationId,
                input.revision,
                hash,
                JSON.stringify(input),
                authority.authorityVersion,
                this.retention.evidenceTtlSeconds,
                this.retention.policyRef,
                this.retention.cleanupEnabled,
              ],
            )
          ).rows[0];
        if (!row) throw new ApplicationError('MEDIA_UNAVAILABLE');
        registerTransactionDeadline(
          tx,
          row.evidence_expires_at.getTime(),
          'MEDIA_UNAVAILABLE',
        );
        await access.retainCurrent(input.applicationId, tx);
        return {
          actorAccountId: actor,
          serverScopeId: row.id,
          scopeRevision: row.scope_revision,
          expiresAt: row.expires_at.getTime(),
          ownerKind: 'verification',
          resourceKind: 'student_evidence',
          targetKind: 'edit',
          contentVersion: 1,
          audience: 'verification-private',
          purpose: 'verification-evidence-image',
          slot: 'evidence',
          ordinal: 0,
        };
      },
    });
    this.intents = new MediaIntentRepository(this.scopes);
    this.registry = new VerificationEvidenceOwnerProofRegistry({
      authorizeCurrent: (credential, request, tx) =>
        this.authorizeRead(credential, request, tx),
    });
    this.assets = new VerificationEvidenceAssetRepository(this.registry);
    this.recovery = new VerificationEvidenceMediaRecoveryRepository(
      this.lifecycle,
      this.assets,
    );
    this.ingress = runtime
      ? new MediaIngressRepository(runtime.planning, 13)
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
      const input = prepareVerificationEvidenceMediaSchema.parse(raw),
        hash = verificationEvidenceMediaRequestHash(session.accountId, input),
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
        await this.scopes.authorizeVerificationEvidence(
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
        await this.scopes.authorizeVerificationEvidence(
          s.accountId,
          await ingress.originalVerificationEvidenceInput(
            s.accountId,
            intentId,
            tx,
          ),
          tx,
        ),
        this.scopes,
        tx,
      );
    });
    if ('blocked' in result) throw new ApplicationError(result.blocked);
    const { version: _version, ...grant } = result;
    void _version;
    return verificationEvidenceMediaGrantSchema.parse({
      ...grant,
      protocol: VERIFICATION_EVIDENCE_MEDIA_PROTOCOL,
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
      await this.scopes.authorizeVerificationEvidence(
        s.accountId,
        await ingress.originalVerificationEvidenceInput(
          s.accountId,
          intentId,
          tx,
        ),
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
        await this.scopes.authorizeVerificationEvidence(
          s.accountId,
          await ingress.originalVerificationEvidenceInput(
            s.accountId,
            intentId,
            tx,
          ),
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
        await this.scopes.authorizeVerificationEvidence(
          s.accountId,
          await ingress.originalVerificationEvidenceInput(
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
    return verificationEvidenceMediaUploadObservedSchema.parse({
      ...observed,
      protocol: VERIFICATION_EVIDENCE_MEDIA_PROTOCOL,
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
  /** Caller owns the application CAS and its final owner proof. This does not
   * capture the pre-submit application fingerprint. Deferred SQL binds both ends. */
  async acceptAndBind(
    actor: string,
    applicationId: string,
    expectedRevision: number,
    raw: unknown,
    tx: PoolClient,
  ) {
    if (!this.runtime) throw new ApplicationError('MEDIA_UNAVAILABLE');
    const descriptor = verificationEvidenceUploadDescriptorSchema.parse(raw);
    const authority = await this.access.authorizePrepare(
      actor,
      applicationId,
      expectedRevision,
      tx,
    );
    if (
      authority.actorAccountId !== actor ||
      authority.applicationId !== applicationId ||
      authority.revision !== expectedRevision
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return this.assets.acceptAndBind(
      actor,
      applicationId,
      expectedRevision,
      descriptor.assetId,
      authority.authorityVersion,
      tx,
    );
  }
  evidenceCurrent(
    application: {
      id: string;
      evidence_revision: number | string | null;
      evidence_id: string | null;
    },
    tx: PoolClient,
  ) {
    if (
      !this.runtime ||
      !application.evidence_id ||
      !application.evidence_revision
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return this.assets.requireCurrentBinding(
      application.id,
      Number(application.evidence_revision),
      application.evidence_id,
      tx,
    );
  }
  /** Metadata-only soft retirement. Does not invoke deleteExact or erase records.
   * Immutable per-evidence cleanup policy controls enrollment, not later config. */
  async retireEvidence(
    applicationId: string,
    bindingId: string,
    tx: PoolClient,
  ) {
    return this.retireEvidenceBatch([{ applicationId, bindingId }], tx);
  }
  async retireEvidenceBatch(
    references: readonly VerificationEvidenceRetirement[],
    tx: PoolClient,
  ): Promise<void> {
    if (
      !Array.isArray(references) ||
      references.length > VERIFICATION_EVIDENCE_RETIREMENT_BATCH_LIMIT ||
      new Set(references.map((item) => item.bindingId)).size !==
        references.length
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const items = references.map(({ applicationId, bindingId }) => ({
      applicationId,
      bindingId,
    }));
    const eligible: VerificationEvidenceRetirement[] = [];
    for (const item of items) {
      const row = (
        await tx.query<{ cleanup_enabled: boolean }>(
          `SELECT s.cleanup_enabled AND b.evidence_expires_at<=clock_timestamp() AS cleanup_enabled FROM whaleu_media.verification_evidence_bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id JOIN whaleu_media.verification_evidence_scopes s ON s.id=a.resource_id WHERE b.application_id=$1 AND b.binding_id=$2`,
          [item.applicationId, item.bindingId],
        )
      ).rows[0];
      if (!row) throw new ApplicationError('MEDIA_UNAVAILABLE');
      if (row.cleanup_enabled) eligible.push(item);
    }
    // The repository enrolls one exact final Media epoch after every retirement.
    await this.assets.retireEvidenceBatch(eligible, tx);
  }
  async descriptorForApplication(
    application: {
      id: string;
      evidence_revision: number | string | null;
      evidence_id: string | null;
    },
    tx: PoolClient,
  ) {
    if (
      !application.evidence_id ||
      !application.evidence_revision ||
      !this.runtime
    )
      return null;
    const available = (
      await tx.query(
        `SELECT 1 FROM whaleu_media.verification_evidence_bindings e JOIN whaleu_media.bindings b ON b.id=e.binding_id WHERE e.binding_id=$1 AND e.application_id=$2 AND e.revision=$3 AND e.evidence_expires_at>clock_timestamp() AND b.detached_at IS NULL`,
        [
          application.evidence_id,
          application.id,
          application.evidence_revision,
        ],
      )
    ).rowCount;
    if (!available) return null;
    return (await this.evidenceCurrent(application, tx)).descriptor;
  }
  async cleanupExpired(limit = 20): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return this.database
      .transaction(
        async (tx) => {
          await lockSafetyPolicy(tx, true);
          const rows = (
            await tx.query<{ application_id: string; binding_id: string }>(
              `SELECT e.application_id,e.binding_id FROM whaleu_media.verification_evidence_bindings e JOIN whaleu_media.bindings b ON b.id=e.binding_id JOIN whaleu_media.assets a ON a.id=e.asset_id JOIN whaleu_media.verification_evidence_scopes s ON s.id=a.resource_id WHERE e.evidence_expires_at<=clock_timestamp() AND b.detached_at IS NULL AND s.cleanup_enabled ORDER BY e.binding_id LIMIT $1`,
              [limit],
            )
          ).rows;
          // One transaction per binding keeps append-only Media proof epochs exact.
          return rows;
        },
        { isolationLevel: 'read committed' },
      )
      .then(async (rows) => {
        for (const row of rows)
          await this.database.transaction(
            async (tx) => {
              await lockSafetyPolicy(tx, true);
              await this.retireEvidence(row.application_id, row.binding_id, tx);
            },
            { isolationLevel: 'read committed' },
          );
        return rows.length;
      });
  }
  descriptor(token: string, target: VerificationEvidenceReadTarget) {
    return this.database.transaction(
      async (tx) => {
        const request = await this.resolveRead(
          token,
          target,
          null,
          randomUUID(),
          tx,
        );
        if (!this.runtime) throw new ApplicationError('MEDIA_UNAVAILABLE');
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
    target: VerificationEvidenceReadTarget,
    bindingId: string,
    variant: MediaVariantName,
    range?: string,
  ) {
    mediaVariantSchema.parse(variant);
    mediaV2IdSchema.parse(bindingId);
    if (!this.delivery) throw new ApplicationError('MEDIA_UNAVAILABLE');
    const requestId = randomUUID();
    return this.delivery.open(
      async (tx) => {
        const request = await this.resolveRead(
          token,
          target,
          bindingId,
          requestId,
          tx,
        );
        return this.assets.plan(
          await this.registry.authorize(token, request, tx),
          request,
          variant,
          tx,
        );
      },
      (plan) => `account:${plan.principal.accountId}`,
      range,
    );
  }
  private async resolveRead(
    token: string,
    target: VerificationEvidenceReadTarget,
    bindingId: string | null,
    requestId: string,
    tx: PoolClient,
  ): Promise<VerificationEvidenceReadRequest> {
    await this.access.authorizeRead(token, target, tx);
    const row = (
      await tx.query<{
        evidence_id: string | null;
        evidence_revision: string | null;
      }>(
        'SELECT evidence_id,evidence_revision FROM whaleu_verification.student_applications WHERE id=$1',
        [target.applicationId],
      )
    ).rows[0];
    if (
      !row?.evidence_id ||
      Number(row.evidence_revision) !== target.revision ||
      (bindingId !== null && row.evidence_id !== bindingId)
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return {
      reference: verificationEvidenceReferenceSchema.parse({
        applicationId: target.applicationId,
        revision: target.revision,
        bindingId: row.evidence_id,
      }),
      reviewRegionId: target.reviewRegionId,
      requestId,
    };
  }
  private async authorizeRead(
    token: string,
    request: VerificationEvidenceReadRequest,
    tx: PoolClient,
  ): Promise<VerificationEvidenceReadAuthority> {
    const ref = request.reference;
    const authority = await this.access.authorizeRead(
      token,
      {
        applicationId: ref.applicationId,
        revision: ref.revision,
        reviewRegionId: request.reviewRegionId,
      },
      tx,
    );
    const row = (
      await tx.query<{
        asset_id: string;
        manifest_digest: string;
        evidence_expires_at: Date;
        evidence_policy_ref: string;
      }>(
        `SELECT b.asset_id,b.manifest_digest,b.evidence_expires_at,b.evidence_policy_ref FROM whaleu_media.verification_evidence_bindings b JOIN whaleu_verification.student_applications a ON a.id=b.application_id AND a.evidence_id=b.binding_id AND a.evidence_revision=b.revision WHERE b.binding_id=$1 AND b.application_id=$2 AND b.revision=$3 AND b.actor_id=$4`,
        [
          ref.bindingId,
          ref.applicationId,
          ref.revision,
          authority.actorAccountId,
        ],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return {
      principal: {
        accountId: authority.accountId,
        sessionId: authority.sessionId,
      },
      actorAccountId: authority.actorAccountId,
      reference: ref,
      assetId: row.asset_id,
      manifestDigest: row.manifest_digest,
      expiresAt: row.evidence_expires_at.getTime(),
      policyRef: row.evidence_policy_ref,
      ownerRevision: createHash('sha256')
        .update(
          JSON.stringify({
            authorityVersion: authority.authorityVersion,
            reference: ref,
            reviewRegionId: request.reviewRegionId,
          }),
        )
        .digest('hex'),
    };
  }
  private requireIngress() {
    if (!this.ingress) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return this.ingress;
  }
}
