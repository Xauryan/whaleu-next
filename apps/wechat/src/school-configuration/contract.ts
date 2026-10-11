import { sha256 } from 'js-sha256';
import { ClientError } from '../api/errors';
import { exact } from '../community/contract';
import { isUuid } from '../profile/contract';
export const schoolEntryKeys = [
  'treehole',
  'trading',
  'errand',
  'review',
  'official_account',
  'admin',
] as const;
export const publicSchoolEntryKeys = [
  'treehole',
  'trading',
  'errand',
  'official_account',
  'admin',
] as const;
export type SchoolEntryKey = (typeof schoolEntryKeys)[number];
export const schoolLabels: Record<SchoolEntryKey, string> = {
  treehole: '树洞交流群',
  trading: '二手交易群',
  errand: '跑腿互助群',
  review: '内部审核群',
  official_account: '学校公众号',
  admin: '联系管理员',
};
export type SchoolEntryData =
  | {
      kind: 'group';
      enabled: boolean;
      name: string;
      description: string;
      joinUrl: string;
      qqGroupNumber: string;
      maxGroupNumber: number | null;
    }
  | {
      kind: 'official_account';
      enabled: boolean;
      name: string;
      description: string;
    }
  | { kind: 'admin'; enabled: boolean; wechatId: string };
export type SchoolQrChange =
  | { action: 'keep' }
  | { action: 'remove' }
  | { action: 'replace'; assetId: string };
export interface SchoolCommand {
  clientRequestId: string;
  expectedRevision: number;
  entry: SchoolEntryData;
  qrcode: SchoolQrChange;
}
export interface SchoolEntry {
  entryKey: SchoolEntryKey;
  revision: number;
  state: 'unconfigured' | 'disabled' | 'partial' | 'configured';
  data: SchoolEntryData | null;
  qrcode: { status: 'none' | 'configured' };
}
export interface SchoolPublicView {
  context: {
    campusId: string;
    campusName: string;
    region: { id: string; name: string } | null;
  };
  entries: SchoolEntry[];
}
export interface SchoolManagementView {
  context: {
    regionId: string;
    regionName: string;
    management: 'fixed' | 'global';
  };
  entries: SchoolEntry[];
}
export interface SchoolCapabilities {
  management: 'none' | 'fixed' | 'global';
  region: { id: string; name: string } | null;
}
export interface SchoolReceipt {
  requestId: string;
  requestHash: string;
  regionId: string;
  entryKey: SchoolEntryKey;
  revision: number;
  outcome: 'saved';
}
export type SchoolRecovery =
  | { state: 'cancelled'; requestId: string; requestHash: string }
  | { state: 'not_recorded'; requestId: string }
  | { state: 'recorded'; requestId: string; receipt: SchoolReceipt };
