import {
  decodeRemovalPunishmentSelection,
  decodeRemovalPunishmentReference,
  decodeRemovalPunishmentOptions,
} from '../admin-post-removal/punishment';
import type {
  RemovalPunishmentSelection,
  RemovalPunishmentReference,
  RemovalPunishmentOptions,
} from '../admin-post-removal/punishment';
import { sha256 } from 'js-sha256';
import { ClientError, isRecord } from '../api/errors';
import { exact, timestamp, uuid4 } from '../community/contract';
import { isUuid } from '../profile/contract';

/** Visible content only, including anonymous comments/replies; never an author lookup key. */
export interface AdminDiscussionRemovalTarget {
  readonly kind: 'comment' | 'reply';
  readonly id: string;
}
export interface AdminDiscussionRemovalManagement {
  readonly target: AdminDiscussionRemovalTarget;
  readonly targetVersion: string;
  readonly canRemove: true;
  readonly punishmentOptions?: RemovalPunishmentOptions;
}
export interface AdminDiscussionRemovalCommand {
  readonly version?: 2;
  readonly punishment?: RemovalPunishmentSelection;
  readonly clientRequestId: string;
  readonly target: AdminDiscussionRemovalTarget;
  readonly expectedTargetVersion: string;
  readonly action: 'remove_discussion';
}
export type AdminDiscussionRemovalReceipt = {
  readonly version?: 2;
  readonly selection?: RemovalPunishmentSelection;
  readonly punishment?: RemovalPunishmentReference;
  readonly requestId: string;
  readonly target: AdminDiscussionRemovalTarget;
  readonly expectedTargetVersion: string;
  readonly action: 'remove_discussion';
} & (
  | {
      readonly outcome: 'applied';
      readonly eventId: string;
      readonly recordedAt: string;
    }
  | {
      readonly outcome: 'rejected';
      readonly code:
        'ADMIN_DISCUSSION_REMOVAL_STALE' | 'ADMIN_DISCUSSION_REMOVAL_CANCELLED';
    }
);
export type AdminDiscussionRemovalRecovery =
  | {
      readonly state: 'recorded';
      readonly receipt: AdminDiscussionRemovalReceipt;
    }
  | { readonly state: 'not_recorded' };
