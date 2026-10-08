import { ClientError, isRecord } from '../api/errors';
import { exact } from '../community/contract';
import { isUuid } from '../profile/contract';
export const activityUuid = (value: unknown): value is string =>
  isUuid(value) && value === value.toLowerCase();
export const activityCursor = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
export function invalidActivity(): never {
  throw new ClientError('protocol', 'Invalid activity response');
}
export function activityText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 200000 &&
    !Array.from(value).some((character) =>
      [0, 11, 12].includes(character.codePointAt(0)!),
    ) &&
    !/[\uD800-\uDFFF]/u.test(value)
  );
}
export function activityTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,6})?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
      value,
    );
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]);
  const days = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
}
export type ActivityFact<T> =
  | { readonly status: 'known'; readonly value: T }
  | { readonly status: 'unavailable'; readonly value: null };
export interface ActivityMedia {
  readonly status: 'absent' | 'unavailable';
}
export interface ActivityContext {
  readonly regionId: string;
  readonly visitHistory: 'never_visited' | 'visited' | 'unavailable';
}
export type ActivityWindow = 'entry' | 'all';
export type ActivitySelection =
  | { readonly kind: 'all' }
  | { readonly kind: 'recent'; readonly since: string }
  | { readonly kind: 'historical'; readonly maximum: 10 };
