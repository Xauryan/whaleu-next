import { sha256 } from 'js-sha256';
import { ClientError, isRecord } from '../api/errors';
import { exact, timestamp, uuid4 } from '../community/contract';
import { isUuid } from '../profile/contract';

/** A visible named content target, never an account/profile lookup key. */
export interface ProfileAvatarModerationTarget {
  readonly kind: 'post' | 'comment' | 'reply';
  readonly id: string;
}
export interface ProfileAvatarModerationManagement {
  readonly target: ProfileAvatarModerationTarget;
  readonly displayName: string;
  readonly revision: number;
  readonly canClearCustomAvatar: boolean;
  readonly expectedAppearanceId: string | null;
}
export interface ProfileAvatarModerationCommand {
  readonly clientRequestId: string;
  readonly target: ProfileAvatarModerationTarget;
  readonly expectedProfileRevision: number;
  readonly expectedAppearanceId: string;
  readonly action: 'clear_custom_avatar';
}
export type ProfileAvatarModerationReceipt = {
  readonly requestId: string;
  readonly target: ProfileAvatarModerationTarget;
  readonly expectedProfileRevision: number;
  readonly expectedAppearanceId: string;
  readonly action: 'clear_custom_avatar';
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
        | 'PROFILE_AVATAR_MODERATION_STALE'
        | 'PROFILE_AVATAR_MODERATION_NOT_APPLICABLE'
        | 'PROFILE_AVATAR_MODERATION_CANCELLED';
    }
);
export type ProfileAvatarModerationRecovery =
  | {
      readonly state: 'recorded';
      readonly receipt: ProfileAvatarModerationReceipt;
    }
  | { readonly state: 'not_recorded' };
