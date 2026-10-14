import { ClientError, isRecord } from '../api/errors';
import { boundedText, exact } from '../community/contract';
import { isUuid } from '../profile/contract';
export interface SchoolUidSchool {
  readonly code: string;
  readonly name: string;
}
export type SchoolUid =
  | {
      readonly status: 'assigned';
      readonly school: SchoolUidSchool;
      readonly uid: string;
      readonly formattedUid: string;
    }
  | { readonly status: 'unassigned' | 'unavailable' };
export type SchoolUidLookup =
  | {
      readonly status: 'found';
      readonly target: {
        readonly profileId: string;
        readonly displayName: string;
      };
    }
  | { readonly status: 'unavailable' };
export function invalidSchoolUid(): never {
  throw new ClientError('protocol', 'Invalid school UID response');
}
export const isSchoolCode = (raw: unknown): raw is string =>
  typeof raw === 'string' && /^[0-9]{5}$/.test(raw);
export const isSchoolUid = (raw: unknown): raw is string =>
  typeof raw === 'string' &&
  /^[1-9][0-9]{0,18}$/.test(raw) &&
  BigInt(raw) <= 9223372036854775807n;
export function parseSchoolUid(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[0-9]{1,19}$/.test(raw)) invalidSchoolUid();
  const canonical = BigInt(raw).toString();
  if (!isSchoolUid(canonical)) invalidSchoolUid();
  return canonical;
}
export function formatSchoolUid(raw: string): string {
  if (!isSchoolUid(raw)) invalidSchoolUid();
  return raw.padStart(6, '0');
}
export function decodeSchoolUidSchool(raw: unknown): SchoolUidSchool {
  exact(raw, ['code', 'name']);
  if (!isSchoolCode(raw.code) || !boundedText(raw.name, 1, 200))
    invalidSchoolUid();
  return Object.freeze({ code: raw.code, name: raw.name });
}
export function decodeSchoolUid(raw: unknown): SchoolUid {
  if (!isRecord(raw)) invalidSchoolUid();
  if (raw.status === 'assigned') {
    exact(raw, ['status', 'school', 'uid', 'formattedUid']);
    if (!isSchoolUid(raw.uid) || raw.formattedUid !== formatSchoolUid(raw.uid))
      invalidSchoolUid();
    return Object.freeze({
      status: 'assigned',
      school: decodeSchoolUidSchool(raw.school),
      uid: raw.uid,
      formattedUid: raw.formattedUid as string,
    });
  }
  exact(raw, ['status']);
  if (raw.status !== 'unassigned' && raw.status !== 'unavailable')
    invalidSchoolUid();
  return Object.freeze({ status: raw.status });
}
export function decodeSchoolUidLookup(raw: unknown): SchoolUidLookup {
  if (!isRecord(raw)) invalidSchoolUid();
  if (raw.status === 'found') {
    exact(raw, ['status', 'target']);
    exact(raw.target, ['profileId', 'displayName']);
    if (
      !isUuid(raw.target.profileId) ||
      !boundedText(raw.target.displayName, 1, 100)
    )
      invalidSchoolUid();
    return Object.freeze({
      status: 'found',
      target: Object.freeze({
        profileId: raw.target.profileId,
        displayName: raw.target.displayName,
      }),
    });
  }
  exact(raw, ['status']);
  if (raw.status !== 'unavailable') invalidSchoolUid();
  return Object.freeze({ status: 'unavailable' });
}
