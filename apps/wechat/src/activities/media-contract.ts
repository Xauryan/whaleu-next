import { sha256 } from 'js-sha256';
import { isRecord } from '../api/errors';
import { exact } from '../community/contract';
import {
  invalidActivityMedia,
  activityMediaUuid,
  activityMediaSlot,
  activityMediaRevision,
} from './media-validation';
import type { ActivityMediaSlot } from './media-validation';
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
export type { ActivityMediaSlot } from './media-validation';
export const ACTIVITY_MEDIA_PROTOCOL = 'activity-media-v1' as const;
export interface ActivityMediaPrepare {
  readonly protocol: typeof ACTIVITY_MEDIA_PROTOCOL;
  readonly clientRequestId: string;
  readonly activityId: string;
  readonly slot: ActivityMediaSlot;
  readonly revision: number;
  readonly declaration: UploadDeclaration;
}
export interface ActivityMediaDescriptor {
  readonly protocol: typeof ACTIVITY_MEDIA_PROTOCOL;
  readonly kind: 'activity-media';
  readonly activityId: string;
  readonly slot: ActivityMediaSlot;
  readonly revision: number;
  readonly bindingId: string;
  readonly width: number;
  readonly height: number;
  readonly variants: readonly ['thumb-v1', 'display-v1'];
}
interface Base {
  readonly protocol: typeof ACTIVITY_MEDIA_PROTOCOL;
  readonly intentId: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly serverNow: number;
}
export type ActivityMediaStatus = Base &
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
export type ActivityMediaRecovery = {
  readonly protocol: typeof ACTIVITY_MEDIA_PROTOCOL;
  readonly requestId: string;
  readonly serverNow: number;
} & (
  | { readonly state: 'not_recorded'; readonly requestHash: null }
  | {
      readonly state: 'recorded';
      readonly requestHash: string;
      readonly status: ActivityMediaStatus;
    }
  | {
      readonly state: 'cancelled_before_prepare';
      readonly requestHash: string;
      readonly reason: 'cancelled';
    }
);
export type ActivityMediaGrant = Omit<UploadGrant, 'version'> & {
  readonly protocol: typeof ACTIVITY_MEDIA_PROTOCOL;
};
export type ActivityMediaObserved = Omit<UploadObserved, 'version'> & {
  readonly protocol: typeof ACTIVITY_MEDIA_PROTOCOL;
};
export function decodeActivityMediaPrepare(v: unknown): ActivityMediaPrepare {
  exact(v, [
    'protocol',
    'clientRequestId',
    'activityId',
    'slot',
    'revision',
    'declaration',
  ]);
  exact(v.declaration, ['mime', 'bytes', 'sha256']);
  if (
    v.protocol !== ACTIVITY_MEDIA_PROTOCOL ||
    activityMediaRevision(v.revision) === Number.MAX_SAFE_INTEGER ||
    (v.declaration.mime !== 'image/png' &&
      v.declaration.mime !== 'image/jpeg') ||
    !uploadInteger(v.declaration.bytes, 1, 5 * 1024 * 1024) ||
    !uploadDigest(v.declaration.sha256)
  )
    invalidActivityMedia();
  return Object.freeze({
    protocol: ACTIVITY_MEDIA_PROTOCOL,
    clientRequestId: activityMediaUuid(v.clientRequestId),
    activityId: activityMediaUuid(v.activityId),
    slot: activityMediaSlot(v.slot),
    revision: activityMediaRevision(v.revision),
    declaration: Object.freeze({
      mime: v.declaration.mime,
      bytes: v.declaration.bytes,
      sha256: v.declaration.sha256,
    }),
  });
}
export function activityMediaPrepareHash(actor: string, raw: unknown): string {
  const input = decodeActivityMediaPrepare(raw);
  return sha256(
    'whaleu-activity-media-prepare:v1\n' +
      JSON.stringify({
        protocol: ACTIVITY_MEDIA_PROTOCOL,
        actorAccountId: activityMediaUuid(actor),
        clientRequestId: input.clientRequestId,
        activityId: input.activityId,
        slot: input.slot,
        revision: input.revision,
        declaration: {
          mime: input.declaration.mime,
          bytes: input.declaration.bytes,
          sha256: input.declaration.sha256,
        },
      }),
  );
}
export function decodeActivityMediaDescriptor(
  v: unknown,
): ActivityMediaDescriptor {
  exact(v, [
    'protocol',
    'kind',
    'activityId',
    'slot',
    'revision',
    'bindingId',
    'width',
    'height',
    'variants',
  ]);
  if (
    v.protocol !== ACTIVITY_MEDIA_PROTOCOL ||
    v.kind !== 'activity-media' ||
    activityMediaRevision(v.revision) === 0 ||
    !uploadInteger(v.width, 1, 2048) ||
    !uploadInteger(v.height, 1, 2048) ||
    !Array.isArray(v.variants) ||
    v.variants.length !== 2 ||
    v.variants[0] !== 'thumb-v1' ||
    v.variants[1] !== 'display-v1'
  )
    invalidActivityMedia();
  return Object.freeze({
    protocol: ACTIVITY_MEDIA_PROTOCOL,
    kind: 'activity-media',
    activityId: activityMediaUuid(v.activityId),
    slot: activityMediaSlot(v.slot),
    revision: v.revision as number,
    bindingId: activityMediaUuid(v.bindingId),
    width: v.width,
    height: v.height,
    variants: Object.freeze(['thumb-v1', 'display-v1'] as const),
  });
}
export function decodeActivityMediaStatus(v: unknown): ActivityMediaStatus {
  if (
    !isRecord(v) ||
    v.protocol !== ACTIVITY_MEDIA_PROTOCOL ||
    !uploadDigest(v.requestHash) ||
    !uploadInteger(v.serverNow, 1, Number.MAX_SAFE_INTEGER)
  )
    invalidActivityMedia();
  activityMediaUuid(v.intentId);
  activityMediaUuid(v.requestId);
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
        invalidActivityMedia();
      break;
    case 'uploaded':
      exact(v, [...base, 'operationDeadlineAt']);
      break;
    case 'processing':
      exact(v, [...base, 'operationDeadlineAt', 'retryAfterMs']);
      if (!uploadInteger(v.retryAfterMs, 250, 30000)) invalidActivityMedia();
      break;
    case 'ready_unbound':
      exact(v, [...base, 'assetId', 'bindBefore', 'mediaProof']);
      activityMediaUuid(v.assetId);
      if (
        v.mediaProof !== 'current' ||
        !uploadInteger(v.bindBefore, 1, Number.MAX_SAFE_INTEGER) ||
        v.bindBefore <= v.serverNow
      )
        invalidActivityMedia();
      break;
    case 'bound_history':
      exact(v, [...base, 'assetId', 'bindingId', 'attachmentState']);
      activityMediaUuid(v.assetId);
      activityMediaUuid(v.bindingId);
      if (!['active', 'detached'].includes(String(v.attachmentState)))
        invalidActivityMedia();
      break;
    case 'terminal':
      exact(v, [...base, 'reason', 'cleanup']);
      if (
        !['cancelled', 'expired', 'rejected', 'deleted'].includes(
          String(v.reason),
        ) ||
        !['pending', 'retained', 'confirmed'].includes(String(v.cleanup))
      )
        invalidActivityMedia();
      break;
    case 'unavailable':
      exact(v, [...base, 'reason', 'retryable']);
      if (v.reason !== 'MEDIA_UNAVAILABLE' || typeof v.retryable !== 'boolean')
        invalidActivityMedia();
      break;
    default:
      invalidActivityMedia();
  }
  if (
    'operationDeadlineAt' in v &&
    !uploadInteger(v.operationDeadlineAt, 1, Number.MAX_SAFE_INTEGER)
  )
    invalidActivityMedia();
  return Object.freeze({ ...v }) as unknown as ActivityMediaStatus;
}
export function decodeActivityMediaRecovery(v: unknown): ActivityMediaRecovery {
  if (
    !isRecord(v) ||
    v.protocol !== ACTIVITY_MEDIA_PROTOCOL ||
    !uploadInteger(v.serverNow, 1, Number.MAX_SAFE_INTEGER)
  )
    invalidActivityMedia();
  activityMediaUuid(v.requestId);
  const base = ['protocol', 'requestId', 'serverNow', 'state', 'requestHash'];
  if (v.state === 'not_recorded') {
    exact(v, base);
    if (v.requestHash !== null) invalidActivityMedia();
  } else if (v.state === 'cancelled_before_prepare') {
    exact(v, [...base, 'reason']);
    if (!uploadDigest(v.requestHash) || v.reason !== 'cancelled')
      invalidActivityMedia();
  } else if (v.state === 'recorded') {
    exact(v, [...base, 'status']);
    const status = decodeActivityMediaStatus(v.status);
    if (
      !uploadDigest(v.requestHash) ||
      status.requestId !== v.requestId ||
      status.requestHash !== v.requestHash
    )
      invalidActivityMedia();
    return Object.freeze({
      ...v,
      status,
    }) as unknown as ActivityMediaRecovery;
  } else invalidActivityMedia();
  return Object.freeze({ ...v }) as unknown as ActivityMediaRecovery;
}
export function decodeActivityMediaGrant(v: unknown): ActivityMediaGrant {
  if (!isRecord(v) || v.protocol !== ACTIVITY_MEDIA_PROTOCOL || 'version' in v)
    invalidActivityMedia();
  const { protocol, ...rest } = v;
  void protocol;
  const { version, ...value } = decodeUploadGrant({ ...rest, version: 1 });
  void version;
  return Object.freeze({ ...value, protocol: ACTIVITY_MEDIA_PROTOCOL });
}
export function decodeActivityMediaObserved(v: unknown): ActivityMediaObserved {
  if (!isRecord(v) || v.protocol !== ACTIVITY_MEDIA_PROTOCOL || 'version' in v)
    invalidActivityMedia();
  const { protocol, ...rest } = v;
  void protocol;
  const { version, ...value } = decodeUploadObserved({ ...rest, version: 2 });
  void version;
  return Object.freeze({ ...value, protocol: ACTIVITY_MEDIA_PROTOCOL });
}
