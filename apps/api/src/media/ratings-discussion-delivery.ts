import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { ExactMediaDeliveryService } from './delivery.js';
import type {
  ExactMediaDeliveryPlan,
  MediaTransactionRunner,
  AuthorizedMediaStream,
} from './delivery.js';
import type { MediaDeliveryBudgetPool } from './delivery-budget.js';
import type { ImmutableMediaStorage } from './storage-port.js';
import type { MediaVariantName } from './contracts.js';
import { mediaIdSchema, mediaVariantSchema } from './contracts.js';
import { ratingsDiscussionMediaParentSchema } from './contracts-ratings-discussion.js';
import type { RatingsDiscussionMediaParent } from './contracts-ratings-discussion.js';
import type { RatingsMediaPrincipal } from './ratings-owner-proof.js';
import type { RatingsDiscussionMediaReadRequest } from './ratings-discussion-owner-proof.js';
export interface RatingsDiscussionMediaDeliveryPlan extends ExactMediaDeliveryPlan {
  readonly parent: RatingsDiscussionMediaParent;
  readonly principal: RatingsMediaPrincipal;
  readonly ownerRevision: string;
  readonly reviewRevision: string;
  readonly subjectRevision: string;
  readonly contextId: string;
  readonly contextToken: string;
  readonly bindingId: string;
  readonly ordinal: number;
  readonly variant: MediaVariantName;
  readonly manifestDigest: string;
  readonly safetyRevision: string;
}
export interface CurrentRatingsDiscussionMediaDeliveryAuthorizer {
  authorize(
    token: string,
    request: RatingsDiscussionMediaReadRequest,
    bindingId: string,
    ordinal: number,
    variant: MediaVariantName,
    tx: PoolClient,
  ): Promise<RatingsDiscussionMediaDeliveryPlan>;
}
/** The SAME injected application budget is shared with Community/Profile/cover:
 * 64 delivery credits globally, two per authenticated account, no extra pool. */
export class RatingsDiscussionMediaDeliveryService {
  private readonly exact: ExactMediaDeliveryService;
  constructor(
    database: MediaTransactionRunner,
    private readonly authorizer: CurrentRatingsDiscussionMediaDeliveryAuthorizer,
    storage: ImmutableMediaStorage,
    budget: MediaDeliveryBudgetPool,
  ) {
    this.exact = new ExactMediaDeliveryService(database, storage, budget);
  }
  open(
    token: string,
    request: RatingsDiscussionMediaReadRequest,
    bindingId: string,
    ordinal: number,
    variant: MediaVariantName,
    range?: string,
  ): Promise<AuthorizedMediaStream> {
    if (
      !token ||
      request.purpose !== 'download' ||
      !Number.isInteger(ordinal) ||
      ordinal < 0 ||
      ordinal >= (request.replyId === null ? 9 : 3)
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    mediaIdSchema.parse(bindingId);
    mediaVariantSchema.parse(variant);
    const snapshot = Object.freeze({ ...request });
    return this.exact.open(
      async (tx) => {
        const plan = await this.authorizer.authorize(
          token,
          snapshot,
          bindingId,
          ordinal,
          variant,
          tx,
        );
        const parent = ratingsDiscussionMediaParentSchema.parse(plan.parent);
        if (
          plan.principal.kind !== 'authenticatedRatings' ||
          parent.targetId !== snapshot.targetId ||
          parent.resourceId !== (snapshot.replyId ?? snapshot.rootId) ||
          (parent.resourceKind === 'rating_reply') !==
            (snapshot.replyId !== null) ||
          (parent.resourceKind === 'rating_reply' &&
            parent.rootId !== snapshot.rootId) ||
          plan.subjectRevision !== snapshot.subjectRevision ||
          plan.contextId !== snapshot.contextId ||
          plan.contextToken !== snapshot.contextToken ||
          plan.bindingId !== bindingId ||
          plan.ordinal !== ordinal ||
          plan.variant !== variant
        )
          throw new ApplicationError('MEDIA_UNAVAILABLE');
        mediaIdSchema.parse(plan.principal.accountId);
        mediaIdSchema.parse(plan.principal.sessionId);
        return plan;
      },
      (plan) => `account:${plan.principal.accountId}`,
      range,
    );
  }
}
