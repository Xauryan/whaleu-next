import { ClientError, isRecord } from '../api/errors';
import { exact, timestamp, uuid4 } from '../community/contract';
import { isUuid } from '../profile/contract';
export interface OwnerVisibilityState {
  readonly ownerHidden: boolean;
  readonly version: number;
  readonly canChange: boolean;
}
export interface OwnerVisibilityManagement extends OwnerVisibilityState {
  readonly postId: string;
}
export interface OwnerVisibilityCommand {
  readonly clientRequestId: string;
  readonly postId: string;
  readonly ownerHidden: boolean;
  readonly expectedVersion: number;
}
export type OwnerVisibilityReceipt = {
  readonly requestId: string;
  readonly postId: string;
  readonly ownerHidden: boolean;
  readonly expectedVersion: number;
} & (
  | {
      readonly outcome: 'applied';
      readonly version: number;
      readonly changed: boolean;
      readonly recordedAt: string;
    }
  | {
      readonly outcome: 'rejected';
      readonly code:
        | 'POST_OWNER_VISIBILITY_STALE'
        | 'POST_OWNER_VISIBILITY_CANCELLED'
        | 'POST_OWNER_VISIBILITY_UNAVAILABLE';
    }
);
export function invalidOwnerVisibility(): never {
  throw new ClientError('protocol', 'Invalid owner visibility response');
}
const version = (value: unknown, max = 2147483647): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= max;
export function decodeOwnerVisibilityState(raw: unknown): OwnerVisibilityState {
  exact(raw, ['ownerHidden', 'version', 'canChange']);
  if (
    typeof raw.ownerHidden !== 'boolean' ||
    !version(raw.version) ||
    typeof raw.canChange !== 'boolean'
  )
    invalidOwnerVisibility();
  return Object.freeze({
    ownerHidden: raw.ownerHidden,
    version: raw.version,
    canChange: raw.canChange,
  });
}
export function decodeOwnerVisibilityManagement(
  raw: unknown,
): OwnerVisibilityManagement {
  exact(raw, ['postId', 'ownerHidden', 'version', 'canChange']);
  if (!isUuid(raw.postId)) invalidOwnerVisibility();
  return Object.freeze({
    postId: raw.postId,
    ...decodeOwnerVisibilityState({
      ownerHidden: raw.ownerHidden,
      version: raw.version,
      canChange: raw.canChange,
    }),
  });
}
export function decodeOwnerVisibilityCommand(
  raw: unknown,
): OwnerVisibilityCommand {
  exact(raw, ['clientRequestId', 'postId', 'ownerHidden', 'expectedVersion']);
  if (
    !uuid4(raw.clientRequestId) ||
    !isUuid(raw.postId) ||
    typeof raw.ownerHidden !== 'boolean' ||
    !version(raw.expectedVersion, 2147483646)
  )
    invalidOwnerVisibility();
  return Object.freeze({
    clientRequestId: raw.clientRequestId,
    postId: raw.postId,
    ownerHidden: raw.ownerHidden,
    expectedVersion: raw.expectedVersion,
  });
}
export function decodeOwnerVisibilityReceipt(
  raw: unknown,
): OwnerVisibilityReceipt {
  if (!isRecord(raw)) invalidOwnerVisibility();
  exact(raw, [
    'requestId',
    'postId',
    'ownerHidden',
    'expectedVersion',
    'outcome',
    ...(raw.outcome === 'applied'
      ? ['version', 'changed', 'recordedAt']
      : ['code']),
  ]);
  if (
    !uuid4(raw.requestId) ||
    !isUuid(raw.postId) ||
    typeof raw.ownerHidden !== 'boolean' ||
    !version(raw.expectedVersion, 2147483646)
  )
    invalidOwnerVisibility();
  if (raw.outcome === 'applied') {
    if (
      !version(raw.version) ||
      raw.version !== raw.expectedVersion + 1 ||
      typeof raw.changed !== 'boolean' ||
      !timestamp(raw.recordedAt)
    )
      invalidOwnerVisibility();
  } else if (
    raw.outcome !== 'rejected' ||
    ![
      'POST_OWNER_VISIBILITY_STALE',
      'POST_OWNER_VISIBILITY_CANCELLED',
      'POST_OWNER_VISIBILITY_UNAVAILABLE',
    ].includes(String(raw.code))
  )
    invalidOwnerVisibility();
  return Object.freeze({ ...raw }) as OwnerVisibilityReceipt;
}
export function matchOwnerVisibilityReceipt(
  command: OwnerVisibilityCommand,
  receipt: OwnerVisibilityReceipt,
): void {
  if (
    command.clientRequestId !== receipt.requestId ||
    command.postId !== receipt.postId ||
    command.ownerHidden !== receipt.ownerHidden ||
    command.expectedVersion !== receipt.expectedVersion
  )
    invalidOwnerVisibility();
}
