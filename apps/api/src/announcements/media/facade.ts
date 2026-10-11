import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { DatabaseService } from '../../database/database.js';
import type { IdentityService } from '../../identity/identity.service.js';
import { authenticateMediaSession } from '../../identity/current-media-session.js';
import type { CurrentMediaSession } from '../../identity/current-media-session.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { ApplicationError } from '../../http/application-error.js';
import type {
  AnnouncementMediaAccessPort,
  AnnouncementMediaReadTarget,
} from './access-port.js';
import type {
  AnnouncementMediaMutation,
  AnnouncementMediaDraftRetirement,
} from './contracts.js';
import {
  announcementMediaBindingsSchema,
  announcementMediaChangesSchema,
} from './contracts.js';
import { MediaAnnouncementPrepareScopes } from '../../media/announcement-prepare-scope.js';
import { MediaIntentRepository } from '../../media/intent-repository.js';
import { MediaIngressRepository } from '../../media/ingress-repository.js';
import { MediaLifecycleRepository } from '../../media/lifecycle-repository.js';
import { AnnouncementMediaRecoveryRepository } from '../../media/announcement-recovery-repository.js';
import { AnnouncementMediaAssetRepository } from '../../media/announcement-asset-repository.js';
import { AnnouncementOwnerProofRegistry } from '../../media/announcement-owner-proof.js';
import type {
  AnnouncementReadAuthority,
  AnnouncementReadRequest,
} from '../../media/announcement-owner-proof.js';
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
  ANNOUNCEMENT_MEDIA_PROTOCOL,
  prepareAnnouncementMediaSchema,
  announcementMediaRequestHash,
  announcementMediaGrantSchema,
  announcementMediaUploadObservedSchema,
  announcementReferenceSchema,
  announcementMediaSlotSchema,
} from '../../media/contracts-announcement.js';
import type {
  AnnouncementReference,
  AnnouncementMediaSlot,
} from '../../media/contracts-announcement.js';
export const ANNOUNCEMENT_MEDIA_RUNTIME = Symbol('ANNOUNCEMENT_MEDIA_RUNTIME');
/** Explicit trusted DI only. Production registration supplies null until real
 * immutable storage, ingress, processor and Review adapters are configured. */
