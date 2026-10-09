import type {
  RatingRandomQuery,
  RatingRandomResult,
} from '../src/ratings/random-contract';
import { categoryId, summary, target } from './ratings-helpers';
export const randomResult = (
  query: RatingRandomQuery = { categoryId },
  patch: Partial<RatingRandomResult> = {},
): RatingRandomResult => ({
  context: {
    categoryId: query.categoryId,
    campusId: query.campusId ?? null,
    minimumAverage: query.minimumAverage ?? null,
  },
  candidateCount: 100,
  item: { regionId: null, target: target(), summary: summary(5) },
  ...patch,
});
