import { AccountPolicy } from '../../safety/account-policy/decorator.js';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { DatabaseService } from '../../database/database.js';
import type { IdentityService } from '../../identity/identity.service.js';
import { authenticateMediaSession } from '../../identity/current-media-session.js';
import type { CurrentMediaSession } from '../../identity/current-media-session.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { ApplicationError } from '../../http/application-error.js';
import type {
  ActivityMediaAccessPort,
  ActivityMediaReadTarget,
} from './access-port.js';
import type {
  ActivityMediaMutation,
  ActivityMediaDraftRetirement,
} from './contracts.js';
import {
  activityMediaBindingsSchema,
  activityMediaChangesSchema,
} from './contracts.js';
import { MediaActivityPrepareScopes } from '../../media/activity-prepare-scope.js';
import { MediaIntentRepository } from '../../media/intent-repository.js';
import { MediaIngressRepository } from '../../media/ingress-repository.js';
import { MediaLifecycleRepository } from '../../media/lifecycle-repository.js';
import { ActivityMediaRecoveryRepository } from '../../media/activity-recovery-repository.js';
import { ActivityMediaAssetRepository } from '../../media/activity-asset-repository.js';
import { ActivityOwnerProofRegistry } from '../../media/activity-owner-proof.js';
import type {
  ActivityReadAuthority,
  ActivityReadRequest,
} from '../../media/activity-owner-proof.js';
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
  ACTIVITY_MEDIA_PROTOCOL,
  prepareActivityMediaSchema,
  activityMediaRequestHash,
  activityMediaGrantSchema,
  activityMediaUploadObservedSchema,
  activityReferenceSchema,
  activityMediaSlotSchema,
} from '../../media/contracts-activity.js';
import type {
  ActivityReference,
  ActivityMediaSlot,
} from '../../media/contracts-activity.js';
export const ACTIVITY_MEDIA_RUNTIME = Symbol('ACTIVITY_MEDIA_RUNTIME');
/** Explicit trusted DI only. Production registration supplies null until real
 * immutable storage, ingress, processor and Review adapters are configured. */
