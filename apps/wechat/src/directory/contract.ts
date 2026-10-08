import { ClientError, isRecord } from '../api/errors';
import { exact, timestamp } from '../community/contract';
import { isUuid } from '../profile/contract';

export const directoryKinds = ['school', 'org', 'official'] as const;
export type DirectoryKind = (typeof directoryKinds)[number];
export const directoryKindLabels = {
  school: '校园群聊',
  org: '组织社团',
  official: '公众号',
} as const;
export const directoryPlatformLabels = {
  qq: 'QQ 群',
  wechat: '微信群',
  official: '公众号',
} as const;
export const directoryAccents = [
  'green',
  'orange',
  'red',
  'yellow',
  'lilac',
  'purple',
  'coral',
  'cyan',
] as const;
export type DirectoryAccent = (typeof directoryAccents)[number];
export type DirectoryPlatform = keyof typeof directoryPlatformLabels;
export type DirectoryFact<T> =
  | { readonly status: 'known'; readonly value: T | null }
  | { readonly status: 'unavailable'; readonly value: null };
export type DirectoryMedia = {
  readonly status: 'absent' | 'unavailable';
  readonly value: null;
};
export type NotApplicable = {
  readonly status: 'not_applicable';
  readonly value: null;
};
export interface DirectoryContext {
  readonly regionId: string;
}
export interface DirectoryCategory {
  readonly id: string;
  readonly kind: DirectoryKind;
  readonly name: string;
  readonly description: string;
  readonly accent: DirectoryAccent;
}
export interface DirectoryEntry {
  readonly id: string;
  readonly categoryId: string;
  readonly kind: DirectoryKind;
  readonly platform: DirectoryPlatform;
  readonly name: string;
  readonly introPreview: string;
  readonly badge: DirectoryFact<'normal' | 'official' | 'partner'>;
  readonly avatar: DirectoryMedia;
}
export interface DirectoryDetail extends DirectoryEntry {
  readonly introText: string;
  readonly introImages:
    | { readonly status: 'known'; readonly items: readonly [] }
    | { readonly status: 'unavailable'; readonly items: null };
  readonly mainQr: DirectoryMedia;
  readonly managerWechatImage: DirectoryMedia | NotApplicable;
  readonly linkedOfficialAccountQr: DirectoryMedia | NotApplicable;
  readonly qqGroupNumber: DirectoryFact<string> | NotApplicable;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly visits: { readonly status: 'unavailable'; readonly value: null };
  readonly managers: { readonly status: 'unavailable'; readonly items: null };
  readonly management: { readonly status: 'unavailable' };
}
export interface DirectoryPage<T> {
  readonly items: readonly T[];
  readonly continuation: 'more' | 'end';
  readonly nextCursor: string | null;
}
export interface DirectoryListIntent {
  readonly regionId: string;
  readonly kind: DirectoryKind;
  readonly categoryId?: string;
  readonly q?: string;
}
export function invalidDirectory(): never {
  throw new ClientError('protocol', 'Invalid directory response');
}
export const directoryUuid = (value: unknown): value is string =>
  isUuid(value) && value === value.toLowerCase();
export const isDirectoryKind = (value: unknown): value is DirectoryKind =>
  (directoryKinds as readonly unknown[]).includes(value);
