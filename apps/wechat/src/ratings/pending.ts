import { ClientError, isRecord } from '../api/errors';
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
import {
  decodeRatingReplyIntent,
  decodeRatingReplyReceipt,
  matchRatingReplyReceipt,
  type RatingReplyIntent,
  type RatingReplyReceipt,
} from './discussion-contract';
export type RatingCommandIntent = RatingIntent | RatingReplyIntent;
export type RatingCommandReceipt = RatingReceipt | RatingReplyReceipt;
export type PendingRating =
  | {
      readonly version: 1;
      readonly accountId: string;
      readonly intent: RatingIntent;
    }
  | {
      readonly version: 2;
      readonly accountId: string;
      readonly intent: RatingCommandIntent;
    };
export function isRatingReplyIntent(
  intent: RatingCommandIntent,
): intent is RatingReplyIntent {
  return (
    intent.operation === 'create_reply' || intent.operation === 'delete_reply'
  );
}
export function decodeRatingCommandIntent(value: unknown): RatingCommandIntent {
  return isRecord(value) &&
    (value.operation === 'create_reply' || value.operation === 'delete_reply')
    ? decodeRatingReplyIntent(value)
    : decodeRatingIntent(value);
}
export function ratingIntentTarget(intent: RatingCommandIntent): string {
  return isRatingReplyIntent(intent) || intent.operation === 'delete_comment'
    ? intent.payload.targetId
    : intent.targetId;
}
const equal = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
const unavailable = (): ClientError =>
  new ClientError('storage', 'Rating recovery storage unavailable');
function decode(
  value: unknown,
  accountId: string,
  version: 1 | 2,
): PendingRating {
  exact(value, ['version', 'accountId', 'intent']);
  if (
    value.version !== version ||
    !ratingId(accountId) ||
    value.accountId !== accountId
  )
    invalidRating();
  const intent =
    version === 1
      ? decodeRatingIntent(value.intent)
      : decodeRatingCommandIntent(value.intent);
  if (!equal(intent, value.intent)) invalidRating();
  return Object.freeze({ version, accountId, intent }) as PendingRating;
}
/** One immutable command per origin/account. A legacy v1 is recovered before v2; neither key is rewritten. */
export class PendingRatingStore {
  constructor(
    private readonly storage: Storage,
    private readonly origin: string,
  ) {}
  private key(accountId: string, version: 1 | 2): string {
    if (!ratingId(accountId)) throw unavailable();
    return `whaleu.ratings.pending.v${version}:${this.origin}:${accountId}`;
  }
  private read(accountId: string, version: 1 | 2): PendingRating | null {
    const raw = this.storage.get(this.key(accountId, version));
    return raw === undefined || raw === null || raw === ''
      ? null
      : decode(raw, accountId, version);
  }
  load(accountId: string): PendingRating | null {
    try {
      return this.read(accountId, 1) ?? this.read(accountId, 2);
    } catch {
      throw unavailable();
    }
  }
  freeze(raw: PendingRating): PendingRating {
    try {
      exact(raw, ['version', 'accountId', 'intent']);
      if (![1, 2].includes(raw.version) || !ratingId(raw.accountId))
        invalidRating();
      const attempt = Object.freeze({
        version: raw.version,
        accountId: raw.accountId,
        intent:
          raw.version === 1
            ? decodeRatingIntent(raw.intent)
            : decodeRatingCommandIntent(raw.intent),
      }) as PendingRating;
      // Read both keys before writing. A second key, malformed data or lost read-back cannot authorize a third command.
      const old1 = this.read(attempt.accountId, 1),
        old2 = this.read(attempt.accountId, 2);
      if ([old1, old2].some((old) => old && !equal(old, attempt)))
        throw unavailable();
      if (!old1 && !old2)
        this.storage.set(this.key(attempt.accountId, attempt.version), attempt);
      this.assertOriginal(attempt);
      return attempt;
    } catch {
      throw unavailable();
    }
  }
  assertOriginal(attempt: PendingRating): void {
    if (!equal(this.load(attempt.accountId), attempt)) throw unavailable();
  }
  settle(
    attempt: PendingRating,
    raw: RatingCommandReceipt,
  ): RatingCommandReceipt {
    let receipt: RatingCommandReceipt;
    if (isRatingReplyIntent(attempt.intent)) {
      receipt = decodeRatingReplyReceipt(raw);
      matchRatingReplyReceipt(attempt.intent, receipt);
    } else {
      receipt = decodeRatingReceipt(raw);
      matchRatingReceipt(attempt.intent, receipt);
    }
    try {
      this.assertOriginal(attempt);
      this.storage.remove(this.key(attempt.accountId, attempt.version));
      if (this.read(attempt.accountId, attempt.version)) throw unavailable();
    } catch {
      throw unavailable();
    }
    return receipt;
  }
}
