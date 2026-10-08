import { activityTimestamp } from '../activities/contract';
import { isRecord } from '../api/errors';
import { boundedText, exact } from '../community/contract';
import {
  decodeAuthorization,
  type Authorization,
} from '../identity-privacy/overlay';
import {
  canonicalErrandText,
  errandCursor,
  errandId,
  exactErrandReward,
  invalidErrand,
  type ErrandState,
} from './contract';

export const errandAdminStatuses = [
  'all',
  'pending',
  'accepted',
  'completed',
  'cancelled',
  'deleted',
] as const;
export type ErrandAdminStatus = (typeof errandAdminStatuses)[number];
export const errandAdminStatusLabels: Record<ErrandAdminStatus, string> = {
  all: '全部',
  pending: '待接单',
  accepted: '进行中',
  completed: '已完成',
  cancelled: '已取消',
  deleted: '已删除',
};
export type ErrandAdminParticipant =
  | {
      readonly status: 'available';
      readonly profileId: string;
      readonly displayName: string;
    }
  | { readonly status: 'unavailable' };
export type ErrandAdminRegion =
  | {
      readonly id: string;
      readonly status: 'available';
      readonly label: string;
      readonly active: boolean;
    }
  | { readonly id: string; readonly status: 'unavailable' };
export type ErrandAdminDeletionReason =
  | { readonly status: 'unavailable' | 'not_provided' }
  | { readonly status: 'provided'; readonly value: string };
export function decodeErrandAdminDeletionReason(
  value: unknown,
): ErrandAdminDeletionReason {
  if (!isRecord(value)) invalidErrand();
  if (value.status === 'provided') {
    exact(value, ['status', 'value']);
    const text = canonicalErrandText(value.value, 500);
    if (text !== value.value) invalidErrand();
    return Object.freeze({ status: 'provided', value: text });
  }
  exact(value, ['status']);
  if (value.status !== 'unavailable' && value.status !== 'not_provided')
    invalidErrand();
  return Object.freeze({ status: value.status });
}
export interface ErrandAdminOrder {
  readonly id: string;
  readonly revision: string;
  readonly title: string;
  readonly publicText: string;
  readonly expectedTimeText: string;
  readonly reward: string;
  readonly state: ErrandState;
  readonly displayState: ErrandState | 'deleted';
  readonly createdAt: string;
  readonly acceptedAt: string | null;
  readonly completedAt: string | null;
  readonly cancelledAt: string | null;
  readonly deletedAt: string | null;
  readonly deletionReason: ErrandAdminDeletionReason | null;
  readonly publisher: ErrandAdminParticipant;
  readonly accepter: ErrandAdminParticipant | null;
  readonly relation: 'publisher' | 'accepter' | 'none';
  readonly sourceRegion: ErrandAdminRegion;
  readonly targetRegion: ErrandAdminRegion;
}
export type ErrandAdminTotal =
  | { readonly status: 'known'; readonly value: string }
  | { readonly status: 'unavailable' };
export interface ErrandAdminQuery {
  readonly regionId: string;
  readonly status: ErrandAdminStatus;
  readonly keyword: string;
}
export interface ErrandAdminPage {
  readonly context: ErrandAdminQuery & {
    readonly management: 'fixed' | 'global';
    readonly search: {
      readonly matcher: 'public-text-name-uuid-v1';
      readonly legacyNumericReferences: 'unavailable';
    };
  };
  readonly items: readonly ErrandAdminOrder[];
  readonly continuation: 'more' | 'end';
  readonly nextCursor: string | null;
  readonly total: ErrandAdminTotal;
}
export function decodeErrandAdminAuthorization(value: unknown): Authorization {
  const auth = decodeAuthorization(value);
  // Authorization's current immutable school-grant model permits at most one binding.
  if (
    auth.management.operatingRegionIds.length > 1 ||
    (auth.role === 'school_admin' &&
      auth.management.operatingRegionIds.length !== 1)
  )
    invalidErrand();
  return auth;
}
export const canonicalErrandAdminKeyword = (value: unknown): string =>
  canonicalErrandText(value, 100, false);
