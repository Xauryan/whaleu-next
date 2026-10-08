import { ClientError, isRecord } from '../api/errors';
import { exact } from '../community/contract';
import { isUuid } from '../profile/contract';

export interface AnnouncementContext {
  readonly campusId: string | null;
}
export type AnnouncementMedia =
  | { readonly status: 'known_empty'; readonly items: readonly [] }
  | { readonly status: 'unavailable'; readonly items: null };
export interface AnnouncementSummary {
  readonly id: string;
  readonly revision: string;
  readonly versionLabel: string;
  readonly title: string;
  readonly announcementDate: string | null;
  readonly createdAt: string | null;
  readonly highlight: boolean;
  readonly isLatest: boolean;
  readonly popupEnabled: boolean;
}
export interface AnnouncementDetail extends AnnouncementSummary {
  readonly bodyText: string;
  readonly updatedAt: string | null;
  readonly media: AnnouncementMedia;
}
export interface AnnouncementPopup {
  readonly id: string;
  readonly revision: string;
  readonly versionLabel: string;
  readonly title: string;
  readonly announcementDate: string | null;
  readonly bodyText: string;
  readonly media: AnnouncementMedia;
}
export interface AnnouncementPage {
  readonly context: AnnouncementContext;
  readonly items: readonly AnnouncementSummary[];
  readonly continuation: 'more' | 'end';
  readonly nextCursor: string | null;
}
export interface AnnouncementPublicPopup {
  readonly context: AnnouncementContext;
  readonly popup: AnnouncementPopup | null;
}
export type AnnouncementAcknowledgement =
  | { readonly status: 'unseen' | 'unavailable'; readonly acknowledgedAt: null }
  | { readonly status: 'acknowledged'; readonly acknowledgedAt: string | null };
export type AnnouncementOwnerPopup =
  | { readonly context: AnnouncementContext; readonly candidate: null }
  | {
      readonly context: AnnouncementContext;
      readonly candidate: AnnouncementPopup;
      readonly acknowledgement: AnnouncementAcknowledgement;
    };
export interface AnnouncementReceipt {
  readonly announcementId: string;
  readonly acknowledgement: {
    readonly status: 'acknowledged';
    readonly acknowledgedAt: string | null;
  };
}
export interface AnnouncementChanges {
  readonly context: AnnouncementContext;
  readonly since: string;
  readonly checkedAt: string;
  readonly newness:
    | {
        readonly status: 'available';
        readonly hasNew: boolean;
        readonly newCount: string;
      }
    | {
        readonly status: 'unavailable';
        readonly hasNew: null;
        readonly newCount: null;
      };
}
export function invalidAnnouncement(): never {
  throw new ClientError('protocol', 'Invalid announcement data');
}
export const announcementUuid = isUuid;
export const announcementCursor = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
export function announcementCampus(
  value: unknown,
): asserts value is string | null {
  if (value !== null && !announcementUuid(value)) invalidAnnouncement();
}
export function announcementTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.[0-9]{1,6})?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (
    !match ||
    !date(match[1]) ||
    Number(match[2]) > 23 ||
    Number(match[3]) > 59 ||
    Number(match[4]) > 59
  )
    return false;
  const offset = match[5]!;
  return (
    (offset === 'Z' ||
      (Number(offset.slice(1, 3)) <= 23 && Number(offset.slice(4)) <= 59)) &&
    Number.isFinite(Date.parse(value))
  );
}
const timestamp = announcementTimestamp;
function date(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}
function context(value: unknown): AnnouncementContext {
  exact(value, ['campusId']);
  announcementCampus(value.campusId);
  return Object.freeze({ campusId: value.campusId });
}
function media(value: unknown): AnnouncementMedia {
  exact(value, ['status', 'items']);
  if (value.status === 'known_empty') {
    if (!Array.isArray(value.items) || value.items.length !== 0)
      invalidAnnouncement();
    return Object.freeze({
      status: 'known_empty',
      items: Object.freeze([]) as readonly [],
    });
  }
  if (value.status !== 'unavailable' || value.items !== null)
    invalidAnnouncement();
  return Object.freeze({ status: 'unavailable', items: null });
}
const text = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 200000 &&
  ![...value].some((character) => {
    const code = character.codePointAt(0)!;
    return (
      code === 0 ||
      code === 11 ||
      code === 12 ||
      (code >= 0xd800 && code <= 0xdfff)
    );
  });