export function invalidProfileAvatarModeration(): never {
  throw new ClientError(
    'protocol',
    'Invalid profile avatar moderation response',
  );
}
const revision = (value: unknown, max = 2147483647): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= max;
export const sameProfileAvatarModerationTarget = (
  a: ProfileAvatarModerationTarget,
  b: ProfileAvatarModerationTarget,
): boolean => a.kind === b.kind && a.id === b.id;
export function decodeProfileAvatarModerationTarget(
  raw: unknown,
): ProfileAvatarModerationTarget {
  exact(raw, ['kind', 'id']);
  if (
    (raw.kind !== 'post' && raw.kind !== 'comment' && raw.kind !== 'reply') ||
    !isUuid(raw.id)
  )
    invalidProfileAvatarModeration();
  return Object.freeze({ kind: raw.kind, id: raw.id });
}
export function decodeProfileAvatarModerationManagement(
  raw: unknown,
): ProfileAvatarModerationManagement {
  exact(raw, [
    'target',
    'displayName',
    'revision',
    'canClearCustomAvatar',
    'expectedAppearanceId',
  ]);
  const target = decodeProfileAvatarModerationTarget(raw.target);
  if (
    typeof raw.displayName !== 'string' ||
    !raw.displayName.trim() ||
    [...raw.displayName].length > 20 ||
    !revision(raw.revision, 2147483646) ||
    typeof raw.canClearCustomAvatar !== 'boolean' ||
    (raw.canClearCustomAvatar
      ? !isUuid(raw.expectedAppearanceId)
      : raw.expectedAppearanceId !== null)
  )
    invalidProfileAvatarModeration();
  return Object.freeze({
    target,
    displayName: raw.displayName,
    revision: raw.revision,
    canClearCustomAvatar: raw.canClearCustomAvatar,
    expectedAppearanceId: raw.expectedAppearanceId as string | null,
  });
}
export function decodeProfileAvatarModerationCommand(
  raw: unknown,
): ProfileAvatarModerationCommand {
  exact(raw, [
    'clientRequestId',
    'target',
    'expectedProfileRevision',
    'expectedAppearanceId',
    'action',
  ]);
  const target = decodeProfileAvatarModerationTarget(raw.target);
  if (
    !uuid4(raw.clientRequestId) ||
    !revision(raw.expectedProfileRevision, 2147483646) ||
    !isUuid(raw.expectedAppearanceId) ||
    raw.action !== 'clear_custom_avatar'
  )
    invalidProfileAvatarModeration();
  return Object.freeze({
    clientRequestId: raw.clientRequestId,
    target,
    expectedProfileRevision: raw.expectedProfileRevision,
    expectedAppearanceId: raw.expectedAppearanceId,
    action: 'clear_custom_avatar',
  });
}
export function decodeProfileAvatarModerationReceipt(
  raw: unknown,
): ProfileAvatarModerationReceipt {
  if (!isRecord(raw)) invalidProfileAvatarModeration();
  exact(raw, [
    'requestId',
    'target',
    'expectedProfileRevision',
    'expectedAppearanceId',
    'action',
    'outcome',
    ...(raw.outcome === 'applied'
      ? ['revision', 'eventId', 'recordedAt']
      : ['code']),
  ]);
  const target = decodeProfileAvatarModerationTarget(raw.target);
  if (
    !uuid4(raw.requestId) ||
    !revision(raw.expectedProfileRevision, 2147483646) ||
    !isUuid(raw.expectedAppearanceId) ||
    raw.action !== 'clear_custom_avatar'
  )
    invalidProfileAvatarModeration();
  if (raw.outcome === 'applied') {
    if (
      !revision(raw.revision) ||
      raw.revision !== raw.expectedProfileRevision + 1 ||
      !isUuid(raw.eventId) ||
      !timestamp(raw.recordedAt)
    )
      invalidProfileAvatarModeration();
  } else if (
    raw.outcome !== 'rejected' ||
    (raw.code !== 'PROFILE_AVATAR_MODERATION_STALE' &&
      raw.code !== 'PROFILE_AVATAR_MODERATION_CANCELLED' &&
      raw.code !== 'PROFILE_AVATAR_MODERATION_NOT_APPLICABLE')
  )
    invalidProfileAvatarModeration();
  return Object.freeze({ ...raw, target }) as ProfileAvatarModerationReceipt;
}
export function matchProfileAvatarModerationReceipt(
  command: ProfileAvatarModerationCommand,
  receipt: ProfileAvatarModerationReceipt,
): void {
  if (
    command.clientRequestId !== receipt.requestId ||
    !sameProfileAvatarModerationTarget(command.target, receipt.target) ||
    command.expectedProfileRevision !== receipt.expectedProfileRevision ||
    command.expectedAppearanceId !== receipt.expectedAppearanceId ||
    command.action !== receipt.action
  )
    invalidProfileAvatarModeration();
}
export function decodeProfileAvatarModerationRecovery(
  raw: unknown,
): ProfileAvatarModerationRecovery {
  if (!isRecord(raw)) invalidProfileAvatarModeration();
  if (raw.state === 'recorded') {
    exact(raw, ['state', 'receipt']);
    return Object.freeze({
      state: 'recorded',
      receipt: decodeProfileAvatarModerationReceipt(raw.receipt),
    });
  }
  exact(raw, ['state']);
  if (raw.state !== 'not_recorded') invalidProfileAvatarModeration();
  return Object.freeze({ state: 'not_recorded' });
}

/** Stable independent command domain, identical to the server's strict intent. */
function canonical(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object' && value !== null)
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ':' +
            canonical((value as Record<string, unknown>)[key]),
        )
        .join(',') +
      '}'
    );
  return invalidProfileAvatarModeration();
}
export function profileAvatarModerationCommandHash(
  actor: string,
  command: ProfileAvatarModerationCommand,
): string {
  if (!isUuid(actor)) invalidProfileAvatarModeration();
  return sha256(
    'whaleu:profile-avatar-moderation-command:v1\n' +
      canonical({
        actor,
        command: decodeProfileAvatarModerationCommand(command),
      }),
  );
}
