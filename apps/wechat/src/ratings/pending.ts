import {
  decodeRatingCoverRecovery,
  ratingCoverPrepareHash,
  type RatingCoverRecovery,
} from './target-cover-media-contract';
import {
  decodePendingRatingCoverUpload,
  decodeRatingCoverScopeCancellation,
  type RatingCoverScopeCancellation,
  type PendingRatingCoverUpload,
} from './target-cover-upload-scope';
import {
  decodeRatingTargetCoverIntent,
  decodeRatingTargetCoverReceipt,
  isRatingTargetCoverIntent,
  matchRatingTargetCoverReceipt,
  type RatingTargetCoverIntent,
  type RatingTargetCoverReceipt,
} from './target-cover-contract';
export { isRatingTargetCoverIntent } from './target-cover-contract';
import {
  decodeRatingCategoryScopedIntent,
  decodeRatingCategoryScopedReceipt,
  isRatingCategoryScopedOperation,
  matchRatingCategoryScopedReceipt,
  type RatingCategoryScopedIntent,
  type RatingCategoryScopedReceipt,
} from './category-scoped-contract';
import {
  decodeRatingScopedIntent,
  decodeRatingScopedReceipt,
  isRatingScopedOperation,
  matchRatingScopedReceipt,
  type RatingScopedIntent,
  type RatingScopedReceipt,
} from './scoped-contract';
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
  | RatingTargetCoverIntent
  | RatingSubscriptionIntent
  | RatingAdminDeletionIntent
  | RatingTargetCreationIntent
  | RatingTargetOwnerDeletionIntent
  | RatingTargetOwnerEditingIntent
  | RatingCategoryCreationIntent
  | RatingScopedIntent
  | RatingCategoryScopedIntent;
export type RatingCommandReceipt =
  | RatingReceipt
  | RatingTargetCoverReceipt
  | RatingReplyReceipt
  | RatingLikeReceipt
  | RatingSubscriptionReceipt
  | RatingAdminDeletionReceipt
  | RatingTargetCreationReceipt
  | RatingTargetOwnerDeletionReceipt
  | RatingTargetOwnerEditingReceipt
  | RatingCategoryCreationReceipt
  | RatingScopedReceipt
  | RatingCategoryScopedReceipt;
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
    }
  | {
      readonly version: 9;
      readonly accountId: string;
      readonly intent: RatingScopedIntent;
    }
  | {
      readonly version: 10;
      readonly accountId: string;
      readonly intent: RatingCategoryScopedIntent;
    }
  | {
      readonly version: 11;
      readonly accountId: string;
      readonly intent: RatingTargetCoverIntent;
      readonly upload?: PendingRatingCoverUpload;
    };
