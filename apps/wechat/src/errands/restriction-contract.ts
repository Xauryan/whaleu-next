import { errandAdminInstantBefore } from './admin-time';
import { activityTimestamp } from '../activities/contract';
import { isRecord } from '../api/errors';
import { exact } from '../community/contract';
import {
  decodeErrandAdminParticipant,
  type ErrandAdminParticipant,
  type ErrandAdminTotal,
} from './admin-contract';
import {
  errandRestrictionAction,
  type ErrandRestrictionAction,
} from './admin-command-contract';
import { errandCursor, errandId, invalidErrand } from './contract';

export const errandRestrictionStates = [
  'all',
  'active',
  'released',
  'expired',
  'superseded',
] as const;
export type ErrandRestrictionState = Exclude<
  (typeof errandRestrictionStates)[number],
  'all'
>;
export const errandRestrictionStateLabels = {
  all: '全部记录',
  active: '生效中',
  released: '已解除',
  expired: '已到期',
  superseded: '已被同类限制替代',
};
export type ErrandRestrictionOperator =
  ErrandAdminParticipant | { readonly status: 'unknown' };
export interface ErrandRestriction {
  readonly restrictionId: string;
  readonly subject: ErrandAdminParticipant;
  readonly action: ErrandRestrictionAction;
  readonly reason: string;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly state: ErrandRestrictionState;
  readonly origin: 'local' | 'baseline';
  readonly recordedAt: string;
  readonly operator: ErrandRestrictionOperator;
  readonly source:
    | { readonly kind: 'global' | 'unknown' }
    | { readonly kind: 'order'; readonly orderId: string };
  readonly terminal:
    | null
    | { readonly kind: 'baseline_released'; readonly effectiveAt: string }
    | {
        readonly kind: 'manually_released' | 'superseded';
        readonly eventId: string;
        readonly effectiveAt: string;
        readonly reason: string | null;
        readonly replacementRestrictionId: string | null;
      };
}
export interface ErrandRestrictionQuery {
  readonly targetProfileId?: string;
  readonly action?: ErrandRestrictionAction;
  readonly state: (typeof errandRestrictionStates)[number];
}
export interface ErrandRestrictionPage {
  readonly items: readonly ErrandRestriction[];
  readonly continuation: 'more' | 'end';
  readonly nextCursor: string | null;
  readonly recordedTotal: ErrandAdminTotal;
  readonly historyCoverage: 'unknown_before_boundary';
}
export interface ErrandRestrictionEvent {
  readonly eventId: string;
  readonly kind:
    'issued' | 'manually_released' | 'superseded' | 'observed_baseline';
  readonly effectiveAt: string;
  readonly recordedAt: string;
  readonly reason: string | null;
  readonly operator: ErrandRestrictionOperator;
  readonly replacementRestrictionId: string | null;
}
export interface ErrandRestrictionHistory {
  readonly restriction: ErrandRestriction;
  readonly events: readonly ErrandRestrictionEvent[];
  readonly continuation: 'more' | 'end';
  readonly nextCursor: string | null;
  readonly historyCoverage: 'unknown_before_boundary';
}
function participant(
  value: unknown,
  allowUnknown: true,
): ErrandRestrictionOperator;
function participant(
  value: unknown,
  allowUnknown?: false,
): ErrandAdminParticipant;
function participant(
  value: unknown,
  allowUnknown = false,
): ErrandRestrictionOperator {
  if (allowUnknown && isRecord(value) && value.status === 'unknown') {
    exact(value, ['status']);
    return Object.freeze({ status: 'unknown' });
  }
  return decodeErrandAdminParticipant(value);
}

function reason(value: unknown, max = 500): string {
  // Historical baseline terms are evidence, not fresh form input. Preserve whitespace/CRLF.
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    [...value].length > max ||
    /[\uD800-\uDFFF]/u.test(value)
  )
    invalidErrand();
  return value;
}

