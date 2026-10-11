import { mediaDigestSchema, mediaVariantSchema } from './contracts.js';
import { categoryIconMediaQualificationSchema } from './category-icon-owner-proof.js';
import { mediaV2IdSchema } from './contracts-v2.js';
import { categoryIconMediaParentSchema } from './contracts-category-icon.js';
import type { MediaDeliveryBudgetPool } from './delivery-budget.js';
import type { PoolClient } from 'pg';
import { ExactMediaDeliveryService } from './delivery.js';
import {
  PostgresCategoryIconDeliveryHolds,
  type CategoryIconDeliveryHolds,
} from './category-icon-delivery-holds.js';
import type {
  ExactMediaDeliveryPlan,
  MediaTransactionRunner,
  AuthorizedMediaStream,
} from './delivery.js';
import type { ImmutableMediaStorage } from './storage-port.js';
import type { MediaVariantName } from './contracts.js';
import type { CategoryIconMediaParent } from './contracts-category-icon.js';
import type {
  CategoryIconMediaPrincipal,
  CategoryIconMediaReadRequest,
  CategoryIconMediaQualification,
} from './category-icon-owner-proof.js';
import { ApplicationError } from '../http/application-error.js';

export interface CategoryIconMediaDeliveryPlan extends ExactMediaDeliveryPlan {
  readonly parent: CategoryIconMediaParent;
  readonly categoryId: string;
  readonly contextId: string;
  readonly contextToken: string;
  readonly bindingId: string;
  readonly principal: CategoryIconMediaPrincipal;
  readonly ownerRevision: string;
  readonly reviewRevision: string;
  readonly qualification: CategoryIconMediaQualification;
  readonly variant: MediaVariantName;
  readonly manifestDigest: string;
  readonly safetyRevision: string;
}
export interface CurrentCategoryIconMediaDeliveryAuthorizer {
  authorize(
    credential: string,
    request: CategoryIconMediaReadRequest,
    variant: MediaVariantName,
    tx: PoolClient,
  ): Promise<CategoryIconMediaDeliveryPlan>;
}
/** Two current authenticated owner checks surround exact storage staging. */
export class CategoryIconMediaDeliveryService {
  private readonly exact: ExactMediaDeliveryService;
  constructor(
    database: MediaTransactionRunner,
    private readonly authorizer: CurrentCategoryIconMediaDeliveryAuthorizer,
    storage: ImmutableMediaStorage,
    budget: MediaDeliveryBudgetPool,
    private readonly holds: CategoryIconDeliveryHolds = new PostgresCategoryIconDeliveryHolds(
      database,
    ),
  ) {
    this.exact = new ExactMediaDeliveryService(database, storage, budget);
  }
  open(
    credential: string,
    request: CategoryIconMediaReadRequest,
    variant: MediaVariantName,
    range?: string,
  ): Promise<AuthorizedMediaStream> {
    if (
      !credential ||
      !['download', 'management-preview'].includes(request.purpose)
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    mediaV2IdSchema.parse(request.categoryId);
    mediaV2IdSchema.parse(request.appearanceId);
    mediaV2IdSchema.parse(request.contextId);
    mediaV2IdSchema.parse(request.requestId);
    mediaVariantSchema.parse(variant);
    if (!/^[A-Za-z0-9_-]{43}$/.test(request.contextToken))
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const snapshot = Object.freeze({ ...request });
    let enrolled = false;
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
          plan.categoryId !== snapshot.categoryId ||
          plan.parent.resourceId !== snapshot.appearanceId ||
          plan.variant !== variant ||
          plan.contextId !== snapshot.contextId ||
          plan.contextToken !== snapshot.contextToken
        )
          throw new ApplicationError('MEDIA_UNAVAILABLE');
        mediaV2IdSchema.parse(plan.principal.accountId);
        mediaV2IdSchema.parse(plan.principal.sessionId);
        categoryIconMediaParentSchema.parse(plan.parent);
        const qualification = categoryIconMediaQualificationSchema.parse(
          plan.qualification,
        );
        if (
          (snapshot.purpose === 'management-preview') !==
          ('kind' in qualification && qualification.kind === 'management-root')
        )
          throw new ApplicationError('MEDIA_UNAVAILABLE');
        mediaV2IdSchema.parse(plan.bindingId);
        mediaDigestSchema.parse(plan.ownerRevision);
        mediaDigestSchema.parse(plan.reviewRevision);
        mediaDigestSchema.parse(plan.manifestDigest);
        if (enrolled) await this.holds.requireCurrent(snapshot, plan, tx);
        else {
          await this.holds.enroll(snapshot, plan, tx);
          enrolled = true;
        }
        return plan;
      },
      (plan) => `account:${plan.principal.accountId}`,
      range,
      (plan) => this.holds.closeQuiet(snapshot, plan),
    );
  }
}
