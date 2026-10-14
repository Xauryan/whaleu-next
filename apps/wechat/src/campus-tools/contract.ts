import { ClientError, isRecord } from '../api/errors';
import { exact } from '../community/contract';
import { isUuid } from '../profile/contract';
import type { ToolPosition } from './location';
export const TOOL_CATALOG_VERSION = 'campus-tools-canonical-v1' as const;
export function invalidTool(): never {
  throw new ClientError('protocol', 'Invalid campus tool data');
}
export function toolUuid(value: unknown): string {
  if (!isUuid(value)) invalidTool();
  return value;
}
export function toolDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalidTool();
  return value;
}
function plain(value: unknown, max: number): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > max ||
    value !== value.normalize('NFC') ||
    // eslint-disable-next-line no-control-regex -- Public plain-text protocol excludes control bytes.
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    invalidTool();
  return value;
}
function sourceId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(value))
    invalidTool();
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    invalidTool();
  return value;
}
function list<T>(
  value: unknown,
  max: number,
  decode: (item: unknown) => T,
): T[] {
  if (!Array.isArray(value) || value.length > max) invalidTool();
  return value.map(decode);
}
function unique(values: readonly (string | number)[]) {
  if (new Set(values).size !== values.length) invalidTool();
}
function instant(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value)
  )
    invalidTool();
  const whole = value.slice(0, 19),
    milliseconds = Date.parse(whole + 'Z');
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString().slice(0, 19) !== whole
  )
    invalidTool();
  return value;
}
/** Preserve PostgreSQL microsecond ordering without browser APIs or BigInt. */
export function compareToolInstants(a: string, b: string): number {
  const first = instant(a),
    second = instant(b);
  const whole =
    Date.parse(first.slice(0, 19) + 'Z') -
    Date.parse(second.slice(0, 19) + 'Z');
  if (whole !== 0) return whole;
  const fraction = (value: string) =>
    Number((value.includes('.') ? value.slice(20, -1) : '').padEnd(6, '0'));
  return fraction(first) - fraction(second);
}
export type ToolValidity =
  | { kind: 'finite'; effectiveAt: string; expiresAt: string }
  | { kind: 'policy_exempt'; effectiveAt: string; exemptionReference: string };
export interface ToolProvenance {
  maintainer: string;
  attribution: string;
  publishedAt: string;
  observedAt: string;
  validity: ToolValidity;
}
function provenance(raw: unknown): ToolProvenance {
  exact(raw, [
    'maintainer',
    'attribution',
    'publishedAt',
    'observedAt',
    'validity',
  ]);
  const v = raw.validity;
  exact(
    v,
    v && typeof v === 'object' && 'kind' in v && v.kind === 'finite'
      ? ['kind', 'effectiveAt', 'expiresAt']
      : ['kind', 'effectiveAt', 'exemptionReference'],
  );
  let validity: ToolValidity;
  if (v.kind === 'finite') {
    validity = {
      kind: 'finite',
      effectiveAt: instant(v.effectiveAt),
      expiresAt: instant(v.expiresAt),
    };
    if (compareToolInstants(validity.expiresAt, validity.effectiveAt) <= 0)
      invalidTool();
  } else if (v.kind === 'policy_exempt')
    validity = {
      kind: 'policy_exempt',
      effectiveAt: instant(v.effectiveAt),
      exemptionReference: plain(v.exemptionReference, 300),
    };
  else invalidTool();
  return {
    maintainer: plain(raw.maintainer, 160),
    attribution: plain(raw.attribution, 300),
    publishedAt: instant(raw.publishedAt),
    observedAt: instant(raw.observedAt),
    validity,
  };
}
function position(raw: unknown): ToolPosition {
  exact(raw, ['latitude', 'longitude']);
  if (
    typeof raw.latitude !== 'number' ||
    !Number.isFinite(raw.latitude) ||
    raw.latitude < -90 ||
    raw.latitude > 90 ||
    typeof raw.longitude !== 'number' ||
    !Number.isFinite(raw.longitude) ||
    raw.longitude < -180 ||
    raw.longitude > 180
  )
    invalidTool();
  return { latitude: raw.latitude, longitude: raw.longitude };
}
export interface ToolMediaSlot {
  id: string;
  bindingId: string;
  assetId: string;
  manifestDigest: string;
  alt: string;
}
export function toolMediaSlot(raw: unknown): ToolMediaSlot {
  exact(raw, ['id', 'bindingId', 'assetId', 'manifestDigest', 'alt']);
  return {
    id: sourceId(raw.id),
    bindingId: toolUuid(raw.bindingId),
    assetId: toolUuid(raw.assetId),
    manifestDigest: toolDigest(raw.manifestDigest),
    alt: plain(raw.alt, 300),
  };
}
export interface ToolMarker {
  id: number;
  sourceId: string;
  title: string;
  category: string;
  details: string;
  position: ToolPosition;
}
interface ToolBase {
  id: string;
  sourceId: string;
  ordinal: number;
  revision: string;
  title: string;
}
export type ToolKind = 'map' | 'shuttle' | 'research' | 'web-link';
export type EnabledToolEntry = ToolBase & { state: 'enabled' } & (
    | {
        kind: 'map';
        coordinateSystem: 'gcj02';
        center: ToolPosition;
        zoom: number;
        markers: ToolMarker[];
      }
    | {
        kind: 'shuttle';
        groups: { id: string; title: string; slots: ToolMediaSlot[] }[];
      }
    | {
        kind: 'research';
        description: string;
        compatibility: string | null;
        image: ToolMediaSlot | null;
        link: { action: 'copy'; state: 'available' } | null;
      }
    | {
        kind: 'web-link';
        link: {
          action: 'webview';
          state: 'available' | 'webview_unconfigured';
        };
      }
  );
