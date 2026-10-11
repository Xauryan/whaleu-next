import { sha256 } from 'js-sha256';
import { isRecord } from '../api/errors';
import { exact } from '../community/contract';
import {
  invalidErrandMedia,
  errandMediaUuid,
  errandMediaSlot,
  errandMediaRevision,
} from './media-validation';
import type { ErrandMediaSlot } from './media-validation';
import {
  decodeUploadGrant,
  decodeUploadObserved,
  uploadInteger,
  uploadDigest,
} from '../media/upload-contracts';
import type {
  UploadGrant,
  UploadObserved,
  UploadDeclaration,
} from '../media/upload-contracts';
export type { ErrandMediaSlot } from './media-validation';
export const ERRAND_MEDIA_PROTOCOL = 'errand-media-v1' as const;
export interface ErrandMediaPrepare {
  readonly protocol: typeof ERRAND_MEDIA_PROTOCOL;
  readonly clientRequestId: string;
  readonly draftId: string;
  readonly targetRegionId: string;
  readonly slot: ErrandMediaSlot;
  readonly draftRevision: number;
  readonly declaration: UploadDeclaration;
}
export interface ErrandMediaDescriptor {
  readonly protocol: typeof ERRAND_MEDIA_PROTOCOL;
  readonly kind: 'errand-media';
  readonly orderId: string;
  readonly slot: ErrandMediaSlot;
  readonly revision: number;
  readonly bindingId: string;
  readonly width: number;
  readonly height: number;
  readonly variants: readonly ['thumb-v1', 'display-v1'];
}
interface Base {
  readonly protocol: typeof ERRAND_MEDIA_PROTOCOL;
  readonly intentId: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly serverNow: number;
}
export type ErrandMediaStatus = Base &
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
        readonly manifestDigest: string;
        readonly bindBefore: number;
        readonly mediaProof: 'current';
      }
    | {
        readonly status: 'bound_history';
        readonly assetId: string;
        readonly bindingId: string;
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
export type ErrandMediaRecovery = {
  readonly protocol: typeof ERRAND_MEDIA_PROTOCOL;
  readonly requestId: string;
  readonly serverNow: number;
} & (
  | { readonly state: 'not_recorded'; readonly requestHash: null }
  | {
      readonly state: 'recorded';
      readonly requestHash: string;
      readonly status: ErrandMediaStatus;
    }
  | {
      readonly state: 'cancelled_before_prepare';
      readonly requestHash: string;
      readonly reason: 'cancelled';
    }
);
export type ErrandMediaGrant = Omit<UploadGrant, 'version'> & {
  readonly protocol: typeof ERRAND_MEDIA_PROTOCOL;
};
export type ErrandMediaObserved = Omit<UploadObserved, 'version'> & {
  readonly protocol: typeof ERRAND_MEDIA_PROTOCOL;
};
export function decodeErrandMediaPrepare(v: unknown): ErrandMediaPrepare {
  exact(v, [
    'protocol',
    'clientRequestId',
    'draftId',
    'targetRegionId',
    'slot',
    'draftRevision',
    'declaration',
  ]);
  exact(v.declaration, ['mime', 'bytes', 'sha256']);
  if (
    v.protocol !== ERRAND_MEDIA_PROTOCOL ||
    errandMediaRevision(v.draftRevision) === Number.MAX_SAFE_INTEGER ||
    (v.declaration.mime !== 'image/png' &&
      v.declaration.mime !== 'image/jpeg') ||
    !uploadInteger(v.declaration.bytes, 1, 5 * 1024 * 1024) ||
    !uploadDigest(v.declaration.sha256)
  )
    invalidErrandMedia();
  return Object.freeze({
    protocol: ERRAND_MEDIA_PROTOCOL,
    clientRequestId: errandMediaUuid(v.clientRequestId),
    draftId: errandMediaUuid(v.draftId),
    targetRegionId: errandMediaUuid(v.targetRegionId),
    slot: errandMediaSlot(v.slot),
    draftRevision: errandMediaRevision(v.draftRevision),
    declaration: Object.freeze({
      mime: v.declaration.mime,
      bytes: v.declaration.bytes,
      sha256: v.declaration.sha256,
    }),
  });
}
export function errandMediaPrepareHash(actor: string, raw: unknown): string {
  const input = decodeErrandMediaPrepare(raw);
  return sha256(
    'whaleu-errand-media-prepare:v1\n' +
      JSON.stringify({
        protocol: ERRAND_MEDIA_PROTOCOL,
        actorAccountId: errandMediaUuid(actor),
        clientRequestId: input.clientRequestId,
        draftId: input.draftId,
        draftRevision: input.draftRevision,
        targetRegionId: input.targetRegionId,
        slot: input.slot,
        declaration: {
          mime: input.declaration.mime,
          bytes: input.declaration.bytes,
          sha256: input.declaration.sha256,
        },
      }),
  );
}
export function decodeErrandMediaDescriptor(v: unknown): ErrandMediaDescriptor {
  exact(v, [
    'protocol',
    'kind',
    'orderId',
    'slot',
    'revision',
    'bindingId',
    'width',
    'height',
    'variants',
  ]);
  if (
    v.protocol !== ERRAND_MEDIA_PROTOCOL ||
    v.kind !== 'errand-media' ||
    errandMediaRevision(v.revision) === 0 ||
    !uploadInteger(v.width, 1, 2048) ||
    !uploadInteger(v.height, 1, 2048) ||
    !Array.isArray(v.variants) ||
    v.variants.length !== 2 ||
    v.variants[0] !== 'thumb-v1' ||
    v.variants[1] !== 'display-v1'
  )
    invalidErrandMedia();
  return Object.freeze({
    protocol: ERRAND_MEDIA_PROTOCOL,
    kind: 'errand-media',
    orderId: errandMediaUuid(v.orderId),
    slot: errandMediaSlot(v.slot),
    revision: v.revision as number,
    bindingId: errandMediaUuid(v.bindingId),
    width: v.width,
    height: v.height,
    variants: Object.freeze(['thumb-v1', 'display-v1'] as const),
  });
}
export function decodeErrandMediaStatus(v: unknown): ErrandMediaStatus {
  if (
    !isRecord(v) ||
    v.protocol !== ERRAND_MEDIA_PROTOCOL ||
    !uploadDigest(v.requestHash) ||
    !uploadInteger(v.serverNow, 1, Number.MAX_SAFE_INTEGER)
  )
    invalidErrandMedia();
  errandMediaUuid(v.intentId);
  errandMediaUuid(v.requestId);
  const base = [
    'protocol',
    'intentId',
    'requestId',
    'requestHash',
    'serverNow',
    'status',
  ];
  switch (v.status) {
    case 'prepared':
      exact(v, [...base, 'operationDeadlineAt', 'upload']);
      if (!['none', 'in_flight', 'reconcile_needed'].includes(String(v.upload)))
        invalidErrandMedia();
      break;
    case 'uploaded':
      exact(v, [...base, 'operationDeadlineAt']);
      break;
    case 'processing':
      exact(v, [...base, 'operationDeadlineAt', 'retryAfterMs']);
      if (!uploadInteger(v.retryAfterMs, 250, 30000)) invalidErrandMedia();
      break;
    case 'ready_unbound':
      exact(v, [
        ...base,
        'assetId',
        'manifestDigest',
        'bindBefore',
        'mediaProof',
      ]);
      errandMediaUuid(v.assetId);
      if (
        !uploadDigest(v.manifestDigest) ||
        v.mediaProof !== 'current' ||
        !uploadInteger(v.bindBefore, 1, Number.MAX_SAFE_INTEGER) ||
        v.bindBefore <= v.serverNow
      )
        invalidErrandMedia();
      break;
    case 'bound_history':
      exact(v, [...base, 'assetId', 'bindingId', 'attachmentState']);
      errandMediaUuid(v.assetId);
      errandMediaUuid(v.bindingId);
      if (!['active', 'detached'].includes(String(v.attachmentState)))
        invalidErrandMedia();
      break;
    case 'terminal':
      exact(v, [...base, 'reason', 'cleanup']);
      if (
        !['cancelled', 'expired', 'rejected', 'deleted'].includes(
          String(v.reason),
        ) ||
        !['pending', 'retained', 'confirmed'].includes(String(v.cleanup))
      )
        invalidErrandMedia();
      break;
    case 'unavailable':
      exact(v, [...base, 'reason', 'retryable']);
      if (v.reason !== 'MEDIA_UNAVAILABLE' || typeof v.retryable !== 'boolean')
        invalidErrandMedia();
      break;
    default:
      invalidErrandMedia();
  }
  if (
    'operationDeadlineAt' in v &&
    !uploadInteger(v.operationDeadlineAt, 1, Number.MAX_SAFE_INTEGER)
  )
    invalidErrandMedia();
  return Object.freeze({ ...v }) as unknown as ErrandMediaStatus;
}
export function decodeErrandMediaRecovery(v: unknown): ErrandMediaRecovery {
  if (
    !isRecord(v) ||
    v.protocol !== ERRAND_MEDIA_PROTOCOL ||
    !uploadInteger(v.serverNow, 1, Number.MAX_SAFE_INTEGER)
  )
    invalidErrandMedia();
  errandMediaUuid(v.requestId);
  const base = ['protocol', 'requestId', 'serverNow', 'state', 'requestHash'];
  if (v.state === 'not_recorded') {
    exact(v, base);
    if (v.requestHash !== null) invalidErrandMedia();
  } else if (v.state === 'cancelled_before_prepare') {
    exact(v, [...base, 'reason']);
    if (!uploadDigest(v.requestHash) || v.reason !== 'cancelled')
      invalidErrandMedia();
  } else if (v.state === 'recorded') {
    exact(v, [...base, 'status']);
    const status = decodeErrandMediaStatus(v.status);
    if (
      !uploadDigest(v.requestHash) ||
      status.requestId !== v.requestId ||
      status.requestHash !== v.requestHash
    )
      invalidErrandMedia();
    return Object.freeze({
      ...v,
      status,
    }) as unknown as ErrandMediaRecovery;
  } else invalidErrandMedia();
  return Object.freeze({ ...v }) as unknown as ErrandMediaRecovery;
}
export function decodeErrandMediaGrant(v: unknown): ErrandMediaGrant {
  if (!isRecord(v) || v.protocol !== ERRAND_MEDIA_PROTOCOL || 'version' in v)
    invalidErrandMedia();
  const { protocol, ...rest } = v;
  void protocol;
  const { version, ...value } = decodeUploadGrant({ ...rest, version: 1 });
  void version;
  return Object.freeze({ ...value, protocol: ERRAND_MEDIA_PROTOCOL });
}
export function decodeErrandMediaObserved(v: unknown): ErrandMediaObserved {
  if (!isRecord(v) || v.protocol !== ERRAND_MEDIA_PROTOCOL || 'version' in v)
    invalidErrandMedia();
  const { protocol, ...rest } = v;
  void protocol;
  const { version, ...value } = decodeUploadObserved({ ...rest, version: 2 });
  void version;
  return Object.freeze({ ...value, protocol: ERRAND_MEDIA_PROTOCOL });
}
