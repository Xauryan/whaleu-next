import {
  ratingTargetCoverCommandContext,
  type RatingTargetCoverContext,
} from './target-cover-context';
import { sha256 } from 'js-sha256';
import { isRecord } from '../api/errors';
import { exact } from '../community/contract';
import {
  canonicalRatingText,
  invalidRating,
  ratingCursor,
  ratingId,
} from './contract';
import { ratingTimestamp } from './discussion-contract';
import {
  canonicalRatingScopedJson,
  decodeRatingScopedCommandContext,
  decodeRatingScopedReceipt,
  type RatingScopedCommandContext,
  type RatingScopedResults,
  type RatingScopedClosureCode,
} from './scoped-contract';

export const RATING_TARGET_COVER_PROTOCOL_VERSION = 3 as const;
export const RATING_TARGET_COVER_JOURNAL_VERSION = 11 as const;
export const RATING_TARGET_COVER_HASH_DOMAIN =
  'whaleu:rating-target-cover-command:v1\n';
export type RatingTargetCoverChange =
  | { readonly action: 'keep' }
  | { readonly action: 'clear' }
  | {
      readonly action: 'replace';
      readonly assetId: string;
      readonly uploadScopeId: string;
    };
interface Definition {
  readonly clientRequestId: string;
  readonly categoryId: string;
  readonly expectedCategoryRevision: string;
  readonly name: string;
  readonly description: string;
}
export type RatingTargetCoverIntent = {
  readonly protocolVersion: 3;
  readonly context: RatingScopedCommandContext;
} & (
  | {
      readonly operation: 'create_target_scoped';
      readonly payload: Definition & {
        readonly cover: Exclude<RatingTargetCoverChange, { action: 'keep' }>;
      };
    }
  | {
      readonly operation: 'edit_target_scoped';
      readonly payload: Definition & {
        readonly targetId: string;
        readonly expectedTargetRevision: string;
        readonly expectedDefinitionRevision: string;
        readonly expectedContentVersion: number;
        readonly cover: RatingTargetCoverChange;
      };
    }
);
export type RatingTargetCoverReceipt = {
  [K in 'create_target_scoped' | 'edit_target_scoped']: {
    readonly protocolVersion: 3;
    readonly requestId: string;
    readonly operation: K;
    readonly intentHash: string;
  } & (
    | { readonly outcome: 'closed'; readonly code: RatingScopedClosureCode }
    | {
        readonly outcome: 'applied' | 'noop';
        readonly result: RatingScopedResults[K];
      }
  );
}['create_target_scoped' | 'edit_target_scoped'];
export interface RatingTargetCoverPreparation {
  readonly intent: RatingTargetCoverIntent;
  readonly contextRevision: string;
  readonly targetId: string;
  readonly targetRevision: string;
  readonly definitionRevision: string;
  readonly contentVersion: number;
  readonly validUntil: string;
}
export type RatingTargetCoverPrepared =
  RatingTargetCoverPreparation | RatingTargetCoverReceipt;
