import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { DatabaseService } from '../../database/database.js';
import type { IdentityService } from '../../identity/identity.service.js';
import { authenticateMediaSession } from '../../identity/current-media-session.js';
import type { CurrentMediaSession } from '../../identity/current-media-session.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { ApplicationError } from '../../http/application-error.js';
import type { SchoolConfigurationAccess } from '../access.js';
import { SchoolConfigurationRepository } from '../repository.js';
import {
  lockSchoolConfigurationEntry,
  requireSchoolCurrent,
} from '../current-proof.js';
import { MediaSchoolQrPrepareScopes } from '../../media/school-qr-prepare-scope.js';
import { MediaIntentRepository } from '../../media/intent-repository.js';
import { MediaIngressRepository } from '../../media/ingress-repository.js';
import { MediaLifecycleRepository } from '../../media/lifecycle-repository.js';
import { SchoolQrMediaRecoveryRepository } from '../../media/school-qr-recovery-repository.js';
import { SchoolQrMediaAssetRepository } from '../../media/school-qr-asset-repository.js';
import type { SchoolQrMutation } from '../../media/school-qr-asset-repository.js';
import { SchoolQrOwnerProofRegistry } from '../../media/school-qr-owner-proof.js';
import type {
  SchoolQrReadAuthority,
  SchoolQrReadRequest,
} from '../../media/school-qr-owner-proof.js';
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
  SCHOOL_QR_MEDIA_PROTOCOL,
  prepareSchoolQrMediaSchema,
  schoolQrMediaRequestHash,
  schoolQrMediaGrantSchema,
  schoolQrMediaUploadObservedSchema,
  schoolQrReferenceSchema,
  schoolQrEntryKeySchema,
} from '../../media/contracts-school-qr.js';
import type {
  SchoolQrReference,
  SchoolQrEntryKey,
} from '../../media/contracts-school-qr.js';
export const SCHOOL_QR_MEDIA_RUNTIME = Symbol('SCHOOL_QR_MEDIA_RUNTIME');
/** Explicit trusted DI only. Production registration supplies null until real
 * immutable storage, ingress, processor and Review adapters are configured. */