export type ToolEntry =
  | EnabledToolEntry
  | (ToolBase & { kind: ToolKind; state: 'disabled' | 'withdrawn' });
const baseKeys = [
  'id',
  'sourceId',
  'ordinal',
  'revision',
  'title',
  'kind',
  'state',
];
export function decodeToolEntry(raw: unknown): ToolEntry {
  if (!isRecord(raw)) invalidTool();
  const fields =
    raw.state !== 'enabled'
      ? []
      : raw.kind === 'map'
        ? ['coordinateSystem', 'center', 'zoom', 'markers']
        : raw.kind === 'shuttle'
          ? ['groups']
          : raw.kind === 'research'
            ? ['description', 'compatibility', 'image', 'link']
            : ['link'];
  exact(raw, [...baseKeys, ...fields]);
  if (!['map', 'shuttle', 'research', 'web-link'].includes(String(raw.kind)))
    invalidTool();
  const base = {
    id: toolUuid(raw.id),
    sourceId: sourceId(raw.sourceId),
    ordinal: integer(raw.ordinal, 0, 31),
    revision: toolUuid(raw.revision),
    title: plain(raw.title, 160),
  };
  if (raw.state === 'disabled' || raw.state === 'withdrawn')
    return { ...base, kind: raw.kind as ToolKind, state: raw.state };
  if (raw.state !== 'enabled') invalidTool();
  const enabled = { ...base, state: 'enabled' as const };
  if (raw.kind === 'map') {
    if (raw.coordinateSystem !== 'gcj02') invalidTool();
    const markers = list(raw.markers, 128, (m) => {
      exact(m, ['id', 'sourceId', 'title', 'category', 'details', 'position']);
      return {
        id: integer(m.id, 0, 2147483647),
        sourceId: sourceId(m.sourceId),
        title: plain(m.title, 160),
        category: plain(m.category, 80),
        details: plain(m.details, 2000),
        position: position(m.position),
      };
    });
    unique(markers.map((m) => m.id));
    unique(markers.map((m) => m.sourceId));
    return {
      ...enabled,
      kind: 'map',
      coordinateSystem: 'gcj02',
      center: position(raw.center),
      zoom: integer(raw.zoom, 3, 20),
      markers,
    };
  }
  if (raw.kind === 'shuttle') {
    const groups = list(raw.groups, 4, (g) => {
      exact(g, ['id', 'title', 'slots']);
      const slots = list(g.slots, 8, toolMediaSlot);
      unique(slots.map((s) => s.id));
      return { id: sourceId(g.id), title: plain(g.title, 160), slots };
    });
    unique(groups.map((g) => g.id));
    unique(groups.flatMap((g) => g.slots.map((s) => s.bindingId)));
    return { ...enabled, kind: 'shuttle', groups };
  }
  if (raw.kind === 'research') {
    if (raw.link !== null) {
      exact(raw.link, ['action', 'state']);
      if (raw.link.action !== 'copy' || raw.link.state !== 'available')
        invalidTool();
    }
    return {
      ...enabled,
      kind: 'research',
      description: plain(raw.description, 4000),
      compatibility:
        raw.compatibility === null ? null : plain(raw.compatibility, 400),
      image: raw.image === null ? null : toolMediaSlot(raw.image),
      link: raw.link === null ? null : { action: 'copy', state: 'available' },
    };
  }
  exact(raw.link, ['action', 'state']);
  if (
    raw.link.action !== 'webview' ||
    (raw.link.state !== 'available' &&
      raw.link.state !== 'webview_unconfigured')
  )
    invalidTool();
  return {
    ...enabled,
    kind: 'web-link',
    link: { action: 'webview', state: raw.link.state },
  };
}
export interface ToolCatalogIdentity {
  campusId: string;
  catalogId: string;
  digest: string;
  version: typeof TOOL_CATALOG_VERSION;
  provenance: ToolProvenance;
}
export type ToolUnavailable = {
  state: 'unknown' | 'expired' | 'unavailable';
  campusId: string;
  reason: string;
};
export type ToolHub =
  | (ToolCatalogIdentity & {
      state: 'ready' | 'known_empty' | 'not_applicable';
      entries: ToolEntry[];
    })
  | ToolUnavailable;