function id(value: unknown): string {
  if (!ratingId(value)) invalidRating();
  return value;
}
function text(value: unknown, limit: number, required: boolean): string {
  const result = canonicalRatingText(value, limit, required);
  if (result !== value) invalidRating();
  return result;
}
export function decodeRatingTargetCoverChange(
  value: unknown,
): RatingTargetCoverChange {
  if (!isRecord(value)) invalidRating();
  if (value.action === 'keep' || value.action === 'clear') {
    exact(value, ['action']);
    return Object.freeze({ action: value.action });
  }
  exact(value, ['action', 'assetId', 'uploadScopeId']);
  if (value.action !== 'replace') invalidRating();
  return Object.freeze({
    action: 'replace',
    assetId: id(value.assetId),
    uploadScopeId: id(value.uploadScopeId),
  });
}
export function isRatingTargetCoverIntent(
  value: unknown,
): value is RatingTargetCoverIntent {
  return (
    isRecord(value) &&
    value.protocolVersion === 3 &&
    (value.operation === 'create_target_scoped' ||
      value.operation === 'edit_target_scoped')
  );
}
export function ratingTargetCoverContext(
  raw: RatingTargetCoverContext,
): RatingScopedCommandContext {
  return ratingTargetCoverCommandContext(raw);
}
export function decodeRatingTargetCoverIntent(
  value: unknown,
): RatingTargetCoverIntent {
  exact(value, ['protocolVersion', 'operation', 'context', 'payload']);
  if (!isRatingTargetCoverIntent(value)) invalidRating();
  const edit = value.operation === 'edit_target_scoped';
  exact(value.payload, [
    'clientRequestId',
    'categoryId',
    'expectedCategoryRevision',
    'name',
    'description',
    'cover',
    ...(edit
      ? [
          'targetId',
          'expectedTargetRevision',
          'expectedDefinitionRevision',
          'expectedContentVersion',
        ]
      : []),
  ]);
  const p = value.payload;
  const cover = decodeRatingTargetCoverChange(p.cover);
  const base = {
    protocolVersion: 3 as const,
    context: decodeRatingScopedCommandContext(value.context),
  };
  const payload = {
    clientRequestId: id(p.clientRequestId),
    categoryId: id(p.categoryId),
    expectedCategoryRevision: id(p.expectedCategoryRevision),
    name: text(p.name, 100, true),
    description: text(p.description, 500, false),
  };
  if (value.operation === 'create_target_scoped') {
    if (cover.action === 'keep') invalidRating();
    return Object.freeze({
      ...base,
      operation: value.operation,
      payload: Object.freeze({ ...payload, cover }),
    });
  }
  const e = value.payload;
  if (
    !Number.isSafeInteger(e.expectedContentVersion) ||
    e.expectedContentVersion < 1 ||
    e.expectedContentVersion > 2147483646
  )
    invalidRating();
  return Object.freeze({
    ...base,
    operation: value.operation,
    payload: Object.freeze({
      ...payload,
      targetId: id(e.targetId),
      expectedTargetRevision: id(e.expectedTargetRevision),
      expectedDefinitionRevision: id(e.expectedDefinitionRevision),
      expectedContentVersion: e.expectedContentVersion,
      cover,
    }),
  });
}
export function ratingTargetCoverIntentHash(
  raw: RatingTargetCoverIntent,
): string {
  const { protocolVersion, operation, context, payload } =
    decodeRatingTargetCoverIntent(raw);
  return sha256(
    RATING_TARGET_COVER_HASH_DOMAIN +
      canonicalRatingScopedJson({
        protocolVersion,
        operation,
        intent: { context, payload },
      }),
  );
}
export function decodeRatingTargetCoverReceipt(
  value: unknown,
): RatingTargetCoverReceipt {
  if (
    !isRecord(value) ||
    value.protocolVersion !== 3 ||
    (value.operation !== 'create_target_scoped' &&
      value.operation !== 'edit_target_scoped')
  )
    invalidRating();
  // The result/closure grammar is deliberately shared; the command hash and version are not.
  const result = decodeRatingScopedReceipt({ ...value, protocolVersion: 2 });
  if (
    result.operation !== 'create_target_scoped' &&
    result.operation !== 'edit_target_scoped'
  )
    invalidRating();
  return Object.freeze({ ...result, protocolVersion: 3 });
}
export function matchRatingTargetCoverReceipt(
  raw: RatingTargetCoverIntent,
  value: RatingTargetCoverReceipt,
): void {
  const intent = decodeRatingTargetCoverIntent(raw),
    receipt = decodeRatingTargetCoverReceipt(value);
  if (
    receipt.operation !== intent.operation ||
    receipt.requestId !== intent.payload.clientRequestId ||
    receipt.intentHash !== ratingTargetCoverIntentHash(intent)
  )
    invalidRating();
  if (receipt.outcome === 'closed') return;
  if (
    intent.operation === 'edit_target_scoped' &&
    receipt.operation === 'edit_target_scoped'
  ) {
    if (
      receipt.result.targetId !== intent.payload.targetId ||
      (receipt.outcome === 'noop'
        ? receipt.result.revision !== intent.payload.expectedTargetRevision ||
          receipt.result.definitionRevision !==
            intent.payload.expectedDefinitionRevision ||
          receipt.result.contentVersion !==
            intent.payload.expectedContentVersion
        : receipt.result.revision === intent.payload.expectedTargetRevision ||
          receipt.result.definitionRevision ===
            intent.payload.expectedDefinitionRevision ||
          receipt.result.contentVersion !==
            intent.payload.expectedContentVersion + 1)
    )
      invalidRating();
  }
}
export function decodeRatingTargetCoverPrepared(
  value: unknown,
): RatingTargetCoverPrepared {
  if (isRecord(value) && 'outcome' in value)
    return decodeRatingTargetCoverReceipt(value);
  exact(value, [
    'intent',
    'contextRevision',
    'targetId',
    'targetRevision',
    'definitionRevision',
    'contentVersion',
    'validUntil',
  ]);
  const intent = decodeRatingTargetCoverIntent(value.intent);
  if (
    !ratingCursor(value.contextRevision) ||
    !ratingId(value.targetId) ||
    !ratingId(value.targetRevision) ||
    !ratingId(value.definitionRevision) ||
    !Number.isSafeInteger(value.contentVersion) ||
    typeof value.contentVersion !== 'number' ||
    value.contentVersion < 1 ||
    value.contentVersion > 2147483647 ||
    !ratingTimestamp(value.validUntil)
  )
    invalidRating();
  if (
    intent.operation === 'create_target_scoped'
      ? value.contentVersion !== 1
      : value.targetId !== intent.payload.targetId ||
        value.targetRevision === intent.payload.expectedTargetRevision ||
        value.definitionRevision ===
          intent.payload.expectedDefinitionRevision ||
        value.contentVersion !== intent.payload.expectedContentVersion + 1
  )
    invalidRating();
  return Object.freeze({
    intent,
    contextRevision: value.contextRevision,
    targetId: value.targetId,
    targetRevision: value.targetRevision,
    definitionRevision: value.definitionRevision,
    contentVersion: value.contentVersion,
    validUntil: value.validUntil,
  });
}

export interface RatingTargetCoverIdentity {
  readonly appearanceId: string;
  readonly assetId: string;
  readonly manifestDigest: string;
}
export function decodeRatingTargetCoverIdentity(
  value: unknown,
): RatingTargetCoverIdentity | null {
  if (value === null) return null;
  exact(value, ['appearanceId', 'assetId', 'manifestDigest']);
  if (
    typeof value.manifestDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.manifestDigest)
  )
    invalidRating();
  return Object.freeze({
    appearanceId: id(value.appearanceId),
    assetId: id(value.assetId),
    manifestDigest: value.manifestDigest,
  });
}
