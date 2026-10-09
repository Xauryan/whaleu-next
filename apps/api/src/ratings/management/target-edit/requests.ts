import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../community/content-review/contracts.js';
import type { PrepareRatingTargetEdit } from './contracts.js';
export function ratingTargetEditIntentHash(
  intent: PrepareRatingTargetEdit,
): string {
  return createHash('sha256')
    .update(
      'whaleu:rating-target-edit:v1\n' +
        canonicalJson({ operation: 'edit_target', intent }),
    )
    .digest('hex');
}
