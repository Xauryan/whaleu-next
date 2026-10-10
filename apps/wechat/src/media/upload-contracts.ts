import { sha256 } from 'js-sha256';
import { ClientError, isRecord } from '../api/errors';
import type { Cancellation } from '../platform/contracts';
import type { LocalMediaFile, MediaSession } from './contracts';
import { mediaUuid } from './decoders';

export const MEDIA_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export interface UploadDeclaration {
  readonly mime: 'image/jpeg' | 'image/png';
  readonly bytes: number;
  readonly sha256: string;
}
export interface InspectedUpload extends UploadDeclaration {
  readonly width: number;
  readonly height: number;
  /** getImageInfo cannot establish APNG/MPO frame count. Server decoding is authoritative. */
  readonly frameCount: number | 'unknown';
}
export interface UploadPrepare {
  readonly clientRequestId: string;
  readonly purpose: 'community-post-image';
  readonly draftId: string;
  readonly spaceId: string;
  readonly slot: 'images';
  readonly ordinal: 0;
  readonly declaration: UploadDeclaration;
}
export interface PublicationReference {
  readonly clientRequestId: string;
  readonly operation: 'publish_post';
  readonly intentHash: string;
}
interface StatusBase {
  readonly version: 2;
  readonly intentId: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly serverNow: number;
}
export type UploadStatus = StatusBase &
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
        readonly draftExpiresAt: number;
        readonly bindBefore: number;
        readonly mediaProof: 'current';
      }
    | {
        readonly status: 'bound_history';
        readonly assetId: string;
        readonly bindingId: string;
        readonly publication: PublicationReference | null;
        readonly attachmentState: 'active' | 'detached';
      }
    | {
        readonly status: 'terminal';
        readonly reason: TerminalReason;
        readonly cleanup: 'pending' | 'retained' | 'confirmed';
      }
    | {
        readonly status: 'unavailable';
        readonly reason: 'MEDIA_UNAVAILABLE';
        readonly retryable: boolean;
      }
  );
export type TerminalReason = 'cancelled' | 'expired' | 'rejected' | 'deleted';
interface RecoveryBase {
  readonly version: 2;
  readonly requestId: string;
  readonly serverNow: number;
}
export type UploadRecovery = RecoveryBase &
  (
    | { readonly state: 'not_recorded'; readonly requestHash: null }
    | {
        readonly state: 'active';
        readonly requestHash: string;
        readonly status: UploadStatus;
      }
    | {
        readonly state: 'bound_history';
        readonly requestHash: string;
        readonly status: Extract<UploadStatus, { status: 'bound_history' }>;
      }
    | {
        readonly state: 'terminal';
        readonly requestHash: string;
        readonly reason: TerminalReason;
        readonly status: Extract<UploadStatus, { status: 'terminal' }> | null;
      }
  );
