import { sha256 } from 'js-sha256';
import { exact } from '../community/contract';
import { isRecord } from '../api/errors';
import { invalidRating, ratingId } from './contract';
import {
  decodeUploadGrant,
  decodeUploadObserved,
  uploadInteger,
  uploadDigest,
  type UploadGrant,
  type UploadObserved,
  type UploadDeclaration,
} from '../media/upload-contracts';
export const RATINGS_MEDIA_PROTOCOL = 'ratings-target-media-v1' as const;
export interface RatingCoverPrepare {
  readonly protocol: typeof RATINGS_MEDIA_PROTOCOL;
  readonly clientRequestId: string;
  readonly editScopeId: string;
  readonly scopeRevision: string;
  readonly slot: 'cover';
  readonly declaration: UploadDeclaration;
}
export interface RatingCoverDescriptor {
  readonly protocol: typeof RATINGS_MEDIA_PROTOCOL;
  readonly kind: 'ratings-target-media';
  readonly contextId: string;
  readonly contextToken: string;
  readonly targetId: string;
  readonly appearanceId: string;
  readonly bindingId: string;
  readonly width: number;
  readonly height: number;
  readonly variants: readonly ['thumb-v1', 'display-v1'];
}
interface Base {
  readonly protocol: typeof RATINGS_MEDIA_PROTOCOL;
  readonly editScopeId: string;
  readonly intentId: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly serverNow: number;
}
export type RatingCoverMediaStatus = Base &
  (
    | {
        readonly status: 'prepared';
        readonly operationDeadlineAt: number;
        readonly upload: 'none' | 'in_flight' | 'reconcile_needed';
      }
    | { readonly status: 'uploaded'; readonly operationDeadlineAt: number }
    | {
        readonly status: 'processing';
        readonly operationDeadlineAt: number;
        readonly retryAfterMs: number;
      }
    | {
        readonly status: 'ready_unbound';
        readonly assetId: string;
        readonly readyRetentionUntil: number;
        readonly editExpiresAt: number;
        readonly bindBefore: number;
        readonly mediaProof: 'current';
      }
    | {
        readonly status: 'bound_history';
        readonly assetId: string;
        readonly bindingId: string;
        readonly appearanceId: string;
        readonly targetId: string;
        readonly attachmentState: 'active' | 'detached';
      }
    | {
        readonly status: 'terminal';
        readonly reason: 'cancelled' | 'expired' | 'rejected' | 'deleted';
        readonly cleanup: 'pending' | 'retained' | 'confirmed';
      }
    | {
        readonly status: 'unavailable';
        readonly reason: 'MEDIA_UNAVAILABLE';
        readonly retryable: boolean;
      }
  );