export const directoryCursor = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const text = (value: unknown): value is string => typeof value === 'string';
export function canonicalDirectoryQuery(value: unknown): string {
  if (
    typeof value !== 'string' ||
    [...value].some((character) => {
      const code = character.codePointAt(0)!;
      return (
        code < 32 ||
        (code >= 127 && code <= 159) ||
        (code >= 0xd800 && code <= 0xdfff)
      );
    })
  )
    invalidDirectory();
  const q = value.trim();
  if (!q || [...q].length > 100) invalidDirectory();
  let bytes = 0;
  for (const char of q) {
    const code = char.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  if (bytes > 400) invalidDirectory();
  return q;
}
export function decodeDirectoryContext(value: unknown): DirectoryContext {
  exact(value, ['regionId']);
  if (!directoryUuid(value.regionId)) invalidDirectory();
  return Object.freeze({ regionId: value.regionId });
}
export function decodeDirectoryCategory(value: unknown): DirectoryCategory {
  exact(value, ['id', 'kind', 'name', 'description', 'accent']);
  if (
    !directoryUuid(value.id) ||
    !isDirectoryKind(value.kind) ||
    !text(value.name) ||
    !value.name ||
    !text(value.description) ||
    !(directoryAccents as readonly unknown[]).includes(value.accent)
  )
    invalidDirectory();
  return Object.freeze({ ...value }) as unknown as DirectoryCategory;
}
function media(
  value: unknown,
  inapplicable = false,
): DirectoryMedia | NotApplicable {
  exact(value, ['status', 'value']);
  if (
    value.value !== null ||
    (inapplicable
      ? value.status !== 'not_applicable'
      : !['absent', 'unavailable'].includes(value.status as string))
  )
    invalidDirectory();
  return Object.freeze({ ...value }) as DirectoryMedia | NotApplicable;
}
function fact<T>(
  value: unknown,
  valid: (value: unknown) => value is T,
): DirectoryFact<T> {
  exact(value, ['status', 'value']);
  if (
    value.status === 'known'
      ? value.value !== null && !valid(value.value)
      : value.status !== 'unavailable' || value.value !== null
  )
    invalidDirectory();
  return Object.freeze({ ...value }) as DirectoryFact<T>;
}
const entryKeys = [
  'id',
  'categoryId',
  'kind',
  'platform',
  'name',
  'introPreview',
  'badge',
  'avatar',
] as const;
function entry(value: Record<string, unknown>): DirectoryEntry {
  if (
    !directoryUuid(value.id) ||
    !directoryUuid(value.categoryId) ||
    !isDirectoryKind(value.kind) ||
    !['qq', 'wechat', 'official'].includes(value.platform as string) ||
    !text(value.name) ||
    !value.name ||
    !text(value.introPreview)
  )
    invalidDirectory();
  return Object.freeze({
    id: value.id,
    categoryId: value.categoryId,
    kind: value.kind,
    platform: value.platform as DirectoryPlatform,
    name: value.name,
    introPreview: value.introPreview,
    badge: fact(value.badge, (v): v is 'normal' | 'official' | 'partner' =>
      ['normal', 'official', 'partner'].includes(v as string),
    ),
    avatar: media(value.avatar) as DirectoryMedia,
  });
}
export function decodeDirectoryEntry(value: unknown): DirectoryEntry {
  exact(value, entryKeys);
  return entry(value);
}
export function decodeDirectoryDetail(value: unknown): DirectoryDetail {
  exact(value, [
    ...entryKeys,
    'introText',
    'introImages',
    'mainQr',
    'managerWechatImage',
    'linkedOfficialAccountQr',
    'qqGroupNumber',
    'createdAt',
    'updatedAt',
    'visits',
    'managers',
    'management',
  ]);
  const base = entry(value);
  if (
    !text(value.introText) ||
    (value.createdAt !== null && !timestamp(value.createdAt)) ||
    (value.updatedAt !== null && !timestamp(value.updatedAt))
  )
    invalidDirectory();
  exact(value.introImages, ['status', 'items']);
  if (
    value.introImages.status === 'known'
      ? !Array.isArray(value.introImages.items) ||
        value.introImages.items.length !== 0
      : value.introImages.status !== 'unavailable' ||
        value.introImages.items !== null
  )
    invalidDirectory();
  exact(value.visits, ['status', 'value']);
  exact(value.managers, ['status', 'items']);
  exact(value.management, ['status']);
  if (
    value.visits.status !== 'unavailable' ||
    value.visits.value !== null ||
    value.managers.status !== 'unavailable' ||
    value.managers.items !== null ||
    value.management.status !== 'unavailable'
  )
    invalidDirectory();
  const qqGroupNumber =
    base.platform === 'qq'
      ? fact(
          value.qqGroupNumber,
          (v): v is string => typeof v === 'string' && /^[0-9]{5,16}$/.test(v),
        )
      : (media(value.qqGroupNumber, true) as NotApplicable);
  return Object.freeze({
    ...base,
    introText: value.introText,
    introImages: Object.freeze(
      value.introImages.status === 'known'
        ? { status: 'known' as const, items: Object.freeze([]) as readonly [] }
        : { status: 'unavailable' as const, items: null },
    ),
    mainQr: media(value.mainQr) as DirectoryMedia,
    managerWechatImage: media(
      value.managerWechatImage,
      base.platform !== 'wechat',
    ),
    linkedOfficialAccountQr: media(
      value.linkedOfficialAccountQr,
      base.platform === 'official',
    ),
    qqGroupNumber,
    createdAt: value.createdAt as string | null,
    updatedAt: value.updatedAt as string | null,
    visits: Object.freeze({ status: 'unavailable', value: null }),
    managers: Object.freeze({ status: 'unavailable', items: null }),
    management: Object.freeze({ status: 'unavailable' }),
  });
}
function page<T extends { readonly id: string }>(
  value: unknown,
  decode: (value: unknown) => T,
): DirectoryPage<T> {
  exact(value, ['items', 'continuation', 'nextCursor']);
  if (
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    (value.continuation === 'end'
      ? value.nextCursor !== null
      : value.continuation !== 'more' ||
        !directoryCursor(value.nextCursor) ||
        value.items.length === 0)
  )
    invalidDirectory();
  const items = value.items.map(decode);
  if (new Set(items.map((item) => item.id)).size !== items.length)
    invalidDirectory();
  return Object.freeze({
    items: Object.freeze(items),
    continuation: value.continuation as 'more' | 'end',
    nextCursor: value.nextCursor as string | null,
  });
}
export const decodeDirectoryCategoryPage = (
  value: unknown,
): DirectoryPage<DirectoryCategory> => page(value, decodeDirectoryCategory);
export const decodeDirectoryEntryPage = (
  value: unknown,
): DirectoryPage<DirectoryEntry> => page(value, decodeDirectoryEntry);
export function decodeDirectoryListIntent(value: unknown): DirectoryListIntent {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !['regionId', 'kind', 'categoryId', 'q'].includes(key),
    ) ||
    !directoryUuid(value.regionId) ||
    !isDirectoryKind(value.kind) ||
    (value.categoryId !== undefined && !directoryUuid(value.categoryId)) ||
    (value.q === undefined && value.categoryId === undefined)
  )
    invalidDirectory();
  return Object.freeze({
    regionId: value.regionId,
    kind: value.kind,
    ...(value.categoryId !== undefined ? { categoryId: value.categoryId } : {}),
    ...(value.q !== undefined ? { q: canonicalDirectoryQuery(value.q) } : {}),
  });
}
