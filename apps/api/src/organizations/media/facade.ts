import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { DatabaseService } from '../../database/database.js';
import type { IdentityService } from '../../identity/identity.service.js';
import { authenticateMediaSession } from '../../identity/current-media-session.js';
import type { CurrentMediaSession } from '../../identity/current-media-session.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { ApplicationError } from '../../http/application-error.js';
import type {
  OrganizationMediaAccessPort,
  OrganizationMediaReadTarget,
} from './access-port.js';
import type { OrganizationMediaMutation } from './contracts.js';
import {
  organizationMediaBindingsSchema,
  organizationMediaChangesSchema,
} from './contracts.js';
import { MediaOrganizationPrepareScopes } from '../../media/organization-prepare-scope.js';
import { MediaIntentRepository } from '../../media/intent-repository.js';
import { MediaIngressRepository } from '../../media/ingress-repository.js';
import { MediaLifecycleRepository } from '../../media/lifecycle-repository.js';
import { OrganizationMediaRecoveryRepository } from '../../media/organization-recovery-repository.js';
import { OrganizationMediaAssetRepository } from '../../media/organization-asset-repository.js';
import { OrganizationOwnerProofRegistry } from '../../media/organization-owner-proof.js';
import type {
  OrganizationReadAuthority,
  OrganizationReadRequest,
} from '../../media/organization-owner-proof.js';
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
  ORGANIZATION_MEDIA_PROTOCOL,
  prepareOrganizationMediaSchema,
  organizationMediaRequestHash,
  organizationMediaGrantSchema,
  organizationMediaUploadObservedSchema,
  organizationReferenceSchema,
  organizationMediaSlotSchema,
} from '../../media/contracts-organization.js';
import type {
  OrganizationReference,
  OrganizationMediaSlot,
} from '../../media/contracts-organization.js';
export const ORGANIZATION_MEDIA_RUNTIME = Symbol('ORGANIZATION_MEDIA_RUNTIME');
/** Explicit trusted DI only. Production registration supplies null until real
 * immutable storage, ingress, processor and Review adapters are configured. */
