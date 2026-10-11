import type { PoolClient } from 'pg';
import type {
  PrepareErrandMediaInput,
  ErrandMediaSlot,
  ErrandMediaBinding,
} from '../../media/contracts-errand.js';
export interface ErrandMediaActorAuthority {
  readonly actorAccountId: string;
  readonly draftId: string;
  readonly draftRevision: number;
  readonly targetRegionId: string;
  readonly authorityVersion: string;
  readonly expiresAt: number;
}
export interface ErrandMediaReadTarget {
  readonly orderId: string;
  readonly mediaRevision: number;
  readonly slot: ErrandMediaSlot;
  readonly bindingId?: string;
}
export interface ErrandMediaReadAuthority {
  readonly accountId: string;
  readonly sessionId: string;
  readonly orderId: string;
  readonly mediaRevision: number;
  readonly ownerRevision: string;
  readonly draftId: string;
  readonly draftRevision: number;
  readonly actorAccountId: string;
  /** Complete owner-authored expected set, including private siblings. Internal only. */
  readonly media: readonly ErrandMediaBinding[];
}
/** Errands owns draft/Campus/session/Safety authority and calls readableOrder for
 * reads. Private slots are publisher/stored-accepter only, with no admin bypass. */
export interface ErrandMediaAccessPort {
  authorizePrepare(
    actor: string,
    input: PrepareErrandMediaInput,
    tx: PoolClient,
  ): Promise<ErrandMediaActorAuthority>;
  retainDraftCurrent(draftId: string, tx: PoolClient): Promise<void>;
  authorizeRead(
    token: string,
    target: ErrandMediaReadTarget,
    tx: PoolClient,
  ): Promise<ErrandMediaReadAuthority>;
}
