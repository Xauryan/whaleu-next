import type { PoolClient } from 'pg';
import type {
  RatingsDiscussionBatchIdentity,
  RatingsDiscussionMemberPrepare,
} from './contracts-ratings-discussion.js';
import { ApplicationError } from '../http/application-error.js';
import { MediaPrepareScopes } from './prepare-scope.js';

export interface AuthorizedRatingsDiscussionBatch {
  readonly actorAccountId: string;
  readonly serverScopeId: string;
  readonly scopeRevision: string;
  readonly expiresAt: number;
  readonly batchIdentity: RatingsDiscussionBatchIdentity;
  readonly ownerKind: 'ratings';
  readonly resourceKind: 'rating_comment' | 'rating_reply';
  readonly targetKind: 'draft';
  readonly contentVersion: 1;
  readonly audience: 'content-gated';
  readonly purpose: 'ratings-comment-image' | 'ratings-reply-image';
  readonly slot: 'images';
}
export interface AuthorizedRatingsDiscussionDraft extends AuthorizedRatingsDiscussionBatch {
  readonly ordinal: number;
}
/** Ratings retains session, context, target/root CAS and publication authority.
 * Both methods enroll Ratings current proofs in this exact owner transaction.
 * Member authorization resolves the immutable Media batch only as a lookup hint. */
export interface RatingsDiscussionMediaDraftOwnerPort {
  authorizeBatch(
    actor: string,
    identity: RatingsDiscussionBatchIdentity,
    tx: PoolClient,
  ): Promise<AuthorizedRatingsDiscussionBatch>;
  authorizePrepare(
    actor: string,
    input: RatingsDiscussionMemberPrepare,
    tx: PoolClient,
  ): Promise<AuthorizedRatingsDiscussionDraft>;
}
export class MediaRatingsDiscussionPrepareScopes extends MediaPrepareScopes {
  constructor(owner: RatingsDiscussionMediaDraftOwnerPort) {
    super(
      {
        authorizePrepare: async () => {
          throw new ApplicationError('MEDIA_UNAVAILABLE');
        },
      },
      undefined,
      undefined,
      owner,
    );
  }
}