export type RatingCoverRecovery = {
  readonly protocol: typeof RATINGS_MEDIA_PROTOCOL;
  readonly requestId: string;
  readonly serverNow: number;
} & (
  | { readonly state: 'not_recorded'; readonly requestHash: null }
  | {
      readonly state: 'recorded';
      readonly requestHash: string;
      readonly status: RatingCoverMediaStatus;
    }
  | {
      readonly state: 'cancelled_before_prepare';
      readonly requestHash: string;
      readonly reason: 'cancelled';
    }
);
export type RatingCoverGrant = Omit<UploadGrant, 'version'> & {
  readonly protocol: typeof RATINGS_MEDIA_PROTOCOL;
  readonly editScopeId: string;
};
export type RatingCoverUploadObserved = Omit<UploadObserved, 'version'> & {
  readonly protocol: typeof RATINGS_MEDIA_PROTOCOL;
  readonly editScopeId: string;
};
export function decodeRatingCoverDeclaration(v: unknown): UploadDeclaration {
  exact(v, ['mime', 'bytes', 'sha256']);
  if (
    (v.mime !== 'image/jpeg' && v.mime !== 'image/png') ||
    !uploadInteger(v.bytes, 1, 5 * 1024 * 1024) ||
    !uploadDigest(v.sha256)
  )
    invalidRating();
  return Object.freeze({ mime: v.mime, bytes: v.bytes, sha256: v.sha256 });
}
export function decodeRatingCoverPrepare(v: unknown): RatingCoverPrepare {
  exact(v, [
    'protocol',
    'clientRequestId',
    'editScopeId',
    'scopeRevision',
    'slot',
    'declaration',
  ]);
  if (
    v.protocol !== RATINGS_MEDIA_PROTOCOL ||
    !ratingId(v.clientRequestId) ||
    !ratingId(v.editScopeId) ||
    !uploadDigest(v.scopeRevision) ||
    v.slot !== 'cover'
  )
    invalidRating();
  return Object.freeze({
    protocol: RATINGS_MEDIA_PROTOCOL,
    clientRequestId: v.clientRequestId,
    editScopeId: v.editScopeId,
    scopeRevision: v.scopeRevision,
    slot: 'cover',
    declaration: decodeRatingCoverDeclaration(v.declaration),
  });
}
export function ratingCoverPrepareHash(
  actorAccountId: string,
  raw: RatingCoverPrepare,
): string {
  if (!ratingId(actorAccountId)) invalidRating();
  const input = decodeRatingCoverPrepare(raw);
  return sha256(
    'whaleu-ratings-target-media-prepare:v1\n' +
      JSON.stringify({
        protocol: RATINGS_MEDIA_PROTOCOL,
        actorAccountId,
        clientRequestId: input.clientRequestId,
        editScopeId: input.editScopeId,
        scopeRevision: input.scopeRevision,
        slot: input.slot,
        declaration: input.declaration,
      }),
  );
}
export function decodeRatingCoverDescriptor(v: unknown): RatingCoverDescriptor {
  exact(v, [
    'protocol',
    'kind',
    'targetId',
    'contextId',
    'contextToken',
    'appearanceId',
    'bindingId',
    'width',
    'height',
    'variants',
  ]);
  if (
    v.protocol !== RATINGS_MEDIA_PROTOCOL ||
    v.kind !== 'ratings-target-media' ||
    !ratingId(v.contextId) ||
    typeof v.contextToken !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(v.contextToken) ||
    !ratingId(v.targetId) ||
    !ratingId(v.appearanceId) ||
    !ratingId(v.bindingId) ||
    !uploadInteger(v.width, 1, 2048) ||
    !uploadInteger(v.height, 1, 2048) ||
    !Array.isArray(v.variants) ||
    v.variants.length !== 2 ||
    v.variants[0] !== 'thumb-v1' ||
    v.variants[1] !== 'display-v1'
  )
    invalidRating();
  return Object.freeze({
    protocol: RATINGS_MEDIA_PROTOCOL,
    kind: 'ratings-target-media',
    contextId: v.contextId,
    contextToken: v.contextToken,
    targetId: v.targetId,
    appearanceId: v.appearanceId,
    bindingId: v.bindingId,
    width: v.width,
    height: v.height,
    variants: Object.freeze(['thumb-v1', 'display-v1'] as const),
  });
}
export function decodeRatingCoverMediaStatus(
  v: unknown,
): RatingCoverMediaStatus {
  if (
    !isRecord(v) ||
    v.protocol !== RATINGS_MEDIA_PROTOCOL ||
    !ratingId(v.editScopeId) ||
    !ratingId(v.intentId) ||
    !ratingId(v.requestId) ||
    !uploadDigest(v.requestHash) ||
    !uploadInteger(v.serverNow, 1, Number.MAX_SAFE_INTEGER)
  )
    invalidRating();
  const common = [
    'protocol',
    'editScopeId',
    'intentId',
    'requestId',
    'requestHash',
    'serverNow',
    'status',
  ];
  const instant = (key: string) => {
    if (!uploadInteger(v[key], 1, Number.MAX_SAFE_INTEGER)) invalidRating();
  };
  switch (v.status) {
    case 'prepared':
      exact(v, [...common, 'operationDeadlineAt', 'upload']);
      instant('operationDeadlineAt');
      if (!['none', 'in_flight', 'reconcile_needed'].includes(String(v.upload)))
        invalidRating();
      break;
    case 'uploaded':
      exact(v, [...common, 'operationDeadlineAt']);
      instant('operationDeadlineAt');
      break;
    case 'processing':
      exact(v, [...common, 'operationDeadlineAt', 'retryAfterMs']);
      instant('operationDeadlineAt');
      if (!uploadInteger(v.retryAfterMs, 250, 30000)) invalidRating();
      break;
    case 'ready_unbound':
      exact(v, [
        ...common,
        'assetId',
        'readyRetentionUntil',
        'editExpiresAt',
        'bindBefore',
        'mediaProof',
      ]);
      if (!ratingId(v.assetId) || v.mediaProof !== 'current') invalidRating();
      for (const key of ['readyRetentionUntil', 'editExpiresAt', 'bindBefore'])
        instant(key);
      break;
    case 'bound_history':
      exact(v, [
        ...common,
        'assetId',
        'bindingId',
        'appearanceId',
        'targetId',
        'attachmentState',
      ]);
      for (const key of ['assetId', 'bindingId', 'appearanceId', 'targetId'])
        if (!ratingId(v[key])) invalidRating();
      if (v.attachmentState !== 'active' && v.attachmentState !== 'detached')
        invalidRating();
      break;
    case 'terminal':
      exact(v, [...common, 'reason', 'cleanup']);
      if (
        !['cancelled', 'expired', 'rejected', 'deleted'].includes(
          String(v.reason),
        ) ||
        !['pending', 'retained', 'confirmed'].includes(String(v.cleanup))
      )
        invalidRating();
      break;
    case 'unavailable':
      exact(v, [...common, 'reason', 'retryable']);
      if (v.reason !== 'MEDIA_UNAVAILABLE' || typeof v.retryable !== 'boolean')
        invalidRating();
      break;
    default:
      invalidRating();
  }
  return Object.freeze({ ...v }) as unknown as RatingCoverMediaStatus;
}
export function decodeRatingCoverRecovery(v: unknown): RatingCoverRecovery {
  if (
    !isRecord(v) ||
    v.protocol !== RATINGS_MEDIA_PROTOCOL ||
    !ratingId(v.requestId) ||
    !uploadInteger(v.serverNow, 1, Number.MAX_SAFE_INTEGER)
  )
    invalidRating();
  const base = ['protocol', 'requestId', 'serverNow', 'state', 'requestHash'];
  if (v.state === 'not_recorded') {
    exact(v, base);
    if (v.requestHash !== null) invalidRating();
  } else if (v.state === 'cancelled_before_prepare') {
    exact(v, [...base, 'reason']);
    if (!uploadDigest(v.requestHash) || v.reason !== 'cancelled')
      invalidRating();
  } else if (v.state === 'recorded') {
    exact(v, [...base, 'status']);
    const status = decodeRatingCoverMediaStatus(v.status);
    if (
      !uploadDigest(v.requestHash) ||
      status.requestId !== v.requestId ||
      status.requestHash !== v.requestHash
    )
      invalidRating();
    return Object.freeze({ ...v, status }) as unknown as RatingCoverRecovery;
  } else invalidRating();
  return Object.freeze({ ...v }) as unknown as RatingCoverRecovery;
}
export function decodeRatingCoverGrant(v: unknown): RatingCoverGrant {
  if (
    !isRecord(v) ||
    v.protocol !== RATINGS_MEDIA_PROTOCOL ||
    !ratingId(v.editScopeId)
  )
    invalidRating();
  const { protocol, editScopeId, ...rest } = v;
  const { version, ...grant } = decodeUploadGrant({
    ...rest,
    version: 1,
  });
  if ('version' in rest || version !== 1) invalidRating();
  return Object.freeze({ protocol, editScopeId, ...grant });
}
export function decodeRatingCoverUploadObserved(
  v: unknown,
): RatingCoverUploadObserved {
  if (
    !isRecord(v) ||
    v.protocol !== RATINGS_MEDIA_PROTOCOL ||
    !ratingId(v.editScopeId)
  )
    invalidRating();
  const { protocol, editScopeId, ...rest } = v;
  const { version, ...observed } = decodeUploadObserved({
    ...rest,
    version: 2,
  });
  if ('version' in rest || version !== 2) invalidRating();
  return Object.freeze({ protocol, editScopeId, ...observed });
}
