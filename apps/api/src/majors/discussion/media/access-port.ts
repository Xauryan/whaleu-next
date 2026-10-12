import type { PoolClient } from 'pg';
import type {
  PrepareMajorDiscussionMediaInput,
  MajorDiscussionReference,
  MajorDiscussionMediaBinding,
} from '../../../media/contracts-major-discussion.js';
export interface MajorDiscussionMediaActorAuthority {
  readonly actorAccountId: string;
  readonly contextDigest: string;
  readonly expiresAt: number;
}
export type MajorDiscussionMediaReadTarget = MajorDiscussionReference;
export interface MajorDiscussionMediaReadAuthority {
  readonly accountId: string;
  readonly sessionId: string;
  readonly actorAccountId: string;
  readonly majorId: string;
  readonly commentId: string;
  readonly publicationRequestId: string;
  readonly contextDigest: string;
  readonly ownerRevision: string;
  /** The complete immutable owner-authored ordered set, never just the selected image. */
  readonly images: readonly MajorDiscussionMediaBinding[];
}
/** Major owns source/history/phone/Safety/session, root ancestry and ContentReview.
 * All positive operations retain the owner's current proof through transaction commit. */
export interface MajorDiscussionMediaAccessPort {
  authorizePrepare(
    actor: string,
    input: PrepareMajorDiscussionMediaInput,
    tx: PoolClient,
  ): Promise<MajorDiscussionMediaActorAuthority>;
  /** Re-read every prepare dependency after Media own writes, retaining owner proof. */
  retainCurrent(tx: PoolClient): Promise<unknown>;
  authorizeRead(
    token: string,
    reference: MajorDiscussionReference,
    tx: PoolClient,
  ): Promise<MajorDiscussionMediaReadAuthority>;
}
