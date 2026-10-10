import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { DatabaseService } from '../database/database.js';
import { ownerFingerprint } from '../database/required-owner-proof.js';
import type { IdentityService } from '../identity/identity.service.js';
import {
  authenticateMediaSession,
  type CurrentMediaSession,
} from '../identity/current-media-session.js';
import { lockSafetyPolicy } from '../safety/locks.js';
import { ApplicationError } from '../http/application-error.js';
import { canonicalEqual } from '../community/content-review/contracts.js';
import { MediaRatingsPrepareScopes } from '../media/ratings-prepare-scope.js';
import { MediaIntentRepository } from '../media/intent-repository.js';
import { MediaLifecycleRepository } from '../media/lifecycle-repository.js';
import { MediaIngressRepository } from '../media/ingress-repository.js';
import { RatingsMediaRecoveryRepository } from '../media/ratings-recovery-repository.js';
import { RatingsMediaAssetRepository } from '../media/ratings-asset-repository.js';
import {
  RatingsMediaProofRegistry,
  type RatingsMediaReadRequest,
  type AuthorizedRatingsMediaRead,
} from '../media/ratings-owner-proof.js';
import { RatingsMediaDeliveryService } from '../media/ratings-delivery.js';
import type { RatingsTargetMediaRuntime } from '../media/application-ratings.js';
import type { MediaDeliveryBudgetPool } from '../media/delivery-budget.js';
import { ratingsMediaRequestHash } from '../media/contracts-ratings.js';
import { registerTransactionDeadline } from '../database/transaction-deadlines.js';
import type { RatingsAccessService } from './access.js';
import { ratingTargetCoverUploadScopeSchema } from './scoped/target-cover-contracts.js';
import { retainRatingTargetCoverMediaAfter } from './target-cover-current.js';
import type { ResolvedRatingScope } from './scoped/context.service.js';
import type { RatingScopedContextService } from './scoped/context.service.js';
import type { RatingScopedRepository } from './scoped/repository.js';
export const RATINGS_TARGET_COVER_RUNTIME = Symbol(
  'RATINGS_TARGET_COVER_RUNTIME',
);
export interface RatingCoverUploadScopeRow {
  id: string;
  actor_id: string;
  client_request_id: string;
  command_request_id: string;
  scope_revision: string;
  request_hash: string;
  input: unknown;
  declaration: unknown;
  context_id: string;
  context_revision: string;
  session_id: string;
  target_id: string;
  category_id: string;
  expected_target_revision: string | null;
  expected_definition_revision: string | null;
  expected_content_version: number | null;
  expires_at: Date;
}
/** The original Ratings authority supplies every authorization. This facade owns
 * Media transport only; it cannot create or edit a target or its current head. */