export interface ActivityMediaRuntime {
  readonly planning: MediaIngressPlanningPort;
  readonly storage: ImmutableMediaStorage;
  readonly ingressStorage: MediaIngressStorage;
}
export class ActivityMediaService {
  readonly scopes: MediaActivityPrepareScopes;
  readonly intents: MediaIntentRepository;
  readonly lifecycle = new MediaLifecycleRepository();
  readonly assets: ActivityMediaAssetRepository;
  readonly registry: ActivityOwnerProofRegistry;
  readonly recovery: ActivityMediaRecoveryRepository;
  readonly ingress: MediaIngressRepository | null;
  readonly delivery: ExactMediaDeliveryService | null;
  constructor(
    readonly database: DatabaseService,
    readonly identity: IdentityService,
    readonly access: ActivityMediaAccessPort,
    readonly runtime: ActivityMediaRuntime | null,
    budget: MediaDeliveryBudgetPool,
  ) {
    this.scopes = new MediaActivityPrepareScopes({
      authorizePrepare: async (actor, input, tx) => {
        const authority = await access.authorizeMediaActor(
          actor,
          input.activityId,
          input.revision,
          tx,
        );
        if (
          authority.actorAccountId !== actor ||
          authority.activityId !== input.activityId ||
          authority.revision !== input.revision
        )
          throw new ApplicationError('MEDIA_UNAVAILABLE');
        const hash = activityMediaRequestHash(actor, input);
        let row = (
          await tx.query<{
            id: string;
            scope_revision: string;
            expires_at: Date;
            authority_version: string;
          }>(
            `SELECT * FROM whaleu_activities.media_upload_scopes WHERE actor_id=$1 AND client_request_id=$2`,
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
              `INSERT INTO whaleu_activities.media_upload_scopes(id,actor_id,client_request_id,activity_id,slot,revision,scope_revision,input,authority_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING *`,
              [
                randomUUID(),
                actor,
                input.clientRequestId,
                input.activityId,
                input.slot,
                input.revision,
                hash,
                JSON.stringify(input),
                authority.authorityVersion,
              ],
            )
          ).rows[0];
        if (!row) throw new ApplicationError('MEDIA_UNAVAILABLE');
        await access.retainMediaCurrent(input.activityId, tx);
        return {
          actorAccountId: actor,
          serverScopeId: row.id,
          scopeRevision: row.scope_revision,
          expiresAt: row.expires_at.getTime(),
          ownerKind: 'activities',
          resourceKind: 'activity_image',
          targetKind: 'edit',
          contentVersion: 1,
          audience: 'activity-gated',
          purpose: 'activity-image',
          slot: input.slot,
          ordinal: 0,
        };
      },
    });
    this.intents = new MediaIntentRepository(this.scopes);
    this.registry = new ActivityOwnerProofRegistry({
      authorizeCurrent: (credential, request, tx) =>
        this.authorizeRead(credential, request, tx),
    });
    this.assets = new ActivityMediaAssetRepository(this.registry);
    this.recovery = new ActivityMediaRecoveryRepository(
      this.lifecycle,
      this.assets,
    );
    this.ingress = runtime
      ? new MediaIngressRepository(runtime.planning, 11)
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
  @AccountPolicy('content_management', 'owner_after_recovery')
  prepare(token: string, raw: unknown) {
    return this.authorized(token, async (session, tx) => {
      const input = prepareActivityMediaSchema.parse(raw),
        hash = activityMediaRequestHash(session.accountId, input),
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
        await this.scopes.authorizeActivity(session.accountId, input, tx),
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
  @AccountPolicy('content_management', 'owner_after_recovery')
  async grant(token: string, intentId: string) {
    const result = await this.authorized(token, async (s, tx) => {
      const ingress = this.requireIngress();
      return ingress.grant(
        s,
        intentId,
        await this.scopes.authorizeActivity(
          s.accountId,
          await ingress.originalActivityInput(s.accountId, intentId, tx),
          tx,
        ),
        this.scopes,
        tx,
      );
    });
    if ('blocked' in result) throw new ApplicationError(result.blocked);
    const { version: _version, ...grant } = result;
    void _version;
    return activityMediaGrantSchema.parse({
      ...grant,
      protocol: ACTIVITY_MEDIA_PROTOCOL,
    });
  }
  @AccountPolicy('content_management', 'owner_after_recovery')
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
      await this.scopes.authorizeActivity(
        s.accountId,
        await ingress.originalActivityInput(s.accountId, intentId, tx),
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
        await this.scopes.authorizeActivity(
          s.accountId,
          await ingress.originalActivityInput(s.accountId, intentId, tx),
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
        await this.scopes.authorizeActivity(
          s.accountId,
          await ingress.originalActivityInput(s.accountId, claim.intentId, tx),
          tx,
        ),
        this.scopes,
        tx,
      );
    });
  }
  @AccountPolicy('content_management', 'owner_after_recovery')
  observed(result: MediaUploadObserved) {
    const { version: _version, ...observed } = result;
    void _version;
    return activityMediaUploadObservedSchema.parse({
      ...observed,
      protocol: ACTIVITY_MEDIA_PROTOCOL,
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
  /** Invoked under the Activities writer transaction. It must publish revision
   * +1 and the returned complete pointer set atomically; SQL enforces both ends. */
  async mutate(input: ActivityMediaMutation, tx: PoolClient) {
    const authority = await this.access.authorizeMediaActor(
      input.actorAccountId,
      input.activityId,
      input.revision,
      tx,
    );
    const current = activityMediaBindingsSchema.parse(input.currentBindings),
      changes = activityMediaChangesSchema.parse(input.changes);
    const row = (
      await tx.query<{ revision: string; media_bindings: unknown }>(
        `SELECT revision,media_bindings FROM whaleu_activities.publication_drafts WHERE id=$1 AND state='draft' FOR UPDATE NOWAIT`,
        [input.activityId],
      )
    ).rows[0];
    if (!row || Number(row.revision) !== input.revision)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const persisted = activityMediaBindingsSchema.parse(row.media_bindings);
    for (const slot of activityMediaSlotSchema.options)
      if ((current[slot] ?? null) !== (persisted[slot] ?? null))
        throw new ApplicationError('MEDIA_UNAVAILABLE');
    const mutations = activityMediaSlotSchema.options.map((slot) => {
      const change = changes[slot] ?? { action: 'keep' as const };
      if (change.action === 'replace' && !this.runtime)
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      return {
        actorAccountId: input.actorAccountId,
        activityId: input.activityId,
        revision: input.revision,
        slot,
        currentBindingId: current[slot] ?? null,
        authorityVersion: authority.authorityVersion,
        ...change,
      };
    });
    return activityMediaBindingsSchema.parse(
      await this.assets.mutateMany(mutations, tx),
    );
  }
  /** Caller authenticates the original actor and holds the activity writer lock.
   * Closure remains possible after organization authority or image Safety ends. */
  async retireDraft(input: ActivityMediaDraftRetirement, tx: PoolClient) {
    const current = activityMediaBindingsSchema.parse(input.currentBindings);
    const row = (
      await tx.query<{
        account_id: string;
        revision: string;
        media_bindings: unknown;
      }>(
        `SELECT account_id,revision,media_bindings FROM whaleu_activities.publication_drafts d WHERE id=$1 AND state='draft' AND NOT EXISTS(SELECT 1 FROM whaleu_activities.native_activities a WHERE a.id=d.id) FOR UPDATE NOWAIT`,
        [input.activityId],
      )
    ).rows[0];
    if (
      !row ||
      row.account_id !== input.actorAccountId ||
      Number(row.revision) !== input.revision
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const persisted = activityMediaBindingsSchema.parse(row.media_bindings);
    for (const slot of activityMediaSlotSchema.options)
      if ((current[slot] ?? null) !== (persisted[slot] ?? null))
        throw new ApplicationError('MEDIA_UNAVAILABLE');
    return activityMediaBindingsSchema.parse(
      await this.assets.retireDraft({ ...input, currentBindings: current }, tx),
    );
  }
  /** Same exact image facts feed the activity text-and-images Review envelope.
   * This does not issue either image Safety approval or publication approval. */
  async reviewFacts(activityId: string, raw: unknown, tx: PoolClient) {
    const bindings = activityMediaBindingsSchema.parse(raw);
    const facts: {
      slot: ActivityMediaSlot;
      assetId: string;
      manifestDigest: string;
    }[] = [];
    for (const slot of activityMediaSlotSchema.options) {
      const bindingId = bindings[slot];
      if (bindingId) {
        const fact = await this.assets.requireCurrentBinding(
          activityId,
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
    activityId: string,
    raw: unknown,
    tx: PoolClient,
    options: { requireCover?: boolean } = {},
  ) {
    const bindings = activityMediaBindingsSchema.parse(raw);
    if (options.requireCover && !bindings.cover)
      throw new ApplicationError('MEDIA_NOT_READY');
    await this.reviewFacts(activityId, bindings, tx);
  }
  @AccountPolicy('browse', 'entry')
  descriptor(token: string, target: ActivityMediaReadTarget) {
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
  @AccountPolicy('browse', 'entry')
  open(
    token: string,
    target: ActivityMediaReadTarget,
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
    reference: ActivityReference,
    audience: 'public' | 'management',
    tx: PoolClient,
  ) {
    return this.describe(
      token,
      {
        reference: activityReferenceSchema.parse(reference),
        audience,
        requestId: randomUUID(),
      },
      tx,
    );
  }
  private async describe(
    token: string,
    request: ActivityReadRequest,
    tx: PoolClient,
  ) {
    const proof = await this.registry.authorize(token, request, tx);
    if (!this.runtime) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return this.assets.describe(proof, request, tx);
  }
  private async resolveRead(
    token: string,
    target: ActivityMediaReadTarget,
    bindingId: string | null,
    requestId: string,
    tx: PoolClient,
  ): Promise<ActivityReadRequest> {
    activityMediaSlotSchema.parse(target.slot);
    mediaV2IdSchema.parse(target.activityId);
    await this.access.authorizeMediaRead(token, target, tx);
    const row = (
      await tx.query<{ revision: string; media_bindings: unknown }>(
        `SELECT revision,media_bindings FROM whaleu_activities.${target.audience === 'public' ? 'native_activities' : 'publication_drafts'} WHERE id=$1`,
        [target.activityId],
      )
    ).rows[0];
    if (!row || Number(row.revision) !== target.revision)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const current = activityMediaBindingsSchema.parse(row.media_bindings)[
      target.slot
    ];
    if (!current || (bindingId !== null && bindingId !== current))
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return {
      reference: activityReferenceSchema.parse({
        activityId: target.activityId,
        slot: target.slot,
        revision: target.revision,
        bindingId: current,
      }),
      audience: target.audience,
      requestId,
    };
  }
  private async authorizeRead(
    token: string,
    request: ActivityReadRequest,
    tx: PoolClient,
  ): Promise<ActivityReadAuthority> {
    const ref = request.reference;
    const authority = await this.access.authorizeMediaRead(
      token,
      { ...ref, audience: request.audience },
      tx,
    );
    const row = (
      await tx.query<{ revision: string; media_bindings: unknown }>(
        `SELECT revision,media_bindings FROM whaleu_activities.${request.audience === 'public' ? 'native_activities' : 'publication_drafts'} WHERE id=$1`,
        [ref.activityId],
      )
    ).rows[0];
    if (
      !row ||
      Number(row.revision) !== ref.revision ||
      activityMediaBindingsSchema.parse(row.media_bindings)[ref.slot] !==
        ref.bindingId
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    if (request.audience === 'public')
      await this.requireCurrentBindings(
        ref.activityId,
        row.media_bindings,
        tx,
        {
          requireCover: true,
        },
      );
    const appearance = (
      await tx.query<{ id: string; asset_id: string; manifest_digest: string }>(
        `SELECT id,asset_id,manifest_digest FROM whaleu_activities.media_appearances WHERE binding_id=$1 AND activity_id=$2 AND slot=$3`,
        [ref.bindingId, ref.activityId, ref.slot],
      )
    ).rows[0];
    if (!appearance) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return {
      principal: {
        kind: 'authenticated-activity',
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
  private requireIngress() {
    if (!this.ingress) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return this.ingress;
  }
}
