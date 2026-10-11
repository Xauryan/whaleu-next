import {
  CategoryIconRetirementProofRegistry,
  type CategoryIconRetirementRequest,
} from '../../media/category-icon-retirement-proof.js';
import {
  RatingCategoryIconRetirementOwner,
  retireCategoryIconAppearances,
} from './icon-retirement.js';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.js';
import { IdentityService } from '../../identity/identity.service.js';
import {
  authenticateMediaSession,
  type CurrentMediaSession,
} from '../../identity/current-media-session.js';
import { ApplicationError } from '../../http/application-error.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import type {
  CategoryIconMediaOwner,
  CategoryIconMediaRuntime,
} from '../../media/application-category-icon.js';
import { MediaCategoryIconPrepareScopes } from '../../media/category-icon-prepare-scope.js';
import { MediaIntentRepository } from '../../media/intent-repository.js';
import { MediaLifecycleRepository } from '../../media/lifecycle-repository.js';
import { MediaIngressRepository } from '../../media/ingress-repository.js';
import { CategoryIconMediaAssetRepository } from '../../media/category-icon-asset-repository.js';
import { CategoryIconMediaRecoveryRepository } from '../../media/category-icon-recovery-repository.js';
import {
  CategoryIconMediaProofRegistry,
  type AuthorizedCategoryIconMediaRead,
  type CategoryIconMediaReadRequest,
} from '../../media/category-icon-owner-proof.js';
import { CategoryIconMediaDeliveryService } from '../../media/category-icon-delivery.js';
import { MediaDeliveryBudgetPool } from '../../media/delivery-budget.js';
import type { CategoryIconMediaDescriptor } from '../../media/contracts-category-icon.js';
import { RatingsAccessService } from '../access.js';
import {
  CategoryIconMediaCredentials,
  RATINGS_CATEGORY_ICON_MEDIA_AUTHORITY,
  RATINGS_CATEGORY_ICON_MEDIA_RUNTIME,
  type CategoryIconMediaAuthority,
} from './icon-media-authority.js';

/** Media 8 transport composition only. The injected original Category owner
 * grants management/public authority and selects the exact current release;
 * this service never selects a latest icon or grants target-creator authority. */
@Injectable()
export class RatingCategoryIconMediaService implements CategoryIconMediaOwner {
  readonly retirements: CategoryIconRetirementProofRegistry | undefined;
  readonly scopes: MediaCategoryIconPrepareScopes;
  readonly intents: MediaIntentRepository;
  readonly lifecycle = new MediaLifecycleRepository();
  readonly assets: CategoryIconMediaAssetRepository;
  readonly registry: CategoryIconMediaProofRegistry;
  readonly recovery: CategoryIconMediaRecoveryRepository;
  readonly ingress: MediaIngressRepository | null;
  readonly delivery: CategoryIconMediaDeliveryService | null;

  constructor(
    @Inject(DatabaseService) readonly database: DatabaseService,
    @Inject(IdentityService) readonly identity: IdentityService,
    @Inject(RatingsAccessService) readonly access: RatingsAccessService,
    @Inject(RATINGS_CATEGORY_ICON_MEDIA_AUTHORITY)
    private readonly authority: CategoryIconMediaAuthority,
    @Inject(CategoryIconMediaCredentials)
    readonly credentials: CategoryIconMediaCredentials,
    @Inject(MediaDeliveryBudgetPool) budget: MediaDeliveryBudgetPool,
    @Optional()
    @Inject(RATINGS_CATEGORY_ICON_MEDIA_RUNTIME)
    readonly runtime: CategoryIconMediaRuntime | null = null,
    @Optional()
    @Inject(RatingCategoryIconRetirementOwner)
    private readonly retirementOwner: RatingCategoryIconRetirementOwner | null = null,
  ) {
    this.scopes = new MediaCategoryIconPrepareScopes({
      authorizePrepare: async (actor, input, tx) => {
        if (this.credentials.require(tx).session.accountId !== actor)
          throw new ApplicationError('MEDIA_UNAVAILABLE');
        const scope = await this.authority.authorizePrepare(actor, input, tx);
        this.credentials.require(tx);
        return scope;
      },
    });
    // The protocol is selected from the opaque Category prepare capability,
    // not from a caller-controlled generic Media protocol number.
    this.intents = new MediaIntentRepository(this.scopes);
    this.registry = new CategoryIconMediaProofRegistry({
      authorizeCurrent: (token, request, tx) =>
        this.authorizeCurrent(token, request, tx),
    });
    this.retirements = retirementOwner
      ? new CategoryIconRetirementProofRegistry(retirementOwner)
      : undefined;
    this.assets = new CategoryIconMediaAssetRepository(
      this.registry,
      this.retirements,
    );
    this.recovery = new CategoryIconMediaRecoveryRepository(
      this.lifecycle,
      this.assets,
    );
    this.ingress = runtime
      ? new MediaIngressRepository(runtime.planning, 8)
      : null;
    this.delivery = runtime
      ? new CategoryIconMediaDeliveryService(
          database,
          {
            authorize: (token, request, variant, tx) =>
              this.inTransaction(
                token,
                async () =>
                  this.assets.categoryIconDeliveryPlan(
                    await this.registry.authorize(token, request, tx),
                    request,
                    variant,
                    tx,
                  ),
                tx,
                false,
              ),
          },
          runtime.storage,
          budget,
        )
      : null;
  }

