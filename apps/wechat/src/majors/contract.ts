import { ClientError, isRecord } from '../api/errors';
import { exact } from '../community/contract';
import { isUuid } from '../profile/contract';

/** Major owns its IDs, catalog and source semantics independently of ratings. */
export const majorId = (value: unknown): value is string =>
  isUuid(value) && value === value.toLowerCase();
export const majorCursor = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 2000;
export const majorDepartment = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= -2147483648 &&
  value <= 2147483647;
export function invalidMajor(): never {
  throw new ClientError('protocol', 'Invalid major directory data');
}
const label = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200;
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
/** Exact text is counted without normalization and without Node/browser globals. */
export function majorTextBytes(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}
export function majorTextBody(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 8000 &&
    value.trim().length > 0 &&
    !value.includes('\u0000') &&
    ![...value].some((character) => {
      const code = character.codePointAt(0)!;
      return code >= 0xd800 && code <= 0xdfff;
    }) &&
    majorTextBytes(value) <= 8000
  );
}
export type MajorSummary =
  | { readonly kind: 'unavailable' }
  | {
      readonly kind: 'known';
      readonly rootCount: number;
      readonly hotComment: {
        readonly id: string;
        readonly body: string;
        readonly likes: number;
      } | null;
    };
export interface Major {
  readonly id: string;
  readonly majorRevision: string;
  readonly catalogRevision: string;
  readonly campusId: string;
  readonly departmentId: number;
  readonly collegeName: string;
  readonly majorName: string;
  readonly summary: MajorSummary;
}
export interface MajorDepartment {
  readonly departmentId: number;
  readonly name: string;
}
export interface MajorDepartments {
  readonly catalogRevision: string;
  readonly items: readonly MajorDepartment[];
}
export interface MajorPage {
  readonly catalogRevision: string;
  readonly items: readonly Major[];
  readonly totalCount: number;
  readonly nextCursor: string | null;
  readonly continuation: 'more' | 'end';
}
export interface MajorDetail {
  readonly catalogRevision: string;
  readonly item: Major;
}
export interface MajorQuery {
  readonly departmentId?: number;
  readonly keyword?: string;
}
export function decodeMajorQuery(value: unknown): MajorQuery {
  if (!isRecord(value)) invalidMajor();
  exact(value, [
    ...('departmentId' in value ? ['departmentId'] : []),
    ...('keyword' in value ? ['keyword'] : []),
  ]);
  if (
    (value.departmentId !== undefined &&
      !majorDepartment(value.departmentId)) ||
    (value.keyword !== undefined &&
      (typeof value.keyword !== 'string' ||
        !value.keyword.length ||
        value.keyword.trim() !== value.keyword ||
        value.keyword.length > 100 ||
        [...value.keyword].some((character) => {
          const code = character.codePointAt(0)!;
          return code < 32 || code === 127;
        })))
  )
    invalidMajor();
  return Object.freeze({
    ...(typeof value.departmentId === 'number'
      ? { departmentId: value.departmentId }
      : {}),
    ...(typeof value.keyword === 'string' ? { keyword: value.keyword } : {}),
  });
}
export function decodeMajorSummary(value: unknown): MajorSummary {
  if (!isRecord(value)) invalidMajor();
  if (value.kind === 'unavailable') {
    exact(value, ['kind']);
    return Object.freeze({ kind: 'unavailable' });
  }
  exact(value, ['kind', 'rootCount', 'hotComment']);
  if (value.kind !== 'known' || !count(value.rootCount)) invalidMajor();
  let hotComment = null;
  if (value.hotComment !== null) {
    exact(value.hotComment, ['id', 'body', 'likes']);
    if (
      !majorId(value.hotComment.id) ||
      !majorTextBody(value.hotComment.body) ||
      !count(value.hotComment.likes)
    )
      invalidMajor();
    hotComment = Object.freeze({
      id: value.hotComment.id,
      body: value.hotComment.body,
      likes: value.hotComment.likes,
    });
  }
  if ((value.rootCount === 0) !== (hotComment === null)) invalidMajor();
  return Object.freeze({
    kind: 'known',
    rootCount: value.rootCount,
    hotComment,
  });
}
export function decodeMajor(value: unknown): Major {
  exact(value, [
    'id',
    'majorRevision',
    'catalogRevision',
    'campusId',
    'departmentId',
    'collegeName',
    'majorName',
    'summary',
  ]);
  if (
    !majorId(value.id) ||
    !majorId(value.majorRevision) ||
    !majorId(value.catalogRevision) ||
    !majorId(value.campusId) ||
    !majorDepartment(value.departmentId) ||
    !label(value.collegeName) ||
    !label(value.majorName)
  )
    invalidMajor();
  return Object.freeze({
    id: value.id,
    majorRevision: value.majorRevision,
    catalogRevision: value.catalogRevision,
    campusId: value.campusId,
    departmentId: value.departmentId,
    collegeName: value.collegeName,
    majorName: value.majorName,
    summary: decodeMajorSummary(value.summary),
  });
}
export function decodeMajorDepartments(value: unknown): MajorDepartments {
  exact(value, ['catalogRevision', 'items']);
  if (
    !majorId(value.catalogRevision) ||
    !Array.isArray(value.items) ||
    value.items.length > 1000
  )
    invalidMajor();
  const items = value.items.map((item) => {
    exact(item, ['departmentId', 'name']);
    if (
      !majorDepartment(item.departmentId) ||
      !label(item.name) ||
      item.name.length > 20
    )
      invalidMajor();
    return Object.freeze({ departmentId: item.departmentId, name: item.name });
  });
  if (
    items.some(
      (item, index) =>
        index > 0 && item.departmentId <= items[index - 1]!.departmentId,
    )
  )
    invalidMajor();
  return Object.freeze({
    catalogRevision: value.catalogRevision,
    items: Object.freeze(items),
  });
}
export function decodeMajorPage(value: unknown): MajorPage {
  exact(value, [
    'catalogRevision',
    'items',
    'totalCount',
    'nextCursor',
    'continuation',
  ]);
  if (
    !majorId(value.catalogRevision) ||
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    !count(value.totalCount) ||
    value.totalCount > 1000 ||
    !(value.nextCursor === null || majorCursor(value.nextCursor)) ||
    !['more', 'end'].includes(String(value.continuation)) ||
    (value.nextCursor === null) !== (value.continuation === 'end') ||
    (value.continuation === 'more' && !value.items.length)
  )
    invalidMajor();
  const items = value.items.map(decodeMajor);
  if (
    items.some((item) => item.catalogRevision !== value.catalogRevision) ||
    new Set(items.map((item) => item.id)).size !== items.length ||
    value.totalCount < items.length
  )
    invalidMajor();
  return Object.freeze({
    catalogRevision: value.catalogRevision,
    items: Object.freeze(items),
    totalCount: value.totalCount,
    nextCursor: value.nextCursor,
    continuation: value.continuation as 'more' | 'end',
  });
}
export function decodeMajorDetail(value: unknown): MajorDetail {
  exact(value, ['catalogRevision', 'item']);
  if (!majorId(value.catalogRevision)) invalidMajor();
  const item = decodeMajor(value.item);
  if (item.catalogRevision !== value.catalogRevision) invalidMajor();
  return Object.freeze({ catalogRevision: value.catalogRevision, item });
}
