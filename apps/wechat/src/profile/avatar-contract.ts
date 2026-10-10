import { sha256 } from 'js-sha256';
import { ClientError, isRecord } from '../api/errors';
import { isUuid } from './contract';

/** Independent Profile protocol. No Community v1/v2/v3/v4 decoder accepts it. */
export const PROFILE_MEDIA_PROTOCOL = 'profile-media-v1' as const;
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export type AvatarVariant = 'thumb-v1' | 'display-v1';
export interface AvatarDeclaration {
  readonly mime: 'image/jpeg' | 'image/png';
  readonly bytes: number;
  readonly sha256: string;
}
export interface AvatarPrepare {
  readonly protocol: typeof PROFILE_MEDIA_PROTOCOL;
  readonly clientRequestId: string;
  readonly expectedRevision: number;
  readonly slot: 'avatar';
  readonly declaration: AvatarDeclaration;
}
export type AvatarSource =
  | { readonly kind: 'clear' }
  | {
      readonly kind: 'catalog';
      readonly catalogVersion: string;
      readonly itemId: string;
    }
  | {
      readonly kind: 'custom';
      readonly editId: string;
      readonly assetId: string;
    };
export interface AvatarCommand {
  readonly protocol: typeof PROFILE_MEDIA_PROTOCOL;
  readonly clientRequestId: string;
  readonly expectedRevision: number;
  readonly source: AvatarSource;
}
export interface AvatarReceipt {
  readonly protocol: typeof PROFILE_MEDIA_PROTOCOL;
  readonly clientRequestId: string;
  readonly requestHash: string;
  readonly resultingRevision: number;
  readonly operation: 'select_avatar';
}
export type AvatarCommandRecovery =
  | {
      readonly protocol: typeof PROFILE_MEDIA_PROTOCOL;
      readonly clientRequestId: string;
      readonly state: 'cancelled';
      readonly requestHash: string;
    }
  | {
      readonly protocol: typeof PROFILE_MEDIA_PROTOCOL;
      readonly clientRequestId: string;
      readonly state: 'not_recorded';
    }
  | {
      readonly protocol: typeof PROFILE_MEDIA_PROTOCOL;
      readonly clientRequestId: string;
      readonly state: 'committed';
      readonly receipt: AvatarReceipt;
    };
export interface AvatarCatalogItem {
  readonly itemId: string;
  readonly label: string;
  readonly contentHash: string;
}
export type AvatarCatalog =
  | {
      readonly protocol: typeof PROFILE_MEDIA_PROTOCOL;
      readonly availability: 'unavailable';
      readonly catalogVersion: null;
      readonly items: readonly [];
    }
  | {
      readonly protocol: typeof PROFILE_MEDIA_PROTOCOL;
      readonly availability: 'available';
      readonly catalogVersion: string;
      readonly items: readonly AvatarCatalogItem[];
    };
export interface AvailableAvatar {
  readonly state: 'available';
  readonly appearanceId: string;
  readonly source:
    | {
        readonly kind: 'catalog';
        readonly catalogVersion: string;
        readonly itemId: string;
      }
    | { readonly kind: 'custom'; readonly bindingId: string };
  readonly variants: readonly ['thumb-v1', 'display-v1'];
  readonly width: number;
  readonly height: number;
}
export type AvatarSelection =
  { readonly state: 'none' | 'unavailable' } | AvailableAvatar;
export interface CurrentAvatar {
  readonly protocol: typeof PROFILE_MEDIA_PROTOCOL;
  readonly profileId: string | null;
  readonly revision: number;
  readonly avatar: AvatarSelection;
}
interface EditBase {
  readonly protocol: typeof PROFILE_MEDIA_PROTOCOL;
  readonly editId: string;
  readonly intentId: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly serverNow: number;
}
export type AvatarTerminalReason =
  'cancelled' | 'expired' | 'rejected' | 'deleted';