export function invalidSchool(): never {
  throw new ClientError('protocol', 'Invalid school service data');
}
export function schoolUuid(value: unknown): string {
  if (!isUuid(value)) invalidSchool();
  return value;
}
export function schoolKey(value: unknown): SchoolEntryKey {
  if (
    typeof value !== 'string' ||
    !(schoolEntryKeys as readonly string[]).includes(value)
  )
    invalidSchool();
  return value as SchoolEntryKey;
}
export function schoolRevision(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER
  )
    invalidSchool();
  return value;
}
const plain = (value: unknown, max: number): string => {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    // eslint-disable-next-line no-control-regex -- Explicitly reject control bytes in public operations data.
    /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)
  )
    invalidSchool();
  return value;
};
export function safeSchoolJoinUrl(value: unknown): string {
  const result = plain(value, 1000);
  if (
    result &&
    !/^https:\/\/(?:qun\.qq\.com|jq\.qq\.com|qm\.qq\.com|weixin\.qq\.com)(?:[/?#][^\s\\]*)?$/iu.test(
      result,
    )
  )
    invalidSchool();
  return result;
}
export function schoolData(
  value: unknown,
  key?: SchoolEntryKey,
): SchoolEntryData {
  exact(
    value,
    value &&
      typeof value === 'object' &&
      'kind' in value &&
      value.kind === 'group'
      ? [
          'kind',
          'enabled',
          'name',
          'description',
          'joinUrl',
          'qqGroupNumber',
          'maxGroupNumber',
        ]
      : value &&
          typeof value === 'object' &&
          'kind' in value &&
          value.kind === 'official_account'
        ? ['kind', 'enabled', 'name', 'description']
        : ['kind', 'enabled', 'wechatId'],
  );
  if (typeof value.enabled !== 'boolean') invalidSchool();
  let data: SchoolEntryData;
  if (value.kind === 'group') {
    if (
      typeof value.qqGroupNumber !== 'string' ||
      !/^(?:[1-9][0-9]{4,31})?$/.test(value.qqGroupNumber) ||
      (value.maxGroupNumber !== null &&
        (typeof value.maxGroupNumber !== 'number' ||
          !Number.isInteger(value.maxGroupNumber) ||
          value.maxGroupNumber < 1 ||
          value.maxGroupNumber > 999))
    )
      invalidSchool();
    data = {
      kind: 'group',
      enabled: value.enabled,
      name: plain(value.name, 100),
      description: plain(value.description, 500),
      joinUrl: safeSchoolJoinUrl(value.joinUrl),
      qqGroupNumber: value.qqGroupNumber,
      maxGroupNumber: value.maxGroupNumber as number | null,
    };
  } else if (value.kind === 'official_account')
    data = {
      kind: 'official_account',
      enabled: value.enabled,
      name: plain(value.name, 100),
      description: plain(value.description, 500),
    };
  else if (value.kind === 'admin') {
    const wechatId = plain(value.wechatId, 100);
    if (/\s/u.test(wechatId)) invalidSchool();
    data = { kind: 'admin', enabled: value.enabled, wechatId };
  } else invalidSchool();
  if (
    key !== undefined &&
    data.kind !==
      (key === 'admin' || key === 'official_account' ? key : 'group')
  )
    invalidSchool();
  return data;
}
export function emptySchoolData(key: SchoolEntryKey): SchoolEntryData {
  return key === 'admin'
    ? { kind: 'admin', enabled: false, wechatId: '' }
    : key === 'official_account'
      ? { kind: 'official_account', enabled: false, name: '', description: '' }
      : {
          kind: 'group',
          enabled: false,
          name: '',
          description: '',
          joinUrl: '',
          qqGroupNumber: '',
          maxGroupNumber: null,
        };
}
export function schoolCommand(
  value: unknown,
  key: SchoolEntryKey,
): SchoolCommand {
  exact(value, ['clientRequestId', 'expectedRevision', 'entry', 'qrcode']);
  const requestId = schoolUuid(value.clientRequestId);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      requestId,
    )
  )
    invalidSchool();
  if (schoolRevision(value.expectedRevision) === Number.MAX_SAFE_INTEGER)
    invalidSchool();
  const q = value.qrcode;
  exact(
    q,
    q && typeof q === 'object' && 'action' in q && q.action === 'replace'
      ? ['action', 'assetId']
      : ['action'],
  );
  if (q.action !== 'keep' && q.action !== 'remove' && q.action !== 'replace')
    invalidSchool();
  return {
    clientRequestId: requestId,
    expectedRevision: schoolRevision(value.expectedRevision),
    entry: schoolData(value.entry, key),
    qrcode:
      q.action === 'replace'
        ? { action: 'replace', assetId: schoolUuid(q.assetId) }
        : { action: q.action },
  };
}
function canonical(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object' && value !== null)
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ':' +
            canonical((value as Record<string, unknown>)[key]),
        )
        .join(',') +
      '}'
    );
  return invalidSchool();
}
export function schoolCommandHash(
  actorId: string,
  regionId: string,
  key: SchoolEntryKey,
  command: SchoolCommand,
): string {
  return sha256(
    'whaleu-school-configuration-command:v1\n' +
      canonical({
        actorId: schoolUuid(actorId),
        regionId: schoolUuid(regionId),
        key: schoolKey(key),
        command: schoolCommand(command, key),
      }),
  );
}
function entry(value: unknown, management: boolean): SchoolEntry {
  exact(value, ['entryKey', 'revision', 'state', 'data', 'qrcode']);
  const key = schoolKey(value.entryKey),
    revision = schoolRevision(value.revision);
  if (
    !['unconfigured', 'disabled', 'partial', 'configured'].includes(
      String(value.state),
    )
  )
    invalidSchool();
  exact(value.qrcode, ['status']);
  if (value.qrcode.status !== 'none' && value.qrcode.status !== 'configured')
    invalidSchool();
  const data = value.data === null ? null : schoolData(value.data, key);
  if (
    value.state === 'unconfigured'
      ? revision !== 0 || data !== null || value.qrcode.status !== 'none'
      : revision === 0
  )
    invalidSchool();
  if (
    !management &&
    value.state === 'disabled' &&
    (data !== null || value.qrcode.status !== 'none')
  )
    invalidSchool();
  if (
    ['partial', 'configured'].includes(String(value.state)) &&
    (!data || !data.enabled)
  )
    invalidSchool();
  if (management && value.state !== 'unconfigured' && !data) invalidSchool();
  return {
    entryKey: key,
    revision,
    state: value.state as SchoolEntry['state'],
    data,
    qrcode: { status: value.qrcode.status },
  };
}
function region(value: unknown): { id: string; name: string } | null {
  if (value === null) return null;
  exact(value, ['id', 'name']);
  return { id: schoolUuid(value.id), name: plain(value.name, 500) };
}
function entries(value: unknown, management: boolean): SchoolEntry[] {
  const keys = management ? schoolEntryKeys : publicSchoolEntryKeys;
  if (!Array.isArray(value) || value.length !== keys.length) invalidSchool();
  return value.map((raw, index) => {
    const result = entry(raw, management);
    if (result.entryKey !== keys[index]) invalidSchool();
    return result;
  });
}
export function decodeSchoolPublic(value: unknown): SchoolPublicView {
  exact(value, ['context', 'entries']);
  exact(value.context, ['campusId', 'campusName', 'region']);
  return {
    context: {
      campusId: schoolUuid(value.context.campusId),
      campusName: plain(value.context.campusName, 500),
      region: region(value.context.region),
    },
    entries: entries(value.entries, false),
  };
}
export function decodeSchoolManagement(value: unknown): SchoolManagementView {
  exact(value, ['context', 'entries']);
  exact(value.context, ['regionId', 'regionName', 'management']);
  if (
    value.context.management !== 'fixed' &&
    value.context.management !== 'global'
  )
    invalidSchool();
  return {
    context: {
      regionId: schoolUuid(value.context.regionId),
      regionName: plain(value.context.regionName, 500),
      management: value.context.management,
    },
    entries: entries(value.entries, true),
  };
}
export function decodeSchoolCapabilities(value: unknown): SchoolCapabilities {
  exact(value, ['management', 'region']);
  if (!['none', 'fixed', 'global'].includes(String(value.management)))
    invalidSchool();
  const r = region(value.region);
  if ((value.management === 'fixed') !== (r !== null)) invalidSchool();
  return {
    management: value.management as SchoolCapabilities['management'],
    region: r,
  };
}
export function decodeSchoolReceipt(value: unknown): SchoolReceipt {
  exact(value, [
    'requestId',
    'requestHash',
    'regionId',
    'entryKey',
    'revision',
    'outcome',
  ]);
  if (
    typeof value.requestHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.requestHash) ||
    value.outcome !== 'saved' ||
    schoolRevision(value.revision) === 0
  )
    invalidSchool();
  return {
    requestId: schoolUuid(value.requestId),
    requestHash: value.requestHash,
    regionId: schoolUuid(value.regionId),
    entryKey: schoolKey(value.entryKey),
    revision: value.revision as number,
    outcome: 'saved',
  };
}
export function decodeSchoolRecovery(value: unknown): SchoolRecovery {
  exact(
    value,
    value &&
      typeof value === 'object' &&
      'state' in value &&
      value.state === 'recorded'
      ? ['state', 'requestId', 'receipt']
      : value &&
          typeof value === 'object' &&
          'state' in value &&
          value.state === 'cancelled'
        ? ['state', 'requestId', 'requestHash']
        : ['state', 'requestId'],
  );
  const requestId = schoolUuid(value.requestId);
  if (value.state === 'cancelled') {
    if (
      typeof value.requestHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.requestHash)
    )
      invalidSchool();
    return { state: 'cancelled', requestId, requestHash: value.requestHash };
  }
  if (value.state === 'not_recorded')
    return { state: 'not_recorded', requestId };
  if (value.state !== 'recorded') invalidSchool();
  const receipt = decodeSchoolReceipt(value.receipt);
  if (receipt.requestId !== requestId) invalidSchool();
  return { state: 'recorded', requestId, receipt };
}

export interface ErrandSchoolService {
  context: { orderId: string; targetRegion: { id: string; name: string } };
  entry: SchoolEntry;
}
export function decodeErrandSchoolService(value: unknown): ErrandSchoolService {
  exact(value, ['context', 'entry']);
  exact(value.context, ['orderId', 'targetRegion']);
  const target = region(value.context.targetRegion),
    group = entry(value.entry, false);
  if (!target || group.entryKey !== 'errand') invalidSchool();
  return {
    context: {
      orderId: schoolUuid(value.context.orderId),
      targetRegion: target,
    },
    entry: group,
  };
}
