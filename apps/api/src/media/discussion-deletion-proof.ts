import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { MediaAssetRepository } from './asset-repository.js';
import { collectDiscussionAncestorMedia } from './discussion-ancestor-proof.js';
import { MediaOwnerProofRegistry } from './owner-proof.js';

const assets = new MediaAssetRepository(new MediaOwnerProofRegistry([]));

/** Internal deletion transition only. This leaf neither authorizes a viewer nor
 * creates a delivery capability. Both phases require the explicit collector. */
export async function verifyDiscussionDeletionMedia(
  tx: PoolClient,
  kind: 'comment' | 'reply',
  id: string,
  images: readonly { assetId: string; digest: string }[],
  deleted: boolean,
): Promise<void> {
  const parent = {
    ownerKind: 'community',
    resourceKind: kind,
    resourceId: id,
    contentVersion: 1,
  } as const;
  if (!collectDiscussionAncestorMedia(tx, parent, images))
    throw new ApplicationError('MEDIA_UNAVAILABLE');
  if (deleted) await assets.verifyDeletedContentBindings(parent, images, tx);
  else await assets.verifyContentBindings(parent, images, tx);
}
