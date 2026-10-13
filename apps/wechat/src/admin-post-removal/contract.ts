import {
  decodeRemovalPunishmentSelection,
  decodeRemovalPunishmentReference,
  decodeRemovalPunishmentOptions,
} from './punishment';
import type {
  RemovalPunishmentSelection,
  RemovalPunishmentReference,
  RemovalPunishmentOptions,
} from './punishment';
import { sha256 } from 'js-sha256';
import { ClientError, isRecord } from '../api/errors';
import { exact, timestamp, uuid4 } from '../community/contract';
import { isUuid } from '../profile/contract';

/** Visible content only, including anonymous posts; never an author lookup key. */
export interface AdminPostRemovalTarget {
  readonly kind: 'post';
  readonly id: string;
}
export type AdminPostRemovalManagement = {
  readonly target: AdminPostRemovalTarget;
  readonly targetVersion: string;
  readonly canRemove: true;
} & (
  | {
      readonly version?: never;
      readonly viewSpaceId?: never;
      readonly punishmentOptions?: RemovalPunishmentOptions;
    }
  | {
      readonly version: 3;
      readonly viewSpaceId: string;
      readonly punishmentOptions?: never;
    }
);
export type AdminPostRemovalCommand = {
  readonly clientRequestId: string;
  readonly target: AdminPostRemovalTarget;
  readonly expectedTargetVersion: string;
  readonly action: 'remove_post';
} & (
  | {
      readonly version?: 2;
      readonly punishment?: RemovalPunishmentSelection;
      readonly viewSpaceId?: never;
    }
  | {
      readonly version: 3;
      readonly viewSpaceId: string;
      readonly punishment?: never;
    }
);
export type AdminPostRemovalReceipt = {
  readonly requestId: string;
  readonly target: AdminPostRemovalTarget;
  readonly expectedTargetVersion: string;
  readonly action: 'remove_post';
} & (
  | {
      readonly version?: 2;
      readonly selection?: RemovalPunishmentSelection;
      readonly punishment?: RemovalPunishmentReference;
      readonly viewSpaceId?: never;
    }
  | {
      readonly version: 3;
      readonly viewSpaceId: string;
      readonly selection?: never;
      readonly punishment?: never;
    }
) &
  (
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
  if (!isRecord(raw)) invalidAdminPostRemoval();
  exact(raw, [
    'target',
    'targetVersion',
    'canRemove',
    ...(raw.version === 3
      ? ['version', 'viewSpaceId']
      : 'punishmentOptions' in raw
        ? ['punishmentOptions']
        : []),
  ]);
  const target = decodeAdminPostRemovalTarget(raw.target);
  if (!version(raw.targetVersion) || raw.canRemove !== true)
    invalidAdminPostRemoval();
  if (raw.version === 3) {
    if (!isUuid(raw.viewSpaceId)) invalidAdminPostRemoval();
    return Object.freeze({
      version: 3,
      viewSpaceId: raw.viewSpaceId,
      target,
      targetVersion: raw.targetVersion,
      canRemove: true,
    });
  }
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
export function decodeAdminPostRemovalCommand(
  raw: unknown,
): AdminPostRemovalCommand {
  if (!isRecord(raw)) invalidAdminPostRemoval();
  exact(raw, [
    'clientRequestId',
    'target',
    'expectedTargetVersion',
    'action',
    ...(raw.version === 3
      ? ['version', 'viewSpaceId']
      : 'version' in raw
        ? ['version', 'punishment']
        : []),
  ]);
  if ('version' in raw && raw.version !== 2 && raw.version !== 3)
    invalidAdminPostRemoval();
  if (raw.version === 3 && !isUuid(raw.viewSpaceId)) invalidAdminPostRemoval();
  const target = decodeAdminPostRemovalTarget(raw.target);
  if (
    !uuid4(raw.clientRequestId) ||
    !version(raw.expectedTargetVersion) ||
    raw.action !== 'remove_post'
  )
    invalidAdminPostRemoval();
  return Object.freeze({
    ...(raw.version === 3
      ? { version: 3 as const, viewSpaceId: raw.viewSpaceId as string }
      : 'version' in raw
        ? {
            version: 2 as const,
            punishment: decodeRemovalPunishmentSelection(raw.punishment, true),
          }
        : {}),
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
    ...(raw.version === 3
      ? ['version', 'viewSpaceId']
      : 'version' in raw
        ? [
            'version',
            'selection',
            ...(raw.outcome === 'applied' ? ['punishment'] : []),
          ]
        : []),
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
  if (raw.version === 3) {
    if (!isUuid(raw.viewSpaceId)) invalidAdminPostRemoval();
    return Object.freeze({ ...raw, target }) as AdminPostRemovalReceipt;
  }
  if ('version' in raw) {
    if (raw.version !== 2) invalidAdminPostRemoval();
    const selection = decodeRemovalPunishmentSelection(raw.selection, true);
    if (raw.outcome === 'applied') {
      const punishment = decodeRemovalPunishmentReference(raw.punishment);
      if (
        punishment.kind !== selection.kind ||
        incrementRevision(selection.expectedRevision) !== punishment.revision
      )
        invalidAdminPostRemoval();
      return Object.freeze({
        ...raw,
        target,
        selection,
        punishment,
      }) as AdminPostRemovalReceipt;
    }
    return Object.freeze({
      ...raw,
      target,
      selection,
    }) as AdminPostRemovalReceipt;
  }
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
    command.action !== receipt.action ||
    command.version !== receipt.version ||
    command.viewSpaceId !== receipt.viewSpaceId ||
    canonical(command.punishment ?? null) !==
      canonical(receipt.selection ?? null)
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
    `whaleu:admin-post-removal-command:v${command.version ?? 1}\n` +
      canonical({ actor, command: decodeAdminPostRemovalCommand(command) }),
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
