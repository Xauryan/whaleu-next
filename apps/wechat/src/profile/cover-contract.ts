import { sha256 } from 'js-sha256';
import { ClientError, isRecord } from '../api/errors';
import { isUuid } from './contract';

/** Independent Profile protocol. No Community v1/v2/v3/v4 decoder accepts it. */
export const PROFILE_COVER_PROTOCOL = 'profile-cover-v1' as const;
export const COVER_MAX_BYTES = 5 * 1024 * 1024;
export interface CoverCapabilities {
  readonly protocol: typeof PROFILE_COVER_PROTOCOL;
  readonly upload: 'available' | 'unavailable';
}
export function decodeCoverCapabilities(value: unknown): CoverCapabilities {
  coverExact(value, ['protocol', 'upload']);
  if (
    value.protocol !== PROFILE_COVER_PROTOCOL ||
    (value.upload !== 'available' && value.upload !== 'unavailable')
  )
    coverInvalid();
  return Object.freeze({
    protocol: PROFILE_COVER_PROTOCOL,
    upload: value.upload,
  });
}
export type CoverVariant = 'thumb-v1' | 'display-v1';
export interface CoverDeclaration {
  readonly mime: 'image/jpeg' | 'image/png';
  readonly bytes: number;
  readonly sha256: string;
}
export interface CoverPrepare {
  readonly protocol: typeof PROFILE_COVER_PROTOCOL;
  readonly clientRequestId: string;
  readonly expectedRevision: number;
  readonly slot: 'cover';
  readonly declaration: CoverDeclaration;
}
export type CoverSource =
  | { readonly kind: 'clear' }
  | {
      readonly kind: 'custom';
      readonly editId: string;
      readonly assetId: string;
    };
export interface CoverCommand {
  readonly protocol: typeof PROFILE_COVER_PROTOCOL;
  readonly clientRequestId: string;
  readonly expectedRevision: number;
  readonly source: CoverSource;
}
export interface CoverReceipt {
  readonly protocol: typeof PROFILE_COVER_PROTOCOL;
  readonly clientRequestId: string;
  readonly requestHash: string;
  readonly resultingRevision: number;
  readonly operation: 'select_cover';
}
export type CoverCommandRecovery =
  | {
      readonly protocol: typeof PROFILE_COVER_PROTOCOL;
      readonly clientRequestId: string;
      readonly state: 'cancelled';
      readonly requestHash: string;
    }
  | {
      readonly protocol: typeof PROFILE_COVER_PROTOCOL;
      readonly clientRequestId: string;
      readonly state: 'not_recorded';
    }
  | {
      readonly protocol: typeof PROFILE_COVER_PROTOCOL;
      readonly clientRequestId: string;
      readonly state: 'committed';
      readonly receipt: CoverReceipt;
    };
export interface AvailableCover {
  readonly state: 'available';
  readonly appearanceId: string;
  readonly source: { readonly kind: 'custom'; readonly bindingId: string };
  readonly variants: readonly ['thumb-v1', 'display-v1'];
  readonly width: number;
  readonly height: number;
}
export type CoverSelection =
  { readonly state: 'none' | 'unavailable' } | AvailableCover;
export interface CurrentCover {
  readonly protocol: typeof PROFILE_COVER_PROTOCOL;
  readonly profileId: string | null;
  readonly revision: number;
  readonly cover: CoverSelection;
}
interface EditBase {
  readonly protocol: typeof PROFILE_COVER_PROTOCOL;
  readonly editId: string;
  readonly intentId: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly serverNow: number;
}
export type CoverTerminalReason =
  'cancelled' | 'expired' | 'rejected' | 'deleted';
export type CoverEditStatus = EditBase &
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
        readonly command: CoverReceipt;
        readonly attachmentState: 'active' | 'detached';
      }
    | {
        readonly status: 'terminal';
        readonly reason: CoverTerminalReason;
        readonly cleanup: 'pending' | 'retained' | 'confirmed';
      }
    | {
        readonly status: 'unavailable';
        readonly reason: 'MEDIA_UNAVAILABLE';
        readonly retryable: boolean;
      }
  );
