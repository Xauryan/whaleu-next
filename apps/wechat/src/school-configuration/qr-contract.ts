import { sha256 } from 'js-sha256';
import { isRecord } from '../api/errors';
import { exact } from '../community/contract';
import {
  invalidSchool,
  schoolUuid,
  schoolKey,
  schoolRevision,
} from './contract';
import type { SchoolEntryKey } from './contract';
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
export const SCHOOL_QR_MEDIA_PROTOCOL =
  'school-configuration-qr-media-v1' as const;
export interface SchoolQrPrepare {
  readonly protocol: typeof SCHOOL_QR_MEDIA_PROTOCOL;
  readonly clientRequestId: string;
  readonly regionId: string;
  readonly entryKey: SchoolEntryKey;
  readonly expectedRevision: number;
  readonly declaration: UploadDeclaration;
}
export interface SchoolQrDescriptor {
  readonly protocol: typeof SCHOOL_QR_MEDIA_PROTOCOL;
  readonly kind: 'school-configuration-qr';
  readonly regionId: string;
  readonly entryKey: SchoolEntryKey;
  readonly entryRevision: number;
  readonly bindingId: string;
  readonly width: number;
  readonly height: number;
  readonly variants: readonly ['thumb-v1', 'display-v1'];
}
interface Base {
  readonly protocol: typeof SCHOOL_QR_MEDIA_PROTOCOL;
  readonly intentId: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly serverNow: number;
}
export type SchoolQrStatus = Base &
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
export type SchoolQrRecovery = {
  readonly protocol: typeof SCHOOL_QR_MEDIA_PROTOCOL;
  readonly requestId: string;
  readonly serverNow: number;
} & (
  | { readonly state: 'not_recorded'; readonly requestHash: null }
  | {
      readonly state: 'recorded';
      readonly requestHash: string;
      readonly status: SchoolQrStatus;
    }
  | {
      readonly state: 'cancelled_before_prepare';
      readonly requestHash: string;
      readonly reason: 'cancelled';
    }
);
export type SchoolQrGrant = Omit<UploadGrant, 'version'> & {
  readonly protocol: typeof SCHOOL_QR_MEDIA_PROTOCOL;
};
export type SchoolQrObserved = Omit<UploadObserved, 'version'> & {
  readonly protocol: typeof SCHOOL_QR_MEDIA_PROTOCOL;
};
export function decodeSchoolQrPrepare(v: unknown): SchoolQrPrepare {
  exact(v, [
    'protocol',
    'clientRequestId',
    'regionId',
    'entryKey',
    'expectedRevision',
    'declaration',
  ]);
  exact(v.declaration, ['mime', 'bytes', 'sha256']);
  if (
    v.protocol !== SCHOOL_QR_MEDIA_PROTOCOL ||
    schoolRevision(v.expectedRevision) === Number.MAX_SAFE_INTEGER ||
    (v.declaration.mime !== 'image/png' &&
      v.declaration.mime !== 'image/jpeg') ||
    !uploadInteger(v.declaration.bytes, 1, 5 * 1024 * 1024) ||
    !uploadDigest(v.declaration.sha256)
  )
    invalidSchool();
  return Object.freeze({
    protocol: SCHOOL_QR_MEDIA_PROTOCOL,
    clientRequestId: schoolUuid(v.clientRequestId),
    regionId: schoolUuid(v.regionId),
    entryKey: schoolKey(v.entryKey),
    expectedRevision: schoolRevision(v.expectedRevision),
    declaration: Object.freeze({
      mime: v.declaration.mime,
      bytes: v.declaration.bytes,
      sha256: v.declaration.sha256,
    }),
  });
}
export function schoolQrPrepareHash(actor: string, raw: unknown): string {
  const input = decodeSchoolQrPrepare(raw);
  return sha256(
    'whaleu-school-configuration-qr-prepare:v1\n' +
      JSON.stringify({
        protocol: SCHOOL_QR_MEDIA_PROTOCOL,
        actorAccountId: schoolUuid(actor),
        clientRequestId: input.clientRequestId,
        regionId: input.regionId,
        entryKey: input.entryKey,
        expectedRevision: input.expectedRevision,
        declaration: {
          mime: input.declaration.mime,
          bytes: input.declaration.bytes,
          sha256: input.declaration.sha256,
        },
      }),
  );
}
export function decodeSchoolQrDescriptor(v: unknown): SchoolQrDescriptor {
  exact(v, [
    'protocol',
    'kind',
    'regionId',
    'entryKey',
    'entryRevision',
    'bindingId',
    'width',
    'height',
    'variants',
  ]);
  if (
    v.protocol !== SCHOOL_QR_MEDIA_PROTOCOL ||
    v.kind !== 'school-configuration-qr' ||
    schoolRevision(v.entryRevision) === 0 ||
    !uploadInteger(v.width, 1, 2048) ||
    !uploadInteger(v.height, 1, 2048) ||
    !Array.isArray(v.variants) ||
    v.variants.length !== 2 ||
    v.variants[0] !== 'thumb-v1' ||
    v.variants[1] !== 'display-v1'
  )
    invalidSchool();
  return Object.freeze({
    protocol: SCHOOL_QR_MEDIA_PROTOCOL,
    kind: 'school-configuration-qr',
    regionId: schoolUuid(v.regionId),
    entryKey: schoolKey(v.entryKey),
    entryRevision: v.entryRevision as number,
    bindingId: schoolUuid(v.bindingId),
    width: v.width,
    height: v.height,
    variants: Object.freeze(['thumb-v1', 'display-v1'] as const),
  });
}
export function decodeSchoolQrStatus(v: unknown): SchoolQrStatus {
  if (
    !isRecord(v) ||
    v.protocol !== SCHOOL_QR_MEDIA_PROTOCOL ||
    !uploadDigest(v.requestHash) ||
    !uploadInteger(v.serverNow, 1, Number.MAX_SAFE_INTEGER)
  )
    invalidSchool();
  schoolUuid(v.intentId);
  schoolUuid(v.requestId);
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
        invalidSchool();
      break;
    case 'uploaded':
      exact(v, [...base, 'operationDeadlineAt']);
      break;
    case 'processing':
      exact(v, [...base, 'operationDeadlineAt', 'retryAfterMs']);
      if (!uploadInteger(v.retryAfterMs, 250, 30000)) invalidSchool();
      break;
    case 'ready_unbound':
      exact(v, [...base, 'assetId', 'bindBefore', 'mediaProof']);
      schoolUuid(v.assetId);
      if (
        v.mediaProof !== 'current' ||
        !uploadInteger(v.bindBefore, 1, Number.MAX_SAFE_INTEGER) ||
        v.bindBefore <= v.serverNow
      )
        invalidSchool();
      break;
    case 'bound_history':
      exact(v, [...base, 'assetId', 'bindingId', 'attachmentState']);
      schoolUuid(v.assetId);
      schoolUuid(v.bindingId);
      if (!['active', 'detached'].includes(String(v.attachmentState)))
        invalidSchool();
      break;
    case 'terminal':
      exact(v, [...base, 'reason', 'cleanup']);
      if (
        !['cancelled', 'expired', 'rejected', 'deleted'].includes(
          String(v.reason),
        ) ||
        !['pending', 'retained', 'confirmed'].includes(String(v.cleanup))
      )
        invalidSchool();
      break;
    case 'unavailable':
      exact(v, [...base, 'reason', 'retryable']);
      if (v.reason !== 'MEDIA_UNAVAILABLE' || typeof v.retryable !== 'boolean')
        invalidSchool();
      break;
    default:
      invalidSchool();
  }
  if (
    'operationDeadlineAt' in v &&
    !uploadInteger(v.operationDeadlineAt, 1, Number.MAX_SAFE_INTEGER)
  )
    invalidSchool();
  return Object.freeze({ ...v }) as unknown as SchoolQrStatus;
}
export function decodeSchoolQrRecovery(v: unknown): SchoolQrRecovery {
  if (
    !isRecord(v) ||
    v.protocol !== SCHOOL_QR_MEDIA_PROTOCOL ||
    !uploadInteger(v.serverNow, 1, Number.MAX_SAFE_INTEGER)
  )
    invalidSchool();
  schoolUuid(v.requestId);
  const base = ['protocol', 'requestId', 'serverNow', 'state', 'requestHash'];
  if (v.state === 'not_recorded') {
    exact(v, base);
    if (v.requestHash !== null) invalidSchool();
  } else if (v.state === 'cancelled_before_prepare') {
    exact(v, [...base, 'reason']);
    if (!uploadDigest(v.requestHash) || v.reason !== 'cancelled')
      invalidSchool();
  } else if (v.state === 'recorded') {
    exact(v, [...base, 'status']);
    const status = decodeSchoolQrStatus(v.status);
    if (
      !uploadDigest(v.requestHash) ||
      status.requestId !== v.requestId ||
      status.requestHash !== v.requestHash
    )
      invalidSchool();
    return Object.freeze({ ...v, status }) as unknown as SchoolQrRecovery;
  } else invalidSchool();
  return Object.freeze({ ...v }) as unknown as SchoolQrRecovery;
}
export function decodeSchoolQrGrant(v: unknown): SchoolQrGrant {
  if (!isRecord(v) || v.protocol !== SCHOOL_QR_MEDIA_PROTOCOL || 'version' in v)
    invalidSchool();
  const { protocol, ...rest } = v;
  void protocol;
  const { version, ...value } = decodeUploadGrant({ ...rest, version: 1 });
  void version;
  return Object.freeze({ ...value, protocol: SCHOOL_QR_MEDIA_PROTOCOL });
}
export function decodeSchoolQrObserved(v: unknown): SchoolQrObserved {
  if (!isRecord(v) || v.protocol !== SCHOOL_QR_MEDIA_PROTOCOL || 'version' in v)
    invalidSchool();
  const { protocol, ...rest } = v;
  void protocol;
  const { version, ...value } = decodeUploadObserved({ ...rest, version: 2 });
  void version;
  return Object.freeze({ ...value, protocol: SCHOOL_QR_MEDIA_PROTOCOL });
}
