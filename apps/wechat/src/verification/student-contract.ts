import { sha256 } from 'js-sha256';
import { ClientError, isRecord } from '../api/errors';
import { isUuid } from '../profile/contract';
export type StudentState =
  'draft' | 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'expired';
export const studentLabels: Record<StudentState, string> = {
  draft: '待提交材料',
  pending: '等待校方审核',
  approved: '学生归属已通过',
  rejected: '申请未通过，可重新申请',
  withdrawn: '申请已取消',
  expired: '材料已过期，请重新申请',
};
const states = Object.keys(studentLabels);
export function invalidStudent(): never {
  throw new ClientError('protocol', '认证申请响应不可用');
}
export function exactStudent(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((k) => !Object.prototype.hasOwnProperty.call(value, k))
  )
    invalidStudent();
}
export function studentUuid(raw: unknown): string {
  if (!isUuid(raw)) invalidStudent();
  return raw;
}
function integer(raw: unknown, min = 1): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < min)
    invalidStudent();
  return raw;
}
function state(raw: unknown): StudentState {
  if (typeof raw !== 'string' || !states.includes(raw)) invalidStudent();
  return raw as StudentState;
}
function text(raw: unknown, max = 200): string {
  if (typeof raw !== 'string' || [...raw].length > max) invalidStudent();
  return raw;
}
function utc(raw: unknown): string | null {
  if (raw === null) return null;
  const s = text(raw, 40);
  if (!Number.isFinite(Date.parse(s)) || new Date(s).toISOString() !== s)
    invalidStudent();
  return s;
}
export interface StudentApplication {
  id: string;
  revision: number;
  state: StudentState;
  campusId: string;
  campusName: string;
  institutionName: string;
  regionId: string;
  profileId: string | null;
  submittedAt: string | null;
  reason: string | null;
  evidenceRevision: number | null;
  evidenceAvailable: boolean;
  evidenceExpiresAt: string | null;
}
export function decodeStudentApplication(raw: unknown): StudentApplication {
  exactStudent(raw, [
    'id',
    'revision',
    'state',
    'campusId',
    'campusName',
    'institutionName',
    'regionId',
    'profileId',
    'submittedAt',
    'reason',
    'evidenceRevision',
    'evidenceAvailable',
    'evidenceExpiresAt',
  ]);
  if (typeof raw.evidenceAvailable !== 'boolean') invalidStudent();
  return Object.freeze({
    id: studentUuid(raw.id),
    revision: integer(raw.revision),
    state: state(raw.state),
    campusId: studentUuid(raw.campusId),
    campusName: text(raw.campusName),
    institutionName: text(raw.institutionName),
    regionId: studentUuid(raw.regionId),
    profileId: raw.profileId === null ? null : studentUuid(raw.profileId),
    submittedAt: utc(raw.submittedAt),
    reason: raw.reason === null ? null : text(raw.reason),
    evidenceRevision:
      raw.evidenceRevision === null ? null : integer(raw.evidenceRevision),
    evidenceAvailable: raw.evidenceAvailable,
    evidenceExpiresAt: utc(raw.evidenceExpiresAt),
  });
}
export interface StudentReceipt {
  requestId: string;
  applicationId: string;
  revision: number;
  state: StudentState;
}
export function decodeStudentReceipt(raw: unknown): StudentReceipt {
  exactStudent(raw, ['requestId', 'applicationId', 'revision', 'state']);
  return Object.freeze({
    requestId: studentUuid(raw.requestId),
    applicationId: studentUuid(raw.applicationId),
    revision: integer(raw.revision),
    state: state(raw.state),
  });
}
export function decodeStudentOwn(raw: unknown) {
  exactStudent(raw, ['application', 'canApply']);
  if (typeof raw.canApply !== 'boolean') invalidStudent();
  return {
    application:
      raw.application === null
        ? null
        : decodeStudentApplication(raw.application),
    canApply: raw.canApply,
  };
}
export function decodeStudentRecovery(raw: unknown) {
  exactStudent(raw, ['requestId', 'state', 'receipt']);
  if (!['recorded', 'not_recorded', 'cancelled'].includes(String(raw.state)))
    invalidStudent();
  const receipt =
    raw.receipt === null ? null : decodeStudentReceipt(raw.receipt);
  if ((raw.state === 'recorded') !== (receipt !== null)) invalidStudent();
  return {
    requestId: studentUuid(raw.requestId),
    state: raw.state as 'recorded' | 'not_recorded' | 'cancelled',
    receipt,
  };
}
export function decodeStudentQueue(raw: unknown) {
  exactStudent(raw, ['items', 'page', 'hasNext', 'nextCursor']);
  if (
    !Array.isArray(raw.items) ||
    raw.items.length > 20 ||
    typeof raw.hasNext !== 'boolean'
  )
    invalidStudent();
  const nextCursor =
    raw.nextCursor === null ? null : studentUuid(raw.nextCursor);
  if (raw.hasNext !== (nextCursor !== null)) invalidStudent();
  return {
    items: raw.items.map(decodeStudentApplication),
    page: integer(raw.page),
    hasNext: raw.hasNext,
    nextCursor,
  };
}

export function decodeStudentCapabilities(raw: unknown) {
  exactStudent(raw, ['management', 'region']);
  if (!['global', 'fixed', 'none'].includes(String(raw.management)))
    invalidStudent();
  let region: { id: string; name: string } | null = null;
  if (raw.region !== null) {
    exactStudent(raw.region, ['id', 'name']);
    region = { id: studentUuid(raw.region.id), name: text(raw.region.name) };
  }
  if ((raw.management === 'fixed') !== (region !== null)) invalidStudent();
  return { management: raw.management as 'global' | 'fixed' | 'none', region };
}
export interface StudentNotice {
  id: string;
  kind: 'student_auth' | 'auth_result';
  outcome: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  read: boolean;
  available: boolean;
}
export function decodeStudentNotices(raw: unknown) {
  exactStudent(raw, ['items', 'page', 'hasNext']);
  if (
    !Array.isArray(raw.items) ||
    raw.items.length > 20 ||
    typeof raw.hasNext !== 'boolean'
  )
    invalidStudent();
  const items = raw.items.map((n) => {
    exactStudent(n, [
      'id',
      'kind',
      'outcome',
      'createdAt',
      'read',
      'available',
    ]);
    if (
      !['student_auth', 'auth_result'].includes(String(n.kind)) ||
      !['pending', 'approved', 'rejected'].includes(String(n.outcome)) ||
      typeof n.read !== 'boolean' ||
      typeof n.available !== 'boolean'
    )
      invalidStudent();
    const createdAt = utc(n.createdAt);
    if (!createdAt) invalidStudent();
    return {
      id: studentUuid(n.id),
      kind: n.kind as StudentNotice['kind'],
      outcome: n.outcome as StudentNotice['outcome'],
      createdAt,
      read: n.read,
      available: n.available,
    };
  });
  return { items, page: integer(raw.page), hasNext: raw.hasNext };
}
export function decodeStudentNoticeTarget(raw: unknown) {
  exactStudent(raw, ['status', 'target']);
  if (raw.status === 'unavailable' && raw.target === null)
    return { status: 'unavailable' as const, target: null };
  if (raw.status !== 'available') invalidStudent();
  exactStudent(raw.target, ['applicationId', 'regionId']);
  return {
    status: 'available' as const,
    target: {
      applicationId: studentUuid(raw.target.applicationId),
      regionId:
        raw.target.regionId === null ? null : studentUuid(raw.target.regionId),
    },
  };
}
export function studentCommandHash(parts: unknown[]) {
  return sha256(JSON.stringify(parts));
}
