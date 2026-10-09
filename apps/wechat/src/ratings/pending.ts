import {
  decodeRatingCategoryCreationIntent,
  decodeRatingCategoryCreationReceipt,
  matchRatingCategoryCreationReceipt,
  type RatingCategoryCreationIntent,
  type RatingCategoryCreationReceipt,
} from './category-management-contract';
import {
  decodeRatingTargetOwnerEditingIntent,
  decodeRatingTargetOwnerEditingReceipt,
  matchRatingTargetOwnerEditingReceipt,
  type RatingTargetOwnerEditingIntent,
  type RatingTargetOwnerEditingReceipt,
} from './target-owner-editing-contract';
import {
  decodeRatingTargetOwnerDeletionIntent,
  decodeRatingTargetOwnerDeletionReceipt,
  matchRatingTargetOwnerDeletionReceipt,
  type RatingTargetOwnerDeletionIntent,
  type RatingTargetOwnerDeletionReceipt,
} from './target-owner-deletion-contract';
import {
  decodeRatingTargetCreationIntent,
  decodeRatingTargetCreationReceipt,
  matchRatingTargetCreationReceipt,
  type RatingTargetCreationIntent,
  type RatingTargetCreationReceipt,
} from './management-contract';
import {
  decodeRatingAdminDeletionIntent,
  decodeRatingAdminDeletionReceipt,
  matchRatingAdminDeletionReceipt,
  type RatingAdminDeletionIntent,
  type RatingAdminDeletionReceipt,
} from './deletion-contract';
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
import {
  decodeRatingLikeIntent,
  decodeRatingLikeReceipt,
  matchRatingLikeReceipt,
  type RatingLikeIntent,
  type RatingLikeReceipt,
} from './like-contract';
import {
  decodeRatingSubscriptionIntent,
  decodeRatingSubscriptionReceipt,
  matchRatingSubscriptionReceipt,
  type RatingSubscriptionIntent,
  type RatingSubscriptionReceipt,
} from './subscription-contract';
type RatingV2Intent = RatingIntent | RatingReplyIntent | RatingLikeIntent;
export type RatingCommandIntent =
  | RatingV2Intent
  | RatingSubscriptionIntent
  | RatingAdminDeletionIntent
  | RatingTargetCreationIntent
  | RatingTargetOwnerDeletionIntent
  | RatingTargetOwnerEditingIntent
  | RatingCategoryCreationIntent;
export type RatingCommandReceipt =
  | RatingReceipt
  | RatingReplyReceipt
  | RatingLikeReceipt
  | RatingSubscriptionReceipt
  | RatingAdminDeletionReceipt
  | RatingTargetCreationReceipt
  | RatingTargetOwnerDeletionReceipt
  | RatingTargetOwnerEditingReceipt
  | RatingCategoryCreationReceipt;
export type PendingRating =
  | {
      readonly version: 1;
      readonly accountId: string;
      readonly intent: RatingIntent;
    }
  | {
      readonly version: 2;
      readonly accountId: string;
      readonly intent: RatingV2Intent;
    }
  | {
      readonly version: 3;
      readonly accountId: string;
      readonly intent: RatingSubscriptionIntent;
    }
  | {
      readonly version: 4;
      readonly accountId: string;
      readonly intent: RatingAdminDeletionIntent;
    }
  | {
      readonly version: 5;
      readonly accountId: string;
      readonly intent: RatingTargetCreationIntent;
    }
  | {
      readonly version: 6;
      readonly accountId: string;
      readonly intent: RatingTargetOwnerDeletionIntent;
    }
  | {
      readonly version: 7;
      readonly accountId: string;
      readonly intent: RatingTargetOwnerEditingIntent;
    }
  | {
      readonly version: 8;
      readonly accountId: string;
      readonly intent: RatingCategoryCreationIntent;
    };
