import { sha256 } from 'js-sha256';
import { isRecord } from '../api/errors';
import { exact } from '../community/contract';
import { ClientError } from '../api/errors';
const exactMessage: typeof exact = exact;
function invalid(): never {
  throw new ClientError('protocol', 'Invalid private message image');
}
const imageUuid = (v: unknown): string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    v,
  )
    ? v
    : invalid();
function invalidImage(): never {
  return invalid();
}
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
export const PRIVATE_MESSAGE_MEDIA_PROTOCOL =
  'private-message-media-v1' as const;
export interface PrivateMessageMediaPrepare {
  readonly protocol: typeof PRIVATE_MESSAGE_MEDIA_PROTOCOL;
  readonly clientRequestId: string;
  readonly conversationId: string;
  readonly messageRequestId: string;
  readonly declaration: UploadDeclaration;
}
export interface PrivateMessageMediaDescriptor {
  readonly protocol: typeof PRIVATE_MESSAGE_MEDIA_PROTOCOL;
  readonly kind: 'private-message-media';
  readonly conversationId: string;
  readonly messageId: string;
  readonly bindingId: string;
  readonly width: number;
  readonly height: number;
  readonly variants: readonly ['thumb-v1', 'display-v1'];
}
interface Base {
  readonly protocol: typeof PRIVATE_MESSAGE_MEDIA_PROTOCOL;
  readonly intentId: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly serverNow: number;
}
export type PrivateMessageMediaStatus = Base &
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
export type PrivateMessageMediaRecovery = {
  readonly protocol: typeof PRIVATE_MESSAGE_MEDIA_PROTOCOL;
  readonly requestId: string;
  readonly serverNow: number;
} & (
  | { readonly state: 'not_recorded'; readonly requestHash: null }
  | {
      readonly state: 'recorded';
      readonly requestHash: string;
      readonly status: PrivateMessageMediaStatus;
    }
  | {
      readonly state: 'cancelled_before_prepare';
      readonly requestHash: string;
      readonly reason: 'cancelled';
    }
);
export type PrivateMessageMediaGrant = Omit<UploadGrant, 'version'> & {
  readonly protocol: typeof PRIVATE_MESSAGE_MEDIA_PROTOCOL;
};
export type PrivateMessageMediaObserved = Omit<UploadObserved, 'version'> & {
  readonly protocol: typeof PRIVATE_MESSAGE_MEDIA_PROTOCOL;
};
export function decodePrivateMessageMediaPrepare(
  v: unknown,
): PrivateMessageMediaPrepare {
  exactMessage(v, [
    'protocol',
    'clientRequestId',
    'conversationId',
    'messageRequestId',
    'declaration',
  ]);
  exactMessage(v.declaration, ['mime', 'bytes', 'sha256']);
  if (
    imageUuid(v.messageRequestId)[14] !== '4' ||
    v.protocol !== PRIVATE_MESSAGE_MEDIA_PROTOCOL ||
    (v.declaration.mime !== 'image/png' &&
      v.declaration.mime !== 'image/jpeg') ||
    !uploadInteger(v.declaration.bytes, 1, 5 * 1024 * 1024) ||
    !uploadDigest(v.declaration.sha256)
  )
    invalid();
  return Object.freeze({
    protocol: PRIVATE_MESSAGE_MEDIA_PROTOCOL,
    clientRequestId: imageUuid(v.clientRequestId),
    conversationId: imageUuid(v.conversationId),
    messageRequestId: imageUuid(v.messageRequestId),
    declaration: Object.freeze({
      mime: v.declaration.mime,
      bytes: v.declaration.bytes,
      sha256: v.declaration.sha256,
    }),
  });
}
export function privateMessageMediaPrepareHash(
  actor: string,
  raw: unknown,
): string {
  const input = decodePrivateMessageMediaPrepare(raw);
  return sha256(
    'whaleu-private-message-media-prepare:v1\n' +
      JSON.stringify({
        protocol: PRIVATE_MESSAGE_MEDIA_PROTOCOL,
        actorAccountId: imageUuid(actor),
        clientRequestId: input.clientRequestId,
        conversationId: input.conversationId,
        messageRequestId: input.messageRequestId,
        declaration: {
          mime: input.declaration.mime,
          bytes: input.declaration.bytes,
          sha256: input.declaration.sha256,
        },
      }),
  );
}
export function decodePrivateMessageMediaDescriptor(
  v: unknown,
): PrivateMessageMediaDescriptor {
  exactMessage(v, [
    'protocol',
    'kind',
    'conversationId',
    'messageId',
    'bindingId',
    'width',
    'height',
    'variants',
  ]);
  if (
    v.protocol !== PRIVATE_MESSAGE_MEDIA_PROTOCOL ||
    v.kind !== 'private-message-media' ||
    !uploadInteger(v.width, 1, 2048) ||
    !uploadInteger(v.height, 1, 2048) ||
    !Array.isArray(v.variants) ||
    v.variants.length !== 2 ||
    v.variants[0] !== 'thumb-v1' ||
    v.variants[1] !== 'display-v1'
  )
    invalid();
  return Object.freeze({
    protocol: PRIVATE_MESSAGE_MEDIA_PROTOCOL,
    kind: 'private-message-media',
    conversationId: imageUuid(v.conversationId),
    messageId: imageUuid(v.messageId),
    bindingId: imageUuid(v.bindingId),
    width: v.width,
    height: v.height,
    variants: Object.freeze(['thumb-v1', 'display-v1'] as const),
  });
}
export function decodePrivateMessageMediaStatus(
  v: unknown,
): PrivateMessageMediaStatus {
  if (
    !isRecord(v) ||
    v.protocol !== PRIVATE_MESSAGE_MEDIA_PROTOCOL ||
    !uploadDigest(v.requestHash) ||
    !uploadInteger(v.serverNow, 1, Number.MAX_SAFE_INTEGER)
  )
    invalidImage();
  imageUuid(v.intentId);
  imageUuid(v.requestId);
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
        invalidImage();
      break;
    case 'uploaded':
      exact(v, [...base, 'operationDeadlineAt']);
      break;
    case 'processing':
      exact(v, [...base, 'operationDeadlineAt', 'retryAfterMs']);
      if (!uploadInteger(v.retryAfterMs, 250, 30000)) invalidImage();
      break;
    case 'ready_unbound':
      exact(v, [
        ...base,
        'assetId',
        'manifestDigest',
        'bindBefore',
        'mediaProof',
      ]);
      imageUuid(v.assetId);
      if (
        !uploadDigest(v.manifestDigest) ||
        v.mediaProof !== 'current' ||
        !uploadInteger(v.bindBefore, 1, Number.MAX_SAFE_INTEGER) ||
        v.bindBefore <= v.serverNow
      )
        invalidImage();
      break;
    case 'bound_history':
      exact(v, [...base, 'assetId', 'bindingId', 'attachmentState']);
      imageUuid(v.assetId);
      imageUuid(v.bindingId);
      if (!['active', 'detached'].includes(String(v.attachmentState)))
        invalidImage();
      break;
    case 'terminal':
      exact(v, [...base, 'reason', 'cleanup']);
      if (
        !['cancelled', 'expired', 'rejected', 'deleted'].includes(
          String(v.reason),
        ) ||
        !['pending', 'retained', 'confirmed'].includes(String(v.cleanup))
      )
        invalidImage();
      break;
    case 'unavailable':
      exact(v, [...base, 'reason', 'retryable']);
      if (v.reason !== 'MEDIA_UNAVAILABLE' || typeof v.retryable !== 'boolean')
        invalidImage();
      break;
    default:
      invalidImage();
  }
  if (
    'operationDeadlineAt' in v &&
    !uploadInteger(v.operationDeadlineAt, 1, Number.MAX_SAFE_INTEGER)
  )
    invalidImage();
  return Object.freeze({ ...v }) as unknown as PrivateMessageMediaStatus;
}
export function decodePrivateMessageMediaRecovery(
  v: unknown,
): PrivateMessageMediaRecovery {
  if (
    !isRecord(v) ||
    v.protocol !== PRIVATE_MESSAGE_MEDIA_PROTOCOL ||
    !uploadInteger(v.serverNow, 1, Number.MAX_SAFE_INTEGER)
  )
    invalidImage();
  imageUuid(v.requestId);
  const base = ['protocol', 'requestId', 'serverNow', 'state', 'requestHash'];
  if (v.state === 'not_recorded') {
    exact(v, base);
    if (v.requestHash !== null) invalidImage();
  } else if (v.state === 'cancelled_before_prepare') {
    exact(v, [...base, 'reason']);
    if (!uploadDigest(v.requestHash) || v.reason !== 'cancelled')
      invalidImage();
  } else if (v.state === 'recorded') {
    exact(v, [...base, 'status']);
    const status = decodePrivateMessageMediaStatus(v.status);
    if (
      !uploadDigest(v.requestHash) ||
      status.requestId !== v.requestId ||
      status.requestHash !== v.requestHash
    )
      invalidImage();
    return Object.freeze({
      ...v,
      status,
    }) as unknown as PrivateMessageMediaRecovery;
  } else invalidImage();
  return Object.freeze({ ...v }) as unknown as PrivateMessageMediaRecovery;
}
export function decodePrivateMessageMediaGrant(
  v: unknown,
): PrivateMessageMediaGrant {
  if (
    !isRecord(v) ||
    v.protocol !== PRIVATE_MESSAGE_MEDIA_PROTOCOL ||
    'version' in v
  )
    invalidImage();
  const { protocol, ...rest } = v;
  void protocol;
  const { version, ...value } = decodeUploadGrant({ ...rest, version: 1 });
  void version;
  return Object.freeze({ ...value, protocol: PRIVATE_MESSAGE_MEDIA_PROTOCOL });
}
export function decodePrivateMessageMediaObserved(
  v: unknown,
): PrivateMessageMediaObserved {
  if (
    !isRecord(v) ||
    v.protocol !== PRIVATE_MESSAGE_MEDIA_PROTOCOL ||
    'version' in v
  )
    invalidImage();
  const { protocol, ...rest } = v;
  void protocol;
  const { version, ...value } = decodeUploadObserved({ ...rest, version: 2 });
  void version;
  return Object.freeze({ ...value, protocol: PRIVATE_MESSAGE_MEDIA_PROTOCOL });
}
