import type { PoolClient } from 'pg';
import type { PrepareCategoryIconMediaInput } from './contracts-category-icon.js';
import { MediaPrepareScopes } from './prepare-scope.js';
import { ApplicationError } from '../http/application-error.js';

export interface AuthorizedCategoryIconMediaEdit {
  readonly actorAccountId: string;
  readonly serverScopeId: string;
  readonly scopeRevision: string;
  readonly expiresAt: number;
  readonly ownerKind: 'ratings';
  readonly resourceKind: 'category_icon';
  readonly targetKind: 'edit';
  readonly contentVersion: 1;
  readonly audience: 'content-gated';
  readonly purpose: 'ratings-category-icon-image';
  readonly slot: 'icon';
  readonly ordinal: 0;
}
/** Owner must verify the complete prepared scope, current session/Safety,
 * all-of Category management authority, selector/source/context and original release CAS, enrolling its required proof. */
export interface CategoryIconMediaDraftOwnerPort {
  authorizePrepare(
    actor: string,
    input: PrepareCategoryIconMediaInput,
    tx: PoolClient,
  ): Promise<AuthorizedCategoryIconMediaEdit>;
}
export class MediaCategoryIconPrepareScopes extends MediaPrepareScopes {
  constructor(owner: CategoryIconMediaDraftOwnerPort) {
    super(
      {
        authorizePrepare: async () => {
          throw new ApplicationError('MEDIA_UNAVAILABLE');
        },
      },
      undefined,
      undefined,
      undefined,
      owner,
    );
  }
}
