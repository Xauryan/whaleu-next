import { sha256 } from 'js-sha256';
import { isRecord } from '../api/errors';
import { exact } from '../community/contract';
import { canonicalRatingText, invalidRating, ratingId } from './contract';
import { ratingTimestamp } from './discussion-contract';
import {
  canonicalRatingScopedJson,
  decodeRatingScopedCommandContext,
  decodeRatingScopedContext,
  decodeRatingScopedReceipt,
  ratingScopedClosureCodes,
  type RatingScopedCommandContext,
  type RatingScopedContext,
  type RatingScopedClosureCode,
  type RatingScopedResults,
} from './scoped-contract';

export const RATING_DISCUSSION_MEDIA_JOURNAL_VERSION = 12 as const;
export const RATING_DISCUSSION_MEDIA_PROTOCOL_VERSION = 4 as const;
export const RATING_DISCUSSION_MEDIA_HASH_DOMAIN =
  'whaleu:rating-discussion-media-command:v1\n';
export interface RatingDiscussionCapability {
  readonly id: string;
  readonly generation: string;
  readonly sourceDigest: string;
  readonly validUntil: string;
}
type VersionFour<T> = T extends RatingScopedContext
  ? Omit<T, 'protocolVersion'> & {
      readonly protocolVersion: 4;
      readonly discussionMedia: RatingDiscussionCapability;
    }
  : never;