export interface SchoolQrMediaRuntime {
  readonly planning: MediaIngressPlanningPort;
  readonly storage: ImmutableMediaStorage;
  readonly ingressStorage: MediaIngressStorage;
}
export class SchoolQrMediaService {
  readonly repository = new SchoolConfigurationRepository();
  readonly scopes: MediaSchoolQrPrepareScopes;
  readonly intents: MediaIntentRepository;
  readonly lifecycle = new MediaLifecycleRepository();
  readonly assets: SchoolQrMediaAssetRepository;
  readonly registry: SchoolQrOwnerProofRegistry;
  readonly recovery: SchoolQrMediaRecoveryRepository;
  readonly ingress: MediaIngressRepository | null;
  readonly delivery: ExactMediaDeliveryService | null;
  constructor(
    readonly database: DatabaseService,
    readonly identity: IdentityService,
    readonly access: SchoolConfigurationAccess,
    readonly runtime: SchoolQrMediaRuntime | null,
    budget: MediaDeliveryBudgetPool,
  ) {
    this.scopes = new MediaSchoolQrPrepareScopes({
      authorizePrepare: async (actor, input, tx) => {
        const authority = await access.authorizeAccount(
          actor,
          input.regionId,
          tx,
        );
        await lockSchoolConfigurationEntry(input.regionId, input.entryKey, tx);
        const entry = await this.repository.entry(
          input.regionId,
          input.entryKey,
          tx,
        );
        if (Number(entry?.revision ?? 0) !== input.expectedRevision)
          throw new ApplicationError('SCHOOL_CONFIGURATION_REVISION_CONFLICT');
        const hash = schoolQrMediaRequestHash(actor, input);
        let row = (
          await tx.query<{
            id: string;
            scope_revision: string;
            expires_at: Date;
          }>(
            `SELECT id,scope_revision,expires_at FROM whaleu_school_configuration.qr_upload_scopes WHERE actor_id=$1 AND client_request_id=$2`,
            [actor, input.clientRequestId],
          )
        ).rows[0];
        if (row && row.scope_revision !== hash)
          throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
        if (!row)
          row = (
            await tx.query<{
              id: string;
              scope_revision: string;
              expires_at: Date;
            }>(
              `INSERT INTO whaleu_school_configuration.qr_upload_scopes(id,actor_id,client_request_id,region_id,entry_key,expected_revision,scope_revision,input,grant_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING id,scope_revision,expires_at`,
              [
                randomUUID(),
                actor,
                input.clientRequestId,
                input.regionId,
                input.entryKey,
                input.expectedRevision,
                hash,
                JSON.stringify(input),
                authority.grant.id,
              ],
            )
          ).rows[0];
        if (!row) throw new ApplicationError('MEDIA_UNAVAILABLE');
        await requireSchoolCurrent(
          { campusId: null, regionId: input.regionId, key: input.entryKey },
          tx,
        );
        return {
          actorAccountId: actor,
          serverScopeId: row.id,
          scopeRevision: row.scope_revision,
          expiresAt: row.expires_at.getTime(),
          ownerKind: 'school_configuration',
          resourceKind: 'entry_qr',
          targetKind: 'edit',
          contentVersion: 1,
          audience: 'school-config-gated',
          purpose: 'school-configuration-qr-image',
          slot: 'qr',
          ordinal: 0,
        };
      },
    });
    this.intents = new MediaIntentRepository(this.scopes);
    this.registry = new SchoolQrOwnerProofRegistry({
      authorizeCurrent: (credential, request, tx) =>
        this.authorizeRead(credential, request, tx),
    });
    this.assets = new SchoolQrMediaAssetRepository(this.registry);
    this.recovery = new SchoolQrMediaRecoveryRepository(
      this.lifecycle,
      this.assets,
    );
    this.ingress = runtime
      ? new MediaIngressRepository(runtime.planning, 9)
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
      const input = prepareSchoolQrMediaSchema.parse(raw),
        hash = schoolQrMediaRequestHash(session.accountId, input),
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
        await this.scopes.authorizeSchoolQr(session.accountId, input, tx),
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
        await this.scopes.authorizeSchoolQr(
          s.accountId,
          await ingress.originalSchoolQrInput(s.accountId, intentId, tx),
          tx,
        ),
        this.scopes,
        tx,
      );
    });
    if ('blocked' in result) throw new ApplicationError(result.blocked);
    const { version: _version, ...grant } = result;
    void _version;
    return schoolQrMediaGrantSchema.parse({
      ...grant,
      protocol: SCHOOL_QR_MEDIA_PROTOCOL,
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
      await this.scopes.authorizeSchoolQr(
        s.accountId,
        await ingress.originalSchoolQrInput(s.accountId, intentId, tx),
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
        await this.scopes.authorizeSchoolQr(
          s.accountId,
          await ingress.originalSchoolQrInput(s.accountId, intentId, tx),
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
        await this.scopes.authorizeSchoolQr(
          s.accountId,
          await ingress.originalSchoolQrInput(s.accountId, claim.intentId, tx),
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
    return schoolQrMediaUploadObservedSchema.parse({
      ...observed,
      protocol: SCHOOL_QR_MEDIA_PROTOCOL,
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
  async mutate(
    input: SchoolQrMutation,
    tx: PoolClient,
  ): Promise<string | null> {
    await this.access.authorizeAccount(
      input.actorAccountId,
      input.regionId,
      tx,
    );
    await lockSchoolConfigurationEntry(input.regionId, input.entryKey, tx);
    const current = await this.repository.entry(
      input.regionId,
      input.entryKey,
      tx,
      true,
    );
    if (
      Number(current?.revision ?? 0) !== input.expectedRevision ||
      (current?.qr_binding_id ?? null) !== input.currentBindingId
    )
      throw new ApplicationError('SCHOOL_CONFIGURATION_REVISION_CONFLICT');
    if (input.action === 'replace' && !this.runtime)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return this.assets.mutate(input, tx);
  }
  async describePublic(
    token: string | null,
    campusId: string,
    reference: SchoolQrReference,
    tx: PoolClient,
  ) {
    const request: SchoolQrReadRequest = {
      reference: schoolQrReferenceSchema.parse(reference),
      audience: 'public',
      campusId,
      requestId: randomUUID(),
    };
    return this.describe(token, request, tx);
  }
  async describeManagement(
    token: string,
    reference: SchoolQrReference,
    tx: PoolClient,
  ) {
    const request: SchoolQrReadRequest = {
      reference: schoolQrReferenceSchema.parse(reference),
      audience: 'management',
      campusId: null,
      requestId: randomUUID(),
    };
    return this.describe(token, request, tx);
  }
  async descriptor(
    token: string | null,
    target: { campusId: string } | { regionId: string },
    entryKey: SchoolQrEntryKey,
    revision: number,
  ) {
    return this.database.transaction(
      async (tx) => {
        const request = await this.resolveRead(
          token,
          target,
          entryKey,
          revision,
          null,
          randomUUID(),
          tx,
        );
        return this.describe(token, request, tx);
      },
      { isolationLevel: 'read committed' },
    );
  }
  open(
    token: string | null,
    target: { campusId: string } | { regionId: string },
    entryKey: SchoolQrEntryKey,
    revision: number,
    bindingId: string,
    variant: MediaVariantName,
    connectionKey: string,
    range?: string,
  ) {
    const requestId = randomUUID();
    mediaVariantSchema.parse(variant);
    mediaV2IdSchema.parse(bindingId);
    if (!this.delivery) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return this.delivery.open(
      async (tx) => {
        const request = await this.resolveRead(
          token,
          target,
          entryKey,
          revision,
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
      (plan) =>
        plan.principal.kind === 'authenticated-school-management' ||
        plan.principal.accountId !== null
          ? `account:${plan.principal.accountId}`
          : `school-public-connection:${connectionKey}`,
      range,
    );
  }
  private async describe(
    token: string | null,
    request: SchoolQrReadRequest,
    tx: PoolClient,
  ) {
    const proof = await this.registry.authorize(token, request, tx);
    if (!this.runtime) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return this.assets.describe(proof, request, tx);
  }
  private async resolveRead(
    token: string | null,
    target: { campusId: string } | { regionId: string },
    entryKey: SchoolQrEntryKey,
    revision: number,
    bindingId: string | null,
    requestId: string,
    tx: PoolClient,
  ): Promise<SchoolQrReadRequest> {
    schoolQrEntryKeySchema.parse(entryKey);
    let regionId: string;
    if ('campusId' in target) {
      if (entryKey === 'review')
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      const scope = await this.access.browse(
        token,
        mediaV2IdSchema.parse(target.campusId),
        tx,
      );
      if (!scope.region) throw new ApplicationError('MEDIA_UNAVAILABLE');
      regionId = scope.region.id;
    } else {
      if (token === null) throw new ApplicationError('MEDIA_UNAVAILABLE');
      regionId = (
        await this.access.management(
          token,
          mediaV2IdSchema.parse(target.regionId),
          tx,
        )
      ).region.id;
    }
    await lockSchoolConfigurationEntry(regionId, entryKey, tx, false);
    const row = await this.repository.entry(regionId, entryKey, tx);
    if (
      !row ||
      !row.data.enabled ||
      Number(row.revision) !== revision ||
      !row.qr_binding_id ||
      (bindingId !== null && bindingId !== row.qr_binding_id)
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return {
      reference: schoolQrReferenceSchema.parse({
        regionId,
        entryKey,
        entryRevision: revision,
        bindingId: row.qr_binding_id,
      }),
      audience: 'campusId' in target ? 'public' : 'management',
      campusId: 'campusId' in target ? target.campusId : null,
      requestId,
    };
  }
  private async authorizeRead(
    token: string | null,
    request: SchoolQrReadRequest,
    tx: PoolClient,
  ): Promise<SchoolQrReadAuthority> {
    const ref = request.reference;
    let principal: SchoolQrReadAuthority['principal'];
    if (request.audience === 'public') {
      if (ref.entryKey === 'review' || !request.campusId)
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      const scope = await this.access.browse(token, request.campusId, tx);
      if (scope.region?.id !== ref.regionId)
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      principal = {
        kind: 'school-public',
        campusId: request.campusId,
        requestId: request.requestId,
        accountId: scope.session?.accountId ?? null,
      };
    } else {
      if (token === null) throw new ApplicationError('MEDIA_UNAVAILABLE');
      const scope = await this.access.management(token, ref.regionId, tx);
      principal = {
        kind: 'authenticated-school-management',
        accountId: scope.session.accountId,
        sessionId: scope.session.sessionId,
      };
    }
    await lockSchoolConfigurationEntry(ref.regionId, ref.entryKey, tx, false);
    const row = await this.repository.entry(ref.regionId, ref.entryKey, tx);
    if (
      !row ||
      !row.data.enabled ||
      Number(row.revision) !== ref.entryRevision ||
      row.qr_binding_id !== ref.bindingId
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const appearance = (
      await tx.query<{ id: string; asset_id: string; manifest_digest: string }>(
        `SELECT id,asset_id,manifest_digest FROM whaleu_school_configuration.qr_appearances WHERE binding_id=$1 AND region_id=$2 AND entry_key=$3`,
        [ref.bindingId, ref.regionId, ref.entryKey],
      )
    ).rows[0];
    if (!appearance) throw new ApplicationError('MEDIA_UNAVAILABLE');
    await requireSchoolCurrent(
      { campusId: request.campusId, regionId: ref.regionId, key: ref.entryKey },
      tx,
    );
    return {
      principal,
      reference: ref,
      appearanceId: appearance.id,
      assetId: appearance.asset_id,
      manifestDigest: appearance.manifest_digest,
      ownerRevision: row.publication_hash,
    };
  }
  private requireIngress() {
    if (!this.ingress) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return this.ingress;
  }
}