export type CoverEditRecovery =
  | {
      readonly protocol: typeof PROFILE_COVER_PROTOCOL;
      readonly requestId: string;
      readonly serverNow: number;
      readonly state: 'cancelled_before_prepare';
      readonly requestHash: string;
      readonly reason: 'cancelled';
    }
  | {
      readonly protocol: typeof PROFILE_COVER_PROTOCOL;
      readonly requestId: string;
      readonly serverNow: number;
      readonly state: 'not_recorded';
      readonly requestHash: null;
    }
  | {
      readonly protocol: typeof PROFILE_COVER_PROTOCOL;
      readonly requestId: string;
      readonly serverNow: number;
      readonly state: 'recorded';
      readonly requestHash: string;
      readonly status: CoverEditStatus;
    };
export interface CoverGrant {
  readonly protocol: typeof PROFILE_COVER_PROTOCOL;
  readonly strategy: 'authenticated-multipart-v1';
  readonly editId: string;
  readonly intentId: string;
  readonly generation: string;
  readonly grantId: string;
  readonly method: 'POST';
  readonly fieldName: 'file';
  readonly maxBytes: number;
  readonly expectedBytes: number;
  readonly expectedMime: CoverDeclaration['mime'];
  readonly expectedSha256: string;
  readonly grantExpiresAt: number;
  readonly operationDeadlineAt: number;
  readonly serverNow: number;
}
export interface CoverUploadObserved {
  readonly protocol: typeof PROFILE_COVER_PROTOCOL;
  readonly status: 'uploadObserved';
  readonly editId: string;
  readonly intentId: string;
  readonly generation: string;
  readonly grantId: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly next: 'finalize';
}
export function coverInvalid(): never {
  throw new ClientError('protocol', 'Invalid Profile cover contract');
}
export function coverExact(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  )
    coverInvalid();
}
export const coverInteger = (
  value: unknown,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= min &&
  value <= max;
export const coverDigest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const coverKey = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value);
const generation = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[1-9][0-9]{0,18}$/.test(value) &&
  (value.length < 19 || value <= '9223372036854775807');
const mime = (value: unknown): value is CoverDeclaration['mime'] =>
  value === 'image/jpeg' || value === 'image/png';
const terminal = (value: unknown): value is CoverTerminalReason =>
  value === 'cancelled' ||
  value === 'expired' ||
  value === 'rejected' ||
  value === 'deleted';
