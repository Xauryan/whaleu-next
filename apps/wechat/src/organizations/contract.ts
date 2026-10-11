import { sha256 } from 'js-sha256';
import { ClientError, isRecord } from '../api/errors';
import { exact } from '../community/contract';
import {
  schoolUuid,
  schoolRevision,
  decodeSchoolCapabilities,
} from '../school-configuration/contract';
import {
  organizationMediaSlot,
  organizationMediaSlots,
} from './media-validation';
import type { OrganizationMediaSlot } from './media-validation';
export { decodeSchoolCapabilities as decodeOrganizationCapabilities };
export const organizationUuid = schoolUuid;
export function organizationRequestId(v: unknown): string {
  const id = organizationUuid(v);
  if (id[14] !== '4') invalidOrganization();
  return id;
}
export const organizationRevision = schoolRevision;
export function invalidOrganization(): never {
  throw new ClientError('protocol', '组织数据不可用');
}
export type OrganizationKind = 'school' | 'org' | 'official';
export type OrganizationPlatform = 'qq' | 'wechat' | 'official';
export type OrganizationRole =
  | 'applicant'
  | 'organization_owner'
  | 'organization_admin'
  | 'school_admin'
  | 'super_admin'
  | 'reader';
export interface OrganizationData {
  kind: OrganizationKind;
  platform: OrganizationPlatform;
  categoryId: string;
  name: string;
  introText: string;
  qqGroupNumber: string | null;
}
export type OrganizationMediaChange =
  | { action: 'keep' }
  | { action: 'remove' }
  | { action: 'replace'; assetId: string };
export type OrganizationMediaChanges = Partial<
  Record<OrganizationMediaSlot, OrganizationMediaChange>
>;
export type OrganizationBindings = Partial<
  Record<OrganizationMediaSlot, string | null>
>;
interface CAS {
  clientRequestId: string;
  expectedRevision: number;
  expectedAuthorityVersion: number;
}
export type OrganizationCommand =
  | (CAS & {
      action: 'create';
      organizationId: string;
      regionId: string;
      data: OrganizationData;
    })
  | (CAS & {
      action: 'save' | 'submit';
      data: OrganizationData;
      mediaChanges: OrganizationMediaChanges;
    })
  | (CAS & { action: 'approve' | 'reject'; reason: string })
  | (CAS & {
      action: 'add_admin' | 'remove_admin' | 'transfer_owner';
      targetProfileId: string;
    });
export interface OrganizationReceipt {
  requestId: string;
  requestHash: string;
  organizationId: string;
  revision: number;
  authorityVersion: number;
  outcome:
    | 'created'
    | 'saved'
    | 'submitted'
    | 'approved'
    | 'rejected'
    | 'admin_added'
    | 'admin_removed'
    | 'owner_transferred';
  changed: boolean;
}
export type OrganizationRecovery =
  | { state: 'not_recorded'; requestId: string }
  | { state: 'cancelled'; requestId: string; requestHash: string }
  | { state: 'recorded'; requestId: string; receipt: OrganizationReceipt };
