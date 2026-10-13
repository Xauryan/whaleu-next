import { sha256 } from 'js-sha256';
import { ClientError } from '../api/errors';
import { exact, boundedText, timestamp, uuid4 } from '../community/contract';
import { isUuid } from '../profile/contract';
export type PunishmentKind = 'interaction_mute' | 'access_suspension';
export interface PunishmentReference {
  readonly punishmentId: string;
  readonly kind: PunishmentKind;
  readonly revision: string;
}
export interface PunishmentView extends PunishmentReference {
  readonly reason: string;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly recordedAt: string;
  readonly state: 'active' | 'expired' | 'superseded' | 'released';
  readonly terminal: {
    readonly cause:
      'expired' | 'superseded' | 'manually_released' | 'appeal_released';
    readonly effectiveAt: string;
    readonly reason: string | null;
  } | null;
  readonly canAppeal: boolean;
  readonly openAppealId: string | null;
}
export interface PunishmentManagement extends PunishmentView {
  readonly stateVersion: string;
  readonly canRelease: boolean;
}
export interface PunishmentStatus {
  readonly coverage: 'complete' | 'unavailable';
  readonly effective: 'clear' | PunishmentKind | 'unavailable';
  readonly checkedAt: string;
  readonly current: readonly PunishmentView[];
}
export type Decision = 'upheld' | 'released' | 'closed_no_longer_effective';
export interface AppealView {
  readonly appealId: string;
  readonly punishment: PunishmentView;
  readonly text: string;
  readonly submittedAt: string;
  readonly state: 'pending' | 'decided';
  readonly decision: {
    readonly outcome: Decision;
    readonly reason: string;
    readonly recordedAt: string;
  } | null;
}
export interface AppealManagement extends AppealView {
  readonly stateVersion: string;
  readonly canDecide: boolean;
}
export interface PageResult<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}
export type Command = { readonly clientRequestId: string } & (
  | {
      readonly action: 'submit_appeal';
      readonly punishment: PunishmentReference;
      readonly text: string;
    }
  | {
      readonly action: 'release';
      readonly punishment: PunishmentReference;
      readonly expectedStateVersion: string;
      readonly reason: string;
    }
  | {
      readonly action: 'decide_appeal';
      readonly appealId: string;
      readonly expectedStateVersion: string;
      readonly decision: Decision;
      readonly reason: string;
    }
);
export type Receipt = { readonly requestId: string } & (
  | {
      readonly action: 'submit_appeal' | 'release';
      readonly punishment: PunishmentReference;
    }
  | { readonly action: 'decide_appeal'; readonly appealId: string }
) &
  (
    | {
        readonly outcome: 'rejected';
        readonly code:
          'SAFETY_MODERATION_STALE' | 'SAFETY_MODERATION_CANCELLED';
      }
    | {
        readonly outcome: 'applied';
        readonly recordedAt: string;
        readonly eventId?: string;
        readonly appealId?: string;
        readonly reusedOpenCase?: boolean;
        readonly decision?: Decision;
      }
  );
export type Recovery =
  | { readonly state: 'not_recorded' }
  | { readonly state: 'recorded'; readonly receipt: Receipt };
export const invalid = (): never => {
  throw new ClientError('protocol', 'Invalid private moderation response');
};
const oneOf = (v: unknown, values: readonly string[]) =>
  typeof v === 'string' && values.includes(v);
const version = (v: unknown) =>
  typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const cursor = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9_-]{1,1024}$/.test(v);
