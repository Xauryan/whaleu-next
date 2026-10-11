import { sha256 } from 'js-sha256';
import { isRecord } from '../api/errors';
import { exact } from '../community/contract';
import {
  invalidVerificationEvidence,
  verificationEvidenceUuid,
  verificationEvidenceRevision,
} from './evidence-validation';
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
export const VERIFICATION_EVIDENCE_MEDIA_PROTOCOL =
  'verification-evidence-media-v1' as const;
export interface VerificationEvidencePrepare {
  readonly protocol: typeof VERIFICATION_EVIDENCE_MEDIA_PROTOCOL;
  readonly clientRequestId: string;
  readonly applicationId: string;
  readonly revision: number;
  readonly declaration: UploadDeclaration;
}
export interface VerificationEvidenceDescriptor {
  readonly protocol: typeof VERIFICATION_EVIDENCE_MEDIA_PROTOCOL;
  readonly kind: 'verification-evidence';
  readonly applicationId: string;
  readonly revision: number;
  readonly bindingId: string;
  readonly width: number;
  readonly height: number;
  readonly variants: readonly ['thumb-v1', 'display-v1'];
}
interface Base {
  readonly protocol: typeof VERIFICATION_EVIDENCE_MEDIA_PROTOCOL;
  readonly intentId: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly serverNow: number;
}
export type VerificationEvidenceStatus = Base &
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
export type VerificationEvidenceRecovery = {
  readonly protocol: typeof VERIFICATION_EVIDENCE_MEDIA_PROTOCOL;
  readonly requestId: string;
  readonly serverNow: number;
} & (
  | { readonly state: 'not_recorded'; readonly requestHash: null }
  | {
      readonly state: 'recorded';
      readonly requestHash: string;
      readonly status: VerificationEvidenceStatus;
    }
  | {
      readonly state: 'cancelled_before_prepare';
      readonly requestHash: string;
      readonly reason: 'cancelled';
    }
);
export type VerificationEvidenceGrant = Omit<UploadGrant, 'version'> & {
  readonly protocol: typeof VERIFICATION_EVIDENCE_MEDIA_PROTOCOL;
};
export type VerificationEvidenceObserved = Omit<UploadObserved, 'version'> & {
  readonly protocol: typeof VERIFICATION_EVIDENCE_MEDIA_PROTOCOL;
};
export function decodeVerificationEvidencePrepare(
  v: unknown,
): VerificationEvidencePrepare {
  exact(v, [
    'protocol',
    'clientRequestId',
    'applicationId',
    'revision',
    'declaration',
  ]);
  exact(v.declaration, ['mime', 'bytes', 'sha256']);
  if (
    v.protocol !== VERIFICATION_EVIDENCE_MEDIA_PROTOCOL ||
    verificationEvidenceRevision(v.revision) === Number.MAX_SAFE_INTEGER ||
    (v.declaration.mime !== 'image/png' &&
      v.declaration.mime !== 'image/jpeg') ||
    !uploadInteger(v.declaration.bytes, 1, 5 * 1024 * 1024) ||
    !uploadDigest(v.declaration.sha256)
  )
    invalidVerificationEvidence();
  return Object.freeze({
    protocol: VERIFICATION_EVIDENCE_MEDIA_PROTOCOL,
    clientRequestId: verificationEvidenceUuid(v.clientRequestId),
    applicationId: verificationEvidenceUuid(v.applicationId),
    revision: verificationEvidenceRevision(v.revision),
    declaration: Object.freeze({
      mime: v.declaration.mime,
      bytes: v.declaration.bytes,
      sha256: v.declaration.sha256,
    }),
  });
}
export function verificationEvidencePrepareHash(
  actor: string,
  raw: unknown,
): string {
  const input = decodeVerificationEvidencePrepare(raw);
  return sha256(
    'whaleu-verification-evidence-media-prepare:v1\n' +
      JSON.stringify({
        protocol: VERIFICATION_EVIDENCE_MEDIA_PROTOCOL,
        actorAccountId: verificationEvidenceUuid(actor),
        clientRequestId: input.clientRequestId,
        applicationId: input.applicationId,
        revision: input.revision,
        declaration: {
          mime: input.declaration.mime,
          bytes: input.declaration.bytes,
          sha256: input.declaration.sha256,
        },
      }),
  );
}
export function decodeVerificationEvidenceDescriptor(
  v: unknown,
): VerificationEvidenceDescriptor {
  exact(v, [
    'protocol',
    'kind',
    'applicationId',
    'revision',
    'bindingId',
    'width',
    'height',
    'variants',
  ]);
  if (
    v.protocol !== VERIFICATION_EVIDENCE_MEDIA_PROTOCOL ||
    v.kind !== 'verification-evidence' ||
    verificationEvidenceRevision(v.revision) === 0 ||
    !uploadInteger(v.width, 1, 2048) ||
    !uploadInteger(v.height, 1, 2048) ||
    !Array.isArray(v.variants) ||
    v.variants.length !== 2 ||
    v.variants[0] !== 'thumb-v1' ||
    v.variants[1] !== 'display-v1'
  )
    invalidVerificationEvidence();
  return Object.freeze({
    protocol: VERIFICATION_EVIDENCE_MEDIA_PROTOCOL,
    kind: 'verification-evidence',
    applicationId: verificationEvidenceUuid(v.applicationId),
    revision: v.revision as number,
    bindingId: verificationEvidenceUuid(v.bindingId),
    width: v.width,
    height: v.height,
    variants: Object.freeze(['thumb-v1', 'display-v1'] as const),
  });
}
export function decodeVerificationEvidenceStatus(
  v: unknown,
): VerificationEvidenceStatus {
  if (
    !isRecord(v) ||
    v.protocol !== VERIFICATION_EVIDENCE_MEDIA_PROTOCOL ||
    !uploadDigest(v.requestHash) ||
    !uploadInteger(v.serverNow, 1, Number.MAX_SAFE_INTEGER)
  )
    invalidVerificationEvidence();
  verificationEvidenceUuid(v.intentId);
  verificationEvidenceUuid(v.requestId);
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
        invalidVerificationEvidence();
      break;
    case 'uploaded':
      exact(v, [...base, 'operationDeadlineAt']);
      break;
    case 'processing':
      exact(v, [...base, 'operationDeadlineAt', 'retryAfterMs']);
      if (!uploadInteger(v.retryAfterMs, 250, 30000))
        invalidVerificationEvidence();
      break;
    case 'ready_unbound':
      exact(v, [...base, 'assetId', 'bindBefore', 'mediaProof']);
      verificationEvidenceUuid(v.assetId);
      if (
        v.mediaProof !== 'current' ||
        !uploadInteger(v.bindBefore, 1, Number.MAX_SAFE_INTEGER) ||
        v.bindBefore <= v.serverNow
      )
        invalidVerificationEvidence();
      break;
    case 'bound_history':
      exact(v, [...base, 'assetId', 'bindingId', 'attachmentState']);
      verificationEvidenceUuid(v.assetId);
      verificationEvidenceUuid(v.bindingId);
      if (!['active', 'detached'].includes(String(v.attachmentState)))
        invalidVerificationEvidence();
      break;
    case 'terminal':
      exact(v, [...base, 'reason', 'cleanup']);
      if (
        !['cancelled', 'expired', 'rejected', 'deleted'].includes(
          String(v.reason),
        ) ||
        !['pending', 'retained', 'confirmed'].includes(String(v.cleanup))
      )
        invalidVerificationEvidence();
      break;
    case 'unavailable':
      exact(v, [...base, 'reason', 'retryable']);
      if (v.reason !== 'MEDIA_UNAVAILABLE' || typeof v.retryable !== 'boolean')
        invalidVerificationEvidence();
      break;
    default:
      invalidVerificationEvidence();
  }
  if (
    'operationDeadlineAt' in v &&
    !uploadInteger(v.operationDeadlineAt, 1, Number.MAX_SAFE_INTEGER)
  )
    invalidVerificationEvidence();
  return Object.freeze({ ...v }) as unknown as VerificationEvidenceStatus;
}
export function decodeVerificationEvidenceRecovery(
  v: unknown,
): VerificationEvidenceRecovery {
  if (
    !isRecord(v) ||
    v.protocol !== VERIFICATION_EVIDENCE_MEDIA_PROTOCOL ||
    !uploadInteger(v.serverNow, 1, Number.MAX_SAFE_INTEGER)
  )
    invalidVerificationEvidence();
  verificationEvidenceUuid(v.requestId);
  const base = ['protocol', 'requestId', 'serverNow', 'state', 'requestHash'];
  if (v.state === 'not_recorded') {
    exact(v, base);
    if (v.requestHash !== null) invalidVerificationEvidence();
  } else if (v.state === 'cancelled_before_prepare') {
    exact(v, [...base, 'reason']);
    if (!uploadDigest(v.requestHash) || v.reason !== 'cancelled')
      invalidVerificationEvidence();
  } else if (v.state === 'recorded') {
    exact(v, [...base, 'status']);
    const status = decodeVerificationEvidenceStatus(v.status);
    if (
      !uploadDigest(v.requestHash) ||
      status.requestId !== v.requestId ||
      status.requestHash !== v.requestHash
    )
      invalidVerificationEvidence();
    return Object.freeze({
      ...v,
      status,
    }) as unknown as VerificationEvidenceRecovery;
  } else invalidVerificationEvidence();
  return Object.freeze({ ...v }) as unknown as VerificationEvidenceRecovery;
}
export function decodeVerificationEvidenceGrant(
  v: unknown,
): VerificationEvidenceGrant {
  if (
    !isRecord(v) ||
    v.protocol !== VERIFICATION_EVIDENCE_MEDIA_PROTOCOL ||
    'version' in v
  )
    invalidVerificationEvidence();
  const { protocol, ...rest } = v;
  void protocol;
  const { version, ...value } = decodeUploadGrant({ ...rest, version: 1 });
  void version;
  return Object.freeze({
    ...value,
    protocol: VERIFICATION_EVIDENCE_MEDIA_PROTOCOL,
  });
}
export function decodeVerificationEvidenceObserved(
  v: unknown,
): VerificationEvidenceObserved {
  if (
    !isRecord(v) ||
    v.protocol !== VERIFICATION_EVIDENCE_MEDIA_PROTOCOL ||
    'version' in v
  )
    invalidVerificationEvidence();
  const { protocol, ...rest } = v;
  void protocol;
  const { version, ...value } = decodeUploadObserved({ ...rest, version: 2 });
  void version;
  return Object.freeze({
    ...value,
    protocol: VERIFICATION_EVIDENCE_MEDIA_PROTOCOL,
  });
}

export interface VerificationEvidenceUploadDescriptor {
  readonly protocol: typeof VERIFICATION_EVIDENCE_MEDIA_PROTOCOL;
  readonly kind: 'verification-evidence-upload';
  readonly assetId: string;
}
export function evidenceUploadDescriptor(
  assetId: string,
): VerificationEvidenceUploadDescriptor {
  return Object.freeze({
    protocol: VERIFICATION_EVIDENCE_MEDIA_PROTOCOL,
    kind: 'verification-evidence-upload',
    assetId: verificationEvidenceUuid(assetId),
  });
}
