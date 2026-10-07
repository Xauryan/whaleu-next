import { isRecord } from '../api/errors';
import { isUuid } from '../profile/contract';
import {
  boundedText,
  displayDiscussionText,
  decodeAuthor,
  exact,
  invalid,
  timestamp,
  uuid4,
  type Author,
} from './contract';
import { tradingText } from './trading-contract';
export interface FormationContacts {
  readonly wechat: string;
  readonly qq: string;
  readonly phone: string;
}
export interface FormationComponent {
  readonly kind: 'formation';
  readonly capacity: number;
  readonly theme: string;
  readonly contacts: FormationContacts;
  readonly contactSharing: 'members_v1';
}
export interface FormationMember {
  readonly id: string;
  readonly author: Author;
  readonly isCreator: boolean;
  readonly joinedAt: string;
  readonly viewer: { readonly isSelf: boolean };
}
export interface Formation {
  readonly id: string;
  readonly postId: string;
  readonly capacity: number;
  readonly theme: string;
  readonly status: 'open' | 'full' | 'unavailable';
  readonly memberCount: number;
  readonly members: readonly FormationMember[];
  readonly viewer: {
    readonly isMember: boolean;
    readonly isCreator: boolean;
    readonly canJoin: boolean;
    readonly reason: string | null;
    readonly canReadContacts: boolean;
  };
}
export interface FormationJoinIntent {
  readonly clientRequestId: string;
  readonly contacts: FormationContacts;
  readonly contactSharing: 'members_v1';
}
export type FormationReceipt =
  | {
      readonly requestId: string;
      readonly operation: 'join_formation';
      readonly outcome: 'created';
      readonly resourceId: string;
      readonly createdAt: string;
    }
  | {
      readonly requestId: string;
      readonly operation: 'join_formation';
      readonly outcome: 'rejected';
      readonly code: string;
    };
export interface OwnFormationMembership {
  readonly postId: string;
  readonly membershipId: string;
  readonly joinedAt: string;
  readonly isCreator: boolean;
}
export interface FormationContactView {
  readonly postId: string;
  readonly members: readonly {
    readonly membershipId: string;
    readonly contacts: FormationContacts;
  }[];
}
export const formationContactDisclosure =
  '你填写的联系方式将分享给当前有权查看本帖的组队成员。公开名单中发起者可保持匿名，但联系方式可能让成员识别你的身份；加入者使用公开个人资料。联系方式不是认证信息。';
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= min &&
  value <= max;
