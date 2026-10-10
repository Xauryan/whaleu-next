import type { Decision } from '../community-policy.js';
import type { PoolClient } from 'pg';
import type { ContentKind } from './contracts.js';
import {
  MediaAssetRepository,
  MediaCurrentDenied,
} from '../../media/asset-repository.js';
import { MediaOwnerProofRegistry } from '../../media/owner-proof.js';

export const CONTENT_MEDIA_PROOF = Symbol('CONTENT_MEDIA_PROOF');
export interface ContentMediaProof {
  current(
    kind: ContentKind,
    id: string,
    images: readonly { assetId: string; digest: string }[],
    tx: PoolClient,
  ): Promise<Decision>;
}
export class UnavailableContentMediaProof implements ContentMediaProof {
  async current(): Promise<Decision> {
    return { kind: 'unavailable' };
  }
}
/** Test/deployment DI leaf: actual immutable binding, manifest, current safety
 * and mandatory final Media proof. Never substitutes for the business owner. */
export class CurrentContentMediaProof implements ContentMediaProof {
  private readonly assets = new MediaAssetRepository(
    new MediaOwnerProofRegistry([]),
  );
  async current(
    kind: ContentKind,
    id: string,
    images: readonly { assetId: string; digest: string }[],
    tx: PoolClient,
  ): Promise<Decision> {
    try {
      await this.assets.verifyContentBindings(
        {
          ownerKind: 'community',
          resourceKind: kind,
          resourceId: id,
          contentVersion: 1,
        },
        images,
        tx,
      );
      return { kind: 'allow', value: undefined };
    } catch (error) {
      if (error instanceof MediaCurrentDenied)
        return { kind: 'deny', reason: 'POST_NOT_FOUND' };
      throw error;
    }
  }
}
