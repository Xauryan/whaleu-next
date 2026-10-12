import type { PoolClient } from 'pg';
import type {
  PreparePrivateMessageMediaInput,
  PrivateMessageMediaBinding,
} from '../../media/contracts-private-message.js';
export interface PrivateMessageMediaActorAuthority {
  readonly actorAccountId: string;
  readonly conversationId: string;
  readonly messageRequestId: string;
  readonly contextDigest: string;
  readonly expiresAt: number;
}
export interface PrivateMessageMediaReadTarget {
  readonly conversationId: string;
  readonly messageId: string;
  readonly bindingId?: string;
}
export interface PrivateMessageMediaReadAuthority {
  readonly accountId: string;
  readonly sessionId: string;
  readonly actorAccountId: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly messageRequestId: string;
  readonly contextDigest: string;
  readonly ownerRevision: string;
  readonly image: PrivateMessageMediaBinding;
}
/** Messaging owns current session, eligibility, membership, exact MessageReview
 * and message state. Blocking stops prepare/send, never erases retained history.
 * No administrator or request-supplied audience bypass is permitted. */
export interface PrivateMessageMediaAccessPort {
  authorizePrepare(
    actor: string,
    input: PreparePrivateMessageMediaInput,
    tx: PoolClient,
  ): Promise<PrivateMessageMediaActorAuthority>;
  authorizeRead(
    token: string,
    target: PrivateMessageMediaReadTarget,
    tx: PoolClient,
  ): Promise<PrivateMessageMediaReadAuthority>;
  retainCurrent(tx: PoolClient): Promise<unknown>;
  /** Session-only original-command closure. Under the same actor/request lock as
   * send_image, fence an unknown command or require its durable rejection. A
   * committed send must never become a cancellation of its bound media. */
  assertSendFenced(
    actor: string,
    target: { conversationId: string; messageRequestId: string },
    tx: PoolClient,
  ): Promise<void>;
}