export function reference(raw: unknown): PunishmentReference {
  exact(raw, ['punishmentId', 'kind', 'revision']);
  if (
    !isUuid(raw.punishmentId) ||
    !oneOf(raw.kind, ['interaction_mute', 'access_suspension']) ||
    typeof raw.revision !== 'string' ||
    !/^(?:0|[1-9][0-9]{0,18})$/.test(raw.revision)
  )
    invalid();
  return Object.freeze({
    punishmentId: raw.punishmentId as string,
    kind: raw.kind as PunishmentKind,
    revision: raw.revision as string,
  });
}
const punishmentKeys = [
  'punishmentId',
  'kind',
  'revision',
  'reason',
  'startsAt',
  'endsAt',
  'recordedAt',
  'state',
  'terminal',
  'canAppeal',
  'openAppealId',
];
export function decodePunishment(
  raw: unknown,
  management = false,
): PunishmentView {
  exact(raw, [
    ...punishmentKeys,
    ...(management ? ['stateVersion', 'canRelease'] : []),
  ]);
  const ref = reference({
    punishmentId: raw.punishmentId,
    kind: raw.kind,
    revision: raw.revision,
  });
  if (
    !boundedText(raw.reason, 1, 255) ||
    !timestamp(raw.startsAt) ||
    (raw.endsAt !== null && !timestamp(raw.endsAt)) ||
    !timestamp(raw.recordedAt) ||
    !oneOf(raw.state, ['active', 'expired', 'superseded', 'released']) ||
    typeof raw.canAppeal !== 'boolean' ||
    (raw.openAppealId !== null && !isUuid(raw.openAppealId))
  )
    invalid();
  if (raw.terminal !== null) {
    exact(raw.terminal, ['cause', 'effectiveAt', 'reason']);
    if (
      !oneOf(raw.terminal.cause, [
        'expired',
        'superseded',
        'manually_released',
        'appeal_released',
      ]) ||
      !timestamp(raw.terminal.effectiveAt) ||
      (raw.terminal.reason !== null &&
        !boundedText(raw.terminal.reason, 1, 255))
    )
      invalid();
  }
  if ((raw.state === 'active') !== (raw.terminal === null)) invalid();
  if (
    management &&
    (!version(raw.stateVersion) || typeof raw.canRelease !== 'boolean')
  )
    invalid();
  return Object.freeze({ ...raw, ...ref }) as unknown as PunishmentView;
}
export const decodePunishmentManagement = (
  raw: unknown,
): PunishmentManagement => decodePunishment(raw, true) as PunishmentManagement;
export function decodeStatus(raw: unknown): PunishmentStatus {
  exact(raw, ['coverage', 'effective', 'checkedAt', 'current']);
  if (
    !oneOf(raw.coverage, ['complete', 'unavailable']) ||
    !oneOf(raw.effective, [
      'clear',
      'interaction_mute',
      'access_suspension',
      'unavailable',
    ]) ||
    !timestamp(raw.checkedAt) ||
    !Array.isArray(raw.current) ||
    raw.current.length > 2
  )
    invalid();
  const current = (raw.current as unknown[]).map((v) => decodePunishment(v));
  if (new Set(current.map((v) => v.kind)).size !== current.length) invalid();
  return Object.freeze({
    ...raw,
    current: Object.freeze(current),
  }) as unknown as PunishmentStatus;
}
export function decodeAppeal(raw: unknown, management = false): AppealView {
  exact(raw, [
    'appealId',
    'punishment',
    'text',
    'submittedAt',
    'state',
    'decision',
    ...(management ? ['stateVersion', 'canDecide'] : []),
  ]);
  const punishment = decodePunishment(raw.punishment);
  if (
    !isUuid(raw.appealId) ||
    !boundedText(raw.text, 1, 4000) ||
    !timestamp(raw.submittedAt) ||
    !oneOf(raw.state, ['pending', 'decided'])
  )
    invalid();
  if (raw.decision !== null) {
    exact(raw.decision, ['outcome', 'reason', 'recordedAt']);
    if (
      !oneOf(raw.decision.outcome, [
        'upheld',
        'released',
        'closed_no_longer_effective',
      ]) ||
      !boundedText(raw.decision.reason, 1, 255) ||
      !timestamp(raw.decision.recordedAt)
    )
      invalid();
  }
  if ((raw.state === 'pending') !== (raw.decision === null)) invalid();
  if (
    management &&
    (!version(raw.stateVersion) || typeof raw.canDecide !== 'boolean')
  )
    invalid();
  return Object.freeze({ ...raw, punishment }) as unknown as AppealView;
}
export const decodeAppealManagement = (raw: unknown): AppealManagement =>
  decodeAppeal(raw, true) as AppealManagement;
