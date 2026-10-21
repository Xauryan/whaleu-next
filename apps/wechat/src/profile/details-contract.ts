import { ClientError, isRecord } from '../api/errors';
import { isUuid } from './contract';

export type ProfileGender = 'female' | 'male';
export interface ProfileDetailFields {
  readonly region: string | null;
  readonly gender: ProfileGender | null;
  readonly age: number | null;
  readonly showRegion: boolean;
  readonly showGender: boolean;
  readonly showAge: boolean;
}
export interface OwnProfileDetails extends ProfileDetailFields {
  readonly accountId: string;
  readonly revision: number;
}
export interface ProfileDetailsPatch extends ProfileDetailFields {
  readonly expectedRevision: number;
}
export type PublicProfileDetails =
  | { readonly status: 'unavailable'; readonly profileId: string }
  | {
      readonly status: 'available';
      readonly profileId: string;
      readonly region: string | null;
      readonly gender: ProfileGender | null;
      readonly age: number | null;
    };
export const profileDetailDefaults = (): ProfileDetailFields => ({
  region: null,
  gender: null,
  age: null,
  showRegion: false,
  showGender: false,
  showAge: false,
});
export const profileGenderLabels = { female: '女', male: '男' };
const fields = [
  'region',
  'gender',
  'age',
  'showRegion',
  'showGender',
  'showAge',
];
const exact = (
  raw: unknown,
  keys: readonly string[],
): raw is Record<string, unknown> =>
  isRecord(raw) &&
  Object.keys(raw).length === keys.length &&
  keys.every((key) => Object.prototype.hasOwnProperty.call(raw, key));
const revision = (raw: unknown): raw is number =>
  typeof raw === 'number' &&
  Number.isInteger(raw) &&
  raw >= 0 &&
  raw <= 2147483647;
export const profileRegionError = (value: string): string =>
  value.length > 80 ||
  [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code < 32 || code === 127;
  })
    ? '地区最多 80 个字，不能包含换行或控制字符'
    : '';
const region = (raw: unknown): raw is string | null =>
  raw === null ||
  (typeof raw === 'string' &&
    raw === raw.trim() &&
    raw.length >= 1 &&
    !profileRegionError(raw));
const gender = (raw: unknown): raw is ProfileGender | null =>
  raw === null || raw === 'female' || raw === 'male';
const age = (raw: unknown): raw is number | null =>
  raw === null ||
  (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 120);
const values = (raw: Record<string, unknown>): boolean =>
  region(raw.region) && gender(raw.gender) && age(raw.age);
const visibility = (raw: Record<string, unknown>): boolean =>
  ['showRegion', 'showGender', 'showAge'].every(
    (key) => typeof raw[key] === 'boolean',
  );
function invalid(): never {
  throw new ClientError('protocol', 'Invalid optional profile details');
}
export function decodeOwnProfileDetails(raw: unknown): OwnProfileDetails {
  if (
    !exact(raw, ['accountId', 'revision', ...fields]) ||
    !isUuid(raw.accountId) ||
    !revision(raw.revision) ||
    !values(raw) ||
    !visibility(raw)
  )
    invalid();
  return Object.freeze({ ...raw }) as unknown as OwnProfileDetails;
}
export function validateProfileDetailsPatch(raw: ProfileDetailsPatch): void {
  if (
    !exact(raw, ['expectedRevision', ...fields]) ||
    !revision(raw.expectedRevision) ||
    raw.expectedRevision === 2147483647 ||
    !values(raw) ||
    !visibility(raw)
  )
    throw new ClientError('business', 'Invalid optional profile details input');
}
export function decodePublicProfileDetails(raw: unknown): PublicProfileDetails {
  if (!isRecord(raw) || !isUuid(raw.profileId)) invalid();
  if (raw.status === 'unavailable') {
    if (!exact(raw, ['status', 'profileId'])) invalid();
    return Object.freeze({ status: 'unavailable', profileId: raw.profileId });
  }
  if (
    raw.status !== 'available' ||
    !exact(raw, ['status', 'profileId', 'region', 'gender', 'age']) ||
    !values(raw)
  )
    invalid();
  return Object.freeze({ ...raw }) as unknown as PublicProfileDetails;
}
