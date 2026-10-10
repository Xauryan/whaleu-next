import { ClientError, isRecord } from '../api/errors';
import type {
  MediaAttachment,
  MediaIntentStatus,
  MediaPrepare,
} from './contracts';

function invalid(): never {
  throw new ClientError('protocol', 'Invalid media contract');
}
function exact(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  )
    invalid();
}
export function mediaUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i.test(
      value,
    )
  );
}
function integer(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}
export function decodeMediaAttachment(value: unknown): MediaAttachment {
  exact(value, [
    'version',
    'kind',
    'assetId',
    'bindingId',
    'width',
    'height',
    'variants',
  ]);
  if (
    value.version !== 1 ||
    value.kind !== 'authenticated-media' ||
    !mediaUuid(value.assetId) ||
    !mediaUuid(value.bindingId) ||
    !integer(value.width, 1, 2048) ||
    !integer(value.height, 1, 2048) ||
    !Array.isArray(value.variants) ||
    value.variants.length !== 2 ||
    value.variants[0] !== 'thumb-v1' ||
    value.variants[1] !== 'display-v1'
  )
    invalid();
  return Object.freeze({
    version: 1,
    kind: 'authenticated-media',
    assetId: value.assetId,
    bindingId: value.bindingId,
    width: value.width,
    height: value.height,
    variants: Object.freeze(['thumb-v1', 'display-v1'] as const),
  });
}
export function decodeMediaPrepare(value: unknown): MediaPrepare {
  exact(value, [
    'clientRequestId',
    'purpose',
    'draftId',
    'spaceId',
    'slot',
    'ordinal',
    'declaration',
  ]);
  exact(value.declaration, ['mime', 'bytes']);
  if (
    !mediaUuid(value.clientRequestId) ||
    !mediaUuid(value.draftId) ||
    !mediaUuid(value.spaceId) ||
    value.purpose !== 'community-post-image' ||
    value.slot !== 'images' ||
    value.ordinal !== 0 ||
    (value.declaration.mime !== 'image/jpeg' &&
      value.declaration.mime !== 'image/png') ||
    !integer(value.declaration.bytes, 1, 5 * 1024 * 1024)
  )
    invalid();
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
    }),
  });
}
/** Exact wire status is validated before projecting the controller's minimal state. */
export function decodeMediaIntentStatus(value: unknown): MediaIntentStatus {
  if (!isRecord(value)) invalid();
  exact(value, [
    'intentId',
    'expiresAt',
    'status',
    'reasonCode',
    'retryable',
    ...(value.status === 'ready' ? ['assetId'] : []),
  ]);
  if (
    !mediaUuid(value.intentId) ||
    !integer(value.expiresAt, 1, 8_640_000_000_000_000) ||
    typeof value.retryable !== 'boolean'
  )
    invalid();
  const status = value.status;
  if (
    status !== 'prepared' &&
    status !== 'uploading' &&
    status !== 'processing' &&
    status !== 'ready' &&
    status !== 'rejected' &&
    status !== 'expired' &&
    status !== 'cancelled' &&
    status !== 'unavailable'
  )
    invalid();
  const reasons = {
    rejected: 'MEDIA_REJECTED',
    expired: 'MEDIA_EXPIRED',
    cancelled: 'MEDIA_CANCELLED',
    unavailable: 'MEDIA_UNAVAILABLE',
  } as const;
  const reason =
    status === 'rejected' ||
    status === 'expired' ||
    status === 'cancelled' ||
    status === 'unavailable'
      ? reasons[status]
      : null;
  if (value.reasonCode !== reason) invalid();
  if (status === 'ready') {
    if (!mediaUuid(value.assetId)) invalid();
    return Object.freeze({
      intentId: value.intentId,
      expiresAt: value.expiresAt,
      status,
      assetId: value.assetId,
    });
  }
  if (
    status === 'prepared' ||
    status === 'uploading' ||
    status === 'processing'
  )
    return Object.freeze({
      intentId: value.intentId,
      expiresAt: value.expiresAt,
      status,
    });
  return Object.freeze({
    intentId: value.intentId,
    expiresAt: value.expiresAt,
    status,
  });
}