export function decodePage<T>(
  raw: unknown,
  decode: (v: unknown) => T,
): PageResult<T> {
  exact(raw, ['items', 'nextCursor']);
  if (
    !Array.isArray(raw.items) ||
    raw.items.length > 50 ||
    (raw.nextCursor !== null && !cursor(raw.nextCursor))
  )
    invalid();
  return Object.freeze({
    items: Object.freeze((raw.items as unknown[]).map((v) => decode(v))),
    nextCursor: raw.nextCursor as string | null,
  });
}
export function decodeCommand(raw: unknown): Command {
  if (!raw || typeof raw !== 'object') invalid();
  const action = (raw as { action?: unknown }).action;
  exact(raw, [
    'clientRequestId',
    'action',
    ...(action === 'submit_appeal'
      ? ['punishment', 'text']
      : action === 'release'
        ? ['punishment', 'expectedStateVersion', 'reason']
        : action === 'decide_appeal'
          ? ['appealId', 'expectedStateVersion', 'decision', 'reason']
          : []),
  ]);
  if (
    !uuid4(raw.clientRequestId) ||
    !oneOf(action, ['submit_appeal', 'release', 'decide_appeal'])
  )
    invalid();
  if (action === 'submit_appeal') {
    reference(raw.punishment);
    if (
      !boundedText(raw.text, 1, 4000) ||
      (raw.text as string).trim() !== raw.text
    )
      invalid();
  } else {
    if (
      !version(raw.expectedStateVersion) ||
      !boundedText(raw.reason, 1, 255) ||
      (raw.reason as string).trim() !== raw.reason
    )
      invalid();
    if (action === 'release') reference(raw.punishment);
    else if (
      !isUuid(raw.appealId) ||
      !oneOf(raw.decision, ['upheld', 'released', 'closed_no_longer_effective'])
    )
      invalid();
  }
  return Object.freeze(JSON.parse(JSON.stringify(raw))) as Command;
}
export function decodeReceipt(raw: unknown): Receipt {
  if (!raw || typeof raw !== 'object') invalid();
  const r = raw as Record<string, unknown>,
    action = r.action;
  if (
    !oneOf(action, ['submit_appeal', 'release', 'decide_appeal']) ||
    !oneOf(r.outcome, ['applied', 'rejected'])
  )
    invalid();
  exact(raw, [
    'requestId',
    'action',
    ...(action === 'decide_appeal' ? ['appealId'] : ['punishment']),
    'outcome',
    ...(r.outcome === 'rejected'
      ? ['code']
      : [
          'recordedAt',
          ...(action === 'submit_appeal'
            ? ['appealId', 'reusedOpenCase']
            : ['eventId', ...(action === 'decide_appeal' ? ['decision'] : [])]),
        ]),
  ]);
  if (!uuid4(raw.requestId)) invalid();
  if (action === 'decide_appeal') {
    if (!isUuid(raw.appealId)) invalid();
  } else reference(raw.punishment);
  if (raw.outcome === 'rejected') {
    if (
      !oneOf(raw.code, [
        'SAFETY_MODERATION_STALE',
        'SAFETY_MODERATION_CANCELLED',
      ])
    )
      invalid();
  } else {
    if (!timestamp(raw.recordedAt)) invalid();
    if (action === 'submit_appeal') {
      if (!isUuid(raw.appealId) || typeof raw.reusedOpenCase !== 'boolean')
        invalid();
    } else if (
      !isUuid(raw.eventId) ||
      (action === 'decide_appeal' &&
        !oneOf(raw.decision, [
          'upheld',
          'released',
          'closed_no_longer_effective',
        ]))
    )
      invalid();
  }
  return Object.freeze(JSON.parse(JSON.stringify(raw))) as Receipt;
}
export function matchReceipt(command: Command, receipt: Receipt): void {
  if (
    command.clientRequestId !== receipt.requestId ||
    command.action !== receipt.action
  )
    invalid();
  if (command.action === 'decide_appeal') {
    if (
      receipt.action !== 'decide_appeal' ||
      command.appealId !== receipt.appealId ||
      (receipt.outcome === 'applied' && command.decision !== receipt.decision)
    )
      invalid();
  } else if (
    receipt.action === 'decide_appeal' ||
    JSON.stringify(reference(command.punishment)) !==
      JSON.stringify(reference(receipt.punishment))
  )
    invalid();
}
export function decodeRecovery(raw: unknown): Recovery {
  if (!raw || typeof raw !== 'object') invalid();
  if ((raw as { state?: unknown }).state === 'not_recorded') {
    exact(raw, ['state']);
    return { state: 'not_recorded' };
  }
  exact(raw, ['state', 'receipt']);
  if (raw.state !== 'recorded') invalid();
  return Object.freeze({
    state: 'recorded',
    receipt: decodeReceipt(raw.receipt),
  });
}
export const commandHash = (account: string, command: Command): string =>
  sha256(JSON.stringify({ account, command: decodeCommand(command) }));