export function decodeErrandAdminQuery(value: unknown): ErrandAdminQuery {
  exact(value, ['regionId', 'status', 'keyword']);
  if (
    !errandId(value.regionId) ||
    !errandAdminStatuses.includes(value.status as ErrandAdminStatus)
  )
    invalidErrand();
  return Object.freeze({
    regionId: value.regionId,
    status: value.status as ErrandAdminStatus,
    keyword: canonicalErrandAdminKeyword(value.keyword),
  });
}
export function decodeErrandAdminParticipant(
  value: unknown,
): ErrandAdminParticipant {
  if (!isRecord(value)) invalidErrand();
  if (value.status === 'unavailable') {
    exact(value, ['status']);
    return Object.freeze({ status: 'unavailable' });
  }
  exact(value, ['status', 'profileId', 'displayName']);
  if (
    value.status !== 'available' ||
    !errandId(value.profileId) ||
    !boundedText(value.displayName, 1, 200) ||
    value.displayName.length > 200
  )
    invalidErrand();
  return Object.freeze({
    status: 'available',
    profileId: value.profileId,
    displayName: value.displayName,
  });
}
function region(value: unknown): ErrandAdminRegion {
  if (!isRecord(value) || !errandId(value.id)) invalidErrand();
  if (value.status === 'unavailable') {
    exact(value, ['id', 'status']);
    return Object.freeze({ id: value.id, status: 'unavailable' });
  }
  exact(value, ['id', 'status', 'label', 'active']);
  if (
    value.status !== 'available' ||
    !boundedText(value.label, 1, 200) ||
    value.label.length > 400 ||
    typeof value.active !== 'boolean'
  )
    invalidErrand();
  return Object.freeze({
    id: value.id,
    status: 'available',
    label: value.label,
    active: value.active,
  });
}
function responseText(value: unknown, max: number): string {
  const text = canonicalErrandText(value, max);
  if (text !== value) invalidErrand();
  return text;
}
/** Preserve sub-millisecond ordering without floating-point epoch multiplication. */
function before(a: string, b: string): boolean {
  const left = Date.parse(a),
    right = Date.parse(b);
  const micros = (text: string): string =>
    ((/\.(\d+)/.exec(text)?.[1] ?? '') + '000000').slice(3, 6);
  return left < right || (left === right && micros(a) < micros(b));
}
export function decodeErrandAdminOrder(value: unknown): ErrandAdminOrder {
  exact(value, [
    'id',
    'revision',
    'title',
    'publicText',
    'expectedTimeText',
    'reward',
    'state',
    'displayState',
    'createdAt',
    'acceptedAt',
    'completedAt',
    'cancelledAt',
    'deletedAt',
    'deletionReason',
    'publisher',
    'accepter',
    'relation',
    'sourceRegion',
    'targetRegion',
  ]);
  if (
    !errandId(value.id) ||
    !errandId(value.revision) ||
    !['pending', 'accepted', 'completed', 'cancelled'].includes(
      String(value.state),
    ) ||
    !activityTimestamp(value.createdAt) ||
    !['publisher', 'accepter', 'none'].includes(String(value.relation))
  )
    invalidErrand();
  for (const key of ['acceptedAt', 'completedAt', 'cancelledAt', 'deletedAt'])
    if (value[key] !== null && !activityTimestamp(value[key])) invalidErrand();
  if (
    (value.state === 'pending' && value.acceptedAt !== null) ||
    (['accepted', 'completed'].includes(String(value.state)) &&
      value.acceptedAt === null) ||
    (value.state === 'completed') !== (value.completedAt !== null) ||
    (value.state === 'cancelled') !== (value.cancelledAt !== null) ||
    value.displayState !==
      (value.deletedAt === null ? value.state : 'deleted') ||
    (value.accepter === null) !== (value.acceptedAt === null) ||
    (value.relation === 'accepter' && value.accepter === null)
  )
    invalidErrand();
  const createdAt = value.createdAt;
  for (const key of ['acceptedAt', 'completedAt', 'cancelledAt', 'deletedAt']) {
    const time = value[key];
    if (typeof time === 'string' && before(time, createdAt)) invalidErrand();
  }
  if (typeof value.acceptedAt === 'string') {
    for (const key of ['completedAt', 'cancelledAt'])
      if (
        typeof value[key] === 'string' &&
        before(value[key] as string, value.acceptedAt)
      )
        invalidErrand();
  }
  if (typeof value.deletedAt === 'string') {
    for (const key of ['acceptedAt', 'completedAt', 'cancelledAt'])
      if (
        typeof value[key] === 'string' &&
        before(value.deletedAt, value[key] as string)
      )
        invalidErrand();
  }
  if (value.deletedAt === null) {
    if (value.deletionReason !== null) invalidErrand();
  } else {
    decodeErrandAdminDeletionReason(value.deletionReason);
  }
  const reward = exactErrandReward(value.reward);
  if (reward !== value.reward) invalidErrand();
  return Object.freeze({
    id: value.id,
    revision: value.revision,
    title: responseText(value.title, 50),
    publicText: responseText(value.publicText, 500),
    expectedTimeText: responseText(value.expectedTimeText, 50),
    reward,
    state: value.state as ErrandState,
    displayState: value.displayState as ErrandAdminOrder['displayState'],
    createdAt: value.createdAt,
    acceptedAt: value.acceptedAt as string | null,
    completedAt: value.completedAt as string | null,
    cancelledAt: value.cancelledAt as string | null,
    deletedAt: value.deletedAt as string | null,
    deletionReason:
      value.deletedAt === null
        ? null
        : decodeErrandAdminDeletionReason(value.deletionReason),
    publisher: decodeErrandAdminParticipant(value.publisher),
    accepter:
      value.accepter === null
        ? null
        : decodeErrandAdminParticipant(value.accepter),
    relation: value.relation as ErrandAdminOrder['relation'],
    sourceRegion: region(value.sourceRegion),
    targetRegion: region(value.targetRegion),
  });
}
export function decodeErrandAdminPage(value: unknown): ErrandAdminPage {
  exact(value, ['context', 'items', 'continuation', 'nextCursor', 'total']);
  exact(value.context, [
    'regionId',
    'management',
    'status',
    'keyword',
    'search',
  ]);
  exact(value.context.search, ['matcher', 'legacyNumericReferences']);
  const context = decodeErrandAdminQuery({
    regionId: value.context.regionId,
    status: value.context.status,
    keyword: value.context.keyword,
  });
  if (
    context.keyword !== value.context.keyword ||
    !['fixed', 'global'].includes(String(value.context.management)) ||
    value.context.search.legacyNumericReferences !== 'unavailable' ||
    value.context.search.matcher !== 'public-text-name-uuid-v1' ||
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    !['more', 'end'].includes(String(value.continuation)) ||
    (value.nextCursor !== null && !errandCursor(value.nextCursor)) ||
    (value.continuation === 'end') !== (value.nextCursor === null)
  )
    invalidErrand();
  const items = value.items.map(decodeErrandAdminOrder);
  if (
    new Set(items.map((item) => item.id)).size !== items.length ||
    items.some(
      (item) =>
        item.targetRegion.id !== context.regionId ||
        (context.status !== 'all' && item.displayState !== context.status),
    )
  )
    invalidErrand();
  if (!isRecord(value.total)) invalidErrand();
  let total: ErrandAdminTotal;
  if (value.total.status === 'known') {
    exact(value.total, ['status', 'value']);
    if (
      typeof value.total.value !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(value.total.value) ||
      (value.total.value.length <= 2 &&
        Number(value.total.value) < items.length) ||
      /^[0-9]+$/.test(context.keyword)
    )
      invalidErrand();
    total = Object.freeze({ status: 'known', value: value.total.value });
  } else {
    exact(value.total, ['status']);
    if (value.total.status !== 'unavailable') invalidErrand();
    total = Object.freeze({ status: 'unavailable' });
  }
  return Object.freeze({
    context: Object.freeze({
      ...context,
      management: value.context.management as 'fixed' | 'global',
      search: Object.freeze({
        matcher: 'public-text-name-uuid-v1',
        legacyNumericReferences: 'unavailable',
      }),
    }),
    items: Object.freeze(items),
    continuation: value.continuation as 'more' | 'end',
    nextCursor: value.nextCursor as string | null,
    total,
  });
}
export function matchErrandAdminPage(
  page: ErrandAdminPage,
  query: ErrandAdminQuery,
  cursor: string | null,
  limit = 20,
): void {
  if (
    page.context.regionId !== query.regionId ||
    page.context.status !== query.status ||
    page.context.keyword !== query.keyword ||
    page.items.length > limit ||
    (page.nextCursor !== null && page.nextCursor === cursor)
  )
    invalidErrand();
}
