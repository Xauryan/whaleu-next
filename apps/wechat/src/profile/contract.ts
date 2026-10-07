import { ClientError, isRecord } from '../api/errors';

export interface Campus {
  readonly id: string;
  readonly institutionId: string;
  readonly institutionName: string;
  readonly fullName: string;
  readonly shortName: string | null;
  readonly district: string;
  readonly isActive: boolean;
}
export interface CampusPage {
  readonly items: readonly Campus[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}
export const preferenceKeys = [
  'showOfficialAccountTip',
  'showHotTopic',
  'showGroupNotice',
  'showTradingGroupNotice',
  'showErrandGroupNotice',
  'defaultAnonymousEnabled',
  'defaultCommentAnonymousEnabled',
  'defaultCommentNonAnonymousEnabled',
  'defaultAllowAnonymousDm',
  'hideProfilePosts',
  'activitySubscribed',
] as const;
export type PreferenceKey = (typeof preferenceKeys)[number];
export type Preferences = Readonly<Record<PreferenceKey, boolean>>;
export interface OwnProfile {
  readonly accountId: string;
  readonly nickname: string | null;
  readonly bio: string;
  readonly selectedCampus: Campus | null;
  readonly revision: number;
  readonly preferences: Preferences;
}
export interface CampusQuery {
  readonly q: string;
  readonly district: string;
  readonly page: number;
  readonly pageSize: number;
}
export interface ProfilePatch {
  readonly expectedRevision: number;
  readonly nickname?: string;
  readonly bio?: string;
}
export interface PreferencesPatch {
  readonly expectedRevision: number;
  readonly preferences: Partial<Preferences>;
}
export interface CampusPatch {
  readonly expectedRevision: number;
  readonly campusId: string;
}
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= min &&
  value <= max;
const text = (value: unknown, min: number, max: number): value is string =>
  typeof value === 'string' &&
  [...value].length >= min &&
  [...value].length <= max;
function exact(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  )
    invalid();
}
function invalid(): never {
  throw new ClientError('protocol', 'Invalid campus or profile data');
}
export function nicknameError(value: string): string {
  return /^[\u4e00-\u9fa5a-zA-Z0-9_#&@.+-]{1,20}$/.test(value)
    ? ''
    : '昵称需为 1–20 个中文、字母、数字或 _ # & @ . + -，不能包含空格';
}
export function bioError(value: string): string {
  if ([...value].length > 100) return '个人简介最多 100 个字';
  if ((value.match(/\n/g) ?? []).length > 5) return '个人简介最多 5 次换行';
  if (
    [...value].some((character) => {
      const code = character.codePointAt(0)!;
      return (
        (code < 32 && code !== 9 && code !== 10) ||
        code === 127 ||
        (code >= 0xd800 && code <= 0xdfff)
      );
    })
  )
    return '个人简介包含不支持的字符';
  return '';
}
export function decodeCampus(value: unknown): Campus {
  exact(value, [
    'id',
    'institutionId',
    'institutionName',
    'fullName',
    'shortName',
    'district',
    'isActive',
  ]);
  if (
    !isUuid(value.id) ||
    !isUuid(value.institutionId) ||
    !text(value.institutionName, 1, 200) ||
    !text(value.fullName, 1, 200) ||
    !(value.shortName === null || text(value.shortName, 1, 100)) ||
    !text(value.district, 1, 100) ||
    typeof value.isActive !== 'boolean'
  )
    invalid();
  return Object.freeze({
    id: value.id,
    institutionId: value.institutionId,
    institutionName: value.institutionName,
    fullName: value.fullName,
    shortName: value.shortName,
    district: value.district,
    isActive: value.isActive,
  });
}
export function decodeCampusPage(value: unknown): CampusPage {
  exact(value, ['items', 'page', 'pageSize', 'total']);
  if (
    !Array.isArray(value.items) ||
    !integer(value.page, 1, 10000) ||
    !integer(value.pageSize, 1, 100) ||
    !integer(value.total, 0, 2147483647) ||
    value.items.length > value.pageSize ||
    value.items.length > value.total
  )
    invalid();
  const items = value.items.map(decodeCampus);
  if (new Set(items.map((item) => item.id)).size !== items.length) invalid();
  return Object.freeze({
    items: Object.freeze(items),
    page: value.page,
    pageSize: value.pageSize,
    total: value.total,
  });
}
export function decodePreferences(value: unknown): Preferences {
  exact(value, preferenceKeys);
  if (
    preferenceKeys.some((key) => typeof value[key] !== 'boolean') ||
    (value.defaultCommentAnonymousEnabled &&
      value.defaultCommentNonAnonymousEnabled)
  )
    invalid();
  return Object.freeze({ ...value }) as Preferences;
}
export function decodeOwnProfile(value: unknown): OwnProfile {
  exact(value, [
    'accountId',
    'nickname',
    'bio',
    'selectedCampus',
    'revision',
    'preferences',
  ]);
  if (
    !isUuid(value.accountId) ||
    !(
      value.nickname === null ||
      (typeof value.nickname === 'string' && !nicknameError(value.nickname))
    ) ||
    typeof value.bio !== 'string' ||
    bioError(value.bio) ||
    !integer(value.revision, 0, 2147483647)
  )
    invalid();
  return Object.freeze({
    accountId: value.accountId,
    nickname: value.nickname,
    bio: value.bio,
    selectedCampus:
      value.selectedCampus === null ? null : decodeCampus(value.selectedCampus),
    revision: value.revision,
    preferences: decodePreferences(value.preferences),
  });
}
function input(condition: boolean): void {
  if (!condition) throw new ClientError('business', 'Invalid profile input');
}
export function validateRevision(value: number): void {
  input(integer(value, 0, 2147483646));
}
export function validateProfilePatch(value: ProfilePatch): void {
  input(
    Object.keys(value).every((key) =>
      ['expectedRevision', 'nickname', 'bio'].includes(key),
    ),
  );
  validateRevision(value.expectedRevision);
  input(value.nickname !== undefined || value.bio !== undefined);
  if (value.nickname !== undefined)
    input(typeof value.nickname === 'string' && !nicknameError(value.nickname));
  if (value.bio !== undefined)
    input(typeof value.bio === 'string' && !bioError(value.bio));
}
export function validatePreferencesPatch(value: PreferencesPatch): void {
  input(
    Object.keys(value).every((key) =>
      ['expectedRevision', 'preferences'].includes(key),
    ),
  );
  validateRevision(value.expectedRevision);
  input(
    isRecord(value.preferences) && Object.keys(value.preferences).length > 0,
  );
  input(
    Object.entries(value.preferences).every(
      ([key, item]) =>
        preferenceKeys.includes(key as PreferenceKey) &&
        typeof item === 'boolean',
    ),
  );
  input(
    !(
      value.preferences.defaultCommentAnonymousEnabled &&
      value.preferences.defaultCommentNonAnonymousEnabled
    ),
  );
}
export function validateCampusQuery(value: CampusQuery): void {
  input(
    typeof value.q === 'string' &&
      [...value.q].length <= 100 &&
      typeof value.district === 'string' &&
      [...value.district].length <= 100 &&
      integer(value.page, 1, 10000) &&
      integer(value.pageSize, 1, 100),
  );
  input(
    [value.q, value.district].every((item) =>
      [...item].every((character) => {
        const code = character.codePointAt(0)!;
        return (
          code >= 32 && code !== 127 && !(code >= 0xd800 && code <= 0xdfff)
        );
      }),
    ),
  );
}
