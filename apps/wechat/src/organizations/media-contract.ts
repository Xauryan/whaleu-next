import { sha256 } from 'js-sha256';
import { isRecord } from '../api/errors';
import { exact } from '../community/contract';
import {
  invalidOrganizationMedia,
  organizationMediaUuid,
  organizationMediaSlot,
  organizationMediaRevision,
} from './media-validation';
import type { OrganizationMediaSlot } from './media-validation';
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
export type { OrganizationMediaSlot } from './media-validation';
export const ORGANIZATION_MEDIA_PROTOCOL = 'organization-media-v1' as const;
export interface OrganizationMediaPrepare {
  readonly protocol: typeof ORGANIZATION_MEDIA_PROTOCOL;
  readonly clientRequestId: string;
  readonly organizationId: string;
  readonly slot: OrganizationMediaSlot;
  readonly applicationRevision: number;
  readonly declaration: UploadDeclaration;
}
export interface OrganizationMediaDescriptor {
  readonly protocol: typeof ORGANIZATION_MEDIA_PROTOCOL;
  readonly kind: 'organization-media';
  readonly organizationId: string;
  readonly slot: OrganizationMediaSlot;
  readonly applicationRevision: number;
  readonly bindingId: string;
  readonly width: number;
  readonly height: number;
  readonly variants: readonly ['thumb-v1', 'display-v1'];
}
interface Base {
  readonly protocol: typeof ORGANIZATION_MEDIA_PROTOCOL;
  readonly intentId: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly serverNow: number;
}
export type OrganizationMediaStatus = Base &
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
export type OrganizationMediaRecovery = {
  readonly protocol: typeof ORGANIZATION_MEDIA_PROTOCOL;
  readonly requestId: string;
  readonly serverNow: number;
} & (
  | { readonly state: 'not_recorded'; readonly requestHash: null }
  | {
      readonly state: 'recorded';
      readonly requestHash: string;
      readonly status: OrganizationMediaStatus;
    }
  | {
      readonly state: 'cancelled_before_prepare';
      readonly requestHash: string;
      readonly reason: 'cancelled';
    }
);
export type OrganizationMediaGrant = Omit<UploadGrant, 'version'> & {
  readonly protocol: typeof ORGANIZATION_MEDIA_PROTOCOL;
};
export type OrganizationMediaObserved = Omit<UploadObserved, 'version'> & {
  readonly protocol: typeof ORGANIZATION_MEDIA_PROTOCOL;
};
export function decodeOrganizationMediaPrepare(
  v: unknown,
): OrganizationMediaPrepare {
  exact(v, [
    'protocol',
    'clientRequestId',
    'organizationId',
    'slot',
    'applicationRevision',
    'declaration',
  ]);
  exact(v.declaration, ['mime', 'bytes', 'sha256']);
  if (
    v.protocol !== ORGANIZATION_MEDIA_PROTOCOL ||
    organizationMediaRevision(v.applicationRevision) ===
      Number.MAX_SAFE_INTEGER ||
    (v.declaration.mime !== 'image/png' &&
      v.declaration.mime !== 'image/jpeg') ||
    !uploadInteger(v.declaration.bytes, 1, 5 * 1024 * 1024) ||
    !uploadDigest(v.declaration.sha256)
  )
    invalidOrganizationMedia();
  return Object.freeze({
    protocol: ORGANIZATION_MEDIA_PROTOCOL,
    clientRequestId: organizationMediaUuid(v.clientRequestId),
    organizationId: organizationMediaUuid(v.organizationId),
    slot: organizationMediaSlot(v.slot),
    applicationRevision: organizationMediaRevision(v.applicationRevision),
    declaration: Object.freeze({
      mime: v.declaration.mime,
      bytes: v.declaration.bytes,
      sha256: v.declaration.sha256,
    }),
  });
}
export function organizationMediaPrepareHash(
  actor: string,
  raw: unknown,
): string {
  const input = decodeOrganizationMediaPrepare(raw);
  return sha256(
    'whaleu-organization-media-prepare:v1\n' +
      JSON.stringify({
        protocol: ORGANIZATION_MEDIA_PROTOCOL,
        actorAccountId: organizationMediaUuid(actor),
        clientRequestId: input.clientRequestId,
        organizationId: input.organizationId,
        slot: input.slot,
        applicationRevision: input.applicationRevision,
        declaration: {
          mime: input.declaration.mime,
          bytes: input.declaration.bytes,
          sha256: input.declaration.sha256,
        },
      }),
  );
}
export function decodeOrganizationMediaDescriptor(
  v: unknown,
): OrganizationMediaDescriptor {
  exact(v, [
    'protocol',
    'kind',
    'organizationId',
    'slot',
    'applicationRevision',
    'bindingId',
    'width',
    'height',
    'variants',
  ]);
  if (
    v.protocol !== ORGANIZATION_MEDIA_PROTOCOL ||
    v.kind !== 'organization-media' ||
    organizationMediaRevision(v.applicationRevision) === 0 ||
    !uploadInteger(v.width, 1, 2048) ||
    !uploadInteger(v.height, 1, 2048) ||
    !Array.isArray(v.variants) ||
    v.variants.length !== 2 ||
    v.variants[0] !== 'thumb-v1' ||
    v.variants[1] !== 'display-v1'
  )
    invalidOrganizationMedia();
  return Object.freeze({
    protocol: ORGANIZATION_MEDIA_PROTOCOL,
    kind: 'organization-media',
    organizationId: organizationMediaUuid(v.organizationId),
    slot: organizationMediaSlot(v.slot),
    applicationRevision: v.applicationRevision as number,
    bindingId: organizationMediaUuid(v.bindingId),
    width: v.width,
    height: v.height,
    variants: Object.freeze(['thumb-v1', 'display-v1'] as const),
  });
}
export function decodeOrganizationMediaStatus(
  v: unknown,
): OrganizationMediaStatus {
  if (
    !isRecord(v) ||
    v.protocol !== ORGANIZATION_MEDIA_PROTOCOL ||
    !uploadDigest(v.requestHash) ||
    !uploadInteger(v.serverNow, 1, Number.MAX_SAFE_INTEGER)
  )
    invalidOrganizationMedia();
  organizationMediaUuid(v.intentId);
  organizationMediaUuid(v.requestId);
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
        invalidOrganizationMedia();
      break;
    case 'uploaded':
      exact(v, [...base, 'operationDeadlineAt']);
      break;
    case 'processing':
      exact(v, [...base, 'operationDeadlineAt', 'retryAfterMs']);
      if (!uploadInteger(v.retryAfterMs, 250, 30000))
        invalidOrganizationMedia();
      break;
    case 'ready_unbound':
      exact(v, [...base, 'assetId', 'bindBefore', 'mediaProof']);
      organizationMediaUuid(v.assetId);
      if (
        v.mediaProof !== 'current' ||
        !uploadInteger(v.bindBefore, 1, Number.MAX_SAFE_INTEGER) ||
        v.bindBefore <= v.serverNow
      )
        invalidOrganizationMedia();
      break;
    case 'bound_history':
      exact(v, [...base, 'assetId', 'bindingId', 'attachmentState']);
      organizationMediaUuid(v.assetId);
      organizationMediaUuid(v.bindingId);
      if (!['active', 'detached'].includes(String(v.attachmentState)))
        invalidOrganizationMedia();
      break;
    case 'terminal':
      exact(v, [...base, 'reason', 'cleanup']);
      if (
        !['cancelled', 'expired', 'rejected', 'deleted'].includes(
          String(v.reason),
        ) ||
        !['pending', 'retained', 'confirmed'].includes(String(v.cleanup))
      )
        invalidOrganizationMedia();
      break;
    case 'unavailable':
      exact(v, [...base, 'reason', 'retryable']);
      if (v.reason !== 'MEDIA_UNAVAILABLE' || typeof v.retryable !== 'boolean')
        invalidOrganizationMedia();
      break;
    default:
      invalidOrganizationMedia();
  }
  if (
    'operationDeadlineAt' in v &&
    !uploadInteger(v.operationDeadlineAt, 1, Number.MAX_SAFE_INTEGER)
  )
    invalidOrganizationMedia();
  return Object.freeze({ ...v }) as unknown as OrganizationMediaStatus;
}
export function decodeOrganizationMediaRecovery(
  v: unknown,
): OrganizationMediaRecovery {
  if (
    !isRecord(v) ||
    v.protocol !== ORGANIZATION_MEDIA_PROTOCOL ||
    !uploadInteger(v.serverNow, 1, Number.MAX_SAFE_INTEGER)
  )
    invalidOrganizationMedia();
  organizationMediaUuid(v.requestId);
  const base = ['protocol', 'requestId', 'serverNow', 'state', 'requestHash'];
  if (v.state === 'not_recorded') {
    exact(v, base);
    if (v.requestHash !== null) invalidOrganizationMedia();
  } else if (v.state === 'cancelled_before_prepare') {
    exact(v, [...base, 'reason']);
    if (!uploadDigest(v.requestHash) || v.reason !== 'cancelled')
      invalidOrganizationMedia();
  } else if (v.state === 'recorded') {
    exact(v, [...base, 'status']);
    const status = decodeOrganizationMediaStatus(v.status);
    if (
      !uploadDigest(v.requestHash) ||
      status.requestId !== v.requestId ||
      status.requestHash !== v.requestHash
    )
      invalidOrganizationMedia();
    return Object.freeze({
      ...v,
      status,
    }) as unknown as OrganizationMediaRecovery;
  } else invalidOrganizationMedia();
  return Object.freeze({ ...v }) as unknown as OrganizationMediaRecovery;
}
export function decodeOrganizationMediaGrant(
  v: unknown,
): OrganizationMediaGrant {
  if (
    !isRecord(v) ||
    v.protocol !== ORGANIZATION_MEDIA_PROTOCOL ||
    'version' in v
  )
    invalidOrganizationMedia();
  const { protocol, ...rest } = v;
  void protocol;
  const { version, ...value } = decodeUploadGrant({ ...rest, version: 1 });
  void version;
  return Object.freeze({ ...value, protocol: ORGANIZATION_MEDIA_PROTOCOL });
}
export function decodeOrganizationMediaObserved(
  v: unknown,
): OrganizationMediaObserved {
  if (
    !isRecord(v) ||
    v.protocol !== ORGANIZATION_MEDIA_PROTOCOL ||
    'version' in v
  )
    invalidOrganizationMedia();
  const { protocol, ...rest } = v;
  void protocol;
  const { version, ...value } = decodeUploadObserved({ ...rest, version: 2 });
  void version;
  return Object.freeze({ ...value, protocol: ORGANIZATION_MEDIA_PROTOCOL });
}
