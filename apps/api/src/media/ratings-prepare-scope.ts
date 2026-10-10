import type { PoolClient } from 'pg';
import type { PrepareRatingsMediaInput } from './contracts-ratings.js';
import { MediaPrepareScopes } from './prepare-scope.js';
import { ApplicationError } from '../http/application-error.js';

export interface AuthorizedRatingsMediaEdit {
  readonly actorAccountId: string;
  readonly serverScopeId: string;
  readonly scopeRevision: string;
  readonly expiresAt: number;
  readonly ownerKind: 'ratings';
  readonly resourceKind: 'target_cover';
  readonly targetKind: 'edit';
  readonly contentVersion: 1;
  readonly audience: 'content-gated';
  readonly purpose: 'ratings-target-cover-image';
  readonly slot: 'cover';
  readonly ordinal: 0;
}
/** Owner must verify the complete prepared scope, current session/Safety,
 * selector/source/context and target CAS, enrolling its required proof. */
export interface RatingsMediaDraftOwnerPort {
  authorizePrepare(
    actor: string,
    input: PrepareRatingsMediaInput,
    tx: PoolClient,
  ): Promise<AuthorizedRatingsMediaEdit>;
}
export class MediaRatingsPrepareScopes extends MediaPrepareScopes {
  constructor(owner: RatingsMediaDraftOwnerPort) {
    super(
      {
        authorizePrepare: async () => {
          throw new ApplicationError('MEDIA_UNAVAILABLE');
        },
      },
      undefined,
      owner,
    );
  }
}
