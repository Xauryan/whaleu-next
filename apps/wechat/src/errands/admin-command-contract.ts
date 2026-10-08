import { activityTimestamp } from '../activities/contract';
import { isRecord } from '../api/errors';
import { exact } from '../community/contract';
import { canonicalErrandText, errandId, invalidErrand } from './contract';

export type ErrandRestrictionAction = 'publish' | 'accept' | 'all';
export const errandRestrictionActionLabels: Record<
  ErrandRestrictionAction,
  string
> = {
  publish: '发布跑腿',
  accept: '接取跑腿',
  all: '发布及接取跑腿',
};
export type ErrandRestrictionDuration =
  | { readonly kind: 'permanent' }
  | {
      readonly kind: 'finite';
      readonly unit: 'hours' | 'days';
      readonly value: number;
    };
export const errandRestrictionDurations: readonly {
  readonly label: string;
  readonly duration: ErrandRestrictionDuration;
}[] = Object.freeze([
  ...[1, 6, 12].map((value) => ({
    label: `${value}小时`,
    duration: { kind: 'finite' as const, unit: 'hours' as const, value },
  })),
  ...[1, 3, 7, 15, 30, 90, 365].map((value) => ({
    label: `${value}天`,
    duration: { kind: 'finite' as const, unit: 'days' as const, value },
  })),
  { label: '永久限制', duration: { kind: 'permanent' } },
]);
export function decodeErrandRestrictionDuration(
  value: unknown,
): ErrandRestrictionDuration {
  if (!isRecord(value)) invalidErrand();
  if (value.kind === 'permanent') {
    exact(value, ['kind']);
    return Object.freeze({ kind: 'permanent' });
  }
  exact(value, ['kind', 'unit', 'value']);
  if (
    value.kind !== 'finite' ||
    !['hours', 'days'].includes(String(value.unit)) ||
    typeof value.value !== 'number' ||
    !Number.isSafeInteger(value.value) ||
    value.value <= 0
  )
    invalidErrand();
  return Object.freeze({
    kind: 'finite',
    unit: value.unit as 'hours' | 'days',
    value: value.value,
  });
}
export function errandRestrictionAction(
  value: unknown,
): ErrandRestrictionAction {
  if (!['publish', 'accept', 'all'].includes(String(value))) invalidErrand();
  return value as ErrandRestrictionAction;
}
export interface ErrandAdminDeletePayload {
  readonly clientRequestId: string;
  readonly expectedRevision: string;
  readonly deleteReason: string;
  readonly publisherRestriction: ErrandRestrictionDuration | null;
}
export interface ErrandAdminAccepterPayload {
  readonly clientRequestId: string;
  readonly expectedRevision: string;
  readonly reason: string;
  readonly duration: ErrandRestrictionDuration;
}
export interface ErrandRestrictionIssuePayload {
  readonly clientRequestId: string;
  readonly targetProfileId: string;
  readonly action: ErrandRestrictionAction;
  readonly reason: string;
  readonly duration: ErrandRestrictionDuration;
}
export interface ErrandRestrictionReleasePayload {
  readonly clientRequestId: string;
  readonly reason: string;
}
export type ErrandAdminIntent =
  | {
      readonly operation: 'admin_delete';
      readonly orderId: string;
      readonly payload: ErrandAdminDeletePayload;
    }
  | {
      readonly operation: 'restrict_accepter';
      readonly orderId: string;
      readonly payload: ErrandAdminAccepterPayload;
    }
  | {
      readonly operation: 'issue';
      readonly payload: ErrandRestrictionIssuePayload;
    }
  | {
      readonly operation: 'release';
      readonly restrictionId: string;
      readonly payload: ErrandRestrictionReleasePayload;
    };
export type ErrandAdminOperation = ErrandAdminIntent['operation'];
export const errandAdminOperationLabels: Record<ErrandAdminOperation, string> =
  {
    admin_delete: '管理删除订单',
    restrict_accepter: '限制接单者',
    issue: '签发跑腿限制',
    release: '解除此项限制',
  };
export const isOrderAdminIntent = (
  intent: ErrandAdminIntent,
): intent is Extract<ErrandAdminIntent, { orderId: string }> =>
  intent.operation === 'admin_delete' ||
  intent.operation === 'restrict_accepter';
