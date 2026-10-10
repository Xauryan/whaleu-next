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
import type { ProfileMediaParent } from './contracts-profile.js';
import type {
  ProfileMediaPrincipal,
  ProfileMediaReadRequest,
} from './profile-owner-proof.js';
import { ApplicationError } from '../http/application-error.js';

export interface ProfileMediaDeliveryPlan extends ExactMediaDeliveryPlan {
  readonly parent: ProfileMediaParent;
  readonly profileId: string;
  readonly bindingId: string;
  readonly principal: ProfileMediaPrincipal;
  readonly ownerRevision: string;
  readonly reviewRevision: string;
  readonly variant: MediaVariantName;
  readonly manifestDigest: string;
  readonly safetyRevision: string;
}
export interface CurrentProfileMediaDeliveryAuthorizer {
  authorize(
    credential: string | null,
    request: ProfileMediaReadRequest,
    variant: MediaVariantName,
    tx: PoolClient,
  ): Promise<ProfileMediaDeliveryPlan>;
}
/** The same exact-byte engine serves Profile with a separate trusted owner.
 * Guest budget identity is a server-issued connection key, never an account ID. */
export class ProfileMediaDeliveryService {
  private readonly exact: ExactMediaDeliveryService;
  constructor(
    database: MediaTransactionRunner,
    private readonly authorizer: CurrentProfileMediaDeliveryAuthorizer,
    storage: ImmutableMediaStorage,
    budget: MediaDeliveryBudgetPool,
  ) {
    this.exact = new ExactMediaDeliveryService(database, storage, budget);
  }
  open(
    credential: string | null,
    request: ProfileMediaReadRequest,
    variant: MediaVariantName,
    connectionKey: string,
    range?: string,
  ): Promise<AuthorizedMediaStream> {
    if (
      !connectionKey ||
      connectionKey.length > 200 ||
      request.purpose !== 'download'
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return this.exact.open(
      (tx) => this.authorizer.authorize(credential, request, variant, tx),
      (plan) =>
        plan.principal.kind === 'session'
          ? `account:${plan.principal.accountId}`
          : `guest-connection:${connectionKey}`,
      range,
    );
  }
}