export type AvatarEditStatus = EditBase &
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
        readonly command: AvatarReceipt;
        readonly attachmentState: 'active' | 'detached';
      }
    | {
        readonly status: 'terminal';
        readonly reason: AvatarTerminalReason;
        readonly cleanup: 'pending' | 'retained' | 'confirmed';
      }
    | {
        readonly status: 'unavailable';
        readonly reason: 'MEDIA_UNAVAILABLE';
        readonly retryable: boolean;
      }
  );
export type AvatarEditRecovery =
  | {
      readonly protocol: typeof PROFILE_MEDIA_PROTOCOL;
      readonly requestId: string;
      readonly serverNow: number;
      readonly state: 'cancelled_before_prepare';
      readonly requestHash: string;
      readonly reason: 'cancelled';
    }
  | {
      readonly protocol: typeof PROFILE_MEDIA_PROTOCOL;
      readonly requestId: string;
      readonly serverNow: number;
      readonly state: 'not_recorded';
      readonly requestHash: null;
    }
  | {
      readonly protocol: typeof PROFILE_MEDIA_PROTOCOL;
      readonly requestId: string;
      readonly serverNow: number;
      readonly state: 'recorded';
      readonly requestHash: string;
      readonly status: AvatarEditStatus;
    };
export interface AvatarGrant {
  readonly protocol: typeof PROFILE_MEDIA_PROTOCOL;
  readonly strategy: 'authenticated-multipart-v1';
  readonly editId: string;
  readonly intentId: string;
  readonly generation: string;
  readonly grantId: string;
  readonly method: 'POST';
  readonly fieldName: 'file';
  readonly maxBytes: number;
  readonly expectedBytes: number;
  readonly expectedMime: AvatarDeclaration['mime'];
  readonly expectedSha256: string;
  readonly grantExpiresAt: number;
  readonly operationDeadlineAt: number;
  readonly serverNow: number;
}
export interface AvatarUploadObserved {
  readonly protocol: typeof PROFILE_MEDIA_PROTOCOL;
  readonly status: 'uploadObserved';
  readonly editId: string;
  readonly intentId: string;
  readonly generation: string;
  readonly grantId: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly next: 'finalize';
}
export function avatarInvalid(): never {
  throw new ClientError('protocol', 'Invalid Profile avatar contract');
}
export function avatarExact(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  )
    avatarInvalid();
}
export const avatarInteger = (
  value: unknown,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= min &&
  value <= max;
export const avatarDigest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const avatarKey = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value);
const generation = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[1-9][0-9]{0,18}$/.test(value) &&
  (value.length < 19 || value <= '9223372036854775807');
const mime = (value: unknown): value is AvatarDeclaration['mime'] =>
  value === 'image/jpeg' || value === 'image/png';
const terminal = (value: unknown): value is AvatarTerminalReason =>
  value === 'cancelled' ||
  value === 'expired' ||
  value === 'rejected' ||
  value === 'deleted';