export interface OrganizationItem {
  source: 'managed';
  id: string;
  regionId: string;
  revision: number;
  authorityVersion: number;
  state: 'draft' | 'pending' | 'rejected' | 'approved';
  data: OrganizationData;
  role: OrganizationRole;
  createdAt: string;
  updatedAt: string;
}
export interface OrganizationPerson {
  profileId: string;
  displayName: string;
}
export interface OrganizationMember {
  profile: OrganizationPerson | null;
  role: 'organization_owner' | 'organization_admin';
  grantId: string;
  validFrom: string;
  validUntil: string | null;
}
export interface OrganizationDetail extends OrganizationItem {
  mediaBindings: OrganizationBindings;
  reviewReason: string | null;
  members: OrganizationMember[];
  permissions: {
    edit: boolean;
    submit: boolean;
    review: boolean;
    manageMembers: boolean;
    transferOwner: boolean;
  };
}
export interface OrganizationPublicDetail extends OrganizationItem {
  mediaBindings: OrganizationBindings;
  management: { available: boolean };
}
export interface OrganizationPage {
  items: OrganizationItem[];
  continuation: 'end' | 'more';
  nextCursor: string | null;
}
export interface OrganizationQuery {
  kind?: OrganizationKind;
  categoryId?: string;
  q?: string;
  limit?: number;
  cursor?: string;
}
const plain = (v: unknown, n: number): string => {
  if (
    typeof v !== 'string' ||
    Array.from(v).length > n ||
    Array.from(v).some((c) => {
      const p = c.codePointAt(0)!;
      return (
        (p < 32 && p !== 10) ||
        (p >= 127 && p <= 159) ||
        (p >= 0xd800 && p <= 0xdfff) ||
        (p >= 0x202a && p <= 0x202e) ||
        (p >= 0x2066 && p <= 0x2069)
      );
    })
  )
    invalidOrganization();
  return v;
};
const one = <T extends string>(v: unknown, allowed: readonly T[]): T => {
  if (typeof v !== 'string' || !allowed.includes(v as T)) invalidOrganization();
  return v as T;
};
const bool = (v: unknown): boolean => {
  if (typeof v !== 'boolean') invalidOrganization();
  return v;
};
const date = (v: unknown): string => {
  if (
    typeof v !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) ||
    !Number.isFinite(Date.parse(v))
  )
    invalidOrganization();
  return v;
};
export const organizationDigest = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) invalidOrganization();
  return v;
};
export function decodeOrganizationData(v: unknown): OrganizationData {
  exact(v, [
    'kind',
    'platform',
    'categoryId',
    'name',
    'introText',
    'qqGroupNumber',
  ]);
  const kind = one(v.kind, ['school', 'org', 'official'] as const),
    platform = one(v.platform, ['qq', 'wechat', 'official'] as const),
    name = plain(v.name, 10),
    qq = v.qqGroupNumber;
  if (
    !name ||
    name.trim() !== name ||
    (kind === 'official') !== (platform === 'official') ||
    (platform === 'qq'
      ? typeof qq !== 'string' || !/^[0-9]{5,16}$/.test(qq)
      : qq !== null)
  )
    invalidOrganization();
  return {
    kind,
    platform,
    categoryId: organizationUuid(v.categoryId),
    name,
    introText: plain(v.introText, 1000),
    qqGroupNumber: qq as string | null,
  };
}
export function decodeOrganizationChanges(
  v: unknown,
): OrganizationMediaChanges {
  if (!v || typeof v !== 'object' || Array.isArray(v)) invalidOrganization();
  const out: OrganizationMediaChanges = {};
  for (const [key, value] of Object.entries(v)) {
    const slot = organizationMediaSlot(key);
    if (!value || typeof value !== 'object' || !('action' in value))
      invalidOrganization();
    if (value.action === 'replace') {
      exact(value, ['action', 'assetId']);
      out[slot] = {
        action: 'replace',
        assetId: organizationUuid(value.assetId),
      };
    } else {
      exact(value, ['action']);
      out[slot] = { action: one(value.action, ['keep', 'remove'] as const) };
    }
  }
  return out;
}
export function decodeOrganizationBindings(v: unknown): OrganizationBindings {
  if (!v || typeof v !== 'object' || Array.isArray(v)) invalidOrganization();
  const out: OrganizationBindings = {};
  for (const [key, value] of Object.entries(v))
    out[organizationMediaSlot(key)] =
      value === null ? null : organizationUuid(value);
  return out;
}
export function decodeOrganizationCommand(v: unknown): OrganizationCommand {
  if (!isRecord(v)) invalidOrganization();
  const base = [
    'clientRequestId',
    'expectedRevision',
    'expectedAuthorityVersion',
    'action',
  ];
  const action = one(v.action, [
    'create',
    'save',
    'submit',
    'approve',
    'reject',
    'add_admin',
    'remove_admin',
    'transfer_owner',
  ] as const);
  exact(v, [
    ...base,
    ...(action === 'create'
      ? ['organizationId', 'regionId', 'data']
      : action === 'save' || action === 'submit'
        ? ['data', 'mediaChanges']
        : action === 'approve' || action === 'reject'
          ? ['reason']
          : ['targetProfileId']),
  ]);
  const cas = {
    clientRequestId: organizationRequestId(v.clientRequestId),
    expectedRevision: organizationRevision(v.expectedRevision),
    expectedAuthorityVersion: organizationRevision(v.expectedAuthorityVersion),
  };
  if (action === 'create') {
    if (cas.expectedRevision !== 0 || cas.expectedAuthorityVersion !== 0)
      invalidOrganization();
    return {
      ...cas,
      action,
      organizationId: organizationRequestId(v.organizationId),
      regionId: organizationUuid(v.regionId),
      data: decodeOrganizationData(v.data),
    };
  }
  if (cas.expectedRevision < 1 || cas.expectedAuthorityVersion < 1)
    invalidOrganization();
  if (action === 'save' || action === 'submit')
    return {
      ...cas,
      action,
      data: decodeOrganizationData(v.data),
      mediaChanges: decodeOrganizationChanges(v.mediaChanges),
    };
  if (action === 'approve' || action === 'reject') {
    const reason = plain(v.reason, 500);
    if (action === 'approve' ? reason !== '' : !reason.trim())
      invalidOrganization();
    return { ...cas, action, reason };
  }
  return {
    ...cas,
    action,
    targetProfileId: organizationUuid(v.targetProfileId),
  };
}
export function canonicalOrganizationJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v))
    return `[${v.map(canonicalOrganizationJson).join(',')}]`;
  return `{${Object.keys(v)
    .sort()
    .map(
      (k) =>
        `${JSON.stringify(k)}:${canonicalOrganizationJson((v as Record<string, unknown>)[k])}`,
    )
    .join(',')}}`;
}
export function organizationCommandHash(
  actorId: string,
  organizationId: string,
  command: OrganizationCommand,
) {
  return sha256(
    'whaleu-organization-command:v1\n' +
      canonicalOrganizationJson({
        actorId: organizationUuid(actorId),
        organizationId: organizationUuid(organizationId),
        command: decodeOrganizationCommand(command),
      }),
  );
}
export function decodeOrganizationReceipt(v: unknown): OrganizationReceipt {
  exact(v, [
    'requestId',
    'requestHash',
    'organizationId',
    'revision',
    'authorityVersion',
    'outcome',
    'changed',
  ]);
  const revision = organizationRevision(v.revision),
    authorityVersion = organizationRevision(v.authorityVersion);
  if (revision < 1 || authorityVersion < 1) invalidOrganization();
  return {
    requestId: organizationRequestId(v.requestId),
    requestHash: organizationDigest(v.requestHash),
    organizationId: organizationUuid(v.organizationId),
    revision,
    authorityVersion,
    outcome: one(v.outcome, [
      'created',
      'saved',
      'submitted',
      'approved',
      'rejected',
      'admin_added',
      'admin_removed',
      'owner_transferred',
    ] as const),
    changed: bool(v.changed),
  };
}
export function decodeOrganizationRecovery(v: unknown): OrganizationRecovery {
  if (!isRecord(v)) invalidOrganization();
  if (v.state === 'recorded') {
    exact(v, ['state', 'requestId', 'receipt']);
    const requestId = organizationRequestId(v.requestId),
      receipt = decodeOrganizationReceipt(v.receipt);
    if (receipt.requestId !== requestId) invalidOrganization();
    return { state: 'recorded', requestId, receipt };
  }
  if (v.state === 'cancelled') {
    exact(v, ['state', 'requestId', 'requestHash']);
    return {
      state: 'cancelled',
      requestId: organizationRequestId(v.requestId),
      requestHash: organizationDigest(v.requestHash),
    };
  }
  exact(v, ['state', 'requestId']);
  if (v.state !== 'not_recorded') invalidOrganization();
  return {
    state: 'not_recorded',
    requestId: organizationRequestId(v.requestId),
  };
}
const itemKeys = [
  'source',
  'id',
  'regionId',
  'revision',
  'authorityVersion',
  'state',
  'data',
  'role',
  'createdAt',
  'updatedAt',
];
function item(v: Record<string, unknown>): OrganizationItem {
  if (v.source !== 'managed') invalidOrganization();
  const revision = organizationRevision(v.revision),
    authorityVersion = organizationRevision(v.authorityVersion);
  if (revision < 1 || authorityVersion < 1) invalidOrganization();
  return {
    source: 'managed',
    id: organizationUuid(v.id),
    regionId: organizationUuid(v.regionId),
    revision,
    authorityVersion,
    state: one(v.state, ['draft', 'pending', 'rejected', 'approved'] as const),
    data: decodeOrganizationData(v.data),
    role: one(v.role, [
      'applicant',
      'organization_owner',
      'organization_admin',
      'school_admin',
      'super_admin',
      'reader',
    ] as const),
    createdAt: date(v.createdAt),
    updatedAt: date(v.updatedAt),
  };
}
export function decodeOrganizationPerson(v: unknown): OrganizationPerson {
  exact(v, ['profileId', 'displayName']);
  const displayName = plain(v.displayName, 20);
  if (!displayName) invalidOrganization();
  return { profileId: organizationUuid(v.profileId), displayName };
}
export function decodeOrganizationPage(v: unknown): OrganizationPage {
  exact(v, ['items', 'continuation', 'nextCursor']);
  if (!Array.isArray(v.items) || v.items.length > 30) invalidOrganization();
  const continuation = one(v.continuation, ['end', 'more'] as const),
    nextCursor = v.nextCursor;
  if (
    continuation === 'end'
      ? nextCursor !== null
      : typeof nextCursor !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(nextCursor)
  )
    invalidOrganization();
  const items = v.items.map((raw) => {
    exact(raw, itemKeys);
    return item(raw);
  });
  if (
    new Set(items.map((i) => i.id)).size !== items.length ||
    (continuation === 'more' && !items.length)
  )
    invalidOrganization();
  return { items, continuation, nextCursor: nextCursor as string | null };
}
export function decodeOrganizationDetail(v: unknown): OrganizationDetail {
  exact(v, [
    ...itemKeys,
    'mediaBindings',
    'reviewReason',
    'members',
    'permissions',
  ]);
  const base = item(v);
  if (!Array.isArray(v.members) || v.members.length > 100)
    invalidOrganization();
  const members = v.members.map((m) => {
    exact(m, ['profile', 'role', 'grantId', 'validFrom', 'validUntil']);
    return {
      profile: m.profile === null ? null : decodeOrganizationPerson(m.profile),
      role: one(m.role, ['organization_owner', 'organization_admin'] as const),
      grantId: organizationUuid(m.grantId),
      validFrom: date(m.validFrom),
      validUntil: m.validUntil === null ? null : date(m.validUntil),
    };
  });
  if (
    new Set(members.map((m) => m.grantId)).size !== members.length ||
    (base.state === 'approved' &&
      members.filter((m) => m.role === 'organization_owner').length !== 1)
  )
    invalidOrganization();
  exact(v.permissions, [
    'edit',
    'submit',
    'review',
    'manageMembers',
    'transferOwner',
  ]);
  return {
    ...base,
    mediaBindings: decodeOrganizationBindings(v.mediaBindings),
    reviewReason: v.reviewReason === null ? null : plain(v.reviewReason, 500),
    members,
    permissions: {
      edit: bool(v.permissions.edit),
      submit: bool(v.permissions.submit),
      review: bool(v.permissions.review),
      manageMembers: bool(v.permissions.manageMembers),
      transferOwner: bool(v.permissions.transferOwner),
    },
  };
}
export function decodeOrganizationPublicDetail(
  v: unknown,
): OrganizationPublicDetail {
  exact(v, [...itemKeys, 'mediaBindings', 'management']);
  const base = item(v),
    mediaBindings = decodeOrganizationBindings(v.mediaBindings);
  if (
    base.state !== 'approved' ||
    base.role !== 'reader' ||
    mediaBindings.managerContact !== undefined
  )
    invalidOrganization();
  exact(v.management, ['available']);
  return {
    ...base,
    mediaBindings,
    management: { available: bool(v.management.available) },
  };
}
export const organizationSlotLabels: Record<OrganizationMediaSlot, string> = {
  avatar: '头像（必填）',
  mainQr: '主二维码（必填）',
  managerContact: '管理员微信图片（仅管理与审核可见，微信群必填）',
  linkedOfficialQr: '关联公众号二维码',
  introImage0: '介绍图片1',
  introImage1: '介绍图片2',
  introImage2: '介绍图片3',
  introImage3: '介绍图片4',
  introImage4: '介绍图片5',
  introImage5: '介绍图片6',
  introImage6: '介绍图片7',
  introImage7: '介绍图片8',
  introImage8: '介绍图片9',
};
export const organizationRoleLabels: Record<OrganizationRole, string> = {
  applicant: '申请人',
  organization_owner: '所有者',
  organization_admin: '组织管理员',
  school_admin: '学校管理员',
  super_admin: '超级管理员',
  reader: '成员',
};
export const organizationStateLabels = {
  draft: '草稿',
  pending: '待审核',
  rejected: '已拒绝',
  approved: '已批准',
};
export const organizationSlots = organizationMediaSlots;
