import { isUuid } from '../profile/contract';
import { ClientError, isRecord } from '../api/errors';
import {
  exact,
  timestamp,
  uuid4,
  decodePost,
  isCategory,
} from '../community/contract';
import type { Post, Category } from '../community/contract';
import { isTradingSubtype } from '../community/trading-contract';
import type { TradingSubtype } from '../community/trading-contract';
export type PinCommand = { clientRequestId: string; postId: string } & (
  { version?: never; spaceId?: never } | { version: 2; spaceId: string }
) &
  (
    | { operation: 'pin'; durationHours: number; level: 1 | 2 }
    | { operation: 'unpin' | 'read'; pinId: string }
  );
export type PinReceipt = {
  requestId: string;
  operation: PinCommand['operation'];
  postId: string;
} & (
  | { outcome: 'applied'; pinId: string; recordedAt: string }
  | {
      outcome: 'rejected';
      code: 'POST_PIN_CONFLICT' | 'POST_PIN_STALE' | 'POST_PIN_CANCELLED';
    }
);
export interface Pin {
  readonly pinId: string;
  readonly postId: string;
  readonly level: 1 | 2;
  readonly pinnedAt: string;
  readonly pinnedUntil: string;
  readonly readState: 'read' | 'unread' | 'guest';
  readonly readAt: string | null;
}
export interface PinQuery {
  spaceId: string;
  category?: Category;
  tradingSubtype?: TradingSubtype;
}
export interface PinPage {
  spaceId: string;
  status: 'available' | 'unavailable';
  items: readonly { pin: Pin; post: Post }[];
}
export interface PinDetail {
  postId: string;
  spaceId?: string;
  status: 'available' | 'unavailable';
  pin: Pin | null;
  canPin: boolean;
  canUnpin: boolean;
}
export function invalidPin(): never {
  throw new ClientError('protocol', 'Invalid scoped post pin');
}
export function decodePin(value: unknown): Pin {
  exact(value, [
    'pinId',
    'postId',
    'level',
    'pinnedAt',
    'pinnedUntil',
    'readState',
    'readAt',
  ]);
  if (
    !uuid4(value.pinId) ||
    !isUuid(value.postId) ||
    (value.level !== 1 && value.level !== 2) ||
    !timestamp(value.pinnedAt) ||
    !timestamp(value.pinnedUntil) ||
    Date.parse(value.pinnedUntil) - Date.parse(value.pinnedAt) < 3600000 ||
    Date.parse(value.pinnedUntil) - Date.parse(value.pinnedAt) >
      168 * 3600000 ||
    !['read', 'unread', 'guest'].includes(String(value.readState)) ||
    !(value.readAt === null || timestamp(value.readAt)) ||
    (value.readState === 'read') !== (value.readAt !== null) ||
    (typeof value.readAt === 'string' &&
      (Date.parse(value.readAt) < Date.parse(String(value.pinnedAt)) ||
        Date.parse(value.readAt) >= Date.parse(String(value.pinnedUntil))))
  )
    invalidPin();
  return Object.freeze({ ...value }) as unknown as Pin;
}
export function decodePinPage(value: unknown): PinPage {
  exact(value, ['spaceId', 'status', 'items']);
  if (
    !isUuid(value.spaceId) ||
    !['available', 'unavailable'].includes(String(value.status)) ||
    !Array.isArray(value.items) ||
    value.items.length > 1 ||
    (value.status === 'unavailable' && value.items.length)
  )
    invalidPin();
  const items = value.items.map((item) => {
    exact(item, ['pin', 'post']);
    const pin = decodePin(item.pin),
      post = decodePost(item.post);
    if (
      pin.postId !== post.id ||
      (post.space.id !== value.spaceId && post.isRelatedCampusSync !== true) ||
      (post.space.id === value.spaceId && post.isRelatedCampusSync === true)
    )
      invalidPin();
    return Object.freeze({ pin, post });
  });
  return Object.freeze({
    spaceId: value.spaceId,
    status: value.status as PinPage['status'],
    items: Object.freeze(items),
  });
}
export function decodePinDetail(value: unknown): PinDetail {
  if (!isRecord(value)) invalidPin();
  exact(value, [
    'postId',
    'status',
    'pin',
    'canPin',
    'canUnpin',
    ...('spaceId' in value ? ['spaceId'] : []),
  ]);
  if (
    !isUuid(value.postId) ||
    ('spaceId' in value && !isUuid(value.spaceId)) ||
    !['available', 'unavailable'].includes(String(value.status)) ||
    typeof value.canPin !== 'boolean' ||
    typeof value.canUnpin !== 'boolean'
  )
    invalidPin();
  const pin = value.pin === null ? null : decodePin(value.pin);
  if (
    (pin && pin.postId !== value.postId) ||
    (value.canUnpin && !pin) ||
    (value.status === 'unavailable' && (pin || value.canPin || value.canUnpin))
  )
    invalidPin();
  return Object.freeze({
    postId: value.postId,
    ...('spaceId' in value ? { spaceId: value.spaceId as string } : {}),
    status: value.status as PinDetail['status'],
    pin,
    canPin: value.canPin,
    canUnpin: value.canUnpin,
  });
}
export function decodePinCommand(value: unknown): PinCommand {
  if (!isRecord(value)) invalidPin();
  exact(value, [
    ...(value.operation === 'pin'
      ? ['clientRequestId', 'operation', 'postId', 'durationHours', 'level']
      : ['clientRequestId', 'operation', 'postId', 'pinId']),
    ...('version' in value ? ['version', 'spaceId'] : []),
  ]);
  if (
    !uuid4(value.clientRequestId) ||
    !isUuid(value.postId) ||
    ('version' in value && (value.version !== 2 || !isUuid(value.spaceId)))
  )
    invalidPin();
  const scope =
    value.version === 2
      ? { version: 2 as const, spaceId: value.spaceId as string }
      : {};
  if (value.operation === 'pin') {
    if (
      typeof value.durationHours !== 'number' ||
      !Number.isInteger(value.durationHours) ||
      value.durationHours < 1 ||
      value.durationHours > 168 ||
      (value.level !== 1 && value.level !== 2)
    )
      invalidPin();
    return Object.freeze({
      ...scope,
      clientRequestId: value.clientRequestId,
      operation: 'pin',
      postId: value.postId,
      durationHours: value.durationHours,
      level: value.level,
    });
  }
  if (
    (value.operation !== 'read' && value.operation !== 'unpin') ||
    !uuid4(value.pinId)
  )
    invalidPin();
  return Object.freeze({
    ...scope,
    clientRequestId: value.clientRequestId,
    operation: value.operation,
    postId: value.postId,
    pinId: value.pinId,
  });
}
export function decodePinReceipt(value: unknown): PinReceipt {
  if (!isRecord(value)) invalidPin();
  exact(
    value,
    value.outcome === 'applied'
      ? ['requestId', 'operation', 'postId', 'outcome', 'pinId', 'recordedAt']
      : ['requestId', 'operation', 'postId', 'outcome', 'code'],
  );
  if (
    !uuid4(value.requestId) ||
    !isUuid(value.postId) ||
    !['pin', 'unpin', 'read'].includes(String(value.operation))
  )
    invalidPin();
  if (value.outcome === 'applied') {
    if (!uuid4(value.pinId) || !timestamp(value.recordedAt)) invalidPin();
  } else if (
    value.outcome !== 'rejected' ||
    !['POST_PIN_CONFLICT', 'POST_PIN_STALE', 'POST_PIN_CANCELLED'].includes(
      String(value.code),
    )
  )
    invalidPin();
  return Object.freeze({ ...value }) as unknown as PinReceipt;
}
export function matchPinReceipt(
  command: PinCommand,
  receipt: PinReceipt,
): void {
  if (
    command.clientRequestId !== receipt.requestId ||
    command.operation !== receipt.operation ||
    command.postId !== receipt.postId ||
    (command.operation !== 'pin' &&
      receipt.outcome === 'applied' &&
      command.pinId !== receipt.pinId)
  )
    invalidPin();
}
export function checkPinQuery(query: PinQuery): void {
  if (
    !isUuid(query.spaceId) ||
    (query.category !== undefined && !isCategory(query.category)) ||
    (query.tradingSubtype !== undefined &&
      (!isTradingSubtype(query.tradingSubtype) || query.category !== 'trading'))
  )
    invalidPin();
}

export interface PinSlot {
  spaceId: string;
  status: 'available' | 'unavailable';
  canUnpin: boolean;
  pin: {
    pinId: string;
    postId: string;
    level: 1 | 2;
    pinnedUntil: string;
  } | null;
}
export function decodePinSlot(value: unknown): PinSlot {
  exact(value, ['spaceId', 'status', 'canUnpin', 'pin']);
  if (
    !isUuid(value.spaceId) ||
    !['available', 'unavailable'].includes(String(value.status)) ||
    typeof value.canUnpin !== 'boolean'
  )
    invalidPin();
  if (value.pin !== null) {
    exact(value.pin, ['pinId', 'postId', 'level', 'pinnedUntil']);
    if (
      !uuid4(value.pin.pinId) ||
      !isUuid(value.pin.postId) ||
      (value.pin.level !== 1 && value.pin.level !== 2) ||
      !timestamp(value.pin.pinnedUntil)
    )
      invalidPin();
  }
  if (
    value.canUnpin !== (value.pin !== null) ||
    (value.status === 'unavailable' && value.pin !== null)
  )
    invalidPin();
  return Object.freeze({
    ...value,
    pin: value.pin === null ? null : Object.freeze({ ...value.pin }),
  }) as PinSlot;
}
