import { ClientError, isRecord } from '../api/errors';
import { exact, timestamp } from '../community/contract';
import { isUuid } from '../profile/contract';

export const courseScoreChoices = Object.freeze([
  0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5,
]);
export const courseId = (value: unknown): value is string =>
  isUuid(value) && value === value.toLowerCase();
export const courseScore = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0.5 &&
  value <= 5 &&
  Number.isInteger(value * 2);
export function invalidCourse(): never {
  throw new ClientError('protocol', 'Invalid course rating data');
}
const text = (
  value: unknown,
  max = 1000,
  nullable = false,
): value is string | null =>
  (nullable && value === null) ||
  (typeof value === 'string' &&
    (nullable || value.length > 0) &&
    [...value].length <= max);
export const courseCursor = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 2000;
export interface CourseScores {
  readonly gradeScore: number;
  readonly abilityScore: number;
  readonly overallScore: number;
}
export type CourseSummary =
  | { readonly kind: 'unavailable' }
  | {
      readonly kind: 'known';
      readonly count: number;
      readonly gradeScore: number | null;
      readonly abilityScore: number | null;
      readonly overallScore: number | null;
    };
export type CourseOwnScore =
  | { readonly kind: 'not_submitted' | 'unavailable' }
  | ({ readonly kind: 'recorded'; readonly recordedAt: string } & CourseScores);
export interface Course {
  readonly id: string;
  readonly revision: string;
  readonly name: string;
  readonly department: number;
  readonly category: string | null;
  readonly nature: string | null;
  readonly code: string | null;
  readonly campusId: string;
  readonly campusLabel: string;
  readonly sourceCampusKey: string;
  readonly createdAt: string;
  readonly summary: CourseSummary;
}
export interface CourseQuery {
  readonly search?: string;
  readonly department?: number;
  readonly category?: string;
  readonly sort: 'rating' | 'time';
}
export interface CoursePage {
  readonly catalogRevision: string;
  readonly scoreRevision: string;
  readonly items: readonly Course[];
  readonly nextCursor: string | null;
  readonly continuation: 'more' | 'end';
}
export interface CourseDetail {
  readonly catalogRevision: string;
  readonly course: Course;
  readonly myScore: CourseOwnScore;
}
export interface CourseFirstScore extends CourseScores {
  readonly clientRequestId: string;
  readonly expectedCatalogRevision: string;
  readonly expectedCourseRevision: string;
}
export type CourseReceipt =
  | {
      readonly requestId: string;
      readonly operation: 'course.first-score.v1';
      readonly outcome: 'rejected';
      readonly courseId: string;
      readonly code: 'COURSE_ALREADY_RATED' | 'COURSE_REVISION_CONFLICT';
    }
  | AppliedCourseReceipt;
