import { sha256 } from 'js-sha256';
import { ClientError } from '../../api/errors';
import { exact } from '../../community/contract';
import { canonicalOrganizationJson } from '../../organizations/contract';
import {
  activityMediaUuid,
  activityMediaRevision,
  activityMediaSlot,
  activityMediaSlots,
} from '../media-validation';
import type { ActivityMediaSlot } from '../media-validation';
export const activityId = activityMediaUuid;
export const activityRevision = activityMediaRevision;
export function invalidActivityPublication(): never {
  throw new ClientError('protocol', '活动发布数据不可用');
}
export function activityKey(v: unknown) {
  const s = activityId(v);
  if (s[14] !== '4') invalidActivityPublication();
  return s;
}
export function activityDigest(v: unknown) {
  if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v))
    invalidActivityPublication();
  return v;
}
function text(v: unknown, max: number) {
  if (
    typeof v !== 'string' ||
    Array.from(v).length > max ||
    Array.from(v).some((c) => {
      const n = c.codePointAt(0)!;
      return (
        (n < 32 && n !== 10) ||
        (n >= 127 && n <= 159) ||
        (n >= 0xd800 && n <= 0xdfff) ||
        (n >= 0x202a && n <= 0x202e) ||
        (n >= 0x2066 && n <= 0x2069)
      );
    })
  )
    invalidActivityPublication();
  return v;
}
export type ActivityType = 'reward' | 'online' | 'offline';
export interface ActivityContent {
  title: string;
  description: string;
  types: ActivityType[];
  activityTime: string;
  activityLocation: string;
  endAt: string | null;
  showOrganizerQr: boolean;
}
export type ActivityBindings = Partial<
  Record<ActivityMediaSlot, string | null>
>;
export type ActivityChanges = Partial<
  Record<
    ActivityMediaSlot,
    { action: 'keep' | 'remove' } | { action: 'replace'; assetId: string }
  >
>;
export interface ActivityOrganizer {
  source: 'managed';
  organizationId: string;
  revision: number;
  name: string;
  kind: 'school' | 'org' | 'official';
  role: 'organization_owner' | 'organization_admin';
}
export type ActivityCommand = {
  clientRequestId: string;
  expectedRevision: number;
} & (
  | {
      action: 'create';
      organization: { source: 'managed'; organizationId: string };
      organizationRevision: number;
      content: ActivityContent;
    }
  | { action: 'save'; content: ActivityContent; mediaChanges: ActivityChanges }
  | { action: 'publish' | 'cancel_draft' }
);
export interface ActivityReceipt {
  requestId: string;
  requestHash: string;
  activityId: string;
  revision: number;
  outcome: 'created' | 'saved' | 'published' | 'draft_cancelled';
}
export type ActivityRecovery =
  | { state: 'not_recorded'; requestId: string }
  | { state: 'cancelled'; requestId: string; requestHash: string }
  | {
      state: 'pending';
      requestId: string;
      requestHash: string;
      review: 'pending' | 'ready' | 'rejected' | 'unavailable';
    }
  | { state: 'recorded'; requestId: string; receipt: ActivityReceipt };