export function decodeErrandRestrictionQuery(
  value: unknown,
): ErrandRestrictionQuery {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !['targetProfileId', 'action', 'state'].includes(key),
    ) ||
    !errandRestrictionStates.includes(value.state as never) ||
    (value.targetProfileId !== undefined && !errandId(value.targetProfileId))
  )
    invalidErrand();
  return Object.freeze({
    ...(value.targetProfileId === undefined
      ? {}
      : { targetProfileId: value.targetProfileId as string }),
    ...(value.action === undefined
      ? {}
      : { action: errandRestrictionAction(value.action) }),
    state: value.state as ErrandRestrictionQuery['state'],
  });
}
export function decodeErrandRestriction(value: unknown): ErrandRestriction {
  exact(value, [
    'restrictionId',
    'subject',
    'action',
    'reason',
    'startsAt',
    'endsAt',
    'state',
    'origin',
    'recordedAt',
    'operator',
    'source',
    'terminal',
  ]);
  if (
    !errandId(value.restrictionId) ||
    !activityTimestamp(value.startsAt) ||
    !activityTimestamp(value.recordedAt) ||
    !(value.endsAt === null || activityTimestamp(value.endsAt)) ||
    !['active', 'released', 'expired', 'superseded'].includes(
      String(value.state),
    ) ||
    !['local', 'baseline'].includes(String(value.origin))
  )
    invalidErrand();
  if (
    value.endsAt !== null &&
    !errandAdminInstantBefore(value.startsAt, value.endsAt)
  )
    invalidErrand();
  if (!isRecord(value.source)) invalidErrand();
  let source: ErrandRestriction['source'];
  if (value.source.kind === 'order') {
    exact(value.source, ['kind', 'orderId']);
    if (!errandId(value.source.orderId)) invalidErrand();
    source = Object.freeze({ kind: 'order', orderId: value.source.orderId });
  } else {
    exact(value.source, ['kind']);
    if (!['global', 'unknown'].includes(String(value.source.kind)))
      invalidErrand();
    source = Object.freeze({ kind: value.source.kind as 'global' | 'unknown' });
  }
  let terminal: ErrandRestriction['terminal'] = null;
  if (isRecord(value.terminal) && value.terminal.kind === 'baseline_released') {
    exact(value.terminal, ['kind', 'effectiveAt']);
    if (
      value.origin !== 'baseline' ||
      value.state !== 'released' ||
      !activityTimestamp(value.terminal.effectiveAt)
    )
      invalidErrand();
    terminal = Object.freeze({
      kind: 'baseline_released',
      effectiveAt: value.terminal.effectiveAt,
    });
  } else if (value.terminal !== null) {
    exact(value.terminal, [
      'kind',
      'eventId',
      'effectiveAt',
      'reason',
      'replacementRestrictionId',
    ]);
    const row = value.terminal;
    if (
      !['manually_released', 'superseded'].includes(String(row.kind)) ||
      !errandId(row.eventId) ||
      !activityTimestamp(row.effectiveAt) ||
      !(
        row.replacementRestrictionId === null ||
        errandId(row.replacementRestrictionId)
      ) ||
      (row.kind === 'manually_released' &&
        (row.replacementRestrictionId !== null ||
          value.state !== 'released')) ||
      (row.kind === 'superseded' &&
        (!row.replacementRestrictionId ||
          row.replacementRestrictionId === value.restrictionId ||
          value.state !== 'superseded'))
    )
      invalidErrand();
    terminal = Object.freeze({
      kind: row.kind as 'manually_released' | 'superseded',
      eventId: row.eventId,
      effectiveAt: row.effectiveAt,
      reason: row.reason === null ? null : reason(row.reason),
      replacementRestrictionId: row.replacementRestrictionId as string | null,
    });
  } else if (value.state === 'released' || value.state === 'superseded')
    invalidErrand();
  if (value.state === 'expired' && value.endsAt === null) invalidErrand();
  return Object.freeze({
    restrictionId: value.restrictionId,
    subject: participant(value.subject),
    action: errandRestrictionAction(value.action),
    reason: reason(value.reason),
    startsAt: value.startsAt,
    endsAt: value.endsAt as string | null,
    state: value.state as ErrandRestrictionState,
    origin: value.origin as 'local' | 'baseline',
    recordedAt: value.recordedAt,
    operator: participant(value.operator, true),
    source,
    terminal,
  });
}
function pageTail(value: Record<string, unknown>): {
  continuation: 'more' | 'end';
  nextCursor: string | null;
  historyCoverage: 'unknown_before_boundary';
} {
  if (
    !['more', 'end'].includes(String(value.continuation)) ||
    !(value.nextCursor === null || errandCursor(value.nextCursor)) ||
    (value.continuation === 'end') !== (value.nextCursor === null) ||
    value.historyCoverage !== 'unknown_before_boundary'
  )
    invalidErrand();
  return {
    continuation: value.continuation as 'more' | 'end',
    nextCursor: value.nextCursor as string | null,
    historyCoverage: 'unknown_before_boundary',
  };
}
export function decodeErrandRestrictionPage(
  value: unknown,
): ErrandRestrictionPage {
  exact(value, [
    'items',
    'continuation',
    'nextCursor',
    'recordedTotal',
    'historyCoverage',
  ]);
  if (
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    !isRecord(value.recordedTotal)
  )
    invalidErrand();
  const items = value.items.map(decodeErrandRestriction);
  if (new Set(items.map((item) => item.restrictionId)).size !== items.length)
    invalidErrand();
  let recordedTotal: ErrandAdminTotal;
  if (value.recordedTotal.status === 'known') {
    exact(value.recordedTotal, ['status', 'value']);
    const total = value.recordedTotal.value;
    if (
      typeof total !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(total) ||
      (total.length <= 2 && Number(total) < items.length)
    )
      invalidErrand();
    recordedTotal = Object.freeze({ status: 'known', value: total });
  } else {
    exact(value.recordedTotal, ['status']);
    if (value.recordedTotal.status !== 'unavailable') invalidErrand();
    recordedTotal = Object.freeze({ status: 'unavailable' });
  }
  return Object.freeze({
    items: Object.freeze(items),
    ...pageTail(value),
    recordedTotal,
  });
}
export function decodeErrandRestrictionEvent(
  value: unknown,
): ErrandRestrictionEvent {
  exact(value, [
    'eventId',
    'kind',
    'effectiveAt',
    'recordedAt',
    'reason',
    'operator',
    'replacementRestrictionId',
  ]);
  if (
    !errandId(value.eventId) ||
    ![
      'issued',
      'manually_released',
      'superseded',
      'observed_baseline',
    ].includes(String(value.kind)) ||
    !activityTimestamp(value.effectiveAt) ||
    !activityTimestamp(value.recordedAt) ||
    !(
      value.replacementRestrictionId === null ||
      errandId(value.replacementRestrictionId)
    ) ||
    (value.kind === 'superseded') !== (value.replacementRestrictionId !== null)
  )
    invalidErrand();
  if (
    value.kind === 'observed_baseline' &&
    (value.reason !== null ||
      !isRecord(value.operator) ||
      value.operator.status !== 'unknown' ||
      value.effectiveAt !== value.recordedAt)
  )
    invalidErrand();
  return Object.freeze({
    eventId: value.eventId,
    kind: value.kind as ErrandRestrictionEvent['kind'],
    effectiveAt: value.effectiveAt,
    recordedAt: value.recordedAt,
    reason: value.reason === null ? null : reason(value.reason),
    operator: participant(value.operator, true),
    replacementRestrictionId: value.replacementRestrictionId,
  });
}
export function decodeErrandRestrictionHistory(
  value: unknown,
): ErrandRestrictionHistory {
  exact(value, [
    'restriction',
    'events',
    'continuation',
    'nextCursor',
    'historyCoverage',
  ]);
  if (!Array.isArray(value.events) || value.events.length > 50) invalidErrand();
  const events = value.events.map(decodeErrandRestrictionEvent);
  if (new Set(events.map((event) => event.eventId)).size !== events.length)
    invalidErrand();
  return Object.freeze({
    restriction: decodeErrandRestriction(value.restriction),
    events: Object.freeze(events),
    ...pageTail(value),
  });
}