export interface AnnouncementMediaRuntime {
  readonly planning: MediaIngressPlanningPort;
  readonly storage: ImmutableMediaStorage;
  readonly ingressStorage: MediaIngressStorage;
}
export class AnnouncementMediaService {
  readonly scopes: MediaAnnouncementPrepareScopes;
  readonly intents: MediaIntentRepository;
  readonly lifecycle = new MediaLifecycleRepository();
  readonly assets: AnnouncementMediaAssetRepository;
  readonly registry: AnnouncementOwnerProofRegistry;
  readonly recovery: AnnouncementMediaRecoveryRepository;
  readonly ingress: MediaIngressRepository | null;
  readonly delivery: ExactMediaDeliveryService | null;
  constructor(
    readonly database: DatabaseService,
    readonly identity: IdentityService,
    readonly access: AnnouncementMediaAccessPort,
    readonly runtime: AnnouncementMediaRuntime | null,
    budget: MediaDeliveryBudgetPool,
  ) {
    this.scopes = new MediaAnnouncementPrepareScopes({
      authorizePrepare: async (actor, input, tx) => {
        const authority = await access.authorizeMediaActor(
          actor,
          input.announcementId,
          input.revision,
          tx,
        );
        if (
          authority.actorAccountId !== actor ||
          authority.announcementId !== input.announcementId ||
          authority.revision !== input.revision
        )
          throw new ApplicationError('MEDIA_UNAVAILABLE');
        const hash = announcementMediaRequestHash(actor, input);
        let row = (
          await tx.query<{
            id: string;
            scope_revision: string;
            expires_at: Date;
            authority_version: string;
          }>(
            `SELECT * FROM whaleu_announcements.media_upload_scopes WHERE actor_id=$1 AND client_request_id=$2`,
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
              `INSERT INTO whaleu_announcements.media_upload_scopes(id,actor_id,client_request_id,announcement_id,slot,revision,scope_revision,input,authority_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING *`,
              [
                randomUUID(),
                actor,
                input.clientRequestId,
                input.announcementId,
                input.slot,
                input.revision,
                hash,
                JSON.stringify(input),
                authority.authorityVersion,
              ],
            )
          ).rows[0];
        if (!row) throw new ApplicationError('MEDIA_UNAVAILABLE');
        await access.retainMediaCurrent(input.announcementId, tx);
        return {
          actorAccountId: actor,
          serverScopeId: row.id,
          scopeRevision: row.scope_revision,
          expiresAt: row.expires_at.getTime(),
          ownerKind: 'announcements',
          resourceKind: 'announcement_image',
          targetKind: 'edit',
          contentVersion: 1,
          audience: 'announcement-gated',
          purpose: 'announcement-image',
          slot: input.slot,
          ordinal: 0,
        };
      },
    });
    this.intents = new MediaIntentRepository(this.scopes);
    this.registry = new AnnouncementOwnerProofRegistry({
      authorizeCurrent: (credential, request, tx) =>
        this.authorizeRead(credential, request, tx),
    });
    this.assets = new AnnouncementMediaAssetRepository(this.registry);
    this.recovery = new AnnouncementMediaRecoveryRepository(
      this.lifecycle,
      this.assets,
    );
    this.ingress = runtime
      ? new MediaIngressRepository(runtime.planning, 12)
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
      const input = prepareAnnouncementMediaSchema.parse(raw),
        hash = announcementMediaRequestHash(session.accountId, input),
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
        await this.scopes.authorizeAnnouncement(session.accountId, input, tx),
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
        await this.scopes.authorizeAnnouncement(
          s.accountId,
          await ingress.originalAnnouncementInput(s.accountId, intentId, tx),
          tx,
        ),
        this.scopes,
        tx,
      );
    });
    if ('blocked' in result) throw new ApplicationError(result.blocked);
    const { version: _version, ...grant } = result;
    void _version;
    return announcementMediaGrantSchema.parse({
      ...grant,
      protocol: ANNOUNCEMENT_MEDIA_PROTOCOL,
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
      await this.scopes.authorizeAnnouncement(
        s.accountId,
        await ingress.originalAnnouncementInput(s.accountId, intentId, tx),
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
        await this.scopes.authorizeAnnouncement(
          s.accountId,
          await ingress.originalAnnouncementInput(s.accountId, intentId, tx),
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
        await this.scopes.authorizeAnnouncement(
          s.accountId,
          await ingress.originalAnnouncementInput(
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
    return announcementMediaUploadObservedSchema.parse({
      ...observed,
      protocol: ANNOUNCEMENT_MEDIA_PROTOCOL,
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
  /** Invoked under the Announcements writer transaction. It must publish revision
   * +1 and the returned complete pointer set atomically; SQL enforces both ends. */
  async mutate(input: AnnouncementMediaMutation, tx: PoolClient) {
    const authority = await this.access.authorizeMediaActor(
      input.actorAccountId,
      input.announcementId,
      input.revision,
      tx,
    );
    const current = announcementMediaBindingsSchema.parse(
        input.currentBindings,
      ),
      changes = announcementMediaChangesSchema.parse(input.changes);
    const row = (
      await tx.query<{ revision: string; media_bindings: unknown }>(
        `SELECT revision,media_bindings FROM whaleu_announcements.native_announcements WHERE id=$1 AND state IN ('draft','active','inactive') FOR UPDATE NOWAIT`,
        [input.announcementId],
      )
    ).rows[0];
    if (!row || Number(row.revision) !== input.revision)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const persisted = announcementMediaBindingsSchema.parse(row.media_bindings);
    for (const slot of announcementMediaSlotSchema.options)
      if ((current[slot] ?? null) !== (persisted[slot] ?? null))
        throw new ApplicationError('MEDIA_UNAVAILABLE');
    const mutations = announcementMediaSlotSchema.options.map((slot) => {
      const change = changes[slot] ?? { action: 'keep' as const };
      if (change.action === 'replace' && !this.runtime)
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      return {
        actorAccountId: input.actorAccountId,
        announcementId: input.announcementId,
        revision: input.revision,
        slot,
        currentBindingId: current[slot] ?? null,
        authorityVersion: authority.authorityVersion,
        ...change,
      };
    });
    return announcementMediaBindingsSchema.parse(
      await this.assets.mutateMany(mutations, tx),
    );
  }
  /** Caller authenticates the original actor and holds the announcement writer lock.
   * Closure remains possible after management authority or image Safety ends. */
  async retireDraft(input: AnnouncementMediaDraftRetirement, tx: PoolClient) {
    const current = announcementMediaBindingsSchema.parse(
      input.currentBindings,
    );
    const row = (
      await tx.query<{
        creator_id: string;
        revision: string;
        media_bindings: unknown;
      }>(
        `SELECT creator_id,revision,media_bindings FROM whaleu_announcements.native_announcements d WHERE id=$1 AND state='draft' AND NOT EXISTS(SELECT 1 FROM whaleu_announcements.native_publications p WHERE p.announcement_id=d.id AND p.operation='publish') FOR UPDATE NOWAIT`,
        [input.announcementId],
      )
    ).rows[0];
    if (
      !row ||
      row.creator_id !== input.actorAccountId ||
      Number(row.revision) !== input.revision
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const persisted = announcementMediaBindingsSchema.parse(row.media_bindings);
    for (const slot of announcementMediaSlotSchema.options)
      if ((current[slot] ?? null) !== (persisted[slot] ?? null))
        throw new ApplicationError('MEDIA_UNAVAILABLE');
    return announcementMediaBindingsSchema.parse(
      await this.assets.retireDraft({ ...input, currentBindings: current }, tx),
    );
  }
  /** Exact immutable image facts feed the native publication snapshot.
   * This requires independent image Safety and issues no approval itself. */
  async reviewFacts(announcementId: string, raw: unknown, tx: PoolClient) {
    const bindings = announcementMediaBindingsSchema.parse(raw);
    const facts: {
      slot: AnnouncementMediaSlot;
      assetId: string;
      manifestDigest: string;
    }[] = [];
    for (const slot of announcementMediaSlotSchema.options) {
      const bindingId = bindings[slot];
      if (bindingId) {
        const fact = await this.assets.requireCurrentBinding(
          announcementId,
          slot,
          bindingId,
          tx,
        );
        facts.push({ slot, ...fact });
      }
    }
    return Object.freeze(facts.map((fact) => Object.freeze(fact)));
  }
  async requireCurrentBindings(
    announcementId: string,
    raw: unknown,
    tx: PoolClient,
  ) {
    const bindings = announcementMediaBindingsSchema.parse(raw);
    await this.reviewFacts(announcementId, bindings, tx);
  }
  descriptor(token: string | null, target: AnnouncementMediaReadTarget) {
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
    token: string | null,
    target: AnnouncementMediaReadTarget,
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
        plan.principal.accountId !== null
          ? `account:${plan.principal.accountId}`
          : `announcement-public-connection:${connectionKey}`,
      range,
    );
  }
  async describeReference(
    token: string | null,
    reference: AnnouncementReference,
    audience: 'public' | 'management',
    campusId: string | null,
    tx: PoolClient,
  ) {
    return this.describe(
      token,
      {
        reference: announcementReferenceSchema.parse(reference),
        audience,
        campusId,
        requestId: randomUUID(),
      },
      tx,
    );
  }
  private async describe(
    token: string | null,
    request: AnnouncementReadRequest,
    tx: PoolClient,
  ) {
    const proof = await this.registry.authorize(token, request, tx);
    if (!this.runtime) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return this.assets.describe(proof, request, tx);
  }
  private async resolveRead(
    token: string | null,
    target: AnnouncementMediaReadTarget,
    bindingId: string | null,
    requestId: string,
    tx: PoolClient,
  ): Promise<AnnouncementReadRequest> {
    announcementMediaSlotSchema.parse(target.slot);
    mediaV2IdSchema.parse(target.announcementId);
    await this.access.authorizeMediaRead(token, target, tx);
    const row = (
      await tx.query<{ revision: string; media_bindings: unknown }>(
        `SELECT revision,media_bindings FROM whaleu_announcements.native_announcements WHERE id=$1`,
        [target.announcementId],
      )
    ).rows[0];
    if (!row || Number(row.revision) !== target.revision)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const current = announcementMediaBindingsSchema.parse(row.media_bindings)[
      target.slot
    ];
    if (!current || (bindingId !== null && bindingId !== current))
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return {
      reference: announcementReferenceSchema.parse({
        announcementId: target.announcementId,
        slot: target.slot,
        revision: target.revision,
        bindingId: current,
      }),
      audience: target.audience,
      campusId: target.campusId,
      requestId,
    };
  }
  private async authorizeRead(
    token: string | null,
    request: AnnouncementReadRequest,
    tx: PoolClient,
  ): Promise<AnnouncementReadAuthority> {
    const ref = request.reference;
    const authority = await this.access.authorizeMediaRead(
      token,
      { ...ref, audience: request.audience, campusId: request.campusId },
      tx,
    );
    const row = (
      await tx.query<{ revision: string; media_bindings: unknown }>(
        `SELECT revision,media_bindings FROM whaleu_announcements.native_announcements WHERE id=$1`,
        [ref.announcementId],
      )
    ).rows[0];
    if (
      !row ||
      Number(row.revision) !== ref.revision ||
      announcementMediaBindingsSchema.parse(row.media_bindings)[ref.slot] !==
        ref.bindingId
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    if (request.audience === 'public')
      await this.requireCurrentBindings(
        ref.announcementId,
        row.media_bindings,
        tx,
      );
    const appearance = (
      await tx.query<{ id: string; asset_id: string; manifest_digest: string }>(
        `SELECT id,asset_id,manifest_digest FROM whaleu_announcements.media_appearances WHERE binding_id=$1 AND announcement_id=$2 AND slot=$3`,
        [ref.bindingId, ref.announcementId, ref.slot],
      )
    ).rows[0];
    if (!appearance) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return {
      principal:
        request.audience === 'public'
          ? {
              kind: 'announcement-public',
              campusId: request.campusId,
              requestId: request.requestId,
              accountId: authority.accountId,
              sessionId: authority.sessionId,
            }
          : {
              kind: 'authenticated-announcement-management',
              accountId: mediaV2IdSchema.parse(authority.accountId),
              sessionId: mediaV2IdSchema.parse(authority.sessionId),
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
            campusId: request.campusId,
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
