import { ClientError, isRecord } from '../api/errors';
import { exact, timestamp, uuid4 } from '../community/contract';
import { isUuid } from '../profile/contract';

/** A visible named content target, never an account/profile lookup key. */
export interface ProfileModerationTarget {
  readonly kind: 'post' | 'comment' | 'reply';
  readonly id: string;
}
export type ProfileModerationManagement =
  | {
      readonly target: ProfileModerationTarget;
      readonly displayName: string;
      readonly revision: number;
      readonly canReset: true;
    }
  | {
      readonly target: ProfileModerationTarget;
      readonly canReset: false;
      readonly availability: 'unavailable';
      readonly blocker: 'related_sync_unsupported';
    };

export interface ProfileModerationCommand {
  readonly clientRequestId: string;
  readonly target: ProfileModerationTarget;
  readonly expectedProfileRevision: number;
  readonly action: 'reset_nickname';
}
export type ProfileModerationReceipt = {
  readonly requestId: string;
  readonly target: ProfileModerationTarget;
  readonly expectedProfileRevision: number;
  readonly action: 'reset_nickname';
} & (
  | {
      readonly outcome: 'applied';
      readonly revision: number;
      readonly eventId: string;
      readonly recordedAt: string;
    }
  | {
      readonly outcome: 'rejected';
      readonly code:
        'PROFILE_MODERATION_STALE' | 'PROFILE_MODERATION_CANCELLED';
    }
);
export type ProfileModerationRecovery =
  | { readonly state: 'recorded'; readonly receipt: ProfileModerationReceipt }
  | { readonly state: 'not_recorded' };
export function invalidProfileModeration(): never {
  throw new ClientError('protocol', 'Invalid profile moderation response');
}
const revision = (value: unknown, max = 2147483647): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= max;
export const sameProfileModerationTarget = (
  a: ProfileModerationTarget,
  b: ProfileModerationTarget,
): boolean => a.kind === b.kind && a.id === b.id;
export function decodeProfileModerationTarget(
  raw: unknown,
): ProfileModerationTarget {
  exact(raw, ['kind', 'id']);
  if (
    (raw.kind !== 'post' && raw.kind !== 'comment' && raw.kind !== 'reply') ||
    !isUuid(raw.id)
  )
    invalidProfileModeration();
  return Object.freeze({ kind: raw.kind, id: raw.id });
}
export function decodeProfileModerationManagement(
  raw: unknown,
): ProfileModerationManagement {
  if (!isRecord(raw)) invalidProfileModeration();
  if ('availability' in raw) {
    exact(raw, ['target', 'canReset', 'availability', 'blocker']);
    const target = decodeProfileModerationTarget(raw.target);
    if (
      raw.canReset !== false ||
      raw.availability !== 'unavailable' ||
      raw.blocker !== 'related_sync_unsupported'
    )
      invalidProfileModeration();
    return Object.freeze({
      target,
      canReset: false,
      availability: 'unavailable',
      blocker: 'related_sync_unsupported',
    });
  }
  exact(raw, ['target', 'displayName', 'revision', 'canReset']);
  const target = decodeProfileModerationTarget(raw.target);
  if (
    typeof raw.displayName !== 'string' ||
    !raw.displayName.trim() ||
    [...raw.displayName].length > 20 ||
    !revision(raw.revision, 2147483646) ||
    raw.canReset !== true
  )
    invalidProfileModeration();
  return Object.freeze({
    target,
    displayName: raw.displayName,
    revision: raw.revision,
    canReset: true,
  });
}
export function decodeProfileModerationCommand(
  raw: unknown,
): ProfileModerationCommand {
  exact(raw, [
    'clientRequestId',
    'target',
    'expectedProfileRevision',
    'action',
  ]);
  const target = decodeProfileModerationTarget(raw.target);
  if (
    !uuid4(raw.clientRequestId) ||
    !revision(raw.expectedProfileRevision, 2147483646) ||
    raw.action !== 'reset_nickname'
  )
    invalidProfileModeration();
  return Object.freeze({
    clientRequestId: raw.clientRequestId,
    target,
    expectedProfileRevision: raw.expectedProfileRevision,
    action: 'reset_nickname',
  });
}
export function decodeProfileModerationReceipt(
  raw: unknown,
): ProfileModerationReceipt {
  if (!isRecord(raw)) invalidProfileModeration();
  exact(raw, [
    'requestId',
    'target',
    'expectedProfileRevision',
    'action',
    'outcome',
    ...(raw.outcome === 'applied'
      ? ['revision', 'eventId', 'recordedAt']
      : ['code']),
  ]);
  const target = decodeProfileModerationTarget(raw.target);
  if (
    !uuid4(raw.requestId) ||
    !revision(raw.expectedProfileRevision, 2147483646) ||
    raw.action !== 'reset_nickname'
  )
    invalidProfileModeration();
  if (raw.outcome === 'applied') {
    if (
      !revision(raw.revision) ||
      raw.revision !== raw.expectedProfileRevision + 1 ||
      !isUuid(raw.eventId) ||
      !timestamp(raw.recordedAt)
    )
      invalidProfileModeration();
  } else if (
    raw.outcome !== 'rejected' ||
    (raw.code !== 'PROFILE_MODERATION_STALE' &&
      raw.code !== 'PROFILE_MODERATION_CANCELLED')
  )
    invalidProfileModeration();
  return Object.freeze({ ...raw, target }) as ProfileModerationReceipt;
}
export function matchProfileModerationReceipt(
  command: ProfileModerationCommand,
  receipt: ProfileModerationReceipt,
): void {
  if (
    command.clientRequestId !== receipt.requestId ||
    !sameProfileModerationTarget(command.target, receipt.target) ||
    command.expectedProfileRevision !== receipt.expectedProfileRevision ||
    command.action !== receipt.action
  )
    invalidProfileModeration();
}
export function decodeProfileModerationRecovery(
  raw: unknown,
): ProfileModerationRecovery {
  if (!isRecord(raw)) invalidProfileModeration();
  if (raw.state === 'recorded') {
    exact(raw, ['state', 'receipt']);
    return Object.freeze({
      state: 'recorded',
      receipt: decodeProfileModerationReceipt(raw.receipt),
    });
  }
  exact(raw, ['state']);
  if (raw.state !== 'not_recorded') invalidProfileModeration();
  return Object.freeze({ state: 'not_recorded' });
}
