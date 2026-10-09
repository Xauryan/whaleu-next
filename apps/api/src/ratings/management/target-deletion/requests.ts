import { createHash } from 'node:crypto';
import type { RatingTargetDeletionIntent } from './contracts.js';
import { canonicalJson } from '../../../community/content-review/contracts.js';
export function ratingTargetOwnerDeletionIntentHash(
  intent: RatingTargetDeletionIntent,
) {
  return createHash('sha256')
    .update(
      'whaleu:rating-target-delete:v1\n' +
        canonicalJson({ operation: 'delete_target', intent }),
    )
    .digest('hex');
}