export class RatingTargetCoverMediaService {
  private readonly credentials = new WeakMap<
    PoolClient,
    { token: string; session: CurrentMediaSession }
  >();
  readonly scopes: MediaRatingsPrepareScopes;
  readonly intents: MediaIntentRepository;
  readonly lifecycle = new MediaLifecycleRepository();
  readonly assets: RatingsMediaAssetRepository;
  readonly registry: RatingsMediaProofRegistry;
  readonly recovery: RatingsMediaRecoveryRepository;
  readonly ingress: MediaIngressRepository | null;
  readonly delivery: RatingsMediaDeliveryService | null;
  constructor(
    readonly database: DatabaseService,
    readonly identity: IdentityService,
    readonly access: RatingsAccessService,
    readonly contexts: RatingScopedContextService,
    readonly scoped: RatingScopedRepository,
    readonly runtime: RatingsTargetMediaRuntime | null,
    budget: MediaDeliveryBudgetPool,
  ) {
    this.scopes = new MediaRatingsPrepareScopes({
      authorizePrepare: async (actor, input, tx) => {
        const row = await this.uploadScope(actor, input.editScopeId, tx);
        if (
          row.client_request_id !== input.clientRequestId ||
          row.scope_revision !== input.scopeRevision ||
          row.request_hash !== ratingsMediaRequestHash(actor, input) ||
          !canonicalEqual(row.declaration, input.declaration)
        )
          throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
        return {
          actorAccountId: actor,
          serverScopeId: row.id,
          scopeRevision: row.scope_revision,
          expiresAt: row.expires_at.getTime(),
          ownerKind: 'ratings',
          resourceKind: 'target_cover',
          targetKind: 'edit',
          contentVersion: 1,
          audience: 'content-gated',
          purpose: 'ratings-target-cover-image',
          slot: 'cover',
          ordinal: 0,
        };
      },
    });
    this.intents = new MediaIntentRepository(this.scopes);
    this.registry = new RatingsMediaProofRegistry({
      authorizeCurrent: (token, request, tx) =>
        this.authorizeCurrent(token, request, tx),
    });
    this.assets = new RatingsMediaAssetRepository(this.registry);
    this.recovery = new RatingsMediaRecoveryRepository(
      this.lifecycle,
      this.assets,
    );
    this.ingress = runtime
      ? new MediaIngressRepository(runtime.planning, 6)
      : null;
    this.delivery = runtime
      ? new RatingsMediaDeliveryService(
          database,
          {
            authorize: async (token, request, variant, tx) => {
              const proof = await this.registry.authorize(token, request, tx);
              return this.assets.ratingsDeliveryPlan(
                proof,
                request,
                variant,
                tx,
              );
            },
          },
          runtime.storage,
          budget,
        )
      : null;
  }
  authorized<T>(
    token: string,
    run: (session: CurrentMediaSession, tx: PoolClient) => Promise<T>,
    write = true,
  ): Promise<T> {
    return this.database.transaction(
      async (tx) => {
        await lockSafetyPolicy(tx, write);
        const session = await authenticateMediaSession(
          this.identity,
          token,
          tx,
        );
        this.credentials.set(tx, { token, session });
        try {
          const result = await run(session, tx);
          await retainRatingTargetCoverMediaAfter(tx);
          await this.access.recheck(token, tx);
          return result;
        } finally {
          this.credentials.delete(tx);
        }
      },
      { isolationLevel: 'read committed' },
    );
  }
  async uploadScope(
    actor: string,
    id: string,
    tx: PoolClient,
    authority?: ResolvedRatingScope,
  ): Promise<RatingCoverUploadScopeRow> {
    const row = (
      await tx.query<RatingCoverUploadScopeRow & { current: boolean }>(
        'SELECT s.*,whaleu_ratings.target_cover_upload_scope_current(s.id,clock_timestamp()) current FROM whaleu_ratings.target_cover_upload_scopes s WHERE s.id=$1 AND s.actor_id=$2',
        [id, actor],
      )
    ).rows[0];
    if (!row || row.current !== true || !(row.expires_at instanceof Date))
      throw new ApplicationError('MEDIA_NOT_READY');
    const input = ratingTargetCoverUploadScopeSchema.parse(row.input),
      credential = this.credentials.get(tx);
    const scope =
      authority ??
      (credential
        ? await this.contexts.resolve(
            credential.token,
            { contextId: row.context_id, contextToken: input.context.token },
            tx,
            {
              purpose: input.target ? 'edit_target' : 'create_target',
              write: true,
              protocolVersion: 3,
            },
          )
        : null);
    if (
      !scope ||
      scope.actor !== actor ||
      scope.contextId !== row.context_id ||
      scope.session.sessionId !== row.session_id ||
      scope.scopeRevision !== row.context_revision ||
      !scope.context.capabilities.includes('target_cover') ||
      (credential && credential.session.sessionId !== row.session_id)
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    const category = await this.scoped.category(
      scope,
      row.category_id,
      tx,
      true,
    );
    if (
      category.kind !== 'general' ||
      category.revision !== input.expectedCategoryRevision
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    if (input.target) {
      const target = await this.scoped.target(
        scope,
        row.target_id,
        tx,
        true,
        true,
      );
      if (
        target.row.creator_id !== actor ||
        target.row.category_id !== row.category_id ||
        target.row.revision !== row.expected_target_revision ||
        target.row.definition.definitionRevision !==
          row.expected_definition_revision ||
        target.row.definition.contentVersion !== row.expected_content_version
      )
        throw new ApplicationError('MEDIA_NOT_READY');
    }
    // Retain owner after-state before returning the immutable scope. No new Media
    // fact is enrolled here: authorized()/replacement finish captures after writes.
    if (!authority) await this.scoped.retainAfter(scope, tx);
    registerTransactionDeadline(
      tx,
      row.expires_at.getTime(),
      'MEDIA_NOT_READY',
    );
    return row;
  }
  async authorizeCurrent(
    token: string,
    request: RatingsMediaReadRequest,
    tx: PoolClient,
  ): Promise<AuthorizedRatingsMediaRead> {
    await lockSafetyPolicy(tx);
    const session = await authenticateMediaSession(this.identity, token, tx);
    const scope = await this.contexts.resolve(
      token,
      { contextId: request.contextId, contextToken: request.contextToken },
      tx,
      { purpose: 'read', protocolVersion: 3 },
    );
    const target = await this.scoped.target(scope, request.targetId, tx);
    const envelope = target.row.envelope;
    if (
      envelope.version !== 6 ||
      !envelope.cover ||
      envelope.cover.appearanceId !== request.appearanceId
    )
      throw new ApplicationError('RATING_NOT_FOUND');
    const a = (
      await tx.query<{
        id: string;
        target_id: string;
        actor_id: string;
        asset_id: string;
        manifest_digest: string;
        media_binding_id: string;
      }>(
        'SELECT id,target_id,actor_id,asset_id,manifest_digest,media_binding_id FROM whaleu_ratings.target_cover_appearances WHERE id=$1',
        [request.appearanceId],
      )
    ).rows[0];
    if (
      !a ||
      a.target_id !== target.row.id ||
      a.actor_id !== target.row.creator_id ||
      a.asset_id !== envelope.cover.assetId ||
      a.manifest_digest !== envelope.cover.manifestDigest
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    await this.scoped.retainAfter(scope, tx);
    await this.access.recheck(token, tx);
    return {
      principal: {
        kind: 'authenticatedRatings',
        accountId: session.accountId,
        sessionId: session.sessionId,
      },
      actorAccountId: a.actor_id,
      targetId: target.row.id,
      parent: {
        ownerKind: 'ratings',
        resourceKind: 'target_cover',
        resourceId: a.id,
        contentVersion: 1,
      },
      assetId: a.asset_id,
      manifestDigest: a.manifest_digest,
      bindingId: a.media_binding_id,
      ownerRevision: ownerFingerprint({
        target: target.row.revision,
        definition: target.row.definition,
        scope: scope.scopeRevision,
      }),
      reviewRevision: ownerFingerprint(envelope),
    };
  }
  async descriptorInTransaction(
    token: string,
    targetId: string,
    appearanceId: string,
    query: { contextId: string; contextToken: string },
    tx: PoolClient,
  ) {
    const request = {
      ...query,
      targetId,
      appearanceId,
      purpose: 'list-projection' as const,
      requestId: randomUUID(),
    };
    return this.assets.ratingsDescriptor(
      await this.registry.authorize(token, request, tx),
      request,
      tx,
    );
  }
  descriptor(
    token: string,
    targetId: string,
    appearanceId: string,
    query: { contextId: string; contextToken: string },
  ) {
    return this.authorized(
      token,
      async (_session, tx) => {
        const request = {
          ...query,
          targetId,
          appearanceId,
          purpose: 'direct-content' as const,
          requestId: randomUUID(),
        };
        const proof = await this.registry.authorize(token, request, tx);
        return this.assets.ratingsDescriptor(proof, request, tx);
      },
      false,
    );
  }
  /** Durable enumeration, not owner deletion and not physical storage deletion. */
  cleanupOne(): Promise<boolean> {
    return this.database.transaction(
      async (tx) => {
        await lockSafetyPolicy(tx, true);
        const job = (
          await tx.query<{
            target_id: string;
            after_appearance_id: string | null;
          }>(
            "SELECT target_id,after_appearance_id FROM whaleu_ratings.target_cover_cleanup WHERE phase='pending' ORDER BY created_at,target_id LIMIT 1 FOR UPDATE SKIP LOCKED",
          )
        ).rows[0];
        if (!job) return false;
        const rows = (
          await tx.query<{ id: string }>(
            'SELECT id FROM whaleu_ratings.target_cover_appearances WHERE target_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 16',
            [job.target_id, job.after_appearance_id],
          )
        ).rows;
        await this.assets.detachRatingsAppearances(
          rows.map((r) => r.id),
          tx,
        );
        await tx.query(
          "UPDATE whaleu_ratings.target_cover_cleanup SET after_appearance_id=coalesce($2,after_appearance_id),phase=CASE WHEN $3 THEN 'complete' ELSE 'pending' END,completed_at=CASE WHEN $3 THEN clock_timestamp() ELSE NULL END WHERE target_id=$1",
          [job.target_id, rows.at(-1)?.id ?? null, rows.length < 16],
        );
        return true;
      },
      { isolationLevel: 'read committed' },
    );
  }
}