export interface ActivityDraft {
  source: 'native';
  id: string;
  regionId: string;
  organization: { source: 'managed'; organizationId: string };
  organizationRevision: number;
  revision: number;
  state: 'draft' | 'published' | 'cancelled';
  content: ActivityContent;
  mediaBindings: ActivityBindings;
}
export interface NativeActivity {
  source: 'native';
  id: string;
  regionId: string;
  revision: number;
  organization: { source: 'managed'; organizationId: string };
  organizerLabel: string;
  content: ActivityContent;
  mediaBindings: ActivityBindings;
  createdAt: string;
  organizerQr:
    | { status: 'disabled' | 'unavailable' }
    | {
        status: 'available';
        organizationId: string;
        applicationRevision: number;
        slot: 'mainQr';
        bindingId: string;
      };
}
export interface ActivityNativePage {
  source: 'native';
  regionId: string;
  items: NativeActivity[];
  nextCursor: string | null;
}
export const emptyActivityContent = (): ActivityContent => ({
  title: '',
  description: '',
  types: [],
  activityTime: '',
  activityLocation: '',
  endAt: null,
  showOrganizerQr: false,
});
export function decodeActivityContent(v: unknown): ActivityContent {
  exact(v, [
    'title',
    'description',
    'types',
    'activityTime',
    'activityLocation',
    'endAt',
    'showOrganizerQr',
  ]);
  if (
    !Array.isArray(v.types) ||
    v.types.length > 3 ||
    v.types.some((t) => !['reward', 'online', 'offline'].includes(String(t))) ||
    new Set(v.types).size !== v.types.length ||
    typeof v.showOrganizerQr !== 'boolean' ||
    (v.endAt !== null &&
      (typeof v.endAt !== 'string' ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(
          v.endAt,
        ) ||
        !Number.isFinite(Date.parse(v.endAt))))
  )
    invalidActivityPublication();
  return {
    title: text(v.title, 50),
    description: text(v.description, 1000),
    types: [...v.types] as ActivityType[],
    activityTime: text(v.activityTime, 200),
    activityLocation: text(v.activityLocation, 200),
    endAt: v.endAt as string | null,
    showOrganizerQr: v.showOrganizerQr,
  };
}
export function decodeActivityBindings(v: unknown): ActivityBindings {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    invalidActivityPublication();
  const result: ActivityBindings = {};
  for (const [k, value] of Object.entries(v)) {
    const slot = activityMediaSlot(k);
    result[slot] = value === null ? null : activityId(value);
  }
  const ids = Object.values(result).filter(Boolean);
  if (new Set(ids).size !== ids.length) invalidActivityPublication();
  return result;
}
export function decodeActivityChanges(v: unknown): ActivityChanges {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    invalidActivityPublication();
  const result: ActivityChanges = {};
  for (const [k, value] of Object.entries(v)) {
    const slot = activityMediaSlot(k);
    if (!value || typeof value !== 'object' || !('action' in value))
      invalidActivityPublication();
    if (value.action === 'replace') {
      exact(value, ['action', 'assetId']);
      result[slot] = { action: 'replace', assetId: activityId(value.assetId) };
    } else {
      exact(value, ['action']);
      if (value.action !== 'keep' && value.action !== 'remove')
        invalidActivityPublication();
      result[slot] = { action: value.action };
    }
  }
  return result;
}
function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    invalidActivityPublication();
  return v as Record<string, unknown>;
}
function organization(v: unknown) {
  exact(v, ['source', 'organizationId']);
  if (v.source !== 'managed') invalidActivityPublication();
  return {
    source: 'managed' as const,
    organizationId: activityId(v.organizationId),
  };
}
export function decodeActivityCommand(raw: unknown): ActivityCommand {
  const v = record(raw);
  if (!v || typeof v !== 'object' || !('action' in v))
    invalidActivityPublication();
  if (v.action === 'create') {
    exact(v, [
      'action',
      'clientRequestId',
      'expectedRevision',
      'organization',
      'organizationRevision',
      'content',
    ]);
    if (v.expectedRevision !== 0) invalidActivityPublication();
    return {
      action: 'create',
      clientRequestId: activityKey(v.clientRequestId),
      expectedRevision: 0,
      organization: organization(v.organization),
      organizationRevision: activityRevision(v.organizationRevision),
      content: decodeActivityContent(v.content),
    };
  }
  if (v.action === 'save') {
    exact(v, [
      'action',
      'clientRequestId',
      'expectedRevision',
      'content',
      'mediaChanges',
    ]);
    return {
      action: 'save',
      clientRequestId: activityKey(v.clientRequestId),
      expectedRevision: activityRevision(v.expectedRevision),
      content: decodeActivityContent(v.content),
      mediaChanges: decodeActivityChanges(v.mediaChanges),
    };
  }
  exact(v, ['action', 'clientRequestId', 'expectedRevision']);
  if (v.action !== 'publish' && v.action !== 'cancel_draft')
    invalidActivityPublication();
  return {
    action: v.action,
    clientRequestId: activityKey(v.clientRequestId),
    expectedRevision: activityRevision(v.expectedRevision),
  };
}
export function activityCommandHash(
  actor: string,
  id: string,
  command: ActivityCommand,
) {
  return sha256(
    'whaleu-activity-command:v1\n' +
      canonicalOrganizationJson({
        actorId: activityId(actor),
        activityId: activityId(id),
        command: decodeActivityCommand(command),
      }),
  );
}
export function decodeActivityReceipt(v: unknown): ActivityReceipt {
  exact(v, ['requestId', 'requestHash', 'activityId', 'revision', 'outcome']);
  if (
    !['created', 'saved', 'published', 'draft_cancelled'].includes(
      String(v.outcome),
    )
  )
    invalidActivityPublication();
  return {
    requestId: activityKey(v.requestId),
    requestHash: activityDigest(v.requestHash),
    activityId: activityId(v.activityId),
    revision: activityRevision(v.revision),
    outcome: v.outcome as ActivityReceipt['outcome'],
  };
}
export function decodeActivityRecovery(raw: unknown): ActivityRecovery {
  const v = record(raw);
  if (!v || typeof v !== 'object' || !('state' in v))
    invalidActivityPublication();
  if (v.state === 'recorded') {
    exact(v, ['state', 'requestId', 'receipt']);
    const receipt = decodeActivityReceipt(v.receipt);
    if (receipt.requestId !== v.requestId) invalidActivityPublication();
    return { state: 'recorded', requestId: activityKey(v.requestId), receipt };
  }
  if (v.state === 'cancelled') {
    exact(v, ['state', 'requestId', 'requestHash']);
    return {
      state: 'cancelled',
      requestId: activityKey(v.requestId),
      requestHash: activityDigest(v.requestHash),
    };
  }
  if (v.state === 'pending') {
    exact(v, ['state', 'requestId', 'requestHash', 'review']);
    if (
      !['pending', 'ready', 'rejected', 'unavailable'].includes(
        String(v.review),
      )
    )
      invalidActivityPublication();
    return {
      state: 'pending',
      requestId: activityKey(v.requestId),
      requestHash: activityDigest(v.requestHash),
      review: v.review as 'pending' | 'ready' | 'rejected' | 'unavailable',
    };
  }
  exact(v, ['state', 'requestId']);
  if (v.state !== 'not_recorded') invalidActivityPublication();
  return { state: 'not_recorded', requestId: activityKey(v.requestId) };
}
export function decodeActivityResult(v: unknown) {
  return v && typeof v === 'object' && 'state' in v
    ? decodeActivityRecovery(v)
    : decodeActivityReceipt(v);
}
export function decodeActivityDraft(v: unknown): ActivityDraft {
  exact(v, [
    'source',
    'id',
    'regionId',
    'organization',
    'organizationRevision',
    'revision',
    'state',
    'content',
    'mediaBindings',
  ]);
  if (
    v.source !== 'native' ||
    !['draft', 'published', 'cancelled'].includes(String(v.state))
  )
    invalidActivityPublication();
  return {
    source: 'native',
    id: activityId(v.id),
    regionId: activityId(v.regionId),
    organization: organization(v.organization),
    organizationRevision: activityRevision(v.organizationRevision),
    revision: activityRevision(v.revision),
    state: v.state as ActivityDraft['state'],
    content: decodeActivityContent(v.content),
    mediaBindings: decodeActivityBindings(v.mediaBindings),
  };
}
export function decodeActivityOrganizer(v: unknown): ActivityOrganizer {
  exact(v, ['source', 'organizationId', 'revision', 'name', 'kind', 'role']);
  if (
    v.source !== 'managed' ||
    !['school', 'org', 'official'].includes(String(v.kind)) ||
    !['organization_owner', 'organization_admin'].includes(String(v.role))
  )
    invalidActivityPublication();
  return {
    source: 'managed',
    organizationId: activityId(v.organizationId),
    revision: activityRevision(v.revision),
    name: text(v.name, 10),
    kind: v.kind as ActivityOrganizer['kind'],
    role: v.role as ActivityOrganizer['role'],
  };
}
export function activityCursor(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(v))
    invalidActivityPublication();
  return v;
}
export function decodeActivityOrganizers(v: unknown) {
  exact(v, ['regionId', 'items', 'nextCursor']);
  if (!Array.isArray(v.items) || v.items.length > 20)
    invalidActivityPublication();
  const items = v.items.map(decodeActivityOrganizer);
  if (new Set(items.map((i) => i.organizationId)).size !== items.length)
    invalidActivityPublication();
  return {
    regionId: activityId(v.regionId),
    items,
    nextCursor: activityCursor(v.nextCursor),
  };
}
export function decodeNativeActivity(v: unknown): NativeActivity {
  exact(v, [
    'source',
    'id',
    'regionId',
    'revision',
    'organization',
    'organizerLabel',
    'content',
    'mediaBindings',
    'createdAt',
    'organizerQr',
  ]);
  if (
    v.source !== 'native' ||
    typeof v.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(v.createdAt))
  )
    invalidActivityPublication();
  const content = decodeActivityContent(v.content),
    bindings = decodeActivityBindings(v.mediaBindings),
    qr = record(v.organizerQr);
  if (
    !bindings.cover ||
    !content.title.trim() ||
    !content.types.length ||
    !qr ||
    typeof qr !== 'object' ||
    !('status' in qr)
  )
    invalidActivityPublication();
  let organizerQr: NativeActivity['organizerQr'];
  if (qr.status === 'available') {
    exact(qr, [
      'status',
      'organizationId',
      'applicationRevision',
      'slot',
      'bindingId',
    ]);
    if (qr.slot !== 'mainQr' || !content.showOrganizerQr)
      invalidActivityPublication();
    organizerQr = {
      status: 'available',
      organizationId: activityId(qr.organizationId),
      applicationRevision: activityRevision(qr.applicationRevision),
      slot: 'mainQr',
      bindingId: activityId(qr.bindingId),
    };
  } else {
    exact(qr, ['status']);
    if (
      !['disabled', 'unavailable'].includes(String(qr.status)) ||
      (qr.status === 'disabled') === content.showOrganizerQr
    )
      invalidActivityPublication();
    organizerQr = { status: qr.status as 'disabled' | 'unavailable' };
  }
  return {
    source: 'native',
    id: activityId(v.id),
    regionId: activityId(v.regionId),
    revision: activityRevision(v.revision),
    organization: organization(v.organization),
    organizerLabel: text(v.organizerLabel, 10),
    content,
    mediaBindings: bindings,
    createdAt: v.createdAt,
    organizerQr,
  };
}
export function decodeNativeActivityPage(v: unknown): ActivityNativePage {
  exact(v, ['source', 'regionId', 'items', 'nextCursor']);
  if (v.source !== 'native' || !Array.isArray(v.items) || v.items.length > 20)
    invalidActivityPublication();
  const regionId = activityId(v.regionId),
    items = v.items.map(decodeNativeActivity);
  if (
    new Set(items.map((i) => i.id)).size !== items.length ||
    items.some((i) => i.regionId !== regionId)
  )
    invalidActivityPublication();
  return {
    source: 'native',
    regionId,
    items,
    nextCursor: activityCursor(v.nextCursor),
  };
}
export const activitySlotLabels = Object.fromEntries(
  activityMediaSlots.map((s) => [
    s,
    s === 'cover' ? '活动封面（必填）' : `详情图 ${Number(s.slice(7)) + 1}`,
  ]),
) as Record<ActivityMediaSlot, string>;
