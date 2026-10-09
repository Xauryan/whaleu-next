import { createHash } from 'node:crypto';
import { canonicalJson } from '../../community/content-review/contracts.js';
import type { PrepareRatingCategories } from './contracts.js';
export function ratingCategoryIntentHash(
  intent: PrepareRatingCategories,
): string {
  return createHash('sha256')
    .update(
      'whaleu:rating-category-create:v1\n' +
        canonicalJson({ operation: 'create_categories', intent }),
    )
    .digest('hex');
}
