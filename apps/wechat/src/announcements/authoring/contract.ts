import { ClientError } from '../../api/errors';
import { sha256 } from 'js-sha256';
import { exact } from '../../community/contract';
import { canonicalOrganizationJson } from '../../organizations/contract';
import {
  activityId as id,
  activityKey as key,
  activityRevision as revision,
  activityDigest as digest,
  invalidActivityPublication as invalid,
} from '../../activities/publication/contract';
export { id, key, revision, digest };
export const slots = [
  'gallery0',
  'gallery1',
  'gallery2',
  'gallery3',
  'gallery4',
  'gallery5',
  'gallery6',
  'gallery7',
  'gallery8',
] as const;
export type Slot = (typeof slots)[number];
export type Bindings = Partial<Record<Slot, string | null>>;
export type Changes = Partial<
  Record<
    Slot,
    { action: 'keep' | 'remove' } | { action: 'replace'; assetId: string }
  >
>;
export interface ContentInput {
  versionLabel: string;
  bodyText: string;
  announcementDate: string | null;
  popupEnabled: boolean;
  highlight: boolean;
  popupTitle: string | null;
  popupBodyText: string | null;
}
export type Content = ContentInput & { title: string; type: 'minor' };
export type AudienceInput =
  | { kind: 'fixed' }
  | { kind: 'all' }
  | { kind: 'regions'; regionIds: string[] };
export type Audience = {
  kind: 'all' | 'regions';
  regionIds: string[];
  campusIds: string[];
};
export type Command = { clientRequestId: string; expectedRevision: number } & (
  | { action: 'create'; content: ContentInput; audience: AudienceInput }
  | {
      action: 'save' | 'update';
      content: ContentInput;
      audience: AudienceInput;
      mediaChanges: Changes;
    }
  | { action: 'publish' | 'cancel_draft' }
  | { action: 'set_enabled'; enabled: boolean }
);
export type Receipt = {
  requestId: string;
  requestHash: string;
  announcementId: string;
  revision: number;
  outcome: Command['action'];
};
export type Recovery =
  | { state: 'not_recorded'; requestId: string }
  | { state: 'recorded'; requestId: string; receipt: Receipt }
  | { state: 'cancelled'; requestId: string; requestHash: string };
