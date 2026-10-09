import { ClientError } from '../api/errors';
import { exact } from '../community/contract';
import type { Storage } from '../platform/contracts';
import {
  decodeRatingIntent,
  decodeRatingReceipt,
  invalidRating,
  matchRatingReceipt,
  ratingId,
  type RatingIntent,
  type RatingReceipt,
} from './contract';
export interface PendingRating {
  readonly version: 1;
  readonly accountId: string;
  readonly intent: RatingIntent;
}
const equal = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
const unavailable = (): ClientError =>
  new ClientError('storage', 'Rating recovery storage unavailable');
function decode(value: unknown, accountId: string): PendingRating {
  exact(value, ['version', 'accountId', 'intent']);
  if (
    value.version !== 1 ||
    !ratingId(accountId) ||
    value.accountId !== accountId
  )
    invalidRating();
  const intent = decodeRatingIntent(value.intent);
  // Frozen storage must already be canonical: no silent rewrite of an uncertain command.
  if (!equal(intent, value.intent)) invalidRating();
  return Object.freeze({ version: 1, accountId, intent });
}
/** One immutable command per account and API origin. Missing/unknown receipts never release it. */
export class PendingRatingStore {
  constructor(
    private readonly storage: Storage,
    private readonly origin: string,
  ) {}
  private key(accountId: string): string {
    if (!ratingId(accountId)) throw unavailable();
    return `whaleu.ratings.pending.v1:${this.origin}:${accountId}`;
  }
  load(accountId: string): PendingRating | null {
    try {
      const raw = this.storage.get(this.key(accountId));
      return raw === undefined || raw === null || raw === ''
        ? null
        : decode(raw, accountId);
    } catch {
      throw unavailable();
    }
  }
  freeze(raw: PendingRating): PendingRating {
    try {
      exact(raw, ['version', 'accountId', 'intent']);
      if (raw.version !== 1 || !ratingId(raw.accountId)) invalidRating();
      const attempt = Object.freeze({
        version: 1 as const,
        accountId: raw.accountId,
        intent: decodeRatingIntent(raw.intent),
      });
      const old = this.load(attempt.accountId);
      if (old && !equal(old, attempt)) throw unavailable();
      if (!old) this.storage.set(this.key(attempt.accountId), attempt);
      this.assertOriginal(attempt);
      return attempt;
    } catch {
      throw unavailable();
    }
  }
  assertOriginal(attempt: PendingRating): void {
    if (!equal(this.load(attempt.accountId), attempt)) throw unavailable();
  }
  settle(attempt: PendingRating, raw: RatingReceipt): RatingReceipt {
    const receipt = decodeRatingReceipt(raw);
    matchRatingReceipt(attempt.intent, receipt);
    try {
      this.assertOriginal(attempt);
      this.storage.remove(this.key(attempt.accountId));
      if (this.load(attempt.accountId)) throw unavailable();
    } catch {
      throw unavailable();
    }
    return receipt;
  }
}