export interface AppliedCourseReceipt extends CourseScores {
  readonly requestId: string;
  readonly operation: 'course.first-score.v1';
  readonly outcome: 'applied';
  readonly courseId: string;
  readonly recordedAt: string;
}
const scores = (value: Record<string, unknown>): CourseScores => {
  if (
    !courseScore(value.gradeScore) ||
    !courseScore(value.abilityScore) ||
    !courseScore(value.overallScore)
  )
    invalidCourse();
  return {
    gradeScore: value.gradeScore,
    abilityScore: value.abilityScore,
    overallScore: value.overallScore,
  };
};
export function decodeCourseSummary(value: unknown): CourseSummary {
  if (!isRecord(value)) invalidCourse();
  if (value.kind === 'unavailable') {
    exact(value, ['kind']);
    return Object.freeze({ kind: 'unavailable' });
  }
  exact(value, ['kind', 'count', 'gradeScore', 'abilityScore', 'overallScore']);
  if (
    value.kind !== 'known' ||
    typeof value.count !== 'number' ||
    !Number.isSafeInteger(value.count) ||
    value.count < 0
  )
    invalidCourse();
  for (const axis of ['gradeScore', 'abilityScore', 'overallScore'] as const) {
    const n = value[axis];
    if (
      value.count === 0
        ? n !== null
        : typeof n !== 'number' || !Number.isFinite(n) || n < 0.5 || n > 5
    )
      invalidCourse();
  }
  return Object.freeze({
    kind: 'known',
    count: value.count,
    gradeScore: value.gradeScore as number | null,
    abilityScore: value.abilityScore as number | null,
    overallScore: value.overallScore as number | null,
  });
}
export function decodeCourseOwnScore(value: unknown): CourseOwnScore {
  if (!isRecord(value)) invalidCourse();
  if (value.kind === 'not_submitted' || value.kind === 'unavailable') {
    exact(value, ['kind']);
    return Object.freeze({ kind: value.kind });
  }
  exact(value, [
    'kind',
    'gradeScore',
    'abilityScore',
    'overallScore',
    'recordedAt',
  ]);
  if (value.kind !== 'recorded' || !timestamp(value.recordedAt))
    invalidCourse();
  return Object.freeze({
    kind: 'recorded',
    ...scores(value),
    recordedAt: value.recordedAt,
  });
}
export function decodeCourse(value: unknown): Course {
  exact(value, [
    'id',
    'revision',
    'name',
    'department',
    'category',
    'nature',
    'code',
    'campusId',
    'campusLabel',
    'sourceCampusKey',
    'createdAt',
    'summary',
  ]);
  if (
    !courseId(value.id) ||
    !courseId(value.revision) ||
    !courseId(value.campusId) ||
    !text(value.name, 200) ||
    typeof value.department !== 'number' ||
    !Number.isInteger(value.department) ||
    !(
      (value.department >= 1 && value.department <= 54) ||
      (value.department >= 90 && value.department <= 99)
    ) ||
    !text(value.category, 80, true) ||
    !text(value.nature, 100, true) ||
    !text(value.code, 100, true) ||
    !text(value.campusLabel, 200) ||
    !text(value.sourceCampusKey, 200) ||
    !timestamp(value.createdAt)
  )
    invalidCourse();
  return Object.freeze({
    id: value.id,
    revision: value.revision,
    name: value.name as string,
    department: value.department,
    category: value.category,
    nature: value.nature,
    code: value.code,
    campusId: value.campusId,
    campusLabel: value.campusLabel as string,
    sourceCampusKey: value.sourceCampusKey as string,
    createdAt: value.createdAt,
    summary: decodeCourseSummary(value.summary),
  });
}
export function decodeCoursePage(value: unknown): CoursePage {
  exact(value, [
    'catalogRevision',
    'scoreRevision',
    'items',
    'nextCursor',
    'continuation',
  ]);
  if (
    !courseId(value.catalogRevision) ||
    typeof value.scoreRevision !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(value.scoreRevision) ||
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    !(value.nextCursor === null || courseCursor(value.nextCursor)) ||
    !['more', 'end'].includes(String(value.continuation)) ||
    (value.nextCursor === null) !== (value.continuation === 'end') ||
    (value.continuation === 'more' && value.items.length === 0)
  )
    invalidCourse();
  const items = value.items.map(decodeCourse);
  if (new Set(items.map((item) => item.id)).size !== items.length)
    invalidCourse();
  return Object.freeze({
    catalogRevision: value.catalogRevision,
    scoreRevision: value.scoreRevision as string,
    items: Object.freeze(items),
    nextCursor: value.nextCursor,
    continuation: value.continuation as 'more' | 'end',
  });
}
export function decodeCourseDetail(value: unknown): CourseDetail {
  exact(value, ['catalogRevision', 'course', 'myScore']);
  if (!courseId(value.catalogRevision)) invalidCourse();
  return Object.freeze({
    catalogRevision: value.catalogRevision,
    course: decodeCourse(value.course),
    myScore: decodeCourseOwnScore(value.myScore),
  });
}
export function decodeCourseFirstScore(value: unknown): CourseFirstScore {
  exact(value, [
    'clientRequestId',
    'expectedCatalogRevision',
    'expectedCourseRevision',
    'gradeScore',
    'abilityScore',
    'overallScore',
  ]);
  if (
    !courseId(value.clientRequestId) ||
    !courseId(value.expectedCatalogRevision) ||
    !courseId(value.expectedCourseRevision)
  )
    invalidCourse();
  return Object.freeze({
    clientRequestId: value.clientRequestId,
    expectedCatalogRevision: value.expectedCatalogRevision,
    expectedCourseRevision: value.expectedCourseRevision,
    ...scores(value),
  });
}
export function decodeCourseReceipt(value: unknown): CourseReceipt {
  if (!isRecord(value)) invalidCourse();
  exact(
    value,
    value.outcome === 'rejected'
      ? ['requestId', 'operation', 'outcome', 'courseId', 'code']
      : [
          'requestId',
          'operation',
          'outcome',
          'courseId',
          'gradeScore',
          'abilityScore',
          'overallScore',
          'recordedAt',
        ],
  );
  if (
    !courseId(value.requestId) ||
    !courseId(value.courseId) ||
    value.operation !== 'course.first-score.v1'
  )
    invalidCourse();
  if (value.outcome === 'rejected') {
    if (
      value.code !== 'COURSE_ALREADY_RATED' &&
      value.code !== 'COURSE_REVISION_CONFLICT'
    )
      invalidCourse();
    return Object.freeze({
      requestId: value.requestId,
      operation: value.operation,
      outcome: value.outcome,
      courseId: value.courseId,
      code: value.code,
    });
  }
  if (value.outcome !== 'applied' || !timestamp(value.recordedAt))
    invalidCourse();
  return Object.freeze({
    requestId: value.requestId,
    operation: value.operation,
    outcome: value.outcome,
    courseId: value.courseId,
    ...scores(value),
    recordedAt: value.recordedAt,
  });
}
export function matchCourseReceipt(
  course: string,
  intent: CourseFirstScore,
  receipt: CourseReceipt,
): void {
  if (
    receipt.courseId !== course ||
    receipt.requestId !== intent.clientRequestId ||
    (receipt.outcome === 'applied' &&
      (receipt.gradeScore !== intent.gradeScore ||
        receipt.abilityScore !== intent.abilityScore ||
        receipt.overallScore !== intent.overallScore))
  )
    invalidCourse();
}
export function decodeCourseQuery(value: unknown): CourseQuery {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !['search', 'department', 'category', 'sort'].includes(key),
    ) ||
    !['rating', 'time'].includes(String(value.sort)) ||
    (value.department !== undefined && value.category !== undefined)
  )
    invalidCourse();
  if (
    value.department !== undefined &&
    (typeof value.department !== 'number' ||
      !Number.isInteger(value.department) ||
      !(
        (value.department >= 1 && value.department <= 54) ||
        value.department === 99
      ))
  )
    invalidCourse();
  const queryText = (raw: unknown): string => {
    if (
      typeof raw !== 'string' ||
      !raw.trim() ||
      [...raw.trim()].length > 80 ||
      [...raw].some((character) => {
        const code = character.codePointAt(0)!;
        return (
          code < 32 ||
          (code >= 127 && code <= 159) ||
          (code >= 0xd800 && code <= 0xdfff)
        );
      })
    )
      invalidCourse();
    return raw.trim();
  };
  return Object.freeze({
    sort: value.sort as CourseQuery['sort'],
    ...(value.search === undefined ? {} : { search: queryText(value.search) }),
    ...(value.department === undefined
      ? {}
      : { department: value.department as number }),
    ...(value.category === undefined
      ? {}
      : { category: queryText(value.category) }),
  });
}
