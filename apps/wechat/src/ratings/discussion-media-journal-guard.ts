import { ClientError } from '../api/errors';
import type { Storage } from '../platform/contracts';
import { ratingId } from './contract';
/** Called only before a fresh historical write. Existing v1-v11 recovery keeps
 * its original precedence and decoder; unrecognized v12 data is not disposable. */
export function assertRatingDiscussionJournalsClear(
  storage: Storage,
  origin: string,
  accountId: string,
): void {
  try {
    if (!ratingId(accountId)) throw new Error('Invalid Ratings account');
    for (const phase of ['batch', 'command']) {
      const raw = storage.get(
        `whaleu.ratings.pending.v12.${phase}:${origin}:${accountId}`,
      );
      if (raw !== null && raw !== undefined && raw !== '')
        throw new Error('Retained discussion media journal');
    }
  } catch {
    throw new ClientError(
      'storage',
      'Recover the original Ratings discussion image request first',
    );
  }
}