export interface Managed {
  source: 'native';
  id: string;
  revision: number;
  revisionId: string;
  state: 'draft' | 'active' | 'inactive' | 'cancelled';
  content: Content;
  audience: Audience;
  mediaBindings: Bindings;
  createdAt: string;
  updatedAt: string;
}
function text(v: unknown, max: number): string {
  if (
    typeof v !== 'string' ||
    Array.from(v).length > max ||
    Array.from(v).some((c) => [0, 11, 12].includes(c.codePointAt(0)!)) ||
    /[\uD800-\uDFFF]/u.test(v)
  )
    invalid();
  return v;
}
function bool(v: unknown): boolean {
  if (typeof v !== 'boolean') invalid();
  return v;
}
export function decodeInput(v: unknown): ContentInput {
  exact(v, [
    'versionLabel',
    'bodyText',
    'announcementDate',
    'popupEnabled',
    'highlight',
    'popupTitle',
    'popupBodyText',
  ]);
  if (
    v.announcementDate !== null &&
    (typeof v.announcementDate !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(v.announcementDate) ||
      !Number.isFinite(Date.parse(v.announcementDate)))
  )
    invalid();
  return {
    versionLabel: text(v.versionLabel, 100),
    bodyText: text(v.bodyText, 10000),
    announcementDate: v.announcementDate as string | null,
    popupEnabled: bool(v.popupEnabled),
    highlight: bool(v.highlight),
    popupTitle: v.popupTitle === null ? null : text(v.popupTitle, 200),
    popupBodyText:
      v.popupBodyText === null ? null : text(v.popupBodyText, 10000),
  };
}
export const emptyContent = (): ContentInput => ({
  versionLabel: '',
  bodyText: '',
  announcementDate: null,
  popupEnabled: true,
  highlight: false,
  popupTitle: null,
  popupBodyText: null,
});
function ids(v: unknown, max: number) {
  if (!Array.isArray(v) || v.length > max) invalid();
  const out = v.map(id);
  if (new Set(out).size !== out.length) invalid();
  return out;
}
function audience(v: unknown): AudienceInput {
  if (typeof v !== 'object' || v === null) invalid();
  const value = v as Record<string, unknown>;
  if (value.kind === 'fixed' || value.kind === 'all') {
    exact(v, ['kind']);
    return { kind: value.kind };
  }
  exact(v, ['kind', 'regionIds']);
  if (value.kind !== 'regions') invalid();
  const regionIds = ids(value.regionIds, 64);
  if (!regionIds.length) invalid();
  return { kind: 'regions', regionIds };
}
function changes(v: unknown): Changes {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) invalid();
  const out: Changes = {};
  for (const [slot, c] of Object.entries(v)) {
    if (!slots.includes(slot as Slot)) invalid();
    const obj = c as Record<string, unknown>;
    if (obj?.action === 'replace') {
      exact(obj, ['action', 'assetId']);
      out[slot as Slot] = { action: 'replace', assetId: id(obj.assetId) };
    } else {
      exact(obj, ['action']);
      if (obj.action !== 'keep' && obj.action !== 'remove') invalid();
      out[slot as Slot] = { action: obj.action };
    }
  }
  return out;
}
export function decodeCommand(v: unknown): Command {
  const bytes = Array.from(canonicalOrganizationJson(v)).reduce((sum, c) => {
    const n = c.codePointAt(0)!;
    return sum + (n <= 0x7f ? 1 : n <= 0x7ff ? 2 : n <= 0xffff ? 3 : 4);
  }, 0);
  if (bytes > 60000)
    throw new ClientError(
      'business',
      '公告正文与弹窗正文合计超过60000字节，请缩短后再提交',
      { serverCode: 'ANNOUNCEMENT_INPUT_TOO_LARGE' },
    );
  const raw = v as Record<string, unknown>;
  const action = raw?.action;
  const base = ['clientRequestId', 'expectedRevision', 'action'];
  exact(v, [
    ...base,
    ...(action === 'create'
      ? ['content', 'audience']
      : action === 'save' || action === 'update'
        ? ['content', 'audience', 'mediaChanges']
        : action === 'set_enabled'
          ? ['enabled']
          : []),
  ]);
  if (
    ![
      'create',
      'save',
      'update',
      'publish',
      'cancel_draft',
      'set_enabled',
    ].includes(String(action))
  )
    invalid();
  const request = key(raw.clientRequestId);
  if (
    typeof raw.expectedRevision !== 'number' ||
    !Number.isSafeInteger(raw.expectedRevision) ||
    raw.expectedRevision < 0 ||
    raw.expectedRevision > Number.MAX_SAFE_INTEGER - 2 ||
    (action === 'create') !== (raw.expectedRevision === 0)
  )
    invalid();
  const common = {
    clientRequestId: request,
    expectedRevision: raw.expectedRevision,
  };
  if (action === 'create')
    return {
      ...common,
      action,
      content: decodeInput(raw.content),
      audience: audience(raw.audience),
    };
  if (action === 'save' || action === 'update')
    return {
      ...common,
      action,
      content: decodeInput(raw.content),
      audience: audience(raw.audience),
      mediaChanges: changes(raw.mediaChanges),
    };
  if (action === 'set_enabled')
    return { ...common, action, enabled: bool(raw.enabled) };
  return { ...common, action: action as 'publish' | 'cancel_draft' };
}
export function commandHash(
  actorId: string,
  announcementId: string,
  command: Command,
) {
  return sha256(
    'whaleu-announcement-command:v1\n' +
      canonicalOrganizationJson({
        actorId: id(actorId),
        announcementId: id(announcementId),
        command: decodeCommand(command),
      }),
  );
}
export function decodeReceipt(v: unknown): Receipt {
  exact(v, [
    'requestId',
    'requestHash',
    'announcementId',
    'revision',
    'outcome',
  ]);
  if (
    ![
      'create',
      'save',
      'publish',
      'update',
      'set_enabled',
      'cancel_draft',
    ].includes(String(v.outcome))
  )
    invalid();
  return {
    requestId: key(v.requestId),
    requestHash: digest(v.requestHash),
    announcementId: id(v.announcementId),
    revision: revision(v.revision),
    outcome: v.outcome as Command['action'],
  };
}
export function decodeRecovery(v: unknown): Recovery {
  const raw = v as Record<string, unknown>;
  if (raw?.state === 'recorded') {
    exact(v, ['state', 'requestId', 'receipt']);
    const r = decodeReceipt(raw.receipt);
    if (r.requestId !== raw.requestId) invalid();
    return { state: 'recorded', requestId: key(raw.requestId), receipt: r };
  }
  if (raw?.state === 'cancelled') {
    exact(v, ['state', 'requestId', 'requestHash']);
    return {
      state: 'cancelled',
      requestId: key(raw.requestId),
      requestHash: digest(raw.requestHash),
    };
  }
  exact(v, ['state', 'requestId']);
  if (raw.state !== 'not_recorded') invalid();
  return { state: 'not_recorded', requestId: key(raw.requestId) };
}
export function decodeManaged(v: unknown): Managed {
  exact(v, [
    'source',
    'id',
    'revision',
    'revisionId',
    'state',
    'content',
    'audience',
    'mediaBindings',
    'createdAt',
    'updatedAt',
  ]);
  if (
    v.source !== 'native' ||
    !['draft', 'active', 'inactive', 'cancelled'].includes(String(v.state))
  )
    invalid();
  exact(v.content, ['title', 'type', ...Object.keys(emptyContent())]);
  if (v.content.type !== 'minor') invalid();
  const { title, type, ...input } = v.content;
  const content = {
    ...decodeInput(input),
    title: text(title, 200),
    type: type as 'minor',
  };
  exact(v.audience, ['kind', 'regionIds', 'campusIds']);
  if (v.audience.kind !== 'all' && v.audience.kind !== 'regions') invalid();
  const a = {
    kind: v.audience.kind as 'all' | 'regions',
    regionIds: ids(v.audience.regionIds, 64),
    campusIds: ids(v.audience.campusIds, 4096),
  };
  if (
    a.kind === 'all'
      ? a.regionIds.length || a.campusIds.length
      : !a.regionIds.length || !a.campusIds.length
  )
    invalid();
  if (
    typeof v.mediaBindings !== 'object' ||
    v.mediaBindings === null ||
    Array.isArray(v.mediaBindings)
  )
    invalid();
  const bindings: Bindings = {};
  for (const [k, b] of Object.entries(v.mediaBindings)) {
    if (!slots.includes(k as Slot)) invalid();
    bindings[k as Slot] = b === null ? null : id(b);
  }
  if (
    typeof v.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(v.createdAt)) ||
    typeof v.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(v.updatedAt))
  )
    invalid();
  return {
    source: 'native',
    id: id(v.id),
    revision: revision(v.revision),
    revisionId: id(v.revisionId),
    state: v.state as Managed['state'],
    content,
    audience: a,
    mediaBindings: bindings,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}
