import type { PoolClient } from 'pg';
import { UnavailableMedia } from '../community-policy.js';
import { MediaAssetRepository } from '../../media/asset-repository.js';
import { MediaOwnerProofRegistry } from '../../media/owner-proof.js';

/** Normal-runtime uploads/reads remain unavailable. Owner-authorized logical
 * deletion is a database operation and must still revoke existing bindings when
 * storage/review providers are disabled. Physical cleanup stays durable/pending.
 * DeletionService checks the current actor and owner before calling this port. */
export class UnavailableCommunityMediaAttachment extends UnavailableMedia {
  private readonly assets = new MediaAssetRepository(
    new MediaOwnerProofRegistry([]),
  );

  override async detach(
    kind: 'post' | 'comment' | 'reply',
    id: string,
    tx: PoolClient,
  ): Promise<void> {
    await this.assets.detach(
      {
        ownerKind: 'community',
        resourceKind: kind,
        resourceId: id,
        contentVersion: 1,
      },
      tx,
    );
  }
}
