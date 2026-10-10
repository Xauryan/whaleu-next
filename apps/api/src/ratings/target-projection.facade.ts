import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import type { RatingContentReviewFacade } from '../community/content-review/rating-content-review.facade.js';
import type { RatingCatalog, RatingsRepository } from './repository.js';

/** One current-definition qualification gate for all public Ratings owners. */
export async function qualifyCurrentRatingTarget(
  records: RatingsRepository,
  review: RatingContentReviewFacade,
  catalog: RatingCatalog,
  id: string,
  tx: PoolClient,
  write = false,
) {
  const result = await records.target(catalog, id, tx, write);
  if (
    result.row.definition.envelope.version === 6 &&
    result.row.definition.envelope.cover !== null
  )
    throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
  const decision = await review.currentTargetDefinition(
    result.row.definition,
    tx,
  );
  if (decision.kind === 'deny') throw new ApplicationError('RATING_NOT_FOUND');
  if (decision.kind !== 'allow')
    throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
  return result;
}