export type RatingDiscussionMediaContext = VersionFour<RatingScopedContext>;
export type RatingDiscussionMediaCommandContext = RatingScopedCommandContext & {
  readonly discussionMedia: RatingDiscussionCapability;
};
export interface RatingDiscussionImageSelection {
  readonly ordinal: number;
  readonly memberId: string;
  readonly assetId: string;
}
interface Content {
  readonly clientRequestId: string;
  readonly categoryId: string;
  readonly expectedCategoryRevision: string;
  readonly targetId: string;
  readonly expectedTargetRevision: string;
  readonly expectedDefinitionRevision: string;
  readonly expectedContentVersion: number;
  readonly draftRevision: string;
  readonly batchRequestId: string | null;
  readonly batchId: string | null;
  readonly sealedPlanDigest: string | null;
  readonly authorMode: 'named' | 'anonymous';
  readonly body: string;
  readonly images: readonly RatingDiscussionImageSelection[];
}
export type RatingDiscussionMediaIntent = {
  readonly protocolVersion: 4;
  readonly context: RatingDiscussionMediaCommandContext;
} & (
  | { readonly operation: 'create_comment_scoped'; readonly payload: Content }
  | {
      readonly operation: 'create_reply_scoped';
      readonly payload: Content & {
        readonly rootId: string;
        readonly expectedRootRevision: string;
        readonly replyTo: {
          readonly replyId: string;
          readonly expectedRevision: string;
        } | null;
      };
    }
);
export type RatingDiscussionMediaReceipt = {
  [K in 'create_comment_scoped' | 'create_reply_scoped']: {
    readonly protocolVersion: 4;
    readonly requestId: string;
    readonly operation: K;
    readonly intentHash: string;
  } & (
    | { readonly outcome: 'closed'; readonly code: RatingScopedClosureCode }
    | { readonly outcome: 'applied'; readonly result: RatingScopedResults[K] }
  );
}['create_comment_scoped' | 'create_reply_scoped'];
export function discussionMediaId(value: unknown): string {
  if (!ratingId(value)) invalidRating();
  return value;
}
export function discussionMediaDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    invalidRating();
  return value;
}
export function decodeRatingDiscussionCapability(
  value: unknown,
): RatingDiscussionCapability {
  exact(value, ['id', 'generation', 'sourceDigest', 'validUntil']);
  if (!ratingTimestamp(value.validUntil)) invalidRating();
  return Object.freeze({
    id: discussionMediaId(value.id),
    generation: discussionMediaId(value.generation),
    sourceDigest: discussionMediaDigest(value.sourceDigest),
    validUntil: value.validUntil,
  });
}
export function decodeRatingDiscussionMediaContext(
  value: unknown,
): RatingDiscussionMediaContext {
  if (!isRecord(value) || value.protocolVersion !== 4) invalidRating();
  const { discussionMedia: raw, ...rest } = value;
  const discussionMedia = decodeRatingDiscussionCapability(raw);
  const legacy = decodeRatingScopedContext({ ...rest, protocolVersion: 2 });
  if (
    !legacy.capabilities.includes('discussion_images') ||
    (legacy.purpose !== 'read' && legacy.purpose !== 'interact') ||
    Date.parse(discussionMedia.validUntil) < Date.parse(legacy.expiresAt)
  )
    invalidRating();
  return Object.freeze({ ...legacy, protocolVersion: 4, discussionMedia });
}
export function decodeRatingDiscussionMediaCommandContext(
  value: unknown,
): RatingDiscussionMediaCommandContext {
  if (!isRecord(value)) invalidRating();
  const { discussionMedia, ...base } = value;
  return Object.freeze({
    ...decodeRatingScopedCommandContext(base),
    discussionMedia: decodeRatingDiscussionCapability(discussionMedia),
  });
}
export function ratingDiscussionMediaCommandContext(
  raw: RatingDiscussionMediaContext,
): RatingDiscussionMediaCommandContext {
  const context = decodeRatingDiscussionMediaContext(raw);
  if (
    context.purpose !== 'interact' ||
    context.mode !== 'public' ||
    context.heads.length !== 1
  )
    invalidRating();
  return decodeRatingDiscussionMediaCommandContext({
    id: context.id,
    token: context.token,
    tokenDigest: context.tokenDigest,
    selector: context.selector,
    scopeRevision: context.scopeRevision,
    protocolGeneration: context.protocolGeneration,
    catalogRevision: context.heads[0]!.catalogRevision,
    headRevision: context.heads[0]!.headRevision,
    sourceDigest: context.sourceDigest,
    discussionMedia: context.discussionMedia,
  });
}
export function decodeRatingDiscussionImages(
  value: unknown,
  maximum: 3 | 9,
): readonly RatingDiscussionImageSelection[] {
  if (!Array.isArray(value) || value.length > maximum) invalidRating();
  const images = value.map((image: unknown, ordinal) => {
    exact(image, ['ordinal', 'memberId', 'assetId']);
    if (image.ordinal !== ordinal) invalidRating();
    return Object.freeze({
      ordinal,
      memberId: discussionMediaId(image.memberId),
      assetId: discussionMediaId(image.assetId),
    });
  });
  if (
    new Set(images.map((image) => image.memberId)).size !== images.length ||
    new Set(images.map((image) => image.assetId)).size !== images.length
  )
    invalidRating();
  return Object.freeze(images);
}
export function decodeRatingDiscussionMediaIntent(
  value: unknown,
): RatingDiscussionMediaIntent {
  exact(value, ['protocolVersion', 'operation', 'context', 'payload']);
  if (
    value.protocolVersion !== 4 ||
    (value.operation !== 'create_comment_scoped' &&
      value.operation !== 'create_reply_scoped')
  )
    invalidRating();
  const reply = value.operation === 'create_reply_scoped';
  exact(value.payload, [
    'clientRequestId',
    'categoryId',
    'expectedCategoryRevision',
    'targetId',
    'expectedTargetRevision',
    'expectedDefinitionRevision',
    'expectedContentVersion',
    'draftRevision',
    'batchRequestId',
    'batchId',
    'sealedPlanDigest',
    'authorMode',
    'body',
    'images',
    ...(reply ? ['rootId', 'expectedRootRevision', 'replyTo'] : []),
  ]);
  const p = value.payload;
  const body = canonicalRatingText(p.body, 500, false);
  const images = decodeRatingDiscussionImages(p.images, reply ? 3 : 9);
  if (
    body !== p.body ||
    (body.length === 0 && images.length === 0) ||
    (p.authorMode !== 'named' && p.authorMode !== 'anonymous') ||
    typeof p.expectedContentVersion !== 'number' ||
    !Number.isSafeInteger(p.expectedContentVersion) ||
    p.expectedContentVersion < 1 ||
    p.expectedContentVersion > 2147483647
  )
    invalidRating();
  const payload: Content = {
    clientRequestId: discussionMediaId(p.clientRequestId),
    categoryId: discussionMediaId(p.categoryId),
    expectedCategoryRevision: discussionMediaId(p.expectedCategoryRevision),
    targetId: discussionMediaId(p.targetId),
    expectedTargetRevision: discussionMediaId(p.expectedTargetRevision),
    expectedDefinitionRevision: discussionMediaId(p.expectedDefinitionRevision),
    expectedContentVersion: p.expectedContentVersion,
    draftRevision: discussionMediaId(p.draftRevision),
    batchRequestId:
      p.batchRequestId === null ? null : discussionMediaId(p.batchRequestId),
    batchId: p.batchId === null ? null : discussionMediaId(p.batchId),
    sealedPlanDigest:
      p.sealedPlanDigest === null
        ? null
        : discussionMediaDigest(p.sealedPlanDigest),
    authorMode: p.authorMode,
    body,
    images,
  };
  if (
    images.length === 0
      ? payload.batchRequestId !== null ||
        payload.batchId !== null ||
        payload.sealedPlanDigest !== null
      : payload.batchRequestId === null ||
        payload.batchId === null ||
        payload.sealedPlanDigest === null ||
        payload.batchRequestId === payload.clientRequestId
  )
    invalidRating();
  const base = {
    protocolVersion: 4 as const,
    context: decodeRatingDiscussionMediaCommandContext(value.context),
  };
  if (!reply)
    return Object.freeze({
      ...base,
      operation: 'create_comment_scoped',
      payload: Object.freeze(payload),
    });
  const rootId = discussionMediaId(p.rootId);
  let replyTo: {
    readonly replyId: string;
    readonly expectedRevision: string;
  } | null = null;
  if (p.replyTo !== null) {
    exact(p.replyTo, ['replyId', 'expectedRevision']);
    const replyId = discussionMediaId(p.replyTo.replyId);
    if (replyId === rootId) invalidRating();
    replyTo = Object.freeze({
      replyId,
      expectedRevision: discussionMediaId(p.replyTo.expectedRevision),
    });
  }
  return Object.freeze({
    ...base,
    operation: 'create_reply_scoped',
    payload: Object.freeze({
      ...payload,
      rootId,
      expectedRootRevision: discussionMediaId(p.expectedRootRevision),
      replyTo,
    }),
  });
}
export function ratingDiscussionMediaIntentHash(
  raw: RatingDiscussionMediaIntent,
): string {
  const { protocolVersion, operation, context, payload } =
    decodeRatingDiscussionMediaIntent(raw);
  return sha256(
    RATING_DISCUSSION_MEDIA_HASH_DOMAIN +
      canonicalRatingScopedJson({
        protocolVersion,
        operation,
        intent: { context, payload },
      }),
  );
}
export function decodeRatingDiscussionMediaReceipt(
  value: unknown,
): RatingDiscussionMediaReceipt {
  if (
    !isRecord(value) ||
    value.protocolVersion !== 4 ||
    (value.operation !== 'create_comment_scoped' &&
      value.operation !== 'create_reply_scoped') ||
    value.outcome === 'noop'
  )
    invalidRating();
  if (value.outcome === 'closed') {
    exact(value, [
      'protocolVersion',
      'requestId',
      'operation',
      'intentHash',
      'outcome',
      'code',
    ]);
    if (!(ratingScopedClosureCodes as readonly unknown[]).includes(value.code))
      invalidRating();
    return Object.freeze({
      protocolVersion: 4,
      requestId: discussionMediaId(value.requestId),
      operation: value.operation,
      intentHash: discussionMediaDigest(value.intentHash),
      outcome: 'closed',
      code: value.code as RatingScopedClosureCode,
    });
  }
  const receipt = decodeRatingScopedReceipt({ ...value, protocolVersion: 2 });
  if (
    (receipt.operation !== 'create_comment_scoped' &&
      receipt.operation !== 'create_reply_scoped') ||
    receipt.outcome === 'noop'
  )
    invalidRating();
  return Object.freeze({
    ...receipt,
    protocolVersion: 4,
  }) as RatingDiscussionMediaReceipt;
}
export function matchRatingDiscussionMediaReceipt(
  intent: RatingDiscussionMediaIntent,
  raw: RatingDiscussionMediaReceipt,
): void {
  const value = decodeRatingDiscussionMediaIntent(intent),
    receipt = decodeRatingDiscussionMediaReceipt(raw);
  if (
    receipt.requestId !== value.payload.clientRequestId ||
    receipt.operation !== value.operation ||
    receipt.intentHash !== ratingDiscussionMediaIntentHash(value)
  )
    invalidRating();
  if (
    receipt.outcome === 'applied' &&
    (receipt.result.targetId !== value.payload.targetId ||
      (receipt.operation === 'create_reply_scoped' &&
        value.operation === 'create_reply_scoped' &&
        receipt.result.rootId !== value.payload.rootId))
  )
    invalidRating();
}
export interface RatingDiscussionMediaPreparation {
  readonly intent: RatingDiscussionMediaIntent;
  readonly contextRevision: string;
  readonly targetId: string;
  readonly targetRevision: string;
  readonly definitionRevision: string;
  readonly contentVersion: number;
  readonly subjectId: string;
  readonly subjectRevision: string;
  readonly attachmentSetDigest: string;
  readonly validUntil: string;
}
export function decodeRatingDiscussionMediaPreparation(
  raw: unknown,
): RatingDiscussionMediaPreparation {
  exact(raw, [
    'intent',
    'contextRevision',
    'targetId',
    'targetRevision',
    'definitionRevision',
    'contentVersion',
    'subjectId',
    'subjectRevision',
    'attachmentSetDigest',
    'validUntil',
  ]);
  const intent = decodeRatingDiscussionMediaIntent(raw.intent);
  if (
    typeof raw.contextRevision !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(raw.contextRevision) ||
    typeof raw.contentVersion !== 'number' ||
    !Number.isSafeInteger(raw.contentVersion) ||
    raw.contentVersion < 1 ||
    raw.contentVersion > 2147483647 ||
    !ratingTimestamp(raw.validUntil)
  )
    invalidRating();
  const value = {
    intent,
    contextRevision: raw.contextRevision,
    targetId: discussionMediaId(raw.targetId),
    targetRevision: discussionMediaId(raw.targetRevision),
    definitionRevision: discussionMediaId(raw.definitionRevision),
    contentVersion: raw.contentVersion,
    subjectId: discussionMediaId(raw.subjectId),
    subjectRevision: discussionMediaId(raw.subjectRevision),
    attachmentSetDigest: discussionMediaDigest(raw.attachmentSetDigest),
    validUntil: raw.validUntil,
  };
  if (
    value.targetId !== intent.payload.targetId ||
    value.targetRevision !== intent.payload.expectedTargetRevision ||
    value.definitionRevision !== intent.payload.expectedDefinitionRevision ||
    value.contentVersion !== intent.payload.expectedContentVersion ||
    Date.parse(value.validUntil) >
      Date.parse(intent.context.discussionMedia.validUntil) ||
    (intent.operation === 'create_reply_scoped' &&
      (value.subjectId === intent.payload.rootId ||
        value.subjectId === intent.payload.replyTo?.replyId))
  )
    invalidRating();
  return Object.freeze(value);
}
