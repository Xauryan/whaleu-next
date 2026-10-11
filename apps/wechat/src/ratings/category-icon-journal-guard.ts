import { ClientError } from '../api/errors';
import type { Storage } from '../platform/contracts';
import { ratingId } from './contract';

/** Fresh-write guard only. Recovery of historical journals keeps its original
 * ordering and exact decoders, even when a later journal is malformed. */
export function assertRatingCategoryIconJournalsClear(
  storage: Storage,
  origin: string,
  accountId: string,
): void {
  try {
    if (!ratingId(accountId)) throw new Error('Invalid Ratings account');
    for (const phase of ['uploads', 'command']) {
      const raw = storage.get(
        `whaleu.ratings.pending.v13.${phase}:${origin}:${accountId}`,
      );
      if (raw !== null && raw !== undefined && raw !== '')
        throw new Error('Retained Category icon journal');
    }
  } catch {
    throw new ClientError(
      'storage',
      'Recover the original Ratings category icon request first',
    );
  }
}
