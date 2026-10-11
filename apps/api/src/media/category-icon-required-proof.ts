import type { PoolClient } from 'pg';
import { requiredOwnerEpoch } from '../database/required-owner-proof.js';
import { MediaRequiredProof, mediaCountProofOwner } from './required-proof.js';

/** Typed8-only final fence. Historical paths never inspect Media8 relations.
 * Shared epoch admission already observes every raw/zero-row/TRUNCATE writer;
 * this also fences the independently retained request marker explicitly. */
export class CategoryIconMediaRequiredProof extends MediaRequiredProof {
  private readonly categoryIconEnroll = requiredOwnerEpoch(
    {
      order: mediaCountProofOwner.order,
      capture: mediaCountProofOwner.capture,
      fence: async (tx) => {
        if (!(await mediaCountProofOwner.fence(tx))) return false;
        await tx.query(
          'LOCK TABLE whaleu_media.category_icon_request_markers IN SHARE MODE NOWAIT',
        );
        return true;
      },
    },
    'MEDIA_UNAVAILABLE',
  );
  override capture(tx: PoolClient): Promise<string> {
    return this.categoryIconEnroll(tx);
  }
}
