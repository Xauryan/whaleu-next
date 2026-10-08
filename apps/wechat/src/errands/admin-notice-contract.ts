import { errandAdminInstantBefore as before } from './admin-time';
import { activityTimestamp } from '../activities/contract';
import { isRecord } from '../api/errors';
import { exact } from '../community/contract';
import { canonicalErrandText, errandId, invalidErrand } from './contract';

interface ErrandNoticeBase {
  readonly noticeId: string;
  readonly createdAt: string;
  readonly readAt: string | null;
}
export type ErrandNoticeAction = 'publish' | 'accept' | 'all';
export type ErrandNoticeDeletionReason =
  | { readonly status: 'not_provided' }
  | { readonly status: 'provided'; readonly value: string };
export type ErrandNotice = ErrandNoticeBase &
  (
    | {
        readonly kind: 'accepted' | 'completed';
        readonly orderId: string;
      }
    | {
        readonly kind: 'admin_deleted';
        readonly orderId: string;
        readonly deletionReason: ErrandNoticeDeletionReason;
      }
    | {
        readonly kind: 'feature_restricted';
        readonly restrictionId: string;
        readonly eventId: string;
        readonly action: ErrandNoticeAction;
        readonly reason: string;
        readonly startsAt: string;
        readonly endsAt: string | null;
      }
    | {
        readonly kind: 'feature_released';
        readonly restrictionId: string;
        readonly eventId: string;
        readonly action: ErrandNoticeAction;
        readonly reason: string;
        readonly releasedAt: string;
      }
  );

function responseReason(value: unknown, maximum: number): string {
  const text = canonicalErrandText(value, maximum);
  if (text !== value) invalidErrand();
  return text;
}
function deletionReason(value: unknown): ErrandNoticeDeletionReason {
  if (!isRecord(value)) invalidErrand();
  if (value.status === 'not_provided') {
    exact(value, ['status']);
    return Object.freeze({ status: 'not_provided' });
  }
  exact(value, ['status', 'value']);
  if (value.status !== 'provided') invalidErrand();
  return Object.freeze({
    status: 'provided',
    value: responseReason(value.value, 500),
  });
}
/** Owner-local snapshots are closed variants, never participant-detail grants. */
export function decodeErrandNotice(value: unknown): ErrandNotice {
  if (
    !isRecord(value) ||
    !errandId(value.noticeId) ||
    !activityTimestamp(value.createdAt) ||
    !(value.readAt === null || activityTimestamp(value.readAt))
  )
    invalidErrand();
  const base = {
    noticeId: value.noticeId,
    createdAt: value.createdAt,
    readAt: value.readAt,
  };
  const commonKeys = ['noticeId', 'kind', 'createdAt', 'readAt'];
  if (value.kind === 'accepted' || value.kind === 'completed') {
    exact(value, [...commonKeys, 'orderId']);
    if (!errandId(value.orderId)) invalidErrand();
    return Object.freeze({ ...base, kind: value.kind, orderId: value.orderId });
  }
  if (value.kind === 'admin_deleted') {
    exact(value, [...commonKeys, 'orderId', 'deletionReason']);
    if (!errandId(value.orderId)) invalidErrand();
    return Object.freeze({
      ...base,
      kind: 'admin_deleted',
      orderId: value.orderId,
      deletionReason: deletionReason(value.deletionReason),
    });
  }
  if (
    (value.kind !== 'feature_restricted' &&
      value.kind !== 'feature_released') ||
    !errandId(value.restrictionId) ||
    !errandId(value.eventId) ||
    (value.action !== 'publish' &&
      value.action !== 'accept' &&
      value.action !== 'all')
  )
    invalidErrand();
  const featureKeys = [
    ...commonKeys,
    'restrictionId',
    'eventId',
    'action',
    'reason',
  ];
  const feature = {
    ...base,
    restrictionId: value.restrictionId,
    eventId: value.eventId,
    action: value.action,
    reason: responseReason(value.reason, 255),
  } as const;
  if (value.kind === 'feature_restricted') {
    exact(value, [...featureKeys, 'startsAt', 'endsAt']);
    if (
      !activityTimestamp(value.startsAt) ||
      !(value.endsAt === null || activityTimestamp(value.endsAt)) ||
      (value.endsAt !== null && !before(value.startsAt, value.endsAt))
    )
      invalidErrand();
    return Object.freeze({
      ...feature,
      kind: 'feature_restricted',
      startsAt: value.startsAt,
      endsAt: value.endsAt,
    });
  }
  exact(value, [...featureKeys, 'releasedAt']);
  if (!activityTimestamp(value.releasedAt)) invalidErrand();
  return Object.freeze({
    ...feature,
    kind: 'feature_released',
    releasedAt: value.releasedAt,
  });
}