export interface OrganizationMediaRuntime {
  readonly planning: MediaIngressPlanningPort;
  readonly storage: ImmutableMediaStorage;
  readonly ingressStorage: MediaIngressStorage;
}
export class OrganizationMediaService {
  readonly scopes: MediaOrganizationPrepareScopes;
  readonly intents: MediaIntentRepository;
  readonly lifecycle = new MediaLifecycleRepository();
  readonly assets: OrganizationMediaAssetRepository;
  readonly registry: OrganizationOwnerProofRegistry;
  readonly recovery: OrganizationMediaRecoveryRepository;
  readonly ingress: MediaIngressRepository | null;
  readonly delivery: ExactMediaDeliveryService | null;
  constructor(
    readonly database: DatabaseService,
    readonly identity: IdentityService,
    readonly access: OrganizationMediaAccessPort,
    readonly runtime: OrganizationMediaRuntime | null,
    budget: MediaDeliveryBudgetPool,
  ) {
    this.scopes = new MediaOrganizationPrepareScopes({
      authorizePrepare: async (actor, input, tx) => {
        const authority = await access.authorizeMediaActor(
          actor,
          input.organizationId,
          input.applicationRevision,
          tx,
        );
        if (
          authority.actorAccountId !== actor ||
          authority.organizationId !== input.organizationId ||
          authority.applicationRevision !== input.applicationRevision
        )
          throw new ApplicationError('MEDIA_UNAVAILABLE');
        this.requireSlot(authority.organizationPlatform, input.slot);
        const hash = organizationMediaRequestHash(actor, input);
        let row = (
          await tx.query<{
            id: string;
            scope_revision: string;
            expires_at: Date;
            authority_version: string;
            authority_role: string;
            grant_id: string | null;
          }>(
            `SELECT * FROM whaleu_organizations.media_upload_scopes WHERE actor_id=$1 AND client_request_id=$2`,
            [actor, input.clientRequestId],
          )
        ).rows[0];
        if (
          row &&
          (row.scope_revision !== hash ||
            row.authority_version !== authority.authorityVersion ||
            row.authority_role !== authority.role ||
            row.grant_id !== authority.grantId)
        )
          throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
        if (!row)
          row = (
            await tx.query<{
              id: string;
              scope_revision: string;
              expires_at: Date;
              authority_version: string;
              authority_role: string;
              grant_id: string | null;
            }>(
              `INSERT INTO whaleu_organizations.media_upload_scopes(id,actor_id,client_request_id,organization_id,slot,application_revision,scope_revision,input,authority_version,authority_role,grant_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11) RETURNING *`,
              [
                randomUUID(),
                actor,
                input.clientRequestId,
                input.organizationId,
                input.slot,
                input.applicationRevision,
                hash,
                JSON.stringify(input),
                authority.authorityVersion,
                authority.role,
                authority.grantId,
              ],
            )
          ).rows[0];
        if (!row) throw new ApplicationError('MEDIA_UNAVAILABLE');
        await access.retainMediaCurrent(input.organizationId, tx);
        return {
          actorAccountId: actor,
          serverScopeId: row.id,
          scopeRevision: row.scope_revision,
          expiresAt: row.expires_at.getTime(),
          ownerKind: 'organizations',
          resourceKind: 'organization_image',
          targetKind: 'edit',
          contentVersion: 1,
          audience: 'organization-gated',
          purpose: 'organization-image',
          slot: input.slot,
          ordinal: 0,
        };
      },
    });
    this.intents = new MediaIntentRepository(this.scopes);
    this.registry = new OrganizationOwnerProofRegistry({
      authorizeCurrent: (credential, request, tx) =>
        this.authorizeRead(credential, request, tx),
    });
    this.assets = new OrganizationMediaAssetRepository(this.registry);
    this.recovery = new OrganizationMediaRecoveryRepository(
      this.lifecycle,
      this.assets,
    );
    this.ingress = runtime
      ? new MediaIngressRepository(runtime.planning, 10)
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
      const input = prepareOrganizationMediaSchema.parse(raw),
        hash = organizationMediaRequestHash(session.accountId, input),
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
        await this.scopes.authorizeOrganization(session.accountId, input, tx),
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
        await this.scopes.authorizeOrganization(
          s.accountId,
          await ingress.originalOrganizationInput(s.accountId, intentId, tx),
          tx,
        ),
        this.scopes,
        tx,
      );
    });
    if ('blocked' in result) throw new ApplicationError(result.blocked);
    const { version: _version, ...grant } = result;
    void _version;
    return organizationMediaGrantSchema.parse({
      ...grant,
      protocol: ORGANIZATION_MEDIA_PROTOCOL,
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
      await this.scopes.authorizeOrganization(
        s.accountId,
        await ingress.originalOrganizationInput(s.accountId, intentId, tx),
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
        await this.scopes.authorizeOrganization(
          s.accountId,
          await ingress.originalOrganizationInput(s.accountId, intentId, tx),
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
        await this.scopes.authorizeOrganization(
          s.accountId,
          await ingress.originalOrganizationInput(
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
    return organizationMediaUploadObservedSchema.parse({
      ...observed,
      protocol: ORGANIZATION_MEDIA_PROTOCOL,
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
  /** Invoked under the Organizations writer transaction. It must publish revision
   * +1 and the returned complete pointer set atomically; SQL enforces both ends. */
  async mutate(input: OrganizationMediaMutation, tx: PoolClient) {
    const authority = await this.access.authorizeMediaActor(
      input.actorAccountId,
      input.organizationId,
      input.applicationRevision,
      tx,
    );
    const current = organizationMediaBindingsSchema.parse(
        input.currentBindings,
      ),
      changes = organizationMediaChangesSchema.parse(input.changes);
    const row = (
      await tx.query<{ revision: string; media_bindings: unknown }>(
        `SELECT revision,media_bindings FROM whaleu_organizations.organizations WHERE id=$1 FOR UPDATE NOWAIT`,
        [input.organizationId],
      )
    ).rows[0];
    if (!row || Number(row.revision) !== input.applicationRevision)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const persisted = organizationMediaBindingsSchema.parse(row.media_bindings);
    for (const slot of organizationMediaSlotSchema.options)
      if ((current[slot] ?? null) !== (persisted[slot] ?? null))
        throw new ApplicationError('MEDIA_UNAVAILABLE');
    const mutations = organizationMediaSlotSchema.options.map((slot) => {
      const change = changes[slot] ?? { action: 'keep' as const };
      if (change.action === 'replace' && !this.runtime)
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      if (
        change.action === 'replace' ||
        (change.action === 'keep' && current[slot])
      )
        this.requireSlot(authority.organizationPlatform, slot);
      return {
        actorAccountId: input.actorAccountId,
        organizationId: input.organizationId,
        applicationRevision: input.applicationRevision,
        slot,
        currentBindingId: current[slot] ?? null,
        authorityVersion: authority.authorityVersion,
        ...change,
      };
    });
    return organizationMediaBindingsSchema.parse(
      await this.assets.mutateMany(mutations, tx),
    );
  }
  /** Revalidates all slots before application submission/business approval. This
   * is the existing independent Safety image decision, never business approval. */
  async requireCurrentBindings(
    organizationId: string,
    raw: unknown,
    tx: PoolClient,
  ) {
    const bindings = organizationMediaBindingsSchema.parse(raw);
    for (const slot of organizationMediaSlotSchema.options)
      if (bindings[slot])
        await this.assets.requireCurrentBinding(
          organizationId,
          slot,
          bindings[slot],
          tx,
        );
  }
  descriptor(token: string, target: OrganizationMediaReadTarget) {
    return this.database.transaction(
      async (tx) => {
        const request = await this.resolveRead(
          token,
          target,
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
    token: string,
    target: OrganizationMediaReadTarget,
    bindingId: string,
    variant: MediaVariantName,
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
  async describeReference(
    token: string,
    reference: OrganizationReference,
    audience: 'public' | 'management',
    tx: PoolClient,
  ) {
    return this.describe(
      token,
      {
        reference: organizationReferenceSchema.parse(reference),
        audience,
        requestId: randomUUID(),
      },
      tx,
    );
  }
  private async describe(
    token: string,
    request: OrganizationReadRequest,
    tx: PoolClient,
  ) {
    const proof = await this.registry.authorize(token, request, tx);
    if (!this.runtime) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return this.assets.describe(proof, request, tx);
  }
  private async resolveRead(
    token: string,
    target: OrganizationMediaReadTarget,
    bindingId: string | null,
    requestId: string,
    tx: PoolClient,
  ): Promise<OrganizationReadRequest> {
    organizationMediaSlotSchema.parse(target.slot);
    mediaV2IdSchema.parse(target.organizationId);
    if (target.audience === 'public' && target.slot === 'managerContact')
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    await this.access.authorizeMediaRead(token, target, tx);
    const row = (
      await tx.query<{ revision: string; media_bindings: unknown }>(
        `SELECT revision,media_bindings FROM whaleu_organizations.organizations WHERE id=$1`,
        [target.organizationId],
      )
    ).rows[0];
    if (!row || Number(row.revision) !== target.applicationRevision)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const current = organizationMediaBindingsSchema.parse(row.media_bindings)[
      target.slot
    ];
    if (!current || (bindingId !== null && bindingId !== current))
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return {
      reference: organizationReferenceSchema.parse({
        organizationId: target.organizationId,
        slot: target.slot,
        applicationRevision: target.applicationRevision,
        bindingId: current,
      }),
      audience: target.audience,
      requestId,
    };
  }
  private async authorizeRead(
    token: string,
    request: OrganizationReadRequest,
    tx: PoolClient,
  ): Promise<OrganizationReadAuthority> {
    const ref = request.reference;
    if (request.audience === 'public' && ref.slot === 'managerContact')
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const authority = await this.access.authorizeMediaRead(
      token,
      { ...ref, audience: request.audience, campusId: null },
      tx,
    );
    const row = (
      await tx.query<{ revision: string; media_bindings: unknown }>(
        `SELECT revision,media_bindings FROM whaleu_organizations.organizations WHERE id=$1`,
        [ref.organizationId],
      )
    ).rows[0];
    if (
      !row ||
      Number(row.revision) !== ref.applicationRevision ||
      organizationMediaBindingsSchema.parse(row.media_bindings)[ref.slot] !==
        ref.bindingId
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const appearance = (
      await tx.query<{ id: string; asset_id: string; manifest_digest: string }>(
        `SELECT id,asset_id,manifest_digest FROM whaleu_organizations.media_appearances WHERE binding_id=$1 AND organization_id=$2 AND slot=$3`,
        [ref.bindingId, ref.organizationId, ref.slot],
      )
    ).rows[0];
    if (!appearance) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return {
      principal: {
        kind: 'authenticated-organization',
        accountId: authority.accountId,
        sessionId: authority.sessionId,
      },
      reference: ref,
      appearanceId: appearance.id,
      assetId: appearance.asset_id,
      manifestDigest: appearance.manifest_digest,
      ownerRevision: createHash('sha256')
        .update(
          JSON.stringify({
            revision: row.revision,
            authorityVersion: authority.authorityVersion,
            bindings: row.media_bindings,
            audience: request.audience,
          }),
        )
        .digest('hex'),
    };
  }
  private requireSlot(
    platform: 'qq' | 'wechat' | 'official',
    slot: OrganizationMediaSlot,
  ) {
    if (
      (slot === 'managerContact' && platform !== 'wechat') ||
      (slot === 'linkedOfficialQr' && platform === 'official')
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
  }
  private requireIngress() {
    if (!this.ingress) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return this.ingress;
  }
}
