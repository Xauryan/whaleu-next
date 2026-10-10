import { sha256 } from 'js-sha256';
import { isRecord } from '../api/errors';
import { exact } from '../community/contract';
import {
  canonicalRatingText,
  invalidRating,
  ratingCursor,
  ratingId,
  ratingRejections,
  type RatingAuthorMode,
} from './contract';
import { ratingNullableId, ratingTimestamp } from './discussion-contract';

export const RATING_SCOPED_PROTOCOL_VERSION = 2 as const;
export const RATING_SCOPED_JOURNAL_VERSION = 9 as const;
export const RATING_SCOPED_COMMAND_REGISTRY = 'ratings-scoped-command-v1';
export const RATING_SCOPED_HASH_DOMAIN = 'whaleu:rating-scoped-command:v1\n';
export type RatingNavigationSelector =
  | { readonly kind: 'global' }
  | { readonly kind: 'campus'; readonly campusId: string };
export type RatingRandomCandidateSelector =
  | { readonly kind: 'global' }
  | {
      readonly kind: 'institution_with_global';
      readonly anchorCampusId: string;
    };
export type RatingScopedPurpose =
  'read' | 'interact' | 'create_target' | 'edit_target' | 'random';
export type RatingScopedMode = 'public' | 'admin_preview';
export type RatingScopedContextRequest = {
  readonly mode: RatingScopedMode;
} & (
  | {
      readonly purpose: Exclude<RatingScopedPurpose, 'random'>;
      readonly selector: RatingNavigationSelector;
    }
  | {
      readonly purpose: 'random';
      readonly selector: RatingRandomCandidateSelector;
    }
);
export interface RatingScopedHead {
  readonly scopeKey: string;
  readonly catalogRevision: string;
  readonly headRevision: string;
}
export type RatingScopedContext = RatingScopedContextRequest & {
  readonly protocolVersion: 2;
  readonly id: string;
  readonly token: string;
  readonly tokenDigest: string;
  readonly actorId: string;
  readonly sessionGeneration: string;
  readonly scopeRevision: string;
  readonly protocolGeneration: string;
  readonly heads: readonly RatingScopedHead[];
  readonly sourceDigest: string;
  readonly identityCampusId: string | null;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly capabilities: readonly string[];
};
/** Exact immutable authorization reference. The token and its digest are part of the command hash. */
export interface RatingScopedCommandContext {
  readonly id: string;
  readonly tokenDigest: string;
  readonly token: string;
  readonly selector: RatingNavigationSelector;
  readonly scopeRevision: string;
  readonly protocolGeneration: string;
  readonly catalogRevision: string;
  readonly headRevision: string;
  readonly sourceDigest: string;
}
export interface RatingScopedLocator {
  readonly selector: RatingNavigationSelector;
  readonly targetId: string;
  readonly rootId: string | null;
  readonly replyId: string | null;
  readonly protocolGeneration: string;
}
export const ratingScopedOperations = [
  'set_score_scoped',
  'create_comment_scoped',
  'create_reply_scoped',
  'set_comment_like_scoped',
  'set_reply_like_scoped',
  'set_target_subscription_scoped',
  'create_target_scoped',
  'edit_target_scoped',
] as const;
export type RatingScopedOperation = (typeof ratingScopedOperations)[number];
interface RequestPayload {
  readonly clientRequestId: string;
}
interface TargetPayload extends RequestPayload {
  readonly categoryId: string;
  readonly expectedCategoryRevision: string;
  readonly targetId: string;
  readonly expectedTargetRevision: string;
}
interface BodyPayload {
  readonly authorMode: RatingAuthorMode;
  readonly body: string;
  readonly assetIds: readonly [];
}
interface LikePayload extends TargetPayload {
  readonly rootId: string;
  readonly expectedRevision: string;
  readonly expectedLikeRevision: string;
  readonly liked: boolean;
}
interface DefinitionPayload extends RequestPayload {
  readonly categoryId: string;
  readonly expectedCategoryRevision: string;
  readonly name: string;
  readonly description: string;
  readonly assetIds: readonly [];
}
export interface RatingScopedPayloads {
  readonly set_score_scoped: TargetPayload & {
    readonly expectedRevision: string | null;
    readonly score: number;
  };
  readonly create_comment_scoped: TargetPayload & BodyPayload;
  readonly create_reply_scoped: TargetPayload &
    BodyPayload & {
      readonly rootId: string;
      readonly expectedRootRevision: string;
      readonly replyTo: {
        readonly replyId: string;
        readonly expectedRevision: string;
      } | null;
    };
  readonly set_comment_like_scoped: LikePayload;
  readonly set_reply_like_scoped: LikePayload & {
    readonly replyId: string;
    readonly expectedRootRevision: string;
  };
  readonly set_target_subscription_scoped: TargetPayload & {
    readonly expectedSubscriptionRevision: string;
    readonly subscribed: boolean;
  };
  readonly create_target_scoped: DefinitionPayload;
  readonly edit_target_scoped: DefinitionPayload &
    TargetPayload & {
      readonly expectedDefinitionRevision: string;
      readonly expectedContentVersion: number;
    };
}
export type RatingScopedIntent = {
  [K in RatingScopedOperation]: {
    readonly protocolVersion: 2;
    readonly operation: K;
    readonly context: RatingScopedCommandContext;
    readonly payload: RatingScopedPayloads[K];
  };
}[RatingScopedOperation];
interface CommonResult {
  readonly targetId: string;
  readonly revision: string;
  readonly occurredAt: string;
}
export interface RatingScopedResults {
  readonly set_score_scoped: CommonResult & { readonly subjectId: string };
  readonly create_comment_scoped: CommonResult & { readonly subjectId: string };
  readonly create_reply_scoped: CommonResult & {
    readonly rootId: string;
    readonly replyId: string;
  };
  readonly set_comment_like_scoped: CommonResult & {
    readonly rootId: string;
    readonly replyId: null;
    readonly liked: boolean;
  };
  readonly set_reply_like_scoped: CommonResult & {
    readonly rootId: string;
    readonly replyId: string;
    readonly liked: boolean;
  };
  readonly set_target_subscription_scoped: CommonResult & {
    readonly subscribed: boolean;
  };
  readonly create_target_scoped: CommonResult & {
    readonly catalogRevision: string;
  };
  readonly edit_target_scoped: CommonResult & {
    readonly definitionRevision: string;
    readonly contentVersion: number;
  };
}
export const ratingScopedClosureCodes = [
  ...ratingRejections,
  'RATING_SCOPED_CONTEXT_CHANGED',
  'RATING_CREATION_CANCELLED',
  'RATING_EDIT_CANCELLED',
] as const;
export type RatingScopedClosureCode = (typeof ratingScopedClosureCodes)[number];
export type RatingScopedReceipt = {
  [K in RatingScopedOperation]: {
    readonly protocolVersion: 2;
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
}[RatingScopedOperation];
export interface RatingScopedPreparation {
  readonly intent: RatingScopedIntent;
  readonly contextRevision: string;
  readonly targetId: string;
  readonly targetRevision: string;
  readonly definitionRevision: string;
  readonly contentVersion: number;
  readonly validUntil: string;
}
export type RatingScopedPrepared =
  RatingScopedPreparation | RatingScopedReceipt;
export const ratingScopedDigest = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const ratingScopedPositive = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
export function decodeRatingNavigationSelector(
  v: unknown,
): RatingNavigationSelector {
  if (!isRecord(v)) invalidRating();
  exact(v, v.kind === 'global' ? ['kind'] : ['kind', 'campusId']);
  if (v.kind === 'global') return Object.freeze({ kind: 'global' });
  if (v.kind !== 'campus' || !ratingId(v.campusId)) invalidRating();
  return Object.freeze({ kind: 'campus', campusId: v.campusId });
}
export function decodeRatingRandomCandidateSelector(
  v: unknown,
): RatingRandomCandidateSelector {
  if (!isRecord(v)) invalidRating();
  exact(v, v.kind === 'global' ? ['kind'] : ['kind', 'anchorCampusId']);
  if (v.kind === 'global') return Object.freeze({ kind: 'global' });
  if (v.kind !== 'institution_with_global' || !ratingId(v.anchorCampusId))
    invalidRating();
  return Object.freeze({
    kind: 'institution_with_global',
    anchorCampusId: v.anchorCampusId,
  });
}
export function ratingNavigationKey(
  selector: RatingNavigationSelector,
): string {
  const value = decodeRatingNavigationSelector(selector);
  return value.kind === 'global' ? 'global' : `campus:${value.campusId}`;
}
export function ratingRandomSelector(
  selector: RatingNavigationSelector,
): RatingRandomCandidateSelector {
  const value = decodeRatingNavigationSelector(selector);
  return value.kind === 'global'
    ? value
    : Object.freeze({
        kind: 'institution_with_global',
        anchorCampusId: value.campusId,
      });
}
export function decodeRatingScopedContextRequest(
  v: unknown,
): RatingScopedContextRequest {
  exact(v, ['selector', 'purpose', 'mode']);
  if (v.mode !== 'public' && v.mode !== 'admin_preview') invalidRating();
  if (v.mode === 'admin_preview' && v.purpose !== 'read') invalidRating();
  if (v.purpose === 'random')
    return Object.freeze({
      mode: v.mode,
      purpose: 'random',
      selector: decodeRatingRandomCandidateSelector(v.selector),
    });
  if (
    v.purpose !== 'read' &&
    v.purpose !== 'interact' &&
    v.purpose !== 'create_target' &&
    v.purpose !== 'edit_target'
  )
    invalidRating();
  if (v.mode === 'admin_preview' && v.purpose !== 'read') invalidRating();
  return Object.freeze({
    mode: v.mode,
    purpose: v.purpose,
    selector: decodeRatingNavigationSelector(v.selector),
  });
}
export function decodeRatingScopedContext(v: unknown): RatingScopedContext {
  exact(v, [
    'protocolVersion',
    'id',
    'token',
    'tokenDigest',
    'actorId',
    'sessionGeneration',
    'selector',
    'purpose',
    'mode',
    'scopeRevision',
    'protocolGeneration',
    'heads',
    'sourceDigest',
    'identityCampusId',
    'issuedAt',
    'expiresAt',
    'capabilities',
  ]);
  const request = decodeRatingScopedContextRequest({
    selector: v.selector,
    purpose: v.purpose,
    mode: v.mode,
  });
  if (
    v.protocolVersion !== 2 ||
    !ratingId(v.id) ||
    !ratingCursor(v.token) ||
    !ratingScopedDigest(v.tokenDigest) ||
    sha256(v.token) !== v.tokenDigest ||
    !ratingId(v.actorId) ||
    !ratingScopedDigest(v.sessionGeneration) ||
    !ratingScopedDigest(v.scopeRevision) ||
    !ratingId(v.protocolGeneration) ||
    !ratingScopedDigest(v.sourceDigest) ||
    !ratingNullableId(v.identityCampusId) ||
    !ratingTimestamp(v.issuedAt) ||
    !ratingTimestamp(v.expiresAt) ||
    Date.parse(v.expiresAt) <= Date.parse(v.issuedAt) ||
    Date.parse(v.expiresAt) - Date.parse(v.issuedAt) > 300_000 ||
    !Array.isArray(v.heads) ||
    v.heads.length < 1 ||
    v.heads.length > 1001 ||
    !Array.isArray(v.capabilities) ||
    v.capabilities.length > 32
  )
    invalidRating();
  const heads = v.heads.map((head: unknown) => {
    exact(head, ['scopeKey', 'catalogRevision', 'headRevision']);
    if (
      typeof head.scopeKey !== 'string' ||
      (head.scopeKey !== 'global' &&
        !(
          head.scopeKey.startsWith('campus:') &&
          ratingId(head.scopeKey.slice(7))
        )) ||
      !ratingId(head.catalogRevision) ||
      !ratingId(head.headRevision)
    )
      invalidRating();
    return Object.freeze({
      scopeKey: head.scopeKey,
      catalogRevision: head.catalogRevision,
      headRevision: head.headRevision,
    });
  });
  if (
    new Set(heads.map((head) => head.scopeKey)).size !== heads.length ||
    (request.purpose !== 'random' &&
      (heads.length !== 1 ||
        heads[0]!.scopeKey !== ratingNavigationKey(request.selector))) ||
    (request.purpose === 'random' &&
      request.selector.kind === 'global' &&
      (heads.length !== 1 || heads[0]!.scopeKey !== 'global'))
  )
    invalidRating();
  if (
    request.purpose === 'random' &&
    request.selector.kind === 'institution_with_global' &&
    (!heads.some((head) => head.scopeKey === 'global') ||
      !heads.some(
        (head) =>
          head.scopeKey ===
          `campus:${request.selector.kind === 'institution_with_global' ? request.selector.anchorCampusId : ''}`,
      ))
  )
    invalidRating();
  const capabilities = v.capabilities.map((capability: unknown) => {
    if (
      typeof capability !== 'string' ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(capability)
    )
      invalidRating();
    return capability;
  });
  if (new Set(capabilities).size !== capabilities.length) invalidRating();
  return Object.freeze({
    ...request,
    protocolVersion: 2,
    id: v.id,
    token: v.token,
    tokenDigest: v.tokenDigest,
    actorId: v.actorId,
    sessionGeneration: v.sessionGeneration,
    scopeRevision: v.scopeRevision,
    protocolGeneration: v.protocolGeneration,
    heads: Object.freeze(heads),
    sourceDigest: v.sourceDigest,
    identityCampusId: v.identityCampusId,
    issuedAt: v.issuedAt,
    expiresAt: v.expiresAt,
    capabilities: Object.freeze(capabilities),
  });
}
export function decodeRatingScopedCommandContext(
  v: unknown,
): RatingScopedCommandContext {
  exact(v, [
    'id',
    'tokenDigest',
    'token',
    'selector',
    'scopeRevision',
    'protocolGeneration',
    'catalogRevision',
    'headRevision',
    'sourceDigest',
  ]);
  if (
    !ratingId(v.id) ||
    !ratingCursor(v.token) ||
    !ratingScopedDigest(v.tokenDigest) ||
    sha256(v.token) !== v.tokenDigest ||
    !ratingScopedDigest(v.scopeRevision) ||
    !ratingId(v.protocolGeneration) ||
    !ratingId(v.catalogRevision) ||
    !ratingId(v.headRevision) ||
    !ratingScopedDigest(v.sourceDigest)
  )
    invalidRating();
  return Object.freeze({
    id: v.id,
    tokenDigest: v.tokenDigest,
    token: v.token,
    selector: decodeRatingNavigationSelector(v.selector),
    scopeRevision: v.scopeRevision,
    protocolGeneration: v.protocolGeneration,
    catalogRevision: v.catalogRevision,
    headRevision: v.headRevision,
    sourceDigest: v.sourceDigest,
  });
}
export function ratingScopedCommandContext(
  raw: RatingScopedContext,
): RatingScopedCommandContext {
  const context = decodeRatingScopedContext(raw);
  if (
    context.purpose === 'random' ||
    context.purpose === 'read' ||
    context.mode !== 'public' ||
    context.heads.length !== 1
  )
    invalidRating();
  return decodeRatingScopedCommandContext({
    id: context.id,
    token: context.token,
    tokenDigest: context.tokenDigest,
    selector: context.selector,
    scopeRevision: context.scopeRevision,
    protocolGeneration: context.protocolGeneration,
    catalogRevision: context.heads[0]!.catalogRevision,
    headRevision: context.heads[0]!.headRevision,
    sourceDigest: context.sourceDigest,
  });
}
export function decodeRatingScopedLocator(v: unknown): RatingScopedLocator {
  exact(v, ['selector', 'targetId', 'rootId', 'replyId', 'protocolGeneration']);
  if (
    !ratingId(v.targetId) ||
    !ratingNullableId(v.rootId) ||
    !ratingNullableId(v.replyId) ||
    (v.replyId !== null && v.rootId === null) ||
    !ratingId(v.protocolGeneration)
  )
    invalidRating();
  return Object.freeze({
    selector: decodeRatingNavigationSelector(v.selector),
    targetId: v.targetId,
    rootId: v.rootId,
    replyId: v.replyId,
    protocolGeneration: v.protocolGeneration,
  });
}
const payloadKeys: {
  readonly [K in RatingScopedOperation]: readonly string[];
} = {
  set_score_scoped: [
    'clientRequestId',
    'categoryId',
    'expectedCategoryRevision',
    'targetId',
    'expectedTargetRevision',
    'expectedRevision',
    'score',
  ],
  create_comment_scoped: [
    'clientRequestId',
    'categoryId',
    'expectedCategoryRevision',
    'targetId',
    'expectedTargetRevision',
    'authorMode',
    'body',
    'assetIds',
  ],
  create_reply_scoped: [
    'clientRequestId',
    'categoryId',
    'expectedCategoryRevision',
    'targetId',
    'expectedTargetRevision',
    'rootId',
    'expectedRootRevision',
    'replyTo',
    'authorMode',
    'body',
    'assetIds',
  ],
  set_comment_like_scoped: [
    'clientRequestId',
    'categoryId',
    'expectedCategoryRevision',
    'targetId',
    'expectedTargetRevision',
    'rootId',
    'expectedRevision',
    'expectedLikeRevision',
    'liked',
  ],
  set_reply_like_scoped: [
    'clientRequestId',
    'categoryId',
    'expectedCategoryRevision',
    'targetId',
    'expectedTargetRevision',
    'rootId',
    'replyId',
    'expectedRootRevision',
    'expectedRevision',
    'expectedLikeRevision',
    'liked',
  ],
  set_target_subscription_scoped: [
    'clientRequestId',
    'categoryId',
    'expectedCategoryRevision',
    'targetId',
    'expectedTargetRevision',
    'expectedSubscriptionRevision',
    'subscribed',
  ],
  create_target_scoped: [
    'clientRequestId',
    'categoryId',
    'expectedCategoryRevision',
    'name',
    'description',
    'assetIds',
  ],
  edit_target_scoped: [
    'clientRequestId',
    'targetId',
    'expectedTargetRevision',
    'expectedDefinitionRevision',
    'expectedContentVersion',
    'categoryId',
    'expectedCategoryRevision',
    'name',
    'description',
    'assetIds',
  ],
};
export function isRatingScopedOperation(
  v: unknown,
): v is RatingScopedOperation {
  return (ratingScopedOperations as readonly unknown[]).includes(v);
}
function scopedRequiredId(value: unknown): string {
  if (!ratingId(value)) invalidRating();
  return value;
}
function scopedRequiredText(
  value: unknown,
  limit: number,
  required = true,
): string {
  const text = canonicalRatingText(value, limit, required);
  if (text !== value) invalidRating();
  return text;
}
function scopedRequiredBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') invalidRating();
  return value;
}
function scopedContentVersion(value: unknown, maximum = 2147483647): number {
  if (!ratingScopedPositive(value) || value > maximum) invalidRating();
  return value;
}
function scopedEmptyAssets(value: unknown): readonly [] {
  if (!Array.isArray(value) || value.length !== 0) invalidRating();
  return Object.freeze([] as const);
}
export function decodeRatingScopedIntent(v: unknown): RatingScopedIntent {
  exact(v, ['protocolVersion', 'operation', 'context', 'payload']);
  if (v.protocolVersion !== 2 || !isRatingScopedOperation(v.operation))
    invalidRating();
  const operation = v.operation;
  exact(v.payload, payloadKeys[operation]);
  const p = v.payload,
    base = {
      protocolVersion: 2 as const,
      context: decodeRatingScopedCommandContext(v.context),
    },
    common = {
      clientRequestId: scopedRequiredId(p.clientRequestId),
      categoryId: scopedRequiredId(p.categoryId),
      expectedCategoryRevision: scopedRequiredId(p.expectedCategoryRevision),
    };
  const target = () => ({
    ...common,
    targetId: scopedRequiredId(p.targetId),
    expectedTargetRevision: scopedRequiredId(p.expectedTargetRevision),
  });
  const body = (): BodyPayload => {
    if (p.authorMode !== 'named' && p.authorMode !== 'anonymous')
      invalidRating();
    return {
      authorMode: p.authorMode,
      body: scopedRequiredText(p.body, 500),
      assetIds: scopedEmptyAssets(p.assetIds),
    };
  };
  const definition = () => ({
    ...common,
    name: scopedRequiredText(p.name, 100),
    description: scopedRequiredText(p.description, 500, false),
    assetIds: scopedEmptyAssets(p.assetIds),
  });
  const like = () => ({
    ...target(),
    rootId: scopedRequiredId(p.rootId),
    expectedRevision: scopedRequiredId(p.expectedRevision),
    expectedLikeRevision: scopedRequiredId(p.expectedLikeRevision),
    liked: scopedRequiredBoolean(p.liked),
  });
  switch (operation) {
    case 'set_score_scoped': {
      if (
        !ratingNullableId(p.expectedRevision) ||
        typeof p.score !== 'number' ||
        !Number.isInteger(p.score) ||
        p.score < 1 ||
        p.score > 5
      )
        invalidRating();
      return Object.freeze({
        ...base,
        operation,
        payload: Object.freeze({
          ...target(),
          expectedRevision: p.expectedRevision,
          score: p.score,
        }),
      });
    }
    case 'create_comment_scoped':
      return Object.freeze({
        ...base,
        operation,
        payload: Object.freeze({ ...target(), ...body() }),
      });
    case 'create_reply_scoped': {
      let replyTo: RatingScopedPayloads['create_reply_scoped']['replyTo'] =
        null;
      if (p.replyTo !== null) {
        exact(p.replyTo, ['replyId', 'expectedRevision']);
        replyTo = Object.freeze({
          replyId: scopedRequiredId(p.replyTo.replyId),
          expectedRevision: scopedRequiredId(p.replyTo.expectedRevision),
        });
      }
      return Object.freeze({
        ...base,
        operation,
        payload: Object.freeze({
          ...target(),
          ...body(),
          rootId: scopedRequiredId(p.rootId),
          expectedRootRevision: scopedRequiredId(p.expectedRootRevision),
          replyTo,
        }),
      });
    }
    case 'set_comment_like_scoped':
      return Object.freeze({
        ...base,
        operation,
        payload: Object.freeze(like()),
      });
    case 'set_reply_like_scoped':
      return Object.freeze({
        ...base,
        operation,
        payload: Object.freeze({
          ...like(),
          replyId: scopedRequiredId(p.replyId),
          expectedRootRevision: scopedRequiredId(p.expectedRootRevision),
        }),
      });
    case 'set_target_subscription_scoped':
      return Object.freeze({
        ...base,
        operation,
        payload: Object.freeze({
          ...target(),
          expectedSubscriptionRevision: scopedRequiredId(
            p.expectedSubscriptionRevision,
          ),
          subscribed: scopedRequiredBoolean(p.subscribed),
        }),
      });
    case 'create_target_scoped':
      return Object.freeze({
        ...base,
        operation,
        payload: Object.freeze(definition()),
      });
    case 'edit_target_scoped':
      return Object.freeze({
        ...base,
        operation,
        payload: Object.freeze({
          ...definition(),
          ...target(),
          expectedDefinitionRevision: scopedRequiredId(
            p.expectedDefinitionRevision,
          ),
          expectedContentVersion: scopedContentVersion(
            p.expectedContentVersion,
            2147483646,
          ),
        }),
      });
  }
}
export function canonicalRatingScopedJson(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string')
    return JSON.stringify(v);
  if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
  if (Array.isArray(v))
    return `[${v.map(canonicalRatingScopedJson).join(',')}]`;
  if (isRecord(v))
    return `{${Object.keys(v)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalRatingScopedJson(v[key])}`,
      )
      .join(',')}}`;
  return invalidRating();
}
export function ratingScopedIntentHash(raw: RatingScopedIntent): string {
  const { operation, context, payload } = decodeRatingScopedIntent(raw);
  return sha256(
    RATING_SCOPED_HASH_DOMAIN +
      canonicalRatingScopedJson({
        protocolVersion: 2,
        operation,
        intent: { context, payload },
      }),
  );
}
const resultKeys: { readonly [K in RatingScopedOperation]: readonly string[] } =
  {
    set_score_scoped: ['targetId', 'subjectId', 'revision', 'occurredAt'],
    create_comment_scoped: ['targetId', 'subjectId', 'revision', 'occurredAt'],
    create_reply_scoped: [
      'targetId',
      'rootId',
      'replyId',
      'revision',
      'occurredAt',
    ],
    set_comment_like_scoped: [
      'targetId',
      'rootId',
      'replyId',
      'liked',
      'revision',
      'occurredAt',
    ],
    set_reply_like_scoped: [
      'targetId',
      'rootId',
      'replyId',
      'liked',
      'revision',
      'occurredAt',
    ],
    set_target_subscription_scoped: [
      'targetId',
      'subscribed',
      'revision',
      'occurredAt',
    ],
    create_target_scoped: [
      'targetId',
      'revision',
      'catalogRevision',
      'occurredAt',
    ],
    edit_target_scoped: [
      'targetId',
      'revision',
      'definitionRevision',
      'contentVersion',
      'occurredAt',
    ],
  };
export function decodeRatingScopedReceipt(v: unknown): RatingScopedReceipt {
  if (!isRecord(v)) invalidRating();
  exact(v, [
    'protocolVersion',
    'requestId',
    'operation',
    'intentHash',
    'outcome',
    v.outcome === 'closed' ? 'code' : 'result',
  ]);
  if (
    v.protocolVersion !== 2 ||
    !ratingId(v.requestId) ||
    !isRatingScopedOperation(v.operation) ||
    !ratingScopedDigest(v.intentHash)
  )
    invalidRating();
  const operation = v.operation;
  if (v.outcome === 'closed') {
    if (
      !(ratingScopedClosureCodes as readonly unknown[]).includes(v.code) ||
      (v.code === 'RATING_CREATION_CANCELLED' &&
        operation !== 'create_target_scoped') ||
      (v.code === 'RATING_EDIT_CANCELLED' && operation !== 'edit_target_scoped')
    )
      invalidRating();
    return Object.freeze({
      protocolVersion: 2,
      requestId: v.requestId,
      operation,
      intentHash: v.intentHash,
      outcome: 'closed',
      code: v.code as RatingScopedClosureCode,
    });
  }
  if (
    (v.outcome !== 'applied' && v.outcome !== 'noop') ||
    (v.outcome === 'noop' &&
      (operation === 'create_comment_scoped' ||
        operation === 'create_reply_scoped' ||
        operation === 'create_target_scoped'))
  )
    invalidRating();
  exact(v.result, resultKeys[operation]);
  const r = v.result;
  if (!ratingTimestamp(r.occurredAt)) invalidRating();
  const base: {
      readonly protocolVersion: 2;
      readonly requestId: string;
      readonly intentHash: string;
      readonly outcome: 'applied' | 'noop';
    } = {
      protocolVersion: 2 as const,
      requestId: v.requestId,
      intentHash: v.intentHash,
      outcome: v.outcome,
    },
    result = {
      targetId: scopedRequiredId(r.targetId),
      revision: scopedRequiredId(r.revision),
      occurredAt: r.occurredAt,
    };
  switch (operation) {
    case 'set_score_scoped':
    case 'create_comment_scoped':
      return Object.freeze({
        ...base,
        operation,
        result: Object.freeze({
          ...result,
          subjectId: scopedRequiredId(r.subjectId),
        }),
      });
    case 'create_reply_scoped':
      return Object.freeze({
        ...base,
        operation,
        result: Object.freeze({
          ...result,
          rootId: scopedRequiredId(r.rootId),
          replyId: scopedRequiredId(r.replyId),
        }),
      });
    case 'set_comment_like_scoped':
      if (r.replyId !== null) invalidRating();
      return Object.freeze({
        ...base,
        operation,
        result: Object.freeze({
          ...result,
          rootId: scopedRequiredId(r.rootId),
          replyId: null,
          liked: scopedRequiredBoolean(r.liked),
        }),
      });
    case 'set_reply_like_scoped':
      return Object.freeze({
        ...base,
        operation,
        result: Object.freeze({
          ...result,
          rootId: scopedRequiredId(r.rootId),
          replyId: scopedRequiredId(r.replyId),
          liked: scopedRequiredBoolean(r.liked),
        }),
      });
    case 'set_target_subscription_scoped':
      return Object.freeze({
        ...base,
        operation,
        result: Object.freeze({
          ...result,
          subscribed: scopedRequiredBoolean(r.subscribed),
        }),
      });
    case 'create_target_scoped':
      return Object.freeze({
        ...base,
        operation,
        result: Object.freeze({
          ...result,
          catalogRevision: scopedRequiredId(r.catalogRevision),
        }),
      });
    case 'edit_target_scoped':
      return Object.freeze({
        ...base,
        operation,
        result: Object.freeze({
          ...result,
          definitionRevision: scopedRequiredId(r.definitionRevision),
          contentVersion: scopedContentVersion(r.contentVersion),
        }),
      });
  }
}
export function matchRatingScopedReceipt(
  raw: RatingScopedIntent,
  value: RatingScopedReceipt,
): void {
  const intent = decodeRatingScopedIntent(raw),
    receipt = decodeRatingScopedReceipt(value);
  if (
    receipt.requestId !== intent.payload.clientRequestId ||
    receipt.operation !== intent.operation ||
    receipt.intentHash !== ratingScopedIntentHash(intent)
  )
    invalidRating();
  if (receipt.outcome === 'closed') return;
  if (
    'targetId' in intent.payload &&
    receipt.result.targetId !== intent.payload.targetId
  )
    invalidRating();
  if (
    intent.operation === 'set_score_scoped' &&
    receipt.operation === intent.operation &&
    (receipt.result.subjectId !== intent.payload.targetId ||
      (receipt.outcome === 'noop' &&
        receipt.result.revision !== intent.payload.expectedRevision))
  )
    invalidRating();
  if (
    intent.operation === 'create_reply_scoped' &&
    receipt.operation === intent.operation &&
    receipt.result.rootId !== intent.payload.rootId
  )
    invalidRating();
  if (
    (intent.operation === 'set_comment_like_scoped' ||
      intent.operation === 'set_reply_like_scoped') &&
    (receipt.operation === 'set_comment_like_scoped' ||
      receipt.operation === 'set_reply_like_scoped') &&
    (receipt.result.rootId !== intent.payload.rootId ||
      receipt.result.liked !== intent.payload.liked ||
      (receipt.outcome === 'noop' &&
        receipt.result.revision !== intent.payload.expectedLikeRevision) ||
      (intent.operation === 'set_reply_like_scoped' &&
        receipt.result.replyId !== intent.payload.replyId))
  )
    invalidRating();
  if (
    intent.operation === 'set_target_subscription_scoped' &&
    receipt.operation === intent.operation &&
    (receipt.result.subscribed !== intent.payload.subscribed ||
      (receipt.outcome === 'noop' &&
        receipt.result.revision !==
          intent.payload.expectedSubscriptionRevision))
  )
    invalidRating();
  if (
    intent.operation === 'edit_target_scoped' &&
    receipt.operation === intent.operation &&
    (receipt.outcome === 'noop'
      ? receipt.result.revision !== intent.payload.expectedTargetRevision ||
        receipt.result.definitionRevision !==
          intent.payload.expectedDefinitionRevision ||
        receipt.result.contentVersion !== intent.payload.expectedContentVersion
      : receipt.result.revision === intent.payload.expectedTargetRevision ||
        receipt.result.definitionRevision ===
          intent.payload.expectedDefinitionRevision ||
        receipt.result.contentVersion !==
          intent.payload.expectedContentVersion + 1)
  )
    invalidRating();
}
export function decodeRatingScopedPrepared(v: unknown): RatingScopedPrepared {
  if (isRecord(v) && 'outcome' in v) return decodeRatingScopedReceipt(v);
  exact(v, [
    'intent',
    'contextRevision',
    'targetId',
    'targetRevision',
    'definitionRevision',
    'contentVersion',
    'validUntil',
  ]);
  const intent = decodeRatingScopedIntent(v.intent);
  if (
    (intent.operation !== 'create_target_scoped' &&
      intent.operation !== 'edit_target_scoped') ||
    !ratingCursor(v.contextRevision) ||
    !ratingId(v.targetId) ||
    !ratingId(v.targetRevision) ||
    !ratingId(v.definitionRevision) ||
    !ratingScopedPositive(v.contentVersion) ||
    v.contentVersion > 2147483647 ||
    !ratingTimestamp(v.validUntil)
  )
    invalidRating();
  if (
    intent.operation === 'create_target_scoped'
      ? v.contentVersion !== 1
      : v.targetId !== intent.payload.targetId ||
        v.targetRevision === intent.payload.expectedTargetRevision ||
        v.definitionRevision === intent.payload.expectedDefinitionRevision ||
        v.contentVersion !== intent.payload.expectedContentVersion + 1
  )
    invalidRating();
  return Object.freeze({
    intent,
    contextRevision: v.contextRevision,
    targetId: v.targetId,
    targetRevision: v.targetRevision,
    definitionRevision: v.definitionRevision,
    contentVersion: v.contentVersion,
    validUntil: v.validUntil,
  });
}