export function isRatingCategoryScopedIntent(
  intent: RatingCommandIntent,
): intent is RatingCategoryScopedIntent {
  return isRatingCategoryScopedOperation(intent.operation);
}
export function isRatingScopedIntent(
  intent: RatingCommandIntent,
): intent is RatingScopedIntent {
  return (
    !isRatingTargetCoverIntent(intent) &&
    isRatingScopedOperation(intent.operation)
  );
}
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
  if (isRatingTargetCoverIntent(value))
    return decodeRatingTargetCoverIntent(value);
  if (isRecord(value) && isRatingCategoryScopedOperation(value.operation))
    return decodeRatingCategoryScopedIntent(value);
  if (isRecord(value) && isRatingScopedOperation(value.operation))
    return decodeRatingScopedIntent(value);
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
  if (isRatingTargetCoverIntent(intent))
    return intent.operation === 'create_target_scoped'
      ? ''
      : intent.payload.targetId;
  if (isRatingCategoryScopedIntent(intent)) return '';
  if (isRatingScopedIntent(intent))
    return intent.operation === 'create_target_scoped'
      ? ''
      : intent.payload.targetId;
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
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11,
): PendingRating {
  exact(value, [
    'version',
    'accountId',
    'intent',
    ...(version === 11 && isRecord(value) && 'upload' in value
      ? ['upload']
      : []),
  ]);
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
                  : version === 8
                    ? decodeRatingCategoryCreationIntent(value.intent)
                    : version === 9
                      ? decodeRatingScopedIntent(value.intent)
                      : version === 10
                        ? decodeRatingCategoryScopedIntent(value.intent)
                        : decodeRatingTargetCoverIntent(value.intent);
  if (!equal(intent, value.intent)) invalidRating();
  const upload =
    version === 11 && 'upload' in value
      ? decodePendingRatingCoverUpload(value.upload, accountId)
      : undefined;
  if (upload) matchCoverUploadCommand(upload, intent);
  return Object.freeze({
    version,
    accountId,
    intent,
    ...(upload ? { upload } : {}),
  }) as PendingRating;
}
function matchCoverUploadCommand(
  upload: PendingRatingCoverUpload,
  intent: RatingCommandIntent,
): void {
  if (
    !isRatingTargetCoverIntent(intent) ||
    !upload.scope ||
    upload.status?.status !== 'ready_unbound' ||
    intent.payload.clientRequestId !== upload.scopeInput.commandRequestId ||
    intent.payload.cover.action !== 'replace' ||
    intent.payload.cover.uploadScopeId !== upload.scope.scopeId ||
    intent.payload.cover.assetId !== upload.status.assetId ||
    intent.payload.categoryId !== upload.scopeInput.categoryId ||
    intent.payload.expectedCategoryRevision !==
      upload.scopeInput.expectedCategoryRevision ||
    JSON.stringify(intent.context) !== JSON.stringify(upload.scopeInput.context)
  )
    invalidRating();
  const target = upload.scopeInput.target;
  if (
    intent.operation === 'create_target_scoped'
      ? target !== null
      : target === null ||
        intent.payload.targetId !== target.targetId ||
        intent.payload.expectedTargetRevision !==
          target.expectedTargetRevision ||
        intent.payload.expectedDefinitionRevision !==
          target.expectedDefinitionRevision ||
        intent.payload.expectedContentVersion !== target.expectedContentVersion
  )
    invalidRating();
}
/** One immutable command per origin/account. Recovery order is v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, v11; every original key and payload stays unchanged. */
export class PendingRatingStore {
  constructor(
    private readonly storage: Storage,
    private readonly origin: string,
  ) {}
  private key(
    accountId: string,
    version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11,
  ): string {
    if (!ratingId(accountId)) throw unavailable();
    return `whaleu.ratings.pending.v${version}:${this.origin}:${accountId}`;
  }
  private read(
    accountId: string,
    version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11,
  ): PendingRating | null {
    const raw = this.storage.get(this.key(accountId, version));
    return raw === undefined || raw === null || raw === ''
      ? null
      : decode(raw, accountId, version);
  }
  loadCoverUpload(accountId: string): PendingRatingCoverUpload | null {
    try {
      const raw = this.storage.get(this.key(accountId, 11));
      if (!isRecord(raw) || raw.phase !== 'upload') return null;
      const value = decodePendingRatingCoverUpload(raw, accountId);
      if (!equal(value, raw)) throw unavailable();
      for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const)
        if (this.read(accountId, version)) throw unavailable();
      return value;
    } catch {
      throw unavailable();
    }
  }
  freezeCoverUpload(raw: PendingRatingCoverUpload): PendingRatingCoverUpload {
    try {
      const value = decodePendingRatingCoverUpload(raw, raw.accountId);
      if (value.scope !== null || value.status !== null) throw unavailable();
      const original = this.loadCoverUpload(value.accountId);
      if (original) {
        if (!equal(original, value)) throw unavailable();
        return original;
      }
      // Includes corrupt later slots; no new upload can bypass an existing owner command.
      for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const)
        if (this.read(value.accountId, version)) throw unavailable();
      this.storage.set(this.key(value.accountId, 11), value);
      if (!equal(this.loadCoverUpload(value.accountId), value))
        throw unavailable();
      return value;
    } catch {
      throw unavailable();
    }
  }
  updateCoverUpload(
    original: PendingRatingCoverUpload,
    raw: PendingRatingCoverUpload,
  ): PendingRatingCoverUpload {
    try {
      if (!equal(this.loadCoverUpload(original.accountId), original))
        throw unavailable();
      const value = decodePendingRatingCoverUpload(raw, original.accountId);
      if (
        !equal(value.scopeInput, original.scopeInput) ||
        (original.scope !== null && !equal(original.scope, value.scope))
      )
        throw unavailable();
      this.storage.set(this.key(value.accountId, 11), value);
      if (!equal(this.loadCoverUpload(value.accountId), value))
        throw unavailable();
      return value;
    } catch {
      throw unavailable();
    }
  }
  settleCoverScopeCancellation(
    original: PendingRatingCoverUpload,
    raw: RatingCoverScopeCancellation,
  ): void {
    const result = decodeRatingCoverScopeCancellation(
      raw,
      original.accountId,
      original.scopeInput,
    );
    if (!(
      result.recovery.state === 'cancelled_before_prepare' ||
      (result.recovery.state === 'recorded' &&
        result.recovery.status.status === 'terminal')
    ))
      throw unavailable();
    try {
      if (!equal(this.loadCoverUpload(original.accountId), original))
        throw unavailable();
      this.storage.remove(this.key(original.accountId, 11));
      if (this.storage.get(this.key(original.accountId, 11)))
        throw unavailable();
    } catch {
      try {
        if (!this.storage.get(this.key(original.accountId, 11)))
          this.storage.set(this.key(original.accountId, 11), original);
      } catch {
        /* Preserve uncertainty. */
      }
      throw unavailable();
    }
  }
  settleCoverUploadCancellation(
    original: PendingRatingCoverUpload,
    raw: RatingCoverRecovery,
  ): void {
    try {
      const result = decodeRatingCoverRecovery(raw);
      if (
        !original.scope ||
        result.requestId !== original.scope.prepare.clientRequestId ||
        result.requestHash !==
          ratingCoverPrepareHash(original.accountId, original.scope.prepare) ||
        !(
          result.state === 'cancelled_before_prepare' ||
          (result.state === 'recorded' && result.status.status === 'terminal')
        )
      )
        throw unavailable();
      if (!equal(this.loadCoverUpload(original.accountId), original))
        throw unavailable();
      this.storage.remove(this.key(original.accountId, 11));
      if (this.storage.get(this.key(original.accountId, 11)))
        throw unavailable();
    } catch {
      try {
        if (!this.storage.get(this.key(original.accountId, 11)))
          this.storage.set(this.key(original.accountId, 11), original);
      } catch {
        /* unknown remains blocked */
      }
      throw unavailable();
    }
  }
  sealCoverUpload(
    original: PendingRatingCoverUpload,
    intent: RatingTargetCoverIntent,
  ): Extract<PendingRating, { version: 11 }> {
    try {
      if (!equal(this.loadCoverUpload(original.accountId), original))
        throw unavailable();
      const value = decode(
        {
          version: 11,
          accountId: original.accountId,
          intent,
          upload: original,
        },
        original.accountId,
        11,
      );
      if (value.version !== 11) throw unavailable();
      this.storage.set(this.key(value.accountId, 11), value);
      this.assertOriginal(value);
      return value;
    } catch {
      throw unavailable();
    }
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
        this.read(accountId, 8) ??
        this.read(accountId, 9) ??
        this.read(accountId, 10) ??
        this.read(accountId, 11)
      );
    } catch {
      throw unavailable();
    }
  }
  freeze(raw: PendingRating): PendingRating {
    try {
      exact(raw, [
        'version',
        'accountId',
        'intent',
        ...(raw.version === 11 && 'upload' in raw ? ['upload'] : []),
      ]);
      if (
        ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].includes(raw.version) ||
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
                        : raw.version === 8
                          ? decodeRatingCategoryCreationIntent(raw.intent)
                          : raw.version === 9
                            ? decodeRatingScopedIntent(raw.intent)
                            : raw.version === 10
                              ? decodeRatingCategoryScopedIntent(raw.intent)
                              : decodeRatingTargetCoverIntent(raw.intent),
        ...(raw.version === 11 && raw.upload
          ? {
              upload: decodePendingRatingCoverUpload(raw.upload, raw.accountId),
            }
          : {}),
      }) as PendingRating;
      if (attempt.version === 11 && attempt.upload)
        matchCoverUploadCommand(attempt.upload, attempt.intent);
      // Read every version before writing. Any old unresolved or untrusted journal blocks a new command.
      const old1 = this.read(attempt.accountId, 1),
        old2 = this.read(attempt.accountId, 2),
        old3 = this.read(attempt.accountId, 3),
        old4 = this.read(attempt.accountId, 4),
        old5 = this.read(attempt.accountId, 5),
        old6 = this.read(attempt.accountId, 6),
        old7 = this.read(attempt.accountId, 7),
        old8 = this.read(attempt.accountId, 8),
        old9 = this.read(attempt.accountId, 9),
        old10 = this.read(attempt.accountId, 10),
        old11 = this.read(attempt.accountId, 11);
      if (
        [
          old1,
          old2,
          old3,
          old4,
          old5,
          old6,
          old7,
          old8,
          old9,
          old10,
          old11,
        ].some((old) => old && !equal(old, attempt))
      )
        throw unavailable();
      if (
        !old1 &&
        !old2 &&
        !old3 &&
        !old4 &&
        !old5 &&
        !old6 &&
        !old7 &&
        !old8 &&
        !old9 &&
        !old10 &&
        !old11
      )
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
    if (isRatingTargetCoverIntent(attempt.intent)) {
      receipt = decodeRatingTargetCoverReceipt(raw);
      matchRatingTargetCoverReceipt(attempt.intent, receipt);
      if (
        attempt.version === 11 &&
        attempt.upload?.scope &&
        receipt.outcome !== 'closed' &&
        receipt.result.targetId !== attempt.upload.scope.targetId
      )
        invalidRating();
    } else if (isRatingCategoryScopedIntent(attempt.intent)) {
      receipt = decodeRatingCategoryScopedReceipt(raw);
      matchRatingCategoryScopedReceipt(attempt.intent, receipt);
    } else if (isRatingScopedIntent(attempt.intent)) {
      receipt = decodeRatingScopedReceipt(raw);
      matchRatingScopedReceipt(attempt.intent, receipt);
    } else if (isRatingCategoryCreationIntent(attempt.intent)) {
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
          attempt.version === 8 ||
          attempt.version === 9 ||
          attempt.version === 10 ||
          attempt.version === 11) &&
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