const summaryKeys = [
  'id',
  'revision',
  'versionLabel',
  'title',
  'announcementDate',
  'createdAt',
  'highlight',
  'isLatest',
  'popupEnabled',
] as const;
function summary(value: Record<string, unknown>): AnnouncementSummary {
  if (
    !announcementUuid(value.id) ||
    !announcementUuid(value.revision) ||
    !text(value.versionLabel) ||
    !text(value.title) ||
    !date(value.announcementDate) ||
    (value.createdAt !== null && !timestamp(value.createdAt)) ||
    typeof value.highlight !== 'boolean' ||
    typeof value.isLatest !== 'boolean' ||
    typeof value.popupEnabled !== 'boolean'
  )
    invalidAnnouncement();
  return Object.freeze({
    id: value.id,
    revision: value.revision,
    versionLabel: value.versionLabel,
    title: value.title,
    announcementDate: value.announcementDate,
    createdAt: value.createdAt as string | null,
    highlight: value.highlight,
    isLatest: value.isLatest,
    popupEnabled: value.popupEnabled,
  });
}
export function decodeAnnouncementSummary(value: unknown): AnnouncementSummary {
  exact(value, summaryKeys);
  return summary(value);
}
export function decodeAnnouncementDetail(value: unknown): AnnouncementDetail {
  exact(value, [...summaryKeys, 'bodyText', 'updatedAt', 'media']);
  if (
    !text(value.bodyText) ||
    (value.updatedAt !== null && !timestamp(value.updatedAt))
  )
    invalidAnnouncement();
  return Object.freeze({
    ...summary(value),
    bodyText: value.bodyText,
    updatedAt: value.updatedAt as string | null,
    media: media(value.media),
  });
}
export function decodeAnnouncementPopup(value: unknown): AnnouncementPopup {
  exact(value, [
    'id',
    'revision',
    'versionLabel',
    'title',
    'announcementDate',
    'bodyText',
    'media',
  ]);
  if (
    !announcementUuid(value.id) ||
    !announcementUuid(value.revision) ||
    !text(value.versionLabel) ||
    !text(value.title) ||
    !text(value.bodyText) ||
    !date(value.announcementDate)
  )
    invalidAnnouncement();
  return Object.freeze({
    id: value.id,
    revision: value.revision,
    versionLabel: value.versionLabel,
    title: value.title,
    announcementDate: value.announcementDate,
    bodyText: value.bodyText,
    media: media(value.media),
  });
}
export function decodeAnnouncementPage(value: unknown): AnnouncementPage {
  exact(value, ['context', 'items', 'continuation', 'nextCursor']);
  if (
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    (value.continuation === 'end'
      ? value.nextCursor !== null
      : value.continuation !== 'more' ||
        !announcementCursor(value.nextCursor) ||
        !value.items.length)
  )
    invalidAnnouncement();
  const items = value.items.map(decodeAnnouncementSummary);
  if (
    new Set(items.map((item) => item.id)).size !== items.length ||
    items.filter((item) => item.isLatest).length > 1 ||
    items.some((item, index) => item.isLatest && index !== 0)
  )
    invalidAnnouncement();
  return Object.freeze({
    context: context(value.context),
    items: Object.freeze(items),
    continuation: value.continuation as 'more' | 'end',
    nextCursor: value.nextCursor as string | null,
  });
}
export function decodeAnnouncementPublicPopup(
  value: unknown,
): AnnouncementPublicPopup {
  exact(value, ['context', 'popup']);
  return Object.freeze({
    context: context(value.context),
    popup: value.popup === null ? null : decodeAnnouncementPopup(value.popup),
  });
}
function acknowledgement(value: unknown): AnnouncementAcknowledgement {
  exact(value, ['status', 'acknowledgedAt']);
  if (value.status === 'acknowledged') {
    if (value.acknowledgedAt !== null && !timestamp(value.acknowledgedAt))
      invalidAnnouncement();
    return Object.freeze({
      status: 'acknowledged',
      acknowledgedAt: value.acknowledgedAt as string | null,
    });
  }
  if (
    (value.status !== 'unseen' && value.status !== 'unavailable') ||
    value.acknowledgedAt !== null
  )
    invalidAnnouncement();
  return Object.freeze({ status: value.status, acknowledgedAt: null });
}
export function decodeAnnouncementOwnerPopup(
  value: unknown,
): AnnouncementOwnerPopup {
  if (!isRecord(value)) invalidAnnouncement();
  exact(
    value,
    value.candidate === null
      ? ['context', 'candidate']
      : ['context', 'candidate', 'acknowledgement'],
  );
  const selected = context(value.context);
  return value.candidate === null
    ? Object.freeze({ context: selected, candidate: null })
    : Object.freeze({
        context: selected,
        candidate: decodeAnnouncementPopup(value.candidate),
        acknowledgement: acknowledgement(value.acknowledgement),
      });
}
export function decodeAnnouncementReceipt(value: unknown): AnnouncementReceipt {
  exact(value, ['announcementId', 'acknowledgement']);
  const ack = acknowledgement(value.acknowledgement);
  if (!announcementUuid(value.announcementId) || ack.status !== 'acknowledged')
    invalidAnnouncement();
  return Object.freeze({
    announcementId: value.announcementId,
    acknowledgement: ack,
  });
}
export function decodeAnnouncementChanges(value: unknown): AnnouncementChanges {
  exact(value, ['context', 'since', 'checkedAt', 'newness']);
  exact(value.newness, ['status', 'hasNew', 'newCount']);
  if (!timestamp(value.since) || !timestamp(value.checkedAt))
    invalidAnnouncement();
  const n = value.newness;
  if (
    n.status === 'available'
      ? typeof n.newCount !== 'string' ||
        !/^(0|[1-9][0-9]*)$/.test(n.newCount) ||
        n.hasNew !== (n.newCount !== '0')
      : n.status !== 'unavailable' || n.newCount !== null || n.hasNew !== null
  )
    invalidAnnouncement();
  return Object.freeze({
    context: context(value.context),
    since: value.since,
    checkedAt: value.checkedAt,
    newness: Object.freeze({ ...n }) as AnnouncementChanges['newness'],
  });
}
