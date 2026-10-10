import { mediaV2IdSchema } from './contracts-v2.js';
import { ratingsMediaParentSchema } from './contracts-ratings.js';
import type { MediaDeliveryBudgetPool } from './delivery-budget.js';
import type { PoolClient } from 'pg';
import { ExactMediaDeliveryService } from './delivery.js';
import type {
  ExactMediaDeliveryPlan,
  MediaTransactionRunner,
  AuthorizedMediaStream,
} from './delivery.js';
import type { ImmutableMediaStorage } from './storage-port.js';
import type { MediaVariantName } from './contracts.js';
import type { RatingsMediaParent } from './contracts-ratings.js';
import type {
  RatingsMediaPrincipal,
  RatingsMediaReadRequest,
} from './ratings-owner-proof.js';
import { ApplicationError } from '../http/application-error.js';

export interface RatingsMediaDeliveryPlan extends ExactMediaDeliveryPlan {
  readonly parent: RatingsMediaParent;
  readonly targetId: string;
  readonly contextId: string;
  readonly contextToken: string;
  readonly bindingId: string;
  readonly principal: RatingsMediaPrincipal;
  readonly ownerRevision: string;
  readonly reviewRevision: string;
  readonly variant: MediaVariantName;
  readonly manifestDigest: string;
  readonly safetyRevision: string;
}
export interface CurrentRatingsMediaDeliveryAuthorizer {
  authorize(
    credential: string,
    request: RatingsMediaReadRequest,
    variant: MediaVariantName,
    tx: PoolClient,
  ): Promise<RatingsMediaDeliveryPlan>;
}
/** Two current authenticated owner checks surround exact storage staging. */
export class RatingsMediaDeliveryService {
  private readonly exact: ExactMediaDeliveryService;
  constructor(
    database: MediaTransactionRunner,
    private readonly authorizer: CurrentRatingsMediaDeliveryAuthorizer,
    storage: ImmutableMediaStorage,
    budget: MediaDeliveryBudgetPool,
  ) {
    this.exact = new ExactMediaDeliveryService(database, storage, budget);
  }
  open(
    credential: string,
    request: RatingsMediaReadRequest,
    variant: MediaVariantName,
    range?: string,
  ): Promise<AuthorizedMediaStream> {
    if (!credential || request.purpose !== 'download')
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const snapshot = Object.freeze({ ...request });
    return this.exact.open(
      async (tx) => {
        const plan = await this.authorizer.authorize(
          credential,
          snapshot,
          variant,
          tx,
        );
        if (
          plan.principal.kind !== 'authenticatedRatings' ||
          plan.targetId !== snapshot.targetId ||
          plan.parent.resourceId !== snapshot.appearanceId ||
          plan.variant !== variant ||
          plan.contextId !== snapshot.contextId ||
          plan.contextToken !== snapshot.contextToken
        )
          throw new ApplicationError('MEDIA_UNAVAILABLE');
        mediaV2IdSchema.parse(plan.principal.accountId);
        mediaV2IdSchema.parse(plan.principal.sessionId);
        ratingsMediaParentSchema.parse(plan.parent);
        return plan;
      },
      (plan) => `account:${plan.principal.accountId}`,
      range,
    );
  }
}