export function isRatingCategoryCreationIntent(
  intent: RatingCommandIntent,
): intent is RatingCategoryCreationIntent {
  return intent.operation === 'create_categories';
}
export function isRatingTargetOwnerEditingIntent(
  intent: RatingCommandIntent,
): intent is RatingTargetOwnerEditingIntent {
  return intent.operation === 'edit_target';
}
export function isRatingTargetOwnerDeletionIntent(
  intent: RatingCommandIntent,
): intent is RatingTargetOwnerDeletionIntent {
  return intent.operation === 'delete_target';
}
export function isRatingTargetCreationIntent(
  intent: RatingCommandIntent,
): intent is RatingTargetCreationIntent {
  return intent.operation === 'create_target';
}
export function isRatingAdminDeletionIntent(
  intent: RatingCommandIntent,
): intent is RatingAdminDeletionIntent {
  return (
    intent.operation === 'admin_delete_comment' ||
    intent.operation === 'admin_delete_reply'
  );
}
export function isRatingDeletionContextChanged(error: unknown): boolean {
  return (
    error instanceof ClientError &&
    (error.kind === 'http' || error.kind === 'business') &&
    error.details.httpStatus === 409 &&
    error.details.serverCode === 'RATING_DELETION_CONTEXT_CHANGED'
  );
}
export function isRatingReplyIntent(
  intent: RatingCommandIntent,
): intent is RatingReplyIntent {
  return (
    intent.operation === 'create_reply' || intent.operation === 'delete_reply'
  );
}
export function isRatingLikeIntent(
  intent: RatingCommandIntent,
): intent is RatingLikeIntent {
  return (
    intent.operation === 'set_comment_like' ||
    intent.operation === 'set_reply_like'
  );
}
export function isRatingSubscriptionIntent(
  intent: RatingCommandIntent,
): intent is RatingSubscriptionIntent {
  return intent.operation === 'set_target_subscription';
}
export function decodeRatingCommandIntent(value: unknown): RatingCommandIntent {
  if (isRecord(value) && value.operation === 'create_categories')
    return decodeRatingCategoryCreationIntent(value);
  if (isRecord(value) && value.operation === 'edit_target')
    return decodeRatingTargetOwnerEditingIntent(value);
  if (isRecord(value) && value.operation === 'delete_target')
    return decodeRatingTargetOwnerDeletionIntent(value);
  if (isRecord(value) && value.operation === 'create_target')
    return decodeRatingTargetCreationIntent(value);
  if (
    isRecord(value) &&
    (value.operation === 'admin_delete_comment' ||
      value.operation === 'admin_delete_reply')
  )
    return decodeRatingAdminDeletionIntent(value);
  return isRecord(value) && value.operation === 'set_target_subscription'
    ? decodeRatingSubscriptionIntent(value)
    : decodeRatingV2Intent(value);
}
function decodeRatingV2Intent(value: unknown): RatingV2Intent {
  if (
    isRecord(value) &&
    (value.operation === 'set_comment_like' ||
      value.operation === 'set_reply_like')
  )
    return decodeRatingLikeIntent(value);
  return isRecord(value) &&
    (value.operation === 'create_reply' || value.operation === 'delete_reply')
    ? decodeRatingReplyIntent(value)
    : decodeRatingIntent(value);
}
export function ratingIntentTarget(intent: RatingCommandIntent): string {
  if (
    isRatingCategoryCreationIntent(intent) ||
    isRatingTargetCreationIntent(intent)
  )
    return ''; // No target exists before server preparation.
  return isRatingTargetOwnerEditingIntent(intent) ||
    isRatingTargetOwnerDeletionIntent(intent) ||
    isRatingAdminDeletionIntent(intent) ||
    isRatingReplyIntent(intent) ||
    isRatingLikeIntent(intent) ||
    intent.operation === 'delete_comment'
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
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8,
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
      : version === 2
        ? decodeRatingV2Intent(value.intent)
        : version === 3
          ? decodeRatingSubscriptionIntent(value.intent)
          : version === 4
            ? decodeRatingAdminDeletionIntent(value.intent)
            : version === 5
              ? decodeRatingTargetCreationIntent(value.intent)
              : version === 6
                ? decodeRatingTargetOwnerDeletionIntent(value.intent)
                : version === 7
                  ? decodeRatingTargetOwnerEditingIntent(value.intent)
                  : decodeRatingCategoryCreationIntent(value.intent);
  if (!equal(intent, value.intent)) invalidRating();
  return Object.freeze({ version, accountId, intent }) as PendingRating;
}
/** One immutable command per origin/account. Recovery order is v1, v2, v3, v4, v5, v6, v7, v8; every original key and payload stays unchanged. */
export class PendingRatingStore {
  constructor(
    private readonly storage: Storage,
    private readonly origin: string,
  ) {}
  private key(
    accountId: string,
    version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8,
  ): string {
    if (!ratingId(accountId)) throw unavailable();
    return `whaleu.ratings.pending.v${version}:${this.origin}:${accountId}`;
  }
  private read(
    accountId: string,
    version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8,
  ): PendingRating | null {
    const raw = this.storage.get(this.key(accountId, version));
    return raw === undefined || raw === null || raw === ''
      ? null
      : decode(raw, accountId, version);
  }
  load(accountId: string): PendingRating | null {
    try {
      return (
        this.read(accountId, 1) ??
        this.read(accountId, 2) ??
        this.read(accountId, 3) ??
        this.read(accountId, 4) ??
        this.read(accountId, 5) ??
        this.read(accountId, 6) ??
        this.read(accountId, 7) ??
        this.read(accountId, 8)
      );
    } catch {
      throw unavailable();
    }
  }
  freeze(raw: PendingRating): PendingRating {
    try {
      exact(raw, ['version', 'accountId', 'intent']);
      if (
        ![1, 2, 3, 4, 5, 6, 7, 8].includes(raw.version) ||
        !ratingId(raw.accountId)
      )
        invalidRating();
      const attempt = Object.freeze({
        version: raw.version,
        accountId: raw.accountId,
        intent:
          raw.version === 1
            ? decodeRatingIntent(raw.intent)
            : raw.version === 2
              ? decodeRatingV2Intent(raw.intent)
              : raw.version === 3
                ? decodeRatingSubscriptionIntent(raw.intent)
                : raw.version === 4
                  ? decodeRatingAdminDeletionIntent(raw.intent)
                  : raw.version === 5
                    ? decodeRatingTargetCreationIntent(raw.intent)
                    : raw.version === 6
                      ? decodeRatingTargetOwnerDeletionIntent(raw.intent)
                      : raw.version === 7
                        ? decodeRatingTargetOwnerEditingIntent(raw.intent)
                        : decodeRatingCategoryCreationIntent(raw.intent),
      }) as PendingRating;
      // Read every version before writing. Any old unresolved or untrusted journal blocks a new command.
      const old1 = this.read(attempt.accountId, 1),
        old2 = this.read(attempt.accountId, 2),
        old3 = this.read(attempt.accountId, 3),
        old4 = this.read(attempt.accountId, 4),
        old5 = this.read(attempt.accountId, 5),
        old6 = this.read(attempt.accountId, 6),
        old7 = this.read(attempt.accountId, 7),
        old8 = this.read(attempt.accountId, 8);
      if (
        [old1, old2, old3, old4, old5, old6, old7, old8].some(
          (old) => old && !equal(old, attempt),
        )
      )
        throw unavailable();
      if (!old1 && !old2 && !old3 && !old4 && !old5 && !old6 && !old7 && !old8)
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
  /** Only the replay-first DELETE's definitive rollback permits a fresh context/key. */
  releaseChangedAdminContext(attempt: PendingRating, error: unknown): void {
    if (attempt.version !== 4 || !isRatingDeletionContextChanged(error))
      invalidRating();
    try {
      this.assertOriginal(attempt);
      this.storage.remove(this.key(attempt.accountId, 4));
      if (this.read(attempt.accountId, 4)) throw unavailable();
    } catch {
      throw unavailable();
    }
  }
  settle(
    attempt: PendingRating,
    raw: RatingCommandReceipt,
  ): RatingCommandReceipt {
    let receipt: RatingCommandReceipt;
    if (isRatingCategoryCreationIntent(attempt.intent)) {
      receipt = decodeRatingCategoryCreationReceipt(raw);
      matchRatingCategoryCreationReceipt(attempt.intent, receipt);
    } else if (isRatingTargetOwnerEditingIntent(attempt.intent)) {
      receipt = decodeRatingTargetOwnerEditingReceipt(raw);
      matchRatingTargetOwnerEditingReceipt(attempt.intent, receipt);
    } else if (isRatingTargetOwnerDeletionIntent(attempt.intent)) {
      receipt = decodeRatingTargetOwnerDeletionReceipt(raw);
      matchRatingTargetOwnerDeletionReceipt(attempt.intent, receipt);
    } else if (isRatingTargetCreationIntent(attempt.intent)) {
      receipt = decodeRatingTargetCreationReceipt(raw);
      matchRatingTargetCreationReceipt(attempt.intent, receipt);
    } else if (isRatingAdminDeletionIntent(attempt.intent)) {
      receipt = decodeRatingAdminDeletionReceipt(raw);
      matchRatingAdminDeletionReceipt(attempt.intent, receipt);
    } else if (isRatingSubscriptionIntent(attempt.intent)) {
      receipt = decodeRatingSubscriptionReceipt(raw);
      matchRatingSubscriptionReceipt(attempt.intent, receipt);
    } else if (isRatingLikeIntent(attempt.intent)) {
      receipt = decodeRatingLikeReceipt(raw);
      matchRatingLikeReceipt(attempt.intent, receipt);
    } else if (isRatingReplyIntent(attempt.intent)) {
      receipt = decodeRatingReplyReceipt(raw);
      matchRatingReplyReceipt(attempt.intent, receipt);
    } else {
      receipt = decodeRatingReceipt(raw);
      matchRatingReceipt(attempt.intent, receipt);
    }
    let removing = false;
    try {
      this.assertOriginal(attempt);
      removing = true;
      this.storage.remove(this.key(attempt.accountId, attempt.version));
      if (this.read(attempt.accountId, attempt.version)) throw unavailable();
    } catch {
      if (
        (attempt.version === 6 ||
          attempt.version === 7 ||
          attempt.version === 8) &&
        removing
      ) {
        // A failed settle/read-back must not silently lose the only recovery key.
        try {
          this.storage.set(
            this.key(attempt.accountId, attempt.version),
            attempt,
          );
        } catch {
          // Surface storage failure; never manufacture successful settlement.
        }
      }
      throw unavailable();
    }
    return receipt;
  }
}