export interface ActivitySummary {
  readonly id: string;
  readonly revision: string;
  readonly title: string;
  readonly organizerLabel: string;
  readonly reward: ActivityFact<boolean>;
  readonly online: ActivityFact<'online' | 'offline'>;
  readonly createdAt: ActivityFact<string>;
  readonly cover: ActivityMedia;
  readonly organizerAvatar: ActivityMedia;
}
export interface ActivityDetail extends ActivitySummary {
  readonly regionId: string;
  readonly bodyText: string;
  readonly activityTime: string | null;
  readonly activityLocation: string | null;
  readonly gallery:
    | { readonly status: 'known_empty'; readonly items: readonly [] }
    | { readonly status: 'unavailable'; readonly items: null };
  readonly organizerQr: ActivityMedia;
}
export interface ActivityPage {
  readonly context: {
    readonly regionId: string;
    readonly catalogRevision: string;
  };
  readonly selection: ActivitySelection;
  readonly items: readonly ActivitySummary[];
  readonly continuation: 'more' | 'end';
  readonly nextCursor: string | null;
  readonly pageCursor: string;
}
export interface ActivityVisitIntent {
  readonly requestId: string;
  readonly regionId: string;
  readonly expectedCatalogRevision: string;
}
export interface ActivityVisitReceipt {
  readonly requestId: string;
  readonly regionId: string;
  readonly catalogRevision: string;
  readonly visitedAt: string;
}
function media(value: unknown): ActivityMedia {
  exact(value, ['status']);
  if (value.status !== 'absent' && value.status !== 'unavailable')
    invalidActivity();
  return Object.freeze({ status: value.status });
}
function fact<T>(
  value: unknown,
  valid: (value: unknown) => value is T,
): ActivityFact<T> {
  exact(value, ['status', 'value']);
  if (value.status === 'known' && valid(value.value))
    return Object.freeze({ status: 'known', value: value.value });
  if (value.status === 'unavailable' && value.value === null)
    return Object.freeze({ status: 'unavailable', value: null });
  return invalidActivity();
}
const summaryKeys = [
  'id',
  'revision',
  'title',
  'organizerLabel',
  'reward',
  'online',
  'createdAt',
  'cover',
  'organizerAvatar',
];
function summary(value: Record<string, unknown>): ActivitySummary {
  if (
    !activityUuid(value.id) ||
    !activityUuid(value.revision) ||
    !activityText(value.title) ||
    !activityText(value.organizerLabel)
  )
    invalidActivity();
  return Object.freeze({
    id: value.id,
    revision: value.revision,
    title: value.title,
    organizerLabel: value.organizerLabel,
    reward: fact(value.reward, (v): v is boolean => typeof v === 'boolean'),
    online: fact(
      value.online,
      (v): v is 'online' | 'offline' => v === 'online' || v === 'offline',
    ),
    createdAt: fact(value.createdAt, activityTimestamp),
    cover: media(value.cover),
    organizerAvatar: media(value.organizerAvatar),
  });
}
export function decodeActivityContext(value: unknown): ActivityContext {
  exact(value, ['regionId', 'visitHistory']);
  if (
    !activityUuid(value.regionId) ||
    !['never_visited', 'visited', 'unavailable'].includes(
      value.visitHistory as string,
    )
  )
    invalidActivity();
  return Object.freeze({
    regionId: value.regionId,
    visitHistory: value.visitHistory as ActivityContext['visitHistory'],
  });
}
export function decodeActivitySummary(value: unknown): ActivitySummary {
  exact(value, summaryKeys);
  return summary(value);
}
export function decodeActivityDetail(value: unknown): ActivityDetail {
  exact(value, [
    ...summaryKeys,
    'regionId',
    'bodyText',
    'activityTime',
    'activityLocation',
    'gallery',
    'organizerQr',
  ]);
  if (
    !activityUuid(value.regionId) ||
    !activityText(value.bodyText) ||
    (value.activityTime !== null && !activityText(value.activityTime)) ||
    (value.activityLocation !== null && !activityText(value.activityLocation))
  )
    invalidActivity();
  exact(value.gallery, ['status', 'items']);
  if (
    value.gallery.status === 'known_empty'
      ? !Array.isArray(value.gallery.items) || value.gallery.items.length !== 0
      : value.gallery.status !== 'unavailable' || value.gallery.items !== null
  )
    invalidActivity();
  return Object.freeze({
    ...summary(value),
    regionId: value.regionId,
    bodyText: value.bodyText,
    activityTime: value.activityTime,
    activityLocation: value.activityLocation,
    gallery:
      value.gallery.status === 'known_empty'
        ? Object.freeze({
            status: 'known_empty',
            items: Object.freeze([]) as readonly [],
          })
        : Object.freeze({ status: 'unavailable', items: null }),
    organizerQr: media(value.organizerQr),
  });
}
export function decodeActivitySelection(value: unknown): ActivitySelection {
  if (!isRecord(value)) invalidActivity();
  if (value.kind === 'all') {
    exact(value, ['kind']);
    return Object.freeze({ kind: 'all' });
  }
  if (value.kind === 'recent') {
    exact(value, ['kind', 'since']);
    if (!activityTimestamp(value.since)) invalidActivity();
    return Object.freeze({ kind: 'recent', since: value.since });
  }
  exact(value, ['kind', 'maximum']);
  if (value.kind !== 'historical' || value.maximum !== 10) invalidActivity();
  return Object.freeze({ kind: 'historical', maximum: 10 });
}
export function decodeActivityPage(value: unknown): ActivityPage {
  exact(value, [
    'context',
    'selection',
    'items',
    'continuation',
    'nextCursor',
    'pageCursor',
  ]);
  exact(value.context, ['regionId', 'catalogRevision']);
  if (
    !activityCursor(value.pageCursor) ||
    !activityUuid(value.context.regionId) ||
    !activityUuid(value.context.catalogRevision) ||
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    (value.continuation === 'end'
      ? value.nextCursor !== null
      : value.continuation !== 'more' ||
        !activityCursor(value.nextCursor) ||
        value.items.length === 0)
  )
    invalidActivity();
  const selection = decodeActivitySelection(value.selection),
    items = value.items.map(decodeActivitySummary);
  if (
    new Set(items.map((item) => item.id)).size !== items.length ||
    (selection.kind === 'historical' && items.length > 10)
  )
    invalidActivity();
  return Object.freeze({
    context: Object.freeze({
      regionId: value.context.regionId,
      catalogRevision: value.context.catalogRevision,
    }),
    selection,
    items: Object.freeze(items),
    continuation: value.continuation as 'more' | 'end',
    nextCursor: value.nextCursor as string | null,
    pageCursor: value.pageCursor as string,
  });
}
export function decodeActivityVisitIntent(value: unknown): ActivityVisitIntent {
  exact(value, ['requestId', 'regionId', 'expectedCatalogRevision']);
  if (
    !activityUuid(value.requestId) ||
    !activityUuid(value.regionId) ||
    !activityUuid(value.expectedCatalogRevision)
  )
    invalidActivity();
  return Object.freeze({
    requestId: value.requestId,
    regionId: value.regionId,
    expectedCatalogRevision: value.expectedCatalogRevision,
  });
}
export function decodeActivityVisitReceipt(
  value: unknown,
): ActivityVisitReceipt {
  exact(value, ['requestId', 'regionId', 'catalogRevision', 'visitedAt']);
  if (
    !activityUuid(value.requestId) ||
    !activityUuid(value.regionId) ||
    !activityUuid(value.catalogRevision) ||
    !activityTimestamp(value.visitedAt)
  )
    invalidActivity();
  return Object.freeze({
    requestId: value.requestId,
    regionId: value.regionId,
    catalogRevision: value.catalogRevision,
    visitedAt: value.visitedAt,
  });
}
export function matchActivityVisit(
  intent: ActivityVisitIntent,
  receipt: ActivityVisitReceipt,
): void {
  if (
    intent.requestId !== receipt.requestId ||
    intent.regionId !== receipt.regionId ||
    intent.expectedCatalogRevision !== receipt.catalogRevision
  )
    invalidActivity();
}