export function decodeErrandAdminIntent(value: unknown): ErrandAdminIntent {
  if (!isRecord(value) || !isRecord(value.payload)) invalidErrand();
  const payload = value.payload;
  if (!errandId(payload.clientRequestId)) invalidErrand();
  if (
    value.operation === 'admin_delete' ||
    value.operation === 'restrict_accepter'
  ) {
    exact(value, ['operation', 'orderId', 'payload']);
    if (!errandId(value.orderId) || !errandId(payload.expectedRevision))
      invalidErrand();
    if (value.operation === 'admin_delete') {
      exact(payload, [
        'clientRequestId',
        'expectedRevision',
        'deleteReason',
        'publisherRestriction',
      ]);
      const duration =
        payload.publisherRestriction === null
          ? null
          : decodeErrandRestrictionDuration(payload.publisherRestriction);
      return Object.freeze({
        operation: 'admin_delete',
        orderId: value.orderId,
        payload: Object.freeze({
          clientRequestId: payload.clientRequestId,
          expectedRevision: payload.expectedRevision,
          deleteReason: canonicalErrandText(
            payload.deleteReason,
            duration ? 255 : 500,
            duration !== null,
          ),
          publisherRestriction: duration,
        }),
      });
    }
    exact(payload, [
      'clientRequestId',
      'expectedRevision',
      'reason',
      'duration',
    ]);
    return Object.freeze({
      operation: 'restrict_accepter',
      orderId: value.orderId,
      payload: Object.freeze({
        clientRequestId: payload.clientRequestId,
        expectedRevision: payload.expectedRevision,
        reason: canonicalErrandText(payload.reason, 255),
        duration: decodeErrandRestrictionDuration(payload.duration),
      }),
    });
  }
  if (value.operation === 'issue') {
    exact(value, ['operation', 'payload']);
    exact(payload, [
      'clientRequestId',
      'targetProfileId',
      'action',
      'reason',
      'duration',
    ]);
    if (!errandId(payload.targetProfileId)) invalidErrand();
    return Object.freeze({
      operation: 'issue',
      payload: Object.freeze({
        clientRequestId: payload.clientRequestId,
        targetProfileId: payload.targetProfileId,
        action: errandRestrictionAction(payload.action),
        reason: canonicalErrandText(payload.reason, 255),
        duration: decodeErrandRestrictionDuration(payload.duration),
      }),
    });
  }
  exact(value, ['operation', 'restrictionId', 'payload']);
  exact(payload, ['clientRequestId', 'reason']);
  if (value.operation !== 'release' || !errandId(value.restrictionId))
    invalidErrand();
  return Object.freeze({
    operation: 'release',
    restrictionId: value.restrictionId,
    payload: Object.freeze({
      clientRequestId: payload.clientRequestId,
      reason: canonicalErrandText(payload.reason, 255),
    }),
  });
}
const orderCodes = [
  'ERRAND_REVISION_CONFLICT',
  'ERRAND_STATE_CONFLICT',
  'ERRAND_USE_OWNER_COMMAND',
  'ERRAND_RESTRICTION_TARGET_PROTECTED',
] as const;
const globalCodes = [
  'ERRAND_RESTRICTION_TARGET_NOT_FOUND',
  'ERRAND_RESTRICTION_TARGET_PROTECTED',
  'ERRAND_RESTRICTION_NOT_FOUND',
  'ERRAND_RESTRICTION_NOT_ACTIVE',
] as const;
export type ErrandAdminReceipt =
  | {
      readonly requestId: string;
      readonly operation: 'admin_delete' | 'restrict_accepter';
      readonly outcome: 'applied';
      readonly orderId: string;
      readonly revision: string;
      readonly occurredAt: string;
    }
  | {
      readonly requestId: string;
      readonly operation: 'issue' | 'release';
      readonly outcome: 'applied';
      readonly restrictionId: string;
      readonly eventId: string;
      readonly occurredAt: string;
    }
  | {
      readonly requestId: string;
      readonly operation: ErrandAdminOperation;
      readonly outcome: 'rejected';
      readonly code: string;
    };
export function decodeErrandAdminReceipt(value: unknown): ErrandAdminReceipt {
  if (
    !isRecord(value) ||
    !errandId(value.requestId) ||
    !Object.hasOwnProperty.call(
      errandAdminOperationLabels,
      String(value.operation),
    )
  )
    invalidErrand();
  const operation = value.operation as ErrandAdminOperation;
  const scoped =
    operation === 'admin_delete' || operation === 'restrict_accepter';
  if (value.outcome === 'rejected') {
    exact(value, ['requestId', 'operation', 'outcome', 'code']);
    if (
      !(scoped ? [...orderCodes] : [...globalCodes]).includes(
        value.code as never,
      )
    )
      invalidErrand();
    return Object.freeze({
      requestId: value.requestId,
      operation,
      outcome: 'rejected',
      code: value.code as string,
    });
  }
  if (value.outcome !== 'applied' || !activityTimestamp(value.occurredAt))
    invalidErrand();
  if (scoped) {
    exact(value, [
      'requestId',
      'operation',
      'outcome',
      'orderId',
      'revision',
      'occurredAt',
    ]);
    if (!errandId(value.orderId) || !errandId(value.revision)) invalidErrand();
    return Object.freeze({
      requestId: value.requestId,
      operation,
      outcome: 'applied',
      orderId: value.orderId,
      revision: value.revision,
      occurredAt: value.occurredAt,
    });
  }
  exact(value, [
    'requestId',
    'operation',
    'outcome',
    'restrictionId',
    'eventId',
    'occurredAt',
  ]);
  if (!errandId(value.restrictionId) || !errandId(value.eventId))
    invalidErrand();
  return Object.freeze({
    requestId: value.requestId,
    operation,
    outcome: 'applied',
    restrictionId: value.restrictionId,
    eventId: value.eventId,
    occurredAt: value.occurredAt,
  });
}
export function matchErrandAdminReceipt(
  intent: ErrandAdminIntent,
  receipt: ErrandAdminReceipt,
): void {
  if (
    receipt.requestId !== intent.payload.clientRequestId ||
    receipt.operation !== intent.operation
  )
    invalidErrand();
  if (receipt.outcome !== 'applied') return;
  if (isOrderAdminIntent(intent)) {
    if (
      !('orderId' in receipt) ||
      receipt.orderId !== intent.orderId ||
      (intent.operation === 'restrict_accepter' &&
        receipt.revision !== intent.payload.expectedRevision) ||
      (intent.operation === 'admin_delete' &&
        receipt.revision === intent.payload.expectedRevision)
    )
      invalidErrand();
  } else if (
    !('restrictionId' in receipt) ||
    (intent.operation === 'release' &&
      receipt.restrictionId !== intent.restrictionId)
  )
    invalidErrand();
}
