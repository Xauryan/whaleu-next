import type { PoolClient } from 'pg';
import type {
  PrepareWindowDiscussionMediaInput,
  WindowDiscussionReference,
  WindowDiscussionMediaBinding,
} from '../../../../media/contracts-window-discussion.js';
export interface WindowDiscussionMediaActorAuthority {
  readonly actorAccountId: string;
  readonly contextDigest: string;
  readonly expiresAt: number;
}
export type WindowDiscussionMediaReadTarget = WindowDiscussionReference;
export interface WindowDiscussionMediaReadAuthority {
  readonly accountId: string;
  readonly sessionId: string;
  readonly actorAccountId: string;
  readonly windowId: string;
  readonly commentId: string;
  readonly publicationRequestId: string;
  readonly contextDigest: string;
  readonly ownerRevision: string;
  /** The complete immutable owner-authored ordered set, never just the selected image. */
  readonly images: readonly WindowDiscussionMediaBinding[];
}
/** Window owns source/history/phone/Safety/session, root ancestry and ContentReview.
 * All positive operations retain the owner's current proof through transaction commit. */
export interface WindowDiscussionMediaAccessPort {
  authorizePrepare(
    actor: string,
    input: PrepareWindowDiscussionMediaInput,
    tx: PoolClient,
  ): Promise<WindowDiscussionMediaActorAuthority>;
  /** Re-read every prepare dependency after Media own writes, retaining owner proof. */
  retainCurrent(tx: PoolClient): Promise<unknown>;
  authorizeRead(
    token: string,
    reference: WindowDiscussionReference,
    tx: PoolClient,
  ): Promise<WindowDiscussionMediaReadAuthority>;
}