  inspectRetirement(
    token: string,
    request: { requestId: string; appearanceIds?: readonly string[] },
  ) {
    const owner = this.retirementOwner;
    if (!owner) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return this.authorized(
      token,
      (_session, tx) =>
        request.appearanceIds
          ? owner.inspect(
              token,
              {
                requestId: request.requestId,
                appearanceIds: request.appearanceIds,
              },
              tx,
            )
          : owner.inspectRequest(token, request.requestId, tx),
      false,
    );
  }
  retire(token: string, request: CategoryIconRetirementRequest) {
    const owner = this.retirementOwner,
      registry = this.retirements;
    if (!owner || !registry) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return this.authorized(token, (_session, tx) =>
      retireCategoryIconAppearances(
        owner,
        registry,
        this.assets,
        token,
        request,
        tx,
      ),
    );
  }
  authorized<T>(
    token: string,
    work: (session: CurrentMediaSession, tx: PoolClient) => Promise<T>,
    write = true,
  ): Promise<T> {
    return this.database.transaction(
      (tx) => this.inTransaction(token, work, tx, write),
      { isolationLevel: 'read committed' },
    );
  }

  private async inTransaction<T>(
    token: string,
    work: (session: CurrentMediaSession, tx: PoolClient) => Promise<T>,
    tx: PoolClient,
    write: boolean,
  ): Promise<T> {
    await lockSafetyPolicy(tx, write);
    const session = await authenticateMediaSession(this.identity, token, tx);
    return this.credentials.run(token, session, tx, async () => {
      const result = await work(session, tx);
      this.credentials.require(tx);
      await this.access.recheck(token, tx);
      return result;
    });
  }

  authorizeCurrent(
    token: string,
    request: CategoryIconMediaReadRequest,
    tx: PoolClient,
  ): Promise<AuthorizedCategoryIconMediaRead> {
    return this.inTransaction(
      token,
      async (session) => {
        const read = await this.authority.authorizeCurrent(token, request, tx);
        if (
          read.principal.kind !== 'authenticatedRatings' ||
          read.principal.accountId !== session.accountId ||
          read.principal.sessionId !== session.sessionId
        )
          throw new ApplicationError('MEDIA_UNAVAILABLE');
        // actorAccountId is the original uploader and may differ from the
        // current viewer. The asset repository verifies the uploader binding.
        return read;
      },
      tx,
      false,
    );
  }

  describe(
    credential: string,
    request: CategoryIconMediaReadRequest,
  ): Promise<CategoryIconMediaDescriptor> {
    const snapshot = Object.freeze({ ...request });
    return this.authorized(
      credential,
      async (_session, tx) =>
        this.assets.categoryIconDescriptor(
          await this.registry.authorize(credential, snapshot, tx),
          snapshot,
          tx,
        ),
      false,
    );
  }

  /** Composes with an existing Category projection transaction while retaining
   * exactly the same authenticated, current-release qualification as HTTP. */
  descriptorInTransaction(
    credential: string,
    request: CategoryIconMediaReadRequest,
    tx: PoolClient,
  ): Promise<CategoryIconMediaDescriptor> {
    const snapshot = Object.freeze({ ...request });
    return this.inTransaction(
      credential,
      async () =>
        this.assets.categoryIconDescriptor(
          await this.registry.authorize(credential, snapshot, tx),
          snapshot,
          tx,
        ),
      tx,
      false,
    );
  }
}
