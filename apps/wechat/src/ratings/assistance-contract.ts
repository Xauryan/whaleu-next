import { sha256 } from 'js-sha256';
import { isRecord } from '../api/errors';
import { exact } from '../community/contract';
import { invalidRating, ratingId } from './contract';
import {
  decodeRatingCategoryPlacement,
  ratingCategoryScopedJsonByteLength,
  type RatingCategoryPlacement,
} from './category-scoped-contract';
import {
  canonicalRatingScopedJson,
  decodeRatingNavigationSelector,
  decodeRatingScopedCommandContext,
  type RatingNavigationSelector,
  type RatingScopedCommandContext,
} from './scoped-contract';
export const ASSISTANCE_BODY_BUDGET = 65_536 - 1_024;
export const ASSISTANCE_PROFILE = 'synthetic-rating-suggestion-v1';
export type AssistancePurpose = 'category_description' | 'rating_publish_title';
export type AssistanceOutcome =
  | 'queued'
  | 'claimed'
  | 'dispatch_admitted'
  | 'generated'
  | 'unavailable'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'outcome_unknown';
export interface AssistanceMetadata {
  readonly version: 1;
  readonly requestId: string;
  readonly purpose: AssistancePurpose;
  readonly intentHash: string;
  readonly outcome: AssistanceOutcome;
}
export type AssistancePayload =
  | {
      readonly purpose: 'category_description';
      readonly payload: {
        readonly draftNodeKey: string;
        readonly name: string;
        readonly placement: RatingCategoryPlacement;
        readonly expectedSnapshot: string;
      } & (
        | {
            readonly operation: 'create_categories_scoped';
            readonly parentId: null;
          }
        | {
            readonly operation: 'create_system_category_scoped';
            readonly systemKey: string;
            readonly levelCount: number;
          }
      );
    }
  | {
      readonly purpose: 'rating_publish_title';
      readonly payload: {
        readonly targetId: string;
        readonly expectedTargetRevision: string;
        readonly expectedCategoryRevision: string;
        readonly expectedSourceRevision: string;
        readonly destination: {
          readonly spaceId: string;
          readonly category: 'discussion';
          readonly authorMode: 'named' | 'anonymous';
        };
      };
    };
export type AssistanceRequest = AssistancePayload & {
  readonly version: 1;
  readonly requestId: string;
  readonly draftId: string;
  readonly inputRevision: number;
  readonly selector: RatingNavigationSelector;
  readonly context: RatingScopedCommandContext;
};
export type AssistanceInput = AssistancePayload & {
  readonly selector: RatingNavigationSelector;
  readonly context: RatingScopedCommandContext;
};
export interface AvailableAssistanceResult {
  readonly status: 'available';
  readonly version: 1;
  readonly actorId: string;
  readonly requestId: string;
  readonly purpose: AssistancePurpose;
  readonly draftId: string;
  readonly inputRevision: number;
  readonly intentHash: string;
  readonly inputDigest: string;
  readonly resultId: string;
  readonly resultDigest: string;
  readonly profileRevision: typeof ASSISTANCE_PROFILE;
  readonly outputContract: 1;
  readonly text: string;
  readonly expiresAt: string;
}
export type AssistanceResult =
  { readonly status: 'unavailable' } | AvailableAssistanceResult;
export const assistanceId = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    v,
  );
export const assistanceDigest = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
export const assistancePurpose = (v: unknown): v is AssistancePurpose =>
  v === 'category_description' || v === 'rating_publish_title';
const outcomes: readonly unknown[] = [
  'queued',
  'claimed',
  'dispatch_admitted',
  'generated',
  'unavailable',
  'rejected',
  'cancelled',
  'expired',
  'outcome_unknown',
];
const unsafe =
  // eslint-disable-next-line no-control-regex -- reject unsafe literal control characters
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u;
export const literalAssistanceText = (v: unknown): v is string =>
  typeof v === 'string' && !!v && v === v.trim() && !unsafe.test(v);