export function decodeAvatarDeclaration(value: unknown): AvatarDeclaration {
  avatarExact(value, ['mime', 'bytes', 'sha256']);
  if (
    !mime(value.mime) ||
    !avatarInteger(value.bytes, 1, AVATAR_MAX_BYTES) ||
    !avatarDigest(value.sha256)
  )
    avatarInvalid();
  return Object.freeze({
    mime: value.mime,
    bytes: value.bytes,
    sha256: value.sha256,
  });
}
export function decodeAvatarPrepare(value: unknown): AvatarPrepare {
  avatarExact(value, [
    'protocol',
    'clientRequestId',
    'expectedRevision',
    'slot',
    'declaration',
  ]);
  if (
    value.protocol !== PROFILE_MEDIA_PROTOCOL ||
    !isUuid(value.clientRequestId) ||
    !avatarInteger(value.expectedRevision, 0, 2147483646) ||
    value.slot !== 'avatar'
  )
    avatarInvalid();
  return Object.freeze({
    protocol: PROFILE_MEDIA_PROTOCOL,
    clientRequestId: value.clientRequestId,
    expectedRevision: value.expectedRevision,
    slot: 'avatar',
    declaration: decodeAvatarDeclaration(value.declaration),
  });
}
export function decodeAvatarSource(value: unknown): AvatarSource {
  if (!isRecord(value)) avatarInvalid();
  if (value.kind === 'clear') {
    avatarExact(value, ['kind']);
    return Object.freeze({ kind: 'clear' });
  }
  if (value.kind === 'catalog') {
    avatarExact(value, ['kind', 'catalogVersion', 'itemId']);
    if (!avatarKey(value.catalogVersion) || !avatarKey(value.itemId))
      avatarInvalid();
    return Object.freeze({
      kind: 'catalog',
      catalogVersion: value.catalogVersion,
      itemId: value.itemId,
    });
  }
  avatarExact(value, ['kind', 'editId', 'assetId']);
  if (
    value.kind !== 'custom' ||
    !isUuid(value.editId) ||
    !isUuid(value.assetId)
  )
    avatarInvalid();
  return Object.freeze({
    kind: 'custom',
    editId: value.editId,
    assetId: value.assetId,
  });
}
export function decodeAvatarCommand(value: unknown): AvatarCommand {
  avatarExact(value, [
    'protocol',
    'clientRequestId',
    'expectedRevision',
    'source',
  ]);
  if (
    value.protocol !== PROFILE_MEDIA_PROTOCOL ||
    !isUuid(value.clientRequestId) ||
    !avatarInteger(value.expectedRevision, 0, 2147483646)
  )
    avatarInvalid();
  return Object.freeze({
    protocol: PROFILE_MEDIA_PROTOCOL,
    clientRequestId: value.clientRequestId,
    expectedRevision: value.expectedRevision,
    source: decodeAvatarSource(value.source),
  });
}
export function avatarPrepareHash(
  actorAccountId: string,
  raw: unknown,
): string {
  if (!isUuid(actorAccountId)) avatarInvalid();
  const input = decodeAvatarPrepare(raw);
  return sha256(
    'whaleu-profile-media-prepare:v1\n' +
      JSON.stringify({
        protocol: PROFILE_MEDIA_PROTOCOL,
        actorAccountId,
        clientRequestId: input.clientRequestId,
        expectedRevision: input.expectedRevision,
        slot: input.slot,
        declaration: input.declaration,
      }),
  );
}
export function avatarCommandHash(
  actorAccountId: string,
  raw: unknown,
): string {
  if (!isUuid(actorAccountId)) avatarInvalid();
  const input = decodeAvatarCommand(raw);
  return sha256(
    'whaleu-profile-avatar-command:v1\n' +
      JSON.stringify({
        protocol: PROFILE_MEDIA_PROTOCOL,
        actorAccountId,
        clientRequestId: input.clientRequestId,
        expectedRevision: input.expectedRevision,
        source: input.source,
      }),
  );
}
export function decodeAvatarReceipt(value: unknown): AvatarReceipt {
  avatarExact(value, [
    'protocol',
    'clientRequestId',
    'requestHash',
    'resultingRevision',
    'operation',
  ]);
  if (
    value.protocol !== PROFILE_MEDIA_PROTOCOL ||
    !isUuid(value.clientRequestId) ||
    !avatarDigest(value.requestHash) ||
    !avatarInteger(value.resultingRevision, 1, 2147483647) ||
    value.operation !== 'select_avatar'
  )
    avatarInvalid();
  return Object.freeze({ ...value }) as unknown as AvatarReceipt;
}
export function decodeAvatarCommandRecovery(
  value: unknown,
): AvatarCommandRecovery {
  if (
    !isRecord(value) ||
    value.protocol !== PROFILE_MEDIA_PROTOCOL ||
    !isUuid(value.clientRequestId)
  )
    avatarInvalid();
  if (value.state === 'not_recorded') {
    avatarExact(value, ['protocol', 'clientRequestId', 'state']);
    return Object.freeze({
      protocol: PROFILE_MEDIA_PROTOCOL,
      clientRequestId: value.clientRequestId,
      state: 'not_recorded',
    });
  }
  if (value.state === 'cancelled') {
    avatarExact(value, ['protocol', 'clientRequestId', 'state', 'requestHash']);
    if (!avatarDigest(value.requestHash)) avatarInvalid();
    return Object.freeze({
      protocol: PROFILE_MEDIA_PROTOCOL,
      clientRequestId: value.clientRequestId,
      state: 'cancelled',
      requestHash: value.requestHash,
    });
  }
  avatarExact(value, ['protocol', 'clientRequestId', 'state', 'receipt']);
  const receipt = decodeAvatarReceipt(value.receipt);
  if (
    value.state !== 'committed' ||
    receipt.clientRequestId !== value.clientRequestId
  )
    avatarInvalid();
  return Object.freeze({
    protocol: PROFILE_MEDIA_PROTOCOL,
    clientRequestId: value.clientRequestId,
    state: 'committed',
    receipt,
  });
}
export function decodeAvatarCatalog(value: unknown): AvatarCatalog {
  avatarExact(value, ['protocol', 'availability', 'catalogVersion', 'items']);
  if (value.protocol !== PROFILE_MEDIA_PROTOCOL || !Array.isArray(value.items))
    avatarInvalid();
  if (value.availability === 'unavailable') {
    if (value.catalogVersion !== null || value.items.length !== 0)
      avatarInvalid();
    return Object.freeze({
      protocol: PROFILE_MEDIA_PROTOCOL,
      availability: 'unavailable',
      catalogVersion: null,
      items: [] as const,
    });
  }
  if (
    value.availability !== 'available' ||
    !avatarKey(value.catalogVersion) ||
    value.items.length < 1 ||
    value.items.length > 91
  )
    avatarInvalid();
  const items = value.items.map((item) => {
    avatarExact(item, ['itemId', 'label', 'contentHash']);
    if (
      !avatarKey(item.itemId) ||
      !avatarDigest(item.contentHash) ||
      typeof item.label !== 'string' ||
      [...item.label].length < 1 ||
      [...item.label].length > 80 ||
      [...item.label].some(
        (character) =>
          character.codePointAt(0)! < 32 || character.codePointAt(0) === 127,
      )
    )
      avatarInvalid();
    return Object.freeze({
      itemId: item.itemId,
      label: item.label,
      contentHash: item.contentHash,
    });
  });
  if (new Set(items.map((item) => item.itemId)).size !== items.length)
    avatarInvalid();
  return Object.freeze({
    protocol: PROFILE_MEDIA_PROTOCOL,
    availability: 'available',
    catalogVersion: value.catalogVersion,
    items: Object.freeze(items),
  });
}
export function decodeAvatarSelection(value: unknown): AvatarSelection {
  if (!isRecord(value)) avatarInvalid();
  if (value.state === 'none' || value.state === 'unavailable') {
    avatarExact(value, ['state']);
    return Object.freeze({ state: value.state });
  }
  avatarExact(value, [
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
    !avatarInteger(value.width, 1, 2048) ||
    !avatarInteger(value.height, 1, 2048) ||
    !Array.isArray(value.variants) ||
    value.variants.length !== 2 ||
    value.variants[0] !== 'thumb-v1' ||
    value.variants[1] !== 'display-v1' ||
    !isRecord(value.source)
  )
    avatarInvalid();
  let source: AvailableAvatar['source'];
  if (value.source.kind === 'catalog') {
    avatarExact(value.source, ['kind', 'catalogVersion', 'itemId']);
    if (
      !avatarKey(value.source.catalogVersion) ||
      !avatarKey(value.source.itemId)
    )
      avatarInvalid();
    source = Object.freeze({
      kind: 'catalog',
      catalogVersion: value.source.catalogVersion,
      itemId: value.source.itemId,
    });
  } else {
    avatarExact(value.source, ['kind', 'bindingId']);
    if (value.source.kind !== 'custom' || !isUuid(value.source.bindingId))
      avatarInvalid();
    source = Object.freeze({
      kind: 'custom',
      bindingId: value.source.bindingId,
    });
  }
  return Object.freeze({
    state: 'available',
    appearanceId: value.appearanceId,
    source,
    variants: ['thumb-v1', 'display-v1'] as const,
    width: value.width,
    height: value.height,
  });
}
export function decodeCurrentAvatar(value: unknown): CurrentAvatar {
  avatarExact(value, ['protocol', 'profileId', 'revision', 'avatar']);
  if (
    value.protocol !== PROFILE_MEDIA_PROTOCOL ||
    (value.profileId !== null && !isUuid(value.profileId)) ||
    !avatarInteger(value.revision, 0, 2147483647)
  )
    avatarInvalid();
  const avatar = decodeAvatarSelection(value.avatar);
  if (avatar.state === 'available' && value.profileId === null) avatarInvalid();
  return Object.freeze({
    protocol: PROFILE_MEDIA_PROTOCOL,
    profileId: value.profileId,
    revision: value.revision,
    avatar,
  });
}
export function decodeAvatarEditStatus(value: unknown): AvatarEditStatus {
  if (
    !isRecord(value) ||
    value.protocol !== PROFILE_MEDIA_PROTOCOL ||
    !isUuid(value.editId) ||
    !isUuid(value.intentId) ||
    !isUuid(value.requestId) ||
    !avatarDigest(value.requestHash) ||
    !avatarInteger(value.serverNow)
  )
    avatarInvalid();
  const base = {
    protocol: PROFILE_MEDIA_PROTOCOL,
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
      avatarExact(value, [...keys, 'operationDeadlineAt', 'upload']);
      if (
        !avatarInteger(value.operationDeadlineAt) ||
        !['none', 'in_flight', 'reconcile_needed'].includes(
          value.upload as string,
        )
      )
        avatarInvalid();
      return Object.freeze({
        ...base,
        status: 'prepared',
        operationDeadlineAt: value.operationDeadlineAt,
        upload: value.upload as 'none' | 'in_flight' | 'reconcile_needed',
      });
    case 'uploaded':
      avatarExact(value, [...keys, 'operationDeadlineAt']);
      if (!avatarInteger(value.operationDeadlineAt)) avatarInvalid();
      return Object.freeze({
        ...base,
        status: 'uploaded',
        operationDeadlineAt: value.operationDeadlineAt,
      });
    case 'processing':
      avatarExact(value, [...keys, 'operationDeadlineAt', 'retryAfterMs']);
      if (
        !avatarInteger(value.operationDeadlineAt) ||
        !avatarInteger(value.retryAfterMs, 250, 30000)
      )
        avatarInvalid();
      return Object.freeze({
        ...base,
        status: 'processing',
        operationDeadlineAt: value.operationDeadlineAt,
        retryAfterMs: value.retryAfterMs,
      });
    case 'ready_unbound':
      avatarExact(value, [
        ...keys,
        'assetId',
        'readyRetentionUntil',
        'editExpiresAt',
        'bindBefore',
        'mediaProof',
      ]);
      if (
        !isUuid(value.assetId) ||
        !avatarInteger(value.readyRetentionUntil) ||
        !avatarInteger(value.editExpiresAt) ||
        !avatarInteger(value.bindBefore) ||
        value.bindBefore !==
          Math.min(value.readyRetentionUntil, value.editExpiresAt) ||
        value.mediaProof !== 'current'
      )
        avatarInvalid();
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
      avatarExact(value, [
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
        avatarInvalid();
      return Object.freeze({
        ...base,
        status: 'bound_history',
        assetId: value.assetId,
        bindingId: value.bindingId,
        command: decodeAvatarReceipt(value.command),
        attachmentState: value.attachmentState,
      });
    }
    case 'terminal':
      avatarExact(value, [...keys, 'reason', 'cleanup']);
      if (
        !terminal(value.reason) ||
        !['pending', 'retained', 'confirmed'].includes(value.cleanup as string)
      )
        avatarInvalid();
      return Object.freeze({
        ...base,
        status: 'terminal',
        reason: value.reason,
        cleanup: value.cleanup as 'pending' | 'retained' | 'confirmed',
      });
    case 'unavailable':
      avatarExact(value, [...keys, 'reason', 'retryable']);
      if (
        value.reason !== 'MEDIA_UNAVAILABLE' ||
        typeof value.retryable !== 'boolean'
      )
        avatarInvalid();
      return Object.freeze({
        ...base,
        status: 'unavailable',
        reason: 'MEDIA_UNAVAILABLE',
        retryable: value.retryable,
      });
    default:
      return avatarInvalid();
  }
}
export function decodeAvatarEditRecovery(value: unknown): AvatarEditRecovery {
  if (
    !isRecord(value) ||
    value.protocol !== PROFILE_MEDIA_PROTOCOL ||
    !isUuid(value.requestId) ||
    !avatarInteger(value.serverNow)
  )
    avatarInvalid();
  const base = {
    protocol: PROFILE_MEDIA_PROTOCOL,
    requestId: value.requestId,
    serverNow: value.serverNow,
  };
  if (value.state === 'not_recorded') {
    avatarExact(value, [
      'protocol',
      'requestId',
      'serverNow',
      'state',
      'requestHash',
    ]);
    if (value.requestHash !== null) avatarInvalid();
    return Object.freeze({ ...base, state: 'not_recorded', requestHash: null });
  }
  if (value.state === 'cancelled_before_prepare') {
    avatarExact(value, [
      'protocol',
      'requestId',
      'serverNow',
      'state',
      'requestHash',
      'reason',
    ]);
    if (!avatarDigest(value.requestHash) || value.reason !== 'cancelled')
      avatarInvalid();
    return Object.freeze({
      ...base,
      state: 'cancelled_before_prepare',
      requestHash: value.requestHash,
      reason: 'cancelled',
    });
  }
  avatarExact(value, [
    'protocol',
    'requestId',
    'serverNow',
    'state',
    'requestHash',
    'status',
  ]);
  const status = decodeAvatarEditStatus(value.status);
  if (
    value.state !== 'recorded' ||
    status.requestId !== value.requestId ||
    status.requestHash !== value.requestHash
  )
    avatarInvalid();
  return Object.freeze({
    ...base,
    state: 'recorded',
    requestHash: status.requestHash,
    status,
  });
}
export function decodeAvatarGrant(value: unknown): AvatarGrant {
  avatarExact(value, [
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
    value.protocol !== PROFILE_MEDIA_PROTOCOL ||
    value.strategy !== 'authenticated-multipart-v1' ||
    !isUuid(value.editId) ||
    !isUuid(value.intentId) ||
    !generation(value.generation) ||
    !isUuid(value.grantId) ||
    value.method !== 'POST' ||
    value.fieldName !== 'file' ||
    value.maxBytes !== AVATAR_MAX_BYTES ||
    !avatarInteger(value.expectedBytes, 1, AVATAR_MAX_BYTES) ||
    !mime(value.expectedMime) ||
    !avatarDigest(value.expectedSha256) ||
    !avatarInteger(value.grantExpiresAt) ||
    !avatarInteger(value.operationDeadlineAt) ||
    !avatarInteger(value.serverNow) ||
    value.grantExpiresAt > value.operationDeadlineAt ||
    value.grantExpiresAt <= value.serverNow
  )
    avatarInvalid();
  return Object.freeze({ ...value }) as unknown as AvatarGrant;
}
export function decodeAvatarUploadObserved(
  value: unknown,
): AvatarUploadObserved {
  avatarExact(value, [
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
    value.protocol !== PROFILE_MEDIA_PROTOCOL ||
    value.status !== 'uploadObserved' ||
    !isUuid(value.editId) ||
    !isUuid(value.intentId) ||
    !generation(value.generation) ||
    !isUuid(value.grantId) ||
    !avatarInteger(value.bytes, 1, AVATAR_MAX_BYTES) ||
    !avatarDigest(value.sha256) ||
    value.next !== 'finalize'
  )
    avatarInvalid();
  return Object.freeze({ ...value }) as unknown as AvatarUploadObserved;
}