export type ToolDetail =
  | (ToolCatalogIdentity & { state: 'ready'; entry: ToolEntry })
  | ToolUnavailable;
function identity(raw: Record<string, unknown>): ToolCatalogIdentity {
  if (raw.version !== TOOL_CATALOG_VERSION) invalidTool();
  return {
    campusId: toolUuid(raw.campusId),
    catalogId: toolUuid(raw.catalogId),
    digest: toolDigest(raw.digest),
    version: TOOL_CATALOG_VERSION,
    provenance: provenance(raw.provenance),
  };
}
function unavailable(raw: unknown): ToolUnavailable {
  exact(raw, ['state', 'campusId', 'reason']);
  if (
    raw.state !== 'unknown' &&
    raw.state !== 'expired' &&
    raw.state !== 'unavailable'
  )
    invalidTool();
  return {
    state: raw.state,
    campusId: toolUuid(raw.campusId),
    reason: plain(raw.reason, 100),
  };
}
export function decodeToolHub(raw: unknown): ToolHub {
  if (!isRecord(raw)) invalidTool();
  if (!['ready', 'known_empty', 'not_applicable'].includes(String(raw.state)))
    return unavailable(raw);
  exact(raw, [
    'state',
    'campusId',
    'catalogId',
    'digest',
    'version',
    'provenance',
    'entries',
  ]);
  const entries = list(raw.entries, 32, decodeToolEntry);
  if ((raw.state === 'ready') !== entries.length > 0) invalidTool();
  entries.forEach((entry, i) => {
    if (entry.ordinal !== i) invalidTool();
  });
  unique(entries.map((e) => e.id));
  unique(entries.map((e) => e.sourceId));
  unique(entries.map((e) => e.revision));
  const bindings = entries.flatMap((e) =>
    toolSlots(e).map((slot) => slot.bindingId),
  );
  if (bindings.length > 32) invalidTool();
  unique(bindings);
  return {
    ...identity(raw),
    state: raw.state as 'ready' | 'known_empty' | 'not_applicable',
    entries,
  };
}
export function decodeToolDetail(raw: unknown): ToolDetail {
  if (!isRecord(raw)) invalidTool();
  if (raw.state !== 'ready') return unavailable(raw);
  exact(raw, [
    'state',
    'campusId',
    'catalogId',
    'digest',
    'version',
    'provenance',
    'entry',
  ]);
  return {
    ...identity(raw),
    state: 'ready',
    entry: decodeToolEntry(raw.entry),
  };
}
export interface ToolLinkPolicy {
  id: string;
  version: 1;
  rules: {
    action: 'copy' | 'webview';
    host: string;
    path: string;
    query: { key: string; value: string }[];
  }[];
}
export function decodeToolPolicy(raw: unknown): ToolLinkPolicy {
  exact(raw, ['id', 'version', 'rules']);
  if (raw.version !== 1) invalidTool();
  const rules = list(raw.rules, 16, (r): ToolLinkPolicy['rules'][number] => {
    exact(r, ['action', 'host', 'path', 'query']);
    if (
      (r.action !== 'copy' && r.action !== 'webview') ||
      typeof r.host !== 'string' ||
      r.host.length > 253 ||
      r.host.split('.').some((label) => label.length > 63) ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/.test(
        r.host,
      ) ||
      /(?:^|\.)xn--/.test(r.host) ||
      /^[\d.]+$/.test(r.host) ||
      /(?:^|\.)(?:localhost|local|internal|test|invalid|lan|home|localdomain|corp|onion)$/.test(
        r.host,
      ) ||
      typeof r.path !== 'string' ||
      r.path.length > 512 ||
      !/^\/[A-Za-z0-9_./~-]*$/.test(r.path) ||
      /(?:^|\/)\.{1,2}(?:\/|$)/.test(r.path)
    )
      invalidTool();
    const query = list(r.query, 8, (q) => {
      exact(q, ['key', 'value']);
      const key = sourceId(q.key);
      if (
        /^(?:url|redirect|return|next|callback|continue|token|uid|location)$/i.test(
          key,
        ) ||
        typeof q.value !== 'string' ||
        !/^[A-Za-z0-9_~-]{1,128}$/.test(q.value)
      )
        invalidTool();
      return { key, value: q.value };
    });
    unique(query.map((q) => q.key));
    return { action: r.action, host: r.host, path: r.path, query };
  });
  return { id: toolUuid(raw.id), version: 1, rules };
}
/** Exact ASCII reconstruction. No URL global, decoding, prefix/suffix host check,
 * credentials, encoded delimiters, or permissive arbitrary navigation sink. */
