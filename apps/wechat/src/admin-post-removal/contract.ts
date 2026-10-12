import { sha256 } from 'js-sha256';
import { ClientError, isRecord } from '../api/errors';
import { exact, timestamp, uuid4 } from '../community/contract';
import { isUuid } from '../profile/contract';

/** Visible content only, including anonymous posts; never an author lookup key. */
export interface AdminPostRemovalTarget {
  readonly kind: 'post';
  readonly id: string;
}
export interface AdminPostRemovalManagement {
  readonly target: AdminPostRemovalTarget;
  readonly targetVersion: string;
  readonly canRemove: true;
}
export interface AdminPostRemovalCommand {
  readonly clientRequestId: string;
  readonly target: AdminPostRemovalTarget;
  readonly expectedTargetVersion: string;
  readonly action: 'remove_post';
}
export type AdminPostRemovalReceipt = {
  readonly requestId: string;
  readonly target: AdminPostRemovalTarget;
  readonly expectedTargetVersion: string;
  readonly action: 'remove_post';
} & (
  | {
      readonly outcome: 'applied';
      readonly eventId: string;
      readonly recordedAt: string;
    }
  | {
      readonly outcome: 'rejected';
      readonly code:
        'ADMIN_POST_REMOVAL_STALE' | 'ADMIN_POST_REMOVAL_CANCELLED';
    }
);
export type AdminPostRemovalRecovery =
  | { readonly state: 'recorded'; readonly receipt: AdminPostRemovalReceipt }
  | { readonly state: 'not_recorded' };
export function invalidAdminPostRemoval(): never {
  throw new ClientError('protocol', 'Invalid admin post removal response');
}
const version = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const sameAdminPostRemovalTarget = (
  a: AdminPostRemovalTarget,
  b: AdminPostRemovalTarget,
): boolean => a.kind === b.kind && a.id === b.id;
export function decodeAdminPostRemovalTarget(
  raw: unknown,
): AdminPostRemovalTarget {
  exact(raw, ['kind', 'id']);
  if (raw.kind !== 'post' || !isUuid(raw.id)) invalidAdminPostRemoval();
  return Object.freeze({ kind: 'post', id: raw.id });
}
export function decodeAdminPostRemovalManagement(
  raw: unknown,
): AdminPostRemovalManagement {
  exact(raw, ['target', 'targetVersion', 'canRemove']);
  const target = decodeAdminPostRemovalTarget(raw.target);
  if (!version(raw.targetVersion) || raw.canRemove !== true)
    invalidAdminPostRemoval();
  return Object.freeze({
    target,
    targetVersion: raw.targetVersion,
    canRemove: true,
  });
}
export function decodeAdminPostRemovalCommand(
  raw: unknown,
): AdminPostRemovalCommand {
  exact(raw, ['clientRequestId', 'target', 'expectedTargetVersion', 'action']);
  const target = decodeAdminPostRemovalTarget(raw.target);
  if (
    !uuid4(raw.clientRequestId) ||
    !version(raw.expectedTargetVersion) ||
    raw.action !== 'remove_post'
  )
    invalidAdminPostRemoval();
  return Object.freeze({
    clientRequestId: raw.clientRequestId,
    target,
    expectedTargetVersion: raw.expectedTargetVersion,
    action: 'remove_post',
  });
}
export function decodeAdminPostRemovalReceipt(
  raw: unknown,
): AdminPostRemovalReceipt {
  if (!isRecord(raw)) invalidAdminPostRemoval();
  exact(raw, [
    'requestId',
    'target',
    'expectedTargetVersion',
    'action',
    'outcome',
    ...(raw.outcome === 'applied' ? ['eventId', 'recordedAt'] : ['code']),
  ]);
  const target = decodeAdminPostRemovalTarget(raw.target);
  if (
    !uuid4(raw.requestId) ||
    !version(raw.expectedTargetVersion) ||
    raw.action !== 'remove_post'
  )
    invalidAdminPostRemoval();
  if (raw.outcome === 'applied') {
    if (!isUuid(raw.eventId) || !timestamp(raw.recordedAt))
      invalidAdminPostRemoval();
  } else if (
    raw.outcome !== 'rejected' ||
    (raw.code !== 'ADMIN_POST_REMOVAL_STALE' &&
      raw.code !== 'ADMIN_POST_REMOVAL_CANCELLED')
  )
    invalidAdminPostRemoval();
  return Object.freeze({ ...raw, target }) as AdminPostRemovalReceipt;
}
export function matchAdminPostRemovalReceipt(
  command: AdminPostRemovalCommand,
  receipt: AdminPostRemovalReceipt,
): void {
  if (
    command.clientRequestId !== receipt.requestId ||
    !sameAdminPostRemovalTarget(command.target, receipt.target) ||
    command.expectedTargetVersion !== receipt.expectedTargetVersion ||
    command.action !== receipt.action
  )
    invalidAdminPostRemoval();
}
export function decodeAdminPostRemovalRecovery(
  raw: unknown,
): AdminPostRemovalRecovery {
  if (!isRecord(raw)) invalidAdminPostRemoval();
  if (raw.state === 'recorded') {
    exact(raw, ['state', 'receipt']);
    return Object.freeze({
      state: 'recorded',
      receipt: decodeAdminPostRemovalReceipt(raw.receipt),
    });
  }
  exact(raw, ['state']);
  if (raw.state !== 'not_recorded') invalidAdminPostRemoval();
  return Object.freeze({ state: 'not_recorded' });
}
/** Independent command domain, identical to the server's canonical actor/intent. */
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
  return invalidAdminPostRemoval();
}
export function adminPostRemovalCommandHash(
  actor: string,
  command: AdminPostRemovalCommand,
): string {
  if (!isUuid(actor)) invalidAdminPostRemoval();
  return sha256(
    'whaleu:admin-post-removal-command:v1\n' +
      canonical({ actor, command: decodeAdminPostRemovalCommand(command) }),
  );
}
