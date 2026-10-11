import { sha256 } from 'js-sha256';
import { isRecord } from '../api/errors';
import { exact } from '../community/contract';
import {
  invalidAnnouncementMedia,
  announcementMediaUuid,
  announcementMediaSlot,
  announcementMediaRevision,
} from './announcement-validation';
import type { AnnouncementMediaSlot } from './announcement-validation';
import {
  decodeUploadGrant,
  decodeUploadObserved,
  uploadInteger,
  uploadDigest,
} from './upload-contracts';
import type {
  UploadGrant,
  UploadObserved,
  UploadDeclaration,
} from './upload-contracts';
export type { AnnouncementMediaSlot } from './announcement-validation';
export const ANNOUNCEMENT_MEDIA_PROTOCOL = 'announcement-media-v1' as const;
export interface AnnouncementMediaPrepare {
  readonly protocol: typeof ANNOUNCEMENT_MEDIA_PROTOCOL;
  readonly clientRequestId: string;
  readonly announcementId: string;
  readonly slot: AnnouncementMediaSlot;
  readonly revision: number;
  readonly declaration: UploadDeclaration;
}
export interface AnnouncementMediaDescriptor {
  readonly protocol: typeof ANNOUNCEMENT_MEDIA_PROTOCOL;
  readonly kind: 'announcement-media';
  readonly announcementId: string;
  readonly slot: AnnouncementMediaSlot;
  readonly revision: number;
  readonly bindingId: string;
  readonly width: number;
  readonly height: number;
  readonly variants: readonly ['thumb-v1', 'display-v1'];
}
interface Base {
  readonly protocol: typeof ANNOUNCEMENT_MEDIA_PROTOCOL;
  readonly intentId: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly serverNow: number;
}
export type AnnouncementMediaStatus = Base &
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
export type AnnouncementMediaRecovery = {
  readonly protocol: typeof ANNOUNCEMENT_MEDIA_PROTOCOL;
  readonly requestId: string;
  readonly serverNow: number;
} & (
  | { readonly state: 'not_recorded'; readonly requestHash: null }
  | {
      readonly state: 'recorded';
      readonly requestHash: string;
      readonly status: AnnouncementMediaStatus;
    }
  | {
      readonly state: 'cancelled_before_prepare';
      readonly requestHash: string;
      readonly reason: 'cancelled';
    }
);
export type AnnouncementMediaGrant = Omit<UploadGrant, 'version'> & {
  readonly protocol: typeof ANNOUNCEMENT_MEDIA_PROTOCOL;
};
export type AnnouncementMediaObserved = Omit<UploadObserved, 'version'> & {
  readonly protocol: typeof ANNOUNCEMENT_MEDIA_PROTOCOL;
};
export function decodeAnnouncementMediaPrepare(
  v: unknown,
): AnnouncementMediaPrepare {
  exact(v, [
    'protocol',
    'clientRequestId',
    'announcementId',
    'slot',
    'revision',
    'declaration',
  ]);
  exact(v.declaration, ['mime', 'bytes', 'sha256']);
  if (
    v.protocol !== ANNOUNCEMENT_MEDIA_PROTOCOL ||
    announcementMediaRevision(v.revision) === Number.MAX_SAFE_INTEGER ||
    (v.declaration.mime !== 'image/png' &&
      v.declaration.mime !== 'image/jpeg') ||
    !uploadInteger(v.declaration.bytes, 1, 5 * 1024 * 1024) ||
    !uploadDigest(v.declaration.sha256)
  )
    invalidAnnouncementMedia();
  return Object.freeze({
    protocol: ANNOUNCEMENT_MEDIA_PROTOCOL,
    clientRequestId: announcementMediaUuid(v.clientRequestId),
    announcementId: announcementMediaUuid(v.announcementId),
    slot: announcementMediaSlot(v.slot),
    revision: announcementMediaRevision(v.revision),
    declaration: Object.freeze({
      mime: v.declaration.mime,
      bytes: v.declaration.bytes,
      sha256: v.declaration.sha256,
    }),
  });
}
export function announcementMediaPrepareHash(
  actor: string,
  raw: unknown,
): string {
  const input = decodeAnnouncementMediaPrepare(raw);
  return sha256(
    'whaleu-announcement-media-prepare:v1\n' +
      JSON.stringify({
        protocol: ANNOUNCEMENT_MEDIA_PROTOCOL,
        actorAccountId: announcementMediaUuid(actor),
        clientRequestId: input.clientRequestId,
        announcementId: input.announcementId,
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
export function decodeAnnouncementMediaDescriptor(
  v: unknown,
): AnnouncementMediaDescriptor {
  exact(v, [
    'protocol',
    'kind',
    'announcementId',
    'slot',
    'revision',
    'bindingId',
    'width',
    'height',
    'variants',
  ]);
  if (
    v.protocol !== ANNOUNCEMENT_MEDIA_PROTOCOL ||
    v.kind !== 'announcement-media' ||
    announcementMediaRevision(v.revision) === 0 ||
    !uploadInteger(v.width, 1, 2048) ||
    !uploadInteger(v.height, 1, 2048) ||
    !Array.isArray(v.variants) ||
    v.variants.length !== 2 ||
    v.variants[0] !== 'thumb-v1' ||
    v.variants[1] !== 'display-v1'
  )
    invalidAnnouncementMedia();
  return Object.freeze({
    protocol: ANNOUNCEMENT_MEDIA_PROTOCOL,
    kind: 'announcement-media',
    announcementId: announcementMediaUuid(v.announcementId),
    slot: announcementMediaSlot(v.slot),
    revision: v.revision as number,
    bindingId: announcementMediaUuid(v.bindingId),
    width: v.width,
    height: v.height,
    variants: Object.freeze(['thumb-v1', 'display-v1'] as const),
  });
}
export function decodeAnnouncementMediaStatus(
  v: unknown,
): AnnouncementMediaStatus {
  if (
    !isRecord(v) ||
    v.protocol !== ANNOUNCEMENT_MEDIA_PROTOCOL ||
    !uploadDigest(v.requestHash) ||
    !uploadInteger(v.serverNow, 1, Number.MAX_SAFE_INTEGER)
  )
    invalidAnnouncementMedia();
  announcementMediaUuid(v.intentId);
  announcementMediaUuid(v.requestId);
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
        invalidAnnouncementMedia();
      break;
    case 'uploaded':
      exact(v, [...base, 'operationDeadlineAt']);
      break;
    case 'processing':
      exact(v, [...base, 'operationDeadlineAt', 'retryAfterMs']);
      if (!uploadInteger(v.retryAfterMs, 250, 30000))
        invalidAnnouncementMedia();
      break;
    case 'ready_unbound':
      exact(v, [...base, 'assetId', 'bindBefore', 'mediaProof']);
      announcementMediaUuid(v.assetId);
      if (
        v.mediaProof !== 'current' ||
        !uploadInteger(v.bindBefore, 1, Number.MAX_SAFE_INTEGER) ||
        v.bindBefore <= v.serverNow
      )
        invalidAnnouncementMedia();
      break;
    case 'bound_history':
      exact(v, [...base, 'assetId', 'bindingId', 'attachmentState']);
      announcementMediaUuid(v.assetId);
      announcementMediaUuid(v.bindingId);
      if (!['active', 'detached'].includes(String(v.attachmentState)))
        invalidAnnouncementMedia();
      break;
    case 'terminal':
      exact(v, [...base, 'reason', 'cleanup']);
      if (
        !['cancelled', 'expired', 'rejected', 'deleted'].includes(
          String(v.reason),
        ) ||
        !['pending', 'retained', 'confirmed'].includes(String(v.cleanup))
      )
        invalidAnnouncementMedia();
      break;
    case 'unavailable':
      exact(v, [...base, 'reason', 'retryable']);
      if (v.reason !== 'MEDIA_UNAVAILABLE' || typeof v.retryable !== 'boolean')
        invalidAnnouncementMedia();
      break;
    default:
      invalidAnnouncementMedia();
  }
  if (
    'operationDeadlineAt' in v &&
    !uploadInteger(v.operationDeadlineAt, 1, Number.MAX_SAFE_INTEGER)
  )
    invalidAnnouncementMedia();
  return Object.freeze({ ...v }) as unknown as AnnouncementMediaStatus;
}
export function decodeAnnouncementMediaRecovery(
  v: unknown,
): AnnouncementMediaRecovery {
  if (
    !isRecord(v) ||
    v.protocol !== ANNOUNCEMENT_MEDIA_PROTOCOL ||
    !uploadInteger(v.serverNow, 1, Number.MAX_SAFE_INTEGER)
  )
    invalidAnnouncementMedia();
  announcementMediaUuid(v.requestId);
  const base = ['protocol', 'requestId', 'serverNow', 'state', 'requestHash'];
  if (v.state === 'not_recorded') {
    exact(v, base);
    if (v.requestHash !== null) invalidAnnouncementMedia();
  } else if (v.state === 'cancelled_before_prepare') {
    exact(v, [...base, 'reason']);
    if (!uploadDigest(v.requestHash) || v.reason !== 'cancelled')
      invalidAnnouncementMedia();
  } else if (v.state === 'recorded') {
    exact(v, [...base, 'status']);
    const status = decodeAnnouncementMediaStatus(v.status);
    if (
      !uploadDigest(v.requestHash) ||
      status.requestId !== v.requestId ||
      status.requestHash !== v.requestHash
    )
      invalidAnnouncementMedia();
    return Object.freeze({
      ...v,
      status,
    }) as unknown as AnnouncementMediaRecovery;
  } else invalidAnnouncementMedia();
  return Object.freeze({ ...v }) as unknown as AnnouncementMediaRecovery;
}
export function decodeAnnouncementMediaGrant(
  v: unknown,
): AnnouncementMediaGrant {
  if (
    !isRecord(v) ||
    v.protocol !== ANNOUNCEMENT_MEDIA_PROTOCOL ||
    'version' in v
  )
    invalidAnnouncementMedia();
  const { protocol, ...rest } = v;
  void protocol;
  const { version, ...value } = decodeUploadGrant({ ...rest, version: 1 });
  void version;
  return Object.freeze({ ...value, protocol: ANNOUNCEMENT_MEDIA_PROTOCOL });
}
export function decodeAnnouncementMediaObserved(
  v: unknown,
): AnnouncementMediaObserved {
  if (
    !isRecord(v) ||
    v.protocol !== ANNOUNCEMENT_MEDIA_PROTOCOL ||
    'version' in v
  )
    invalidAnnouncementMedia();
  const { protocol, ...rest } = v;
  void protocol;
  const { version, ...value } = decodeUploadObserved({ ...rest, version: 2 });
  void version;
  return Object.freeze({ ...value, protocol: ANNOUNCEMENT_MEDIA_PROTOCOL });
}