export function canonicalToolLink(
  raw: unknown,
  action: 'copy' | 'webview',
  policy: ToolLinkPolicy,
): string {
  if (
    typeof raw !== 'string' ||
    raw.length > 2048 ||
    !/^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9_./~?=&-]*$/.test(raw)
  )
    invalidTool();
  const checked = decodeToolPolicy(policy);
  if (
    !checked.rules.some((rule) => {
      const query = rule.query.map((q) => `${q.key}=${q.value}`).join('&');
      return (
        rule.action === action &&
        raw === `https://${rule.host}${rule.path}${query ? `?${query}` : ''}`
      );
    })
  )
    invalidTool();
  return raw;
}
export type ToolLink =
  | {
      state: 'ready';
      campusId: string;
      catalogId: string;
      digest: string;
      entryId: string;
      entryRevision: string;
      action: 'copy' | 'webview';
      url: string;
      policy: ToolLinkPolicy;
    }
  | ToolUnavailable;
export function decodeToolLink(raw: unknown): ToolLink {
  if (!isRecord(raw)) invalidTool();
  if (raw.state !== 'ready') return unavailable(raw);
  exact(raw, [
    'state',
    'campusId',
    'catalogId',
    'digest',
    'entryId',
    'entryRevision',
    'action',
    'url',
    'policy',
  ]);
  if (raw.action !== 'copy' && raw.action !== 'webview') invalidTool();
  const policy = decodeToolPolicy(raw.policy);
  return {
    state: 'ready',
    campusId: toolUuid(raw.campusId),
    catalogId: toolUuid(raw.catalogId),
    digest: toolDigest(raw.digest),
    entryId: toolUuid(raw.entryId),
    entryRevision: toolUuid(raw.entryRevision),
    action: raw.action,
    url: canonicalToolLink(raw.url, raw.action, policy),
    policy,
  };
}
export function toolSlots(entry: ToolEntry): ToolMediaSlot[] {
  if (entry.state !== 'enabled') return [];
  return entry.kind === 'shuttle'
    ? entry.groups.flatMap((g) => g.slots)
    : entry.kind === 'research' && entry.image
      ? [entry.image]
      : [];
}