export interface UploadGrant {
  readonly version: 1;
  readonly strategy: 'authenticated-multipart-v1';
  readonly intentId: string;
  readonly generation: string;
  readonly grantId: string;
  readonly method: 'POST';
  readonly fieldName: 'file';
  readonly maxBytes: typeof MEDIA_UPLOAD_MAX_BYTES;
  readonly expectedBytes: number;
  readonly expectedMime: 'image/jpeg' | 'image/png';
  readonly expectedSha256: string;
  readonly grantExpiresAt: number;
  readonly operationDeadlineAt: number;
  readonly serverNow: number;
}
/** This object has process-local identity; serialization does not preserve authority. */
export interface UploadHandle {
  readonly handle: string;
}
export interface UploadObserved {
  readonly version: 2;
  readonly status: 'uploadObserved';
  readonly intentId: string;
  readonly generation: string;
  readonly grantId: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly next: 'finalize';
}
export interface UploadGateway {
  prepare(
    input: UploadPrepare,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<UploadStatus>;
  recover(
    requestId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<UploadRecovery>;
  status(
    intentId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<UploadStatus>;
  grant(
    intentId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<UploadGrant>;
  finalize(
    intentId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<UploadStatus>;
  cancelRequest(
    requestId: string,
    requestHash: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<UploadRecovery>;
}
export interface UploadTransfer {
  pick(session: MediaSession, cancel: Cancellation): Promise<LocalMediaFile>;
  inspect(
    file: LocalMediaFile,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<InspectedUpload>;
  register(grant: UploadGrant, session: MediaSession): UploadHandle;
  upload(
    handle: UploadHandle,
    file: LocalMediaFile,
    progress: (percent: number) => void,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<UploadObserved>;
  clearSession(ticket: import('../auth/session').SessionTicket): void;
  remove(file: LocalMediaFile): Promise<void>;
}
export function uploadInvalid(): never {
  throw new ClientError('protocol', 'Invalid media upload contract');
}
export function uploadExact(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  )
    uploadInvalid();
}
export function uploadInteger(
  value: unknown,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}
export const uploadId = (value: unknown): value is string =>
  mediaUuid(value) && value === value.toLowerCase();
export const uploadDigest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const generation = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[1-9][0-9]{0,18}$/.test(value) &&
  (value.length < 19 || value <= '9223372036854775807');
const mime = (value: unknown): value is UploadDeclaration['mime'] =>
  value === 'image/jpeg' || value === 'image/png';
const terminal = (value: unknown): value is TerminalReason =>
  value === 'cancelled' ||
  value === 'expired' ||
  value === 'rejected' ||
  value === 'deleted';
export function decodeUploadPrepare(value: unknown): UploadPrepare {
  uploadExact(value, [
    'clientRequestId',
    'purpose',
    'draftId',
    'spaceId',
    'slot',
    'ordinal',
    'declaration',
  ]);
  uploadExact(value.declaration, ['mime', 'bytes', 'sha256']);
  if (
    !uploadId(value.clientRequestId) ||
    !uploadId(value.draftId) ||
    !uploadId(value.spaceId) ||
    value.purpose !== 'community-post-image' ||
    value.slot !== 'images' ||
    value.ordinal !== 0 ||
    !mime(value.declaration.mime) ||
    !uploadInteger(value.declaration.bytes, 1, MEDIA_UPLOAD_MAX_BYTES) ||
    !uploadDigest(value.declaration.sha256)
  )
    uploadInvalid();
  return Object.freeze({
    clientRequestId: value.clientRequestId,
    purpose: 'community-post-image',
    draftId: value.draftId,
    spaceId: value.spaceId,
    slot: 'images',
    ordinal: 0,
    declaration: Object.freeze({
      mime: value.declaration.mime,
      bytes: value.declaration.bytes,
      sha256: value.declaration.sha256,
    }),
  });
}
export function uploadRequestHash(
  actorAccountId: string,
  raw: unknown,
): string {
  if (!uploadId(actorAccountId)) uploadInvalid();
  const input = decodeUploadPrepare(raw);
  return sha256(
    'whaleu-media-request:v2\n' +
      JSON.stringify({
        version: 2,
        actorAccountId,
        clientRequestId: input.clientRequestId,
        purpose: input.purpose,
        draftId: input.draftId,
        spaceId: input.spaceId,
        slot: input.slot,
        ordinal: input.ordinal,
        declaration: {
          mime: input.declaration.mime,
          bytes: input.declaration.bytes,
          sha256: input.declaration.sha256,
        },
      }),
  );
}
export function decodePublicationReference(
  value: unknown,
): PublicationReference {
  uploadExact(value, ['clientRequestId', 'operation', 'intentHash']);
  if (
    !uploadId(value.clientRequestId) ||
    value.operation !== 'publish_post' ||
    !uploadDigest(value.intentHash)
  )
    uploadInvalid();
  return Object.freeze({
    clientRequestId: value.clientRequestId,
    operation: 'publish_post',
    intentHash: value.intentHash,
  });
}
export function decodeUploadStatus(value: unknown): UploadStatus {
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    !uploadId(value.intentId) ||
    !uploadId(value.requestId) ||
    !uploadDigest(value.requestHash) ||
    !uploadInteger(value.serverNow)
  )
    uploadInvalid();
  const base = {
    version: 2 as const,
    intentId: value.intentId,
    requestId: value.requestId,
    requestHash: value.requestHash,
    serverNow: value.serverNow,
  };
  const keys = [
    'version',
    'intentId',
    'requestId',
    'requestHash',
    'serverNow',
    'status',
  ];
  switch (value.status) {
    case 'prepared':
      uploadExact(value, [...keys, 'operationDeadlineAt', 'upload']);
      if (
        !uploadInteger(value.operationDeadlineAt) ||
        (value.upload !== 'none' &&
          value.upload !== 'in_flight' &&
          value.upload !== 'reconcile_needed')
      )
        uploadInvalid();
      return Object.freeze({
        ...base,
        status: 'prepared',
        operationDeadlineAt: value.operationDeadlineAt,
        upload: value.upload as 'none' | 'in_flight' | 'reconcile_needed',
      });
    case 'uploaded':
      uploadExact(value, [...keys, 'operationDeadlineAt']);
      if (!uploadInteger(value.operationDeadlineAt)) uploadInvalid();
      return Object.freeze({
        ...base,
        status: 'uploaded',
        operationDeadlineAt: value.operationDeadlineAt,
      });
    case 'processing':
      uploadExact(value, [...keys, 'operationDeadlineAt', 'retryAfterMs']);
      if (
        !uploadInteger(value.operationDeadlineAt) ||
        !uploadInteger(value.retryAfterMs, 250, 30000)
      )
        uploadInvalid();
      return Object.freeze({
        ...base,
        status: 'processing',
        operationDeadlineAt: value.operationDeadlineAt,
        retryAfterMs: value.retryAfterMs,
      });
    case 'ready_unbound':
      uploadExact(value, [
        ...keys,
        'assetId',
        'readyRetentionUntil',
        'draftExpiresAt',
        'bindBefore',
        'mediaProof',
      ]);
      if (
        !uploadId(value.assetId) ||
        !uploadInteger(value.readyRetentionUntil) ||
        !uploadInteger(value.draftExpiresAt) ||
        !uploadInteger(value.bindBefore) ||
        value.bindBefore !==
          Math.min(value.readyRetentionUntil, value.draftExpiresAt) ||
        value.mediaProof !== 'current'
      )
        uploadInvalid();
      return Object.freeze({
        ...base,
        status: 'ready_unbound',
        assetId: value.assetId,
        readyRetentionUntil: value.readyRetentionUntil,
        draftExpiresAt: value.draftExpiresAt,
        bindBefore: value.bindBefore,
        mediaProof: 'current',
      });
    case 'bound_history':
      uploadExact(value, [
        ...keys,
        'assetId',
        'bindingId',
        'publication',
        'attachmentState',
      ]);
      if (
        !uploadId(value.assetId) ||
        !uploadId(value.bindingId) ||
        (value.attachmentState !== 'active' &&
          value.attachmentState !== 'detached')
      )
        uploadInvalid();
      return Object.freeze({
        ...base,
        status: 'bound_history',
        assetId: value.assetId,
        bindingId: value.bindingId,
        publication:
          value.publication === null
            ? null
            : decodePublicationReference(value.publication),
        attachmentState: value.attachmentState,
      });
    case 'terminal':
      uploadExact(value, [...keys, 'reason', 'cleanup']);
      if (
        !terminal(value.reason) ||
        (value.cleanup !== 'pending' &&
          value.cleanup !== 'retained' &&
          value.cleanup !== 'confirmed')
      )
        uploadInvalid();
      return Object.freeze({
        ...base,
        status: 'terminal',
        reason: value.reason,
        cleanup: value.cleanup as 'pending' | 'retained' | 'confirmed',
      });
    case 'unavailable':
      uploadExact(value, [...keys, 'reason', 'retryable']);
      if (
        value.reason !== 'MEDIA_UNAVAILABLE' ||
        typeof value.retryable !== 'boolean'
      )
        uploadInvalid();
      return Object.freeze({
        ...base,
        status: 'unavailable',
        reason: 'MEDIA_UNAVAILABLE',
        retryable: value.retryable,
      });
    default:
      return uploadInvalid();
  }
}
export function decodeUploadRecovery(value: unknown): UploadRecovery {
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    !uploadId(value.requestId) ||
    !uploadInteger(value.serverNow)
  )
    uploadInvalid();
  const base = {
    version: 2 as const,
    requestId: value.requestId,
    serverNow: value.serverNow,
  };
  const keys = ['version', 'requestId', 'serverNow', 'state', 'requestHash'];
  if (value.state === 'not_recorded') {
    uploadExact(value, keys);
    if (value.requestHash !== null) uploadInvalid();
    return Object.freeze({ ...base, state: 'not_recorded', requestHash: null });
  }
  if (!uploadDigest(value.requestHash)) uploadInvalid();
  const hash = value.requestHash;
  if (value.state === 'terminal') {
    uploadExact(value, [...keys, 'reason', 'status']);
    if (!terminal(value.reason)) uploadInvalid();
    const status =
      value.status === null ? null : decodeUploadStatus(value.status);
    if (
      status &&
      (status.status !== 'terminal' ||
        status.reason !== value.reason ||
        status.requestId !== value.requestId ||
        status.requestHash !== hash)
    )
      uploadInvalid();
    return Object.freeze({
      ...base,
      state: 'terminal',
      requestHash: hash,
      reason: value.reason,
      status: status as Extract<UploadStatus, { status: 'terminal' }> | null,
    });
  }
  uploadExact(value, [...keys, 'status']);
  const status = decodeUploadStatus(value.status);
  if (status.requestId !== value.requestId || status.requestHash !== hash)
    uploadInvalid();
  if (value.state === 'bound_history' && status.status === 'bound_history')
    return Object.freeze({
      ...base,
      state: 'bound_history',
      requestHash: hash,
      status,
    });
  if (
    value.state !== 'active' ||
    status.status === 'terminal' ||
    status.status === 'bound_history'
  )
    uploadInvalid();
  return Object.freeze({ ...base, state: 'active', requestHash: hash, status });
}
export function decodeUploadGrant(value: unknown): UploadGrant {
  uploadExact(value, [
    'version',
    'strategy',
    'intentId',
    'generation',
    'grantId',
    'method',
    'fieldName',
    'maxBytes',
    'expectedBytes',
    'expectedMime',
    'expectedSha256',
    'grantExpiresAt',
    'operationDeadlineAt',
    'serverNow',
  ]);
  if (
    value.version !== 1 ||
    value.strategy !== 'authenticated-multipart-v1' ||
    !uploadId(value.intentId) ||
    !generation(value.generation) ||
    !uploadId(value.grantId) ||
    value.method !== 'POST' ||
    value.fieldName !== 'file' ||
    value.maxBytes !== MEDIA_UPLOAD_MAX_BYTES ||
    !uploadInteger(value.expectedBytes, 1, MEDIA_UPLOAD_MAX_BYTES) ||
    !mime(value.expectedMime) ||
    !uploadDigest(value.expectedSha256) ||
    !uploadInteger(value.grantExpiresAt) ||
    !uploadInteger(value.operationDeadlineAt) ||
    !uploadInteger(value.serverNow) ||
    value.grantExpiresAt > value.operationDeadlineAt ||
    value.grantExpiresAt <= value.serverNow
  )
    uploadInvalid();
  return Object.freeze({ ...value }) as unknown as UploadGrant;
}
export function decodeUploadObserved(value: unknown): UploadObserved {
  uploadExact(value, [
    'version',
    'status',
    'intentId',
    'generation',
    'grantId',
    'bytes',
    'sha256',
    'next',
  ]);
  if (
    value.version !== 2 ||
    value.status !== 'uploadObserved' ||
    !uploadId(value.intentId) ||
    !generation(value.generation) ||
    !uploadId(value.grantId) ||
    !uploadInteger(value.bytes, 1, MEDIA_UPLOAD_MAX_BYTES) ||
    !uploadDigest(value.sha256) ||
    value.next !== 'finalize'
  )
    uploadInvalid();
  return Object.freeze({ ...value }) as unknown as UploadObserved;
}