export function validAssistanceOutput(
  purpose: AssistancePurpose,
  text: string,
): boolean {
  if (
    !literalAssistanceText(text) ||
    /[<>`{}[\]]|https?:|www\.|[a-z][a-z0-9+.-]*:\/\//iu.test(text) ||
    /^["'“”‘’]|["'“”‘’]$/u.test(text)
  )
    return false;
  const count = [...text].length;
  return purpose === 'category_description'
    ? count >= 9 && count <= 11 && !/[\p{P}]$/u.test(text)
    : count >= 1 && count <= 12 && /[?？]$/u.test(text);
}
export function decodeAssistanceRequest(v: unknown): AssistanceRequest {
  exact(v, [
    'version',
    'requestId',
    'draftId',
    'inputRevision',
    'selector',
    'context',
    'purpose',
    'payload',
  ]);
  if (
    v.version !== 1 ||
    !assistanceId(v.requestId) ||
    !assistanceId(v.draftId) ||
    !assistancePurpose(v.purpose) ||
    !Number.isSafeInteger(v.inputRevision) ||
    (v.inputRevision as number) < 0 ||
    (v.inputRevision as number) > 2_147_483_647 ||
    !isRecord(v.payload)
  )
    invalidRating();
  const selector = decodeRatingNavigationSelector(v.selector),
    context = decodeRatingScopedCommandContext(v.context),
    p = v.payload;
  if (
    canonicalRatingScopedJson(selector) !==
    canonicalRatingScopedJson(context.selector)
  )
    invalidRating();
  if (v.purpose === 'category_description') {
    const system = p.operation === 'create_system_category_scoped';
    exact(p, [
      'operation',
      'draftNodeKey',
      'name',
      'placement',
      'expectedSnapshot',
      ...(system ? ['systemKey', 'levelCount'] : ['parentId']),
    ]);
    if (
      typeof p.draftNodeKey !== 'string' ||
      !/^[a-z][a-z0-9_]{0,31}$/.test(p.draftNodeKey) ||
      !literalAssistanceText(p.name) ||
      [...p.name].length > 100 ||
      !assistanceDigest(p.expectedSnapshot)
    )
      invalidRating();
    if (
      system
        ? typeof p.systemKey !== 'string' ||
          !/^[a-z][a-z0-9_]{1,48}$/.test(p.systemKey) ||
          ![1, 2, 3].includes(p.levelCount as number)
        : p.operation !== 'create_categories_scoped' || p.parentId !== null
    )
      invalidRating();
    decodeRatingCategoryPlacement(p.placement);
  } else {
    exact(p, [
      'targetId',
      'expectedTargetRevision',
      'expectedCategoryRevision',
      'expectedSourceRevision',
      'destination',
    ]);
    for (const field of [
      'targetId',
      'expectedTargetRevision',
      'expectedCategoryRevision',
      'expectedSourceRevision',
    ])
      if (!ratingId(p[field])) invalidRating();
    exact(p.destination, ['spaceId', 'category', 'authorMode']);
    if (
      !ratingId(p.destination.spaceId) ||
      p.destination.category !== 'discussion' ||
      !['named', 'anonymous'].includes(p.destination.authorMode as string)
    )
      invalidRating();
  }
  if (ratingCategoryScopedJsonByteLength(v) > 65_536) invalidRating();
  return Object.freeze({
    ...v,
    selector,
    context,
  }) as unknown as AssistanceRequest;
}
export function assistanceIntentHash(request: AssistanceRequest): string {
  return sha256(
    `whaleu:ratings:assistance:intent:v1\n${canonicalRatingScopedJson(decodeAssistanceRequest(request))}`,
  );
}
export function decodeAssistanceMetadata(v: unknown): AssistanceMetadata {
  exact(v, ['version', 'requestId', 'purpose', 'intentHash', 'outcome']);
  if (
    v.version !== 1 ||
    !assistanceId(v.requestId) ||
    !assistancePurpose(v.purpose) ||
    !assistanceDigest(v.intentHash) ||
    !outcomes.includes(v.outcome)
  )
    invalidRating();
  return Object.freeze({ ...v }) as unknown as AssistanceMetadata;
}
export function decodeAssistanceResult(v: unknown): AssistanceResult {
  if (!isRecord(v)) invalidRating();
  if (v.status === 'unavailable') {
    exact(v, ['status']);
    return { status: 'unavailable' };
  }
  exact(v, [
    'status',
    'version',
    'actorId',
    'requestId',
    'purpose',
    'draftId',
    'inputRevision',
    'intentHash',
    'inputDigest',
    'resultId',
    'resultDigest',
    'profileRevision',
    'outputContract',
    'text',
    'expiresAt',
  ]);
  if (
    v.status !== 'available' ||
    v.version !== 1 ||
    !ratingId(v.actorId) ||
    !assistanceId(v.requestId) ||
    !assistanceId(v.draftId) ||
    !assistanceId(v.resultId) ||
    !assistancePurpose(v.purpose) ||
    !Number.isSafeInteger(v.inputRevision) ||
    (v.inputRevision as number) < 0 ||
    (v.inputRevision as number) > 2_147_483_647 ||
    !assistanceDigest(v.intentHash) ||
    !assistanceDigest(v.inputDigest) ||
    !assistanceDigest(v.resultDigest) ||
    v.profileRevision !== ASSISTANCE_PROFILE ||
    v.outputContract !== 1 ||
    typeof v.text !== 'string' ||
    !validAssistanceOutput(v.purpose, v.text) ||
    sha256(`whaleu:ratings:assistance:result:v1\n${v.text}`) !==
      v.resultDigest ||
    typeof v.expiresAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT.*Z$/.test(v.expiresAt) ||
    !Number.isFinite(Date.parse(v.expiresAt)) ||
    ratingCategoryScopedJsonByteLength(v) > 8192
  )
    invalidRating();
  return Object.freeze({ ...v }) as unknown as AvailableAssistanceResult;
}
export function matchAssistanceMetadata(
  request: Pick<AssistanceMetadata, 'requestId' | 'purpose' | 'intentHash'>,
  metadata: AssistanceMetadata,
): void {
  if (
    request.requestId !== metadata.requestId ||
    request.purpose !== metadata.purpose ||
    request.intentHash !== metadata.intentHash
  )
    invalidRating();
}