const reasons = [
  'FORMATION_FULL',
  'FORMATION_ALREADY_JOINED',
  'FORMATION_UNAVAILABLE',
  'AUTHENTICATION_REQUIRED',
  'COMMUNITY_UNAVAILABLE',
  'PHONE_VERIFICATION_REQUIRED',
  'COMMUNITY_ACTION_RESTRICTED',
  'COMMUNITY_SCOPE_UNAVAILABLE',
];
const terminalCodes = [
  ...reasons.filter(
    (code) =>
      !['AUTHENTICATION_REQUIRED', 'COMMUNITY_UNAVAILABLE'].includes(code),
  ),
  'POST_NOT_FOUND',
  'FORMATION_NOT_FOUND',
];
export function decodeFormationContacts(value: unknown): FormationContacts {
  exact(value, ['wechat', 'qq', 'phone']);
  if (
    typeof value.wechat !== 'string' ||
    typeof value.qq !== 'string' ||
    typeof value.phone !== 'string'
  )
    invalid();
  const contacts = {
    wechat: value.wechat.trim(),
    qq: value.qq.trim(),
    phone: value.phone.trim(),
  };
  if (
    !tradingText(contacts.wechat, 100, false) ||
    !tradingText(contacts.qq, 50, false) ||
    !tradingText(contacts.phone, 20, false) ||
    !Object.values(contacts).some(Boolean)
  )
    invalid();
  return Object.freeze(contacts);
}
export function decodeFormationComponent(value: unknown): FormationComponent {
  exact(value, ['kind', 'capacity', 'theme', 'contacts', 'contactSharing']);
  if (
    value.kind !== 'formation' ||
    !integer(value.capacity, 1, 20) ||
    typeof value.theme !== 'string' ||
    !boundedText(value.theme.trim(), 1, 12) ||
    !value.theme.trim() ||
    value.theme.includes('\r') ||
    value.contactSharing !== 'members_v1'
  )
    invalid();
  return Object.freeze({
    kind: 'formation',
    capacity: value.capacity,
    theme: value.theme.trim(),
    contacts: decodeFormationContacts(value.contacts),
    contactSharing: 'members_v1',
  });
}
export function decodeFormation(value: unknown): Formation {
  exact(value, [
    'id',
    'postId',
    'capacity',
    'theme',
    'status',
    'memberCount',
    'members',
    'viewer',
  ]);
  exact(value.viewer, [
    'isMember',
    'isCreator',
    'canJoin',
    'reason',
    'canReadContacts',
  ]);
  if (
    !isUuid(value.id) ||
    !isUuid(value.postId) ||
    !integer(value.capacity, 1, 20) ||
    !displayDiscussionText(value.theme) ||
    !['open', 'full', 'unavailable'].includes(String(value.status)) ||
    !integer(value.memberCount, 1, 20) ||
    value.memberCount > value.capacity ||
    !Array.isArray(value.members) ||
    value.members.length > value.memberCount ||
    Object.entries(value.viewer).some(
      ([key, item]) => key !== 'reason' && typeof item !== 'boolean',
    ) ||
    !(
      value.viewer.reason === null ||
      (typeof value.viewer.reason === 'string' &&
        reasons.includes(value.viewer.reason))
    )
  )
    invalid();
  const viewer = value.viewer;
  const members = value.members.map((member): FormationMember => {
    exact(member, ['id', 'author', 'isCreator', 'joinedAt', 'viewer']);
    exact(member.viewer, ['isSelf']);
    if (
      !isUuid(member.id) ||
      typeof member.isCreator !== 'boolean' ||
      !timestamp(member.joinedAt) ||
      typeof member.viewer.isSelf !== 'boolean'
    )
      invalid();
    const author = decodeAuthor(member.author);
    if (
      author.kind === 'anonymous' &&
      (!member.isCreator || !author.isPostAuthor)
    )
      invalid();
    return Object.freeze({
      id: member.id,
      author,
      isCreator: member.isCreator,
      joinedAt: member.joinedAt,
      viewer: Object.freeze({ isSelf: member.viewer.isSelf }),
    });
  });
  if (
    new Set(members.map((m) => m.id)).size !== members.length ||
    members.filter((m) => m.isCreator).length > 1 ||
    members.some((m, i) => m.isCreator && i !== 0) ||
    members.filter((m) => m.viewer.isSelf).length > 1 ||
    members.some(
      (m, i) =>
        i > 0 &&
        !m.isCreator &&
        !members[i - 1]!.isCreator &&
        Date.parse(m.joinedAt) < Date.parse(members[i - 1]!.joinedAt),
    ) ||
    (value.status === 'open' && value.memberCount >= value.capacity) ||
    (value.status === 'full' && value.memberCount !== value.capacity) ||
    value.viewer.canJoin !== (value.viewer.reason === null) ||
    (value.viewer.isCreator && !value.viewer.isMember) ||
    (value.viewer.isMember &&
      value.viewer.reason !== 'FORMATION_ALREADY_JOINED') ||
    (!value.viewer.isMember &&
      value.viewer.reason === 'FORMATION_ALREADY_JOINED') ||
    (!value.viewer.isMember &&
      value.status === 'full' &&
      value.viewer.reason !== 'FORMATION_FULL') ||
    (!value.viewer.isMember &&
      value.status === 'unavailable' &&
      value.viewer.reason !== 'FORMATION_UNAVAILABLE') ||
    (value.status !== 'full' && value.viewer.reason === 'FORMATION_FULL') ||
    (value.status !== 'unavailable' &&
      value.viewer.reason === 'FORMATION_UNAVAILABLE') ||
    (value.viewer.canReadContacts &&
      (!value.viewer.isMember || value.status === 'unavailable')) ||
    (value.viewer.canJoin &&
      (value.viewer.isMember || value.status !== 'open')) ||
    members.some(
      (m) =>
        m.viewer.isSelf &&
        (!viewer.isMember || m.isCreator !== viewer.isCreator),
    )
  )
    invalid();
  return Object.freeze({
    id: value.id,
    postId: value.postId,
    capacity: value.capacity,
    theme: value.theme,
    status: value.status as Formation['status'],
    memberCount: value.memberCount,
    members: Object.freeze(members),
    viewer: Object.freeze({ ...value.viewer }) as Formation['viewer'],
  });
}
export function checkFormationCreator(
  formation: Formation,
  author: Author,
): void {
  const creator = formation.members.find((member) => member.isCreator);
  if (
    creator &&
    (creator.author.kind !== author.kind ||
      (author.kind === 'anonymous'
        ? creator.author.kind !== 'anonymous' ||
          creator.author.personaId !== author.personaId
        : creator.author.kind !== 'named' ||
          creator.author.profileId !== author.profileId))
  )
    invalid();
}
export function decodeFormationJoinIntent(value: unknown): FormationJoinIntent {
  exact(value, ['clientRequestId', 'contacts', 'contactSharing']);
  if (!uuid4(value.clientRequestId) || value.contactSharing !== 'members_v1')
    invalid();
  return Object.freeze({
    clientRequestId: value.clientRequestId,
    contacts: decodeFormationContacts(value.contacts),
    contactSharing: 'members_v1',
  });
}
export function decodeFormationReceipt(value: unknown): FormationReceipt {
  if (!isRecord(value)) invalid();
  if (value.outcome === 'created') {
    exact(value, [
      'requestId',
      'operation',
      'outcome',
      'resourceId',
      'createdAt',
    ]);
    if (
      !uuid4(value.requestId) ||
      value.operation !== 'join_formation' ||
      !isUuid(value.resourceId) ||
      !timestamp(value.createdAt)
    )
      invalid();
    return Object.freeze({
      requestId: value.requestId,
      operation: 'join_formation',
      outcome: 'created',
      resourceId: value.resourceId,
      createdAt: value.createdAt,
    });
  }
  exact(value, ['requestId', 'operation', 'outcome', 'code']);
  if (
    !uuid4(value.requestId) ||
    value.operation !== 'join_formation' ||
    value.outcome !== 'rejected' ||
    typeof value.code !== 'string' ||
    !terminalCodes.includes(value.code)
  )
    invalid();
  return Object.freeze({
    requestId: value.requestId,
    operation: 'join_formation',
    outcome: 'rejected',
    code: value.code,
  });
}
export function decodeOwnFormationMembership(
  value: unknown,
): OwnFormationMembership {
  exact(value, ['postId', 'membershipId', 'joinedAt', 'isCreator']);
  if (
    !isUuid(value.postId) ||
    !isUuid(value.membershipId) ||
    !timestamp(value.joinedAt) ||
    typeof value.isCreator !== 'boolean'
  )
    invalid();
  return Object.freeze({
    postId: value.postId,
    membershipId: value.membershipId,
    joinedAt: value.joinedAt,
    isCreator: value.isCreator,
  });
}
export function decodeFormationContactView(
  value: unknown,
): FormationContactView {
  exact(value, ['postId', 'members']);
  if (
    !isUuid(value.postId) ||
    !Array.isArray(value.members) ||
    value.members.length > 20
  )
    invalid();
  const members = value.members.map((member) => {
    exact(member, ['membershipId', 'contacts']);
    if (!isUuid(member.membershipId)) invalid();
    return Object.freeze({
      membershipId: member.membershipId,
      contacts: decodeFormationDisplayContacts(member.contacts),
    });
  });
  if (new Set(members.map((m) => m.membershipId)).size !== members.length)
    invalid();
  return Object.freeze({
    postId: value.postId,
    members: Object.freeze(members),
  });
}

/** Historical approved fields remain verbatim, separate from new-write bounds and normalization. */
export function decodeFormationDisplayContacts(
  value: unknown,
): FormationContacts {
  exact(value, ['wechat', 'qq', 'phone']);
  if (
    !displayDiscussionText(value.wechat) ||
    !displayDiscussionText(value.qq) ||
    !displayDiscussionText(value.phone)
  )
    invalid();
  return Object.freeze({
    wechat: value.wechat,
    qq: value.qq,
    phone: value.phone,
  });
}