export function decodeCoverDeclaration(value: unknown): CoverDeclaration {
  coverExact(value, ['mime', 'bytes', 'sha256']);
  if (
    !mime(value.mime) ||
    !coverInteger(value.bytes, 1, COVER_MAX_BYTES) ||
    !coverDigest(value.sha256)
  )
    coverInvalid();
  return Object.freeze({
    mime: value.mime,
    bytes: value.bytes,
    sha256: value.sha256,
  });
}
export function decodeCoverPrepare(value: unknown): CoverPrepare {
  coverExact(value, [
    'protocol',
    'clientRequestId',
    'expectedRevision',
    'slot',
    'declaration',
  ]);
  if (
    value.protocol !== PROFILE_COVER_PROTOCOL ||
    !isUuid(value.clientRequestId) ||
    !coverInteger(value.expectedRevision, 0, 2147483646) ||
    value.slot !== 'cover'
  )
    coverInvalid();
  return Object.freeze({
    protocol: PROFILE_COVER_PROTOCOL,
    clientRequestId: value.clientRequestId,
    expectedRevision: value.expectedRevision,
    slot: 'cover',
    declaration: decodeCoverDeclaration(value.declaration),
  });
}
export function decodeCoverSource(value: unknown): CoverSource {
  if (!isRecord(value)) coverInvalid();
  if (value.kind === 'clear') {
    coverExact(value, ['kind']);
    return Object.freeze({ kind: 'clear' });
  }
  coverExact(value, ['kind', 'editId', 'assetId']);
  if (
    value.kind !== 'custom' ||
    !isUuid(value.editId) ||
    !isUuid(value.assetId)
  )
    coverInvalid();
  return Object.freeze({
    kind: 'custom',
    editId: value.editId,
    assetId: value.assetId,
  });
}
export function decodeCoverCommand(value: unknown): CoverCommand {
  coverExact(value, [
    'protocol',
    'clientRequestId',
    'expectedRevision',
    'source',
  ]);
  if (
    value.protocol !== PROFILE_COVER_PROTOCOL ||
    !isUuid(value.clientRequestId) ||
    !coverInteger(value.expectedRevision, 0, 2147483646)
  )
    coverInvalid();
  return Object.freeze({
    protocol: PROFILE_COVER_PROTOCOL,
    clientRequestId: value.clientRequestId,
    expectedRevision: value.expectedRevision,
    source: decodeCoverSource(value.source),
  });
}
export function coverPrepareHash(actorAccountId: string, raw: unknown): string {
  if (!isUuid(actorAccountId)) coverInvalid();
  const input = decodeCoverPrepare(raw);
  return sha256(
    'whaleu-profile-cover-prepare:v1\n' +
      JSON.stringify({
        protocol: PROFILE_COVER_PROTOCOL,
        actorAccountId,
        clientRequestId: input.clientRequestId,
        expectedRevision: input.expectedRevision,
        slot: input.slot,
        declaration: input.declaration,
      }),
  );
}
export function coverCommandHash(actorAccountId: string, raw: unknown): string {
  if (!isUuid(actorAccountId)) coverInvalid();
  const input = decodeCoverCommand(raw);
  return sha256(
    'whaleu-profile-cover-command:v1\n' +
      JSON.stringify({
        protocol: PROFILE_COVER_PROTOCOL,
        actorAccountId,
        clientRequestId: input.clientRequestId,
        expectedRevision: input.expectedRevision,
        source: input.source,
      }),
  );
}
export function decodeCoverReceipt(value: unknown): CoverReceipt {
  coverExact(value, [
    'protocol',
    'clientRequestId',
    'requestHash',
    'resultingRevision',
    'operation',
  ]);
  if (
    value.protocol !== PROFILE_COVER_PROTOCOL ||
    !isUuid(value.clientRequestId) ||
    !coverDigest(value.requestHash) ||
    !coverInteger(value.resultingRevision, 1, 2147483647) ||
    value.operation !== 'select_cover'
  )
    coverInvalid();
  return Object.freeze({ ...value }) as unknown as CoverReceipt;
}
export function decodeCoverCommandRecovery(
  value: unknown,
): CoverCommandRecovery {
  if (
    !isRecord(value) ||
    value.protocol !== PROFILE_COVER_PROTOCOL ||
    !isUuid(value.clientRequestId)
  )
    coverInvalid();
  if (value.state === 'not_recorded') {
    coverExact(value, ['protocol', 'clientRequestId', 'state']);
    return Object.freeze({
      protocol: PROFILE_COVER_PROTOCOL,
      clientRequestId: value.clientRequestId,
      state: 'not_recorded',
    });
  }
  if (value.state === 'cancelled') {
    coverExact(value, ['protocol', 'clientRequestId', 'state', 'requestHash']);
    if (!coverDigest(value.requestHash)) coverInvalid();
    return Object.freeze({
      protocol: PROFILE_COVER_PROTOCOL,
      clientRequestId: value.clientRequestId,
      state: 'cancelled',
      requestHash: value.requestHash,
    });
  }
  coverExact(value, ['protocol', 'clientRequestId', 'state', 'receipt']);
  const receipt = decodeCoverReceipt(value.receipt);
  if (
    value.state !== 'committed' ||
    receipt.clientRequestId !== value.clientRequestId
  )
    coverInvalid();
  return Object.freeze({
    protocol: PROFILE_COVER_PROTOCOL,
    clientRequestId: value.clientRequestId,
    state: 'committed',
    receipt,
  });
}
export function decodeCoverSelection(value: unknown): CoverSelection {
  if (!isRecord(value)) coverInvalid();
  if (value.state === 'none' || value.state === 'unavailable') {
    coverExact(value, ['state']);
    return Object.freeze({ state: value.state });
  }
  coverExact(value, [
    'state',
    'appearanceId',
    'source',
    'variants',
    'width',
    'height',
  ]);
  if (
    value.state !== 'available' ||
    !isUuid(value.appearanceId) ||
    !coverInteger(value.width, 1, 2048) ||
    !coverInteger(value.height, 1, 2048) ||
    !Array.isArray(value.variants) ||
    value.variants.length !== 2 ||
    value.variants[0] !== 'thumb-v1' ||
    value.variants[1] !== 'display-v1' ||
    !isRecord(value.source)
  )
    coverInvalid();
  coverExact(value.source, ['kind', 'bindingId']);
  if (value.source.kind !== 'custom' || !isUuid(value.source.bindingId))
    coverInvalid();
  const source = Object.freeze({
    kind: 'custom' as const,
    bindingId: value.source.bindingId,
  });
  return Object.freeze({
    state: 'available',
    appearanceId: value.appearanceId,
    source,
    variants: ['thumb-v1', 'display-v1'] as const,
    width: value.width,
    height: value.height,
  });
}
export function decodeCurrentCover(value: unknown): CurrentCover {
  coverExact(value, ['protocol', 'profileId', 'revision', 'cover']);
  if (
    value.protocol !== PROFILE_COVER_PROTOCOL ||
    (value.profileId !== null && !isUuid(value.profileId)) ||
    !coverInteger(value.revision, 0, 2147483647)
  )
    coverInvalid();
  const cover = decodeCoverSelection(value.cover);
  if (cover.state === 'available' && value.profileId === null) coverInvalid();
  return Object.freeze({
    protocol: PROFILE_COVER_PROTOCOL,
    profileId: value.profileId,
    revision: value.revision,
    cover,
  });
}
export function decodeCoverEditStatus(value: unknown): CoverEditStatus {
  if (
    !isRecord(value) ||
    value.protocol !== PROFILE_COVER_PROTOCOL ||
    !isUuid(value.editId) ||
    !isUuid(value.intentId) ||
    !isUuid(value.requestId) ||
    !coverDigest(value.requestHash) ||
    !coverInteger(value.serverNow)
  )
    coverInvalid();
  const base = {
    protocol: PROFILE_COVER_PROTOCOL,
    editId: value.editId,
    intentId: value.intentId,
    requestId: value.requestId,
    requestHash: value.requestHash,
    serverNow: value.serverNow,
  };
  const keys = [
    'protocol',
    'editId',
    'intentId',
    'requestId',
    'requestHash',
    'serverNow',
    'status',
  ];
  switch (value.status) {
    case 'prepared':
      coverExact(value, [...keys, 'operationDeadlineAt', 'upload']);
      if (
        !coverInteger(value.operationDeadlineAt) ||
        !['none', 'in_flight', 'reconcile_needed'].includes(
          value.upload as string,
        )
      )
        coverInvalid();
      return Object.freeze({
        ...base,
        status: 'prepared',
        operationDeadlineAt: value.operationDeadlineAt,
        upload: value.upload as 'none' | 'in_flight' | 'reconcile_needed',
      });
    case 'uploaded':
      coverExact(value, [...keys, 'operationDeadlineAt']);
      if (!coverInteger(value.operationDeadlineAt)) coverInvalid();
      return Object.freeze({
        ...base,
        status: 'uploaded',
        operationDeadlineAt: value.operationDeadlineAt,
      });
    case 'processing':
      coverExact(value, [...keys, 'operationDeadlineAt', 'retryAfterMs']);
      if (
        !coverInteger(value.operationDeadlineAt) ||
        !coverInteger(value.retryAfterMs, 250, 30000)
      )
        coverInvalid();
      return Object.freeze({
        ...base,
        status: 'processing',
        operationDeadlineAt: value.operationDeadlineAt,
        retryAfterMs: value.retryAfterMs,
      });
    case 'ready_unbound':
      coverExact(value, [
        ...keys,
        'assetId',
        'readyRetentionUntil',
        'editExpiresAt',
        'bindBefore',
        'mediaProof',
      ]);
      if (
        !isUuid(value.assetId) ||
        !coverInteger(value.readyRetentionUntil) ||
        !coverInteger(value.editExpiresAt) ||
        !coverInteger(value.bindBefore) ||
        value.bindBefore !==
          Math.min(value.readyRetentionUntil, value.editExpiresAt) ||
        value.mediaProof !== 'current'
      )
        coverInvalid();
      return Object.freeze({
        ...base,
        status: 'ready_unbound',
        assetId: value.assetId,
        readyRetentionUntil: value.readyRetentionUntil,
        editExpiresAt: value.editExpiresAt,
        bindBefore: value.bindBefore,
        mediaProof: 'current',
      });
    case 'bound_history': {
      coverExact(value, [
        ...keys,
        'assetId',
        'bindingId',
        'command',
        'attachmentState',
      ]);
      if (
        !isUuid(value.assetId) ||
        !isUuid(value.bindingId) ||
        (value.attachmentState !== 'active' &&
          value.attachmentState !== 'detached')
      )
        coverInvalid();
      return Object.freeze({
        ...base,
        status: 'bound_history',
        assetId: value.assetId,
        bindingId: value.bindingId,
        command: decodeCoverReceipt(value.command),
        attachmentState: value.attachmentState,
      });
    }
    case 'terminal':
      coverExact(value, [...keys, 'reason', 'cleanup']);
      if (
        !terminal(value.reason) ||
        !['pending', 'retained', 'confirmed'].includes(value.cleanup as string)
      )
        coverInvalid();
      return Object.freeze({
        ...base,
        status: 'terminal',
        reason: value.reason,
        cleanup: value.cleanup as 'pending' | 'retained' | 'confirmed',
      });
    case 'unavailable':
      coverExact(value, [...keys, 'reason', 'retryable']);
      if (
        value.reason !== 'MEDIA_UNAVAILABLE' ||
        typeof value.retryable !== 'boolean'
      )
        coverInvalid();
      return Object.freeze({
        ...base,
        status: 'unavailable',
        reason: 'MEDIA_UNAVAILABLE',
        retryable: value.retryable,
      });
    default:
      return coverInvalid();
  }
}
export function decodeCoverEditRecovery(value: unknown): CoverEditRecovery {
  if (
    !isRecord(value) ||
    value.protocol !== PROFILE_COVER_PROTOCOL ||
    !isUuid(value.requestId) ||
    !coverInteger(value.serverNow)
  )
    coverInvalid();
  const base = {
    protocol: PROFILE_COVER_PROTOCOL,
    requestId: value.requestId,
    serverNow: value.serverNow,
  };
  if (value.state === 'not_recorded') {
    coverExact(value, [
      'protocol',
      'requestId',
      'serverNow',
      'state',
      'requestHash',
    ]);
    if (value.requestHash !== null) coverInvalid();
    return Object.freeze({ ...base, state: 'not_recorded', requestHash: null });
  }
  if (value.state === 'cancelled_before_prepare') {
    coverExact(value, [
      'protocol',
      'requestId',
      'serverNow',
      'state',
      'requestHash',
      'reason',
    ]);
    if (!coverDigest(value.requestHash) || value.reason !== 'cancelled')
      coverInvalid();
    return Object.freeze({
      ...base,
      state: 'cancelled_before_prepare',
      requestHash: value.requestHash,
      reason: 'cancelled',
    });
  }
  coverExact(value, [
    'protocol',
    'requestId',
    'serverNow',
    'state',
    'requestHash',
    'status',
  ]);
  const status = decodeCoverEditStatus(value.status);
  if (
    value.state !== 'recorded' ||
    status.requestId !== value.requestId ||
    status.requestHash !== value.requestHash
  )
    coverInvalid();
  return Object.freeze({
    ...base,
    state: 'recorded',
    requestHash: status.requestHash,
    status,
  });
}
export function decodeCoverGrant(value: unknown): CoverGrant {
  coverExact(value, [
    'protocol',
    'strategy',
    'editId',
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
    value.protocol !== PROFILE_COVER_PROTOCOL ||
    value.strategy !== 'authenticated-multipart-v1' ||
    !isUuid(value.editId) ||
    !isUuid(value.intentId) ||
    !generation(value.generation) ||
    !isUuid(value.grantId) ||
    value.method !== 'POST' ||
    value.fieldName !== 'file' ||
    value.maxBytes !== COVER_MAX_BYTES ||
    !coverInteger(value.expectedBytes, 1, COVER_MAX_BYTES) ||
    !mime(value.expectedMime) ||
    !coverDigest(value.expectedSha256) ||
    !coverInteger(value.grantExpiresAt) ||
    !coverInteger(value.operationDeadlineAt) ||
    !coverInteger(value.serverNow) ||
    value.grantExpiresAt > value.operationDeadlineAt ||
    value.grantExpiresAt <= value.serverNow
  )
    coverInvalid();
  return Object.freeze({ ...value }) as unknown as CoverGrant;
}
export function decodeCoverUploadObserved(value: unknown): CoverUploadObserved {
  coverExact(value, [
    'protocol',
    'status',
    'editId',
    'intentId',
    'generation',
    'grantId',
    'bytes',
    'sha256',
    'next',
  ]);
  if (
    value.protocol !== PROFILE_COVER_PROTOCOL ||
    value.status !== 'uploadObserved' ||
    !isUuid(value.editId) ||
    !isUuid(value.intentId) ||
    !generation(value.generation) ||
    !isUuid(value.grantId) ||
    !coverInteger(value.bytes, 1, COVER_MAX_BYTES) ||
    !coverDigest(value.sha256) ||
    value.next !== 'finalize'
  )
    coverInvalid();
  return Object.freeze({ ...value }) as unknown as CoverUploadObserved;
}