export function decodePage(v: unknown) {
  exact(v, ['source', 'items', 'nextCursor']);
  if (
    v.source !== 'native' ||
    !Array.isArray(v.items) ||
    v.items.length > 50 ||
    (v.nextCursor !== null &&
      (typeof v.nextCursor !== 'string' ||
        !/^[-_A-Za-z0-9]{43}$/.test(v.nextCursor)))
  )
    invalid();
  return {
    source: 'native' as const,
    items: v.items.map(decodeManaged),
    nextCursor: v.nextCursor as string | null,
  };
}
export function decodeCapabilities(v: unknown) {
  exact(v, ['management', 'region']);
  if (!['none', 'fixed', 'global'].includes(String(v.management))) invalid();
  let region: null | { id: string; name: string } = null;
  if (v.region !== null) {
    exact(v.region, ['id', 'name']);
    region = { id: id(v.region.id), name: text(v.region.name, 200) };
  }
  if ((v.management === 'fixed') !== (region !== null)) invalid();
  return { management: v.management as 'none' | 'fixed' | 'global', region };
}
export function decodeRegions(v: unknown) {
  exact(v, ['items', 'more']);
  if (!Array.isArray(v.items) || v.items.length > 50) invalid();
  return {
    items: v.items.map((r) => {
      exact(r, ['id', 'name']);
      return { id: id(r.id), name: text(r.name, 200) };
    }),
    more: bool(v.more),
  };
}
