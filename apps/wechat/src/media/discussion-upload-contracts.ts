/** Explicit v4 discussion observations. The strict v2 decoder is unchanged. */
import { isRecord } from '../api/errors';
import {
  uploadExact,
  uploadId,
  uploadDigest,
  uploadInteger,
  uploadInvalid,
  type TerminalReason,
} from './upload-contracts';
export interface PublicationReference {
  readonly clientRequestId: string;
  readonly operation: 'publish_comment' | 'publish_reply';
  readonly intentHash: string;
}
export function decodePublicationReference(raw: unknown): PublicationReference {
  uploadExact(raw, ['clientRequestId', 'operation', 'intentHash']);
  if (
    !uploadId(raw.clientRequestId) ||
    !uploadDigest(raw.intentHash) ||
    (raw.operation !== 'publish_comment' && raw.operation !== 'publish_reply')
  )
    uploadInvalid();
  return Object.freeze({
    clientRequestId: raw.clientRequestId,
    operation: raw.operation,
    intentHash: raw.intentHash,
  });
}
const terminal = (value: unknown): value is TerminalReason =>
  value === 'cancelled' ||
  value === 'expired' ||
  value === 'rejected' ||
  value === 'deleted';
interface StatusBase {
  readonly version: 4;
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
export function decodeUploadStatus(value: unknown): UploadStatus {
  if (
    !isRecord(value) ||
    value.version !== 4 ||
    !uploadId(value.intentId) ||
    !uploadId(value.requestId) ||
    !uploadDigest(value.requestHash) ||
    !uploadInteger(value.serverNow)
  )
    uploadInvalid();
  const base = {
    version: 4 as const,
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