export function invalidAdminDiscussionRemoval(): never {
  throw new ClientError(
    'protocol',
    'Invalid admin discussion removal response',
  );
}
const version = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const sameAdminDiscussionRemovalTarget = (
  a: AdminDiscussionRemovalTarget,
  b: AdminDiscussionRemovalTarget,
): boolean => a.kind === b.kind && a.id === b.id;
export function decodeAdminDiscussionRemovalTarget(
  raw: unknown,
): AdminDiscussionRemovalTarget {
  exact(raw, ['kind', 'id']);
  if ((raw.kind !== 'comment' && raw.kind !== 'reply') || !isUuid(raw.id))
    invalidAdminDiscussionRemoval();
  return Object.freeze({ kind: raw.kind, id: raw.id });
}
export function decodeAdminDiscussionRemovalManagement(
  raw: unknown,
): AdminDiscussionRemovalManagement {
  if (!isRecord(raw)) invalidAdminDiscussionRemoval();
  exact(raw, [
    'target',
    'targetVersion',
    'canRemove',
    ...('punishmentOptions' in raw ? ['punishmentOptions'] : []),
  ]);
  const target = decodeAdminDiscussionRemovalTarget(raw.target);
  if (!version(raw.targetVersion) || raw.canRemove !== true)
    invalidAdminDiscussionRemoval();
  return Object.freeze({
    target,
    targetVersion: raw.targetVersion,
    canRemove: true,
    ...('punishmentOptions' in raw
      ? {
          punishmentOptions: decodeRemovalPunishmentOptions(
            raw.punishmentOptions,
          ),
        }
      : {}),
  });
}
export function decodeAdminDiscussionRemovalCommand(
  raw: unknown,
): AdminDiscussionRemovalCommand {
  if (!isRecord(raw)) invalidAdminDiscussionRemoval();
  exact(raw, [
    'clientRequestId',
    'target',
    'expectedTargetVersion',
    'action',
    ...('version' in raw ? ['version', 'punishment'] : []),
  ]);
  if ('version' in raw && raw.version !== 2) invalidAdminDiscussionRemoval();
  const target = decodeAdminDiscussionRemovalTarget(raw.target);
  if (
    !uuid4(raw.clientRequestId) ||
    !version(raw.expectedTargetVersion) ||
    raw.action !== 'remove_discussion'
  )
    invalidAdminDiscussionRemoval();
  return Object.freeze({
    ...('version' in raw
      ? {
          version: 2 as const,
          punishment: decodeRemovalPunishmentSelection(raw.punishment, false),
        }
      : {}),
    clientRequestId: raw.clientRequestId,
    target,
    expectedTargetVersion: raw.expectedTargetVersion,
    action: 'remove_discussion',
  });
}
export function decodeAdminDiscussionRemovalReceipt(
  raw: unknown,
): AdminDiscussionRemovalReceipt {
  if (!isRecord(raw)) invalidAdminDiscussionRemoval();
  exact(raw, [
    'requestId',
    'target',
    'expectedTargetVersion',
    'action',
    'outcome',
    ...('version' in raw
      ? [
          'version',
          'selection',
          ...(raw.outcome === 'applied' ? ['punishment'] : []),
        ]
      : []),
    ...(raw.outcome === 'applied' ? ['eventId', 'recordedAt'] : ['code']),
  ]);
  const target = decodeAdminDiscussionRemovalTarget(raw.target);
  if (
    !uuid4(raw.requestId) ||
    !version(raw.expectedTargetVersion) ||
    raw.action !== 'remove_discussion'
  )
    invalidAdminDiscussionRemoval();
  if (raw.outcome === 'applied') {
    if (!isUuid(raw.eventId) || !timestamp(raw.recordedAt))
      invalidAdminDiscussionRemoval();
  } else if (
    raw.outcome !== 'rejected' ||
    (raw.code !== 'ADMIN_DISCUSSION_REMOVAL_STALE' &&
      raw.code !== 'ADMIN_DISCUSSION_REMOVAL_CANCELLED')
  )
    invalidAdminDiscussionRemoval();
  if ('version' in raw) {
    if (raw.version !== 2) invalidAdminDiscussionRemoval();
    const selection = decodeRemovalPunishmentSelection(raw.selection, false);
    if (raw.outcome === 'applied') {
      const punishment = decodeRemovalPunishmentReference(raw.punishment);
      if (
        punishment.kind !== selection.kind ||
        incrementRevision(selection.expectedRevision) !== punishment.revision
      )
        invalidAdminDiscussionRemoval();
      return Object.freeze({
        ...raw,
        target,
        selection,
        punishment,
      }) as AdminDiscussionRemovalReceipt;
    }
    return Object.freeze({
      ...raw,
      target,
      selection,
    }) as AdminDiscussionRemovalReceipt;
  }
  return Object.freeze({ ...raw, target }) as AdminDiscussionRemovalReceipt;
}
export function matchAdminDiscussionRemovalReceipt(
  command: AdminDiscussionRemovalCommand,
  receipt: AdminDiscussionRemovalReceipt,
): void {
  if (
    command.clientRequestId !== receipt.requestId ||
    !sameAdminDiscussionRemovalTarget(command.target, receipt.target) ||
    command.expectedTargetVersion !== receipt.expectedTargetVersion ||
    command.action !== receipt.action ||
    command.version !== receipt.version ||
    canonical(command.punishment ?? null) !==
      canonical(receipt.selection ?? null)
  )
    invalidAdminDiscussionRemoval();
}
export function decodeAdminDiscussionRemovalRecovery(
  raw: unknown,
): AdminDiscussionRemovalRecovery {
  if (!isRecord(raw)) invalidAdminDiscussionRemoval();
  if (raw.state === 'recorded') {
    exact(raw, ['state', 'receipt']);
    return Object.freeze({
      state: 'recorded',
      receipt: decodeAdminDiscussionRemovalReceipt(raw.receipt),
    });
  }
  exact(raw, ['state']);
  if (raw.state !== 'not_recorded') invalidAdminDiscussionRemoval();
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
  return invalidAdminDiscussionRemoval();
}
export function adminDiscussionRemovalCommandHash(
  actor: string,
  command: AdminDiscussionRemovalCommand,
): string {
  if (!isUuid(actor)) invalidAdminDiscussionRemoval();
  return sha256(
    `whaleu:admin-discussion-removal-command:v${command.version === 2 ? 2 : 1}\n` +
      canonical({
        actor,
        command: decodeAdminDiscussionRemovalCommand(command),
      }),
  );
}

function incrementRevision(value: string): string {
  let carry = 1;
  const chars = value.split('');
  for (let i = chars.length - 1; i >= 0 && carry; i--) {
    const n = Number(chars[i]) + carry;
    chars[i] = String(n % 10);
    carry = n > 9 ? 1 : 0;
  }
  return (carry ? '1' : '') + chars.join('');
}
