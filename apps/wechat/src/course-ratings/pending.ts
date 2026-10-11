import { ClientError } from '../api/errors';
import { exact } from '../community/contract';
import type { Storage } from '../platform/contracts';
import {
  courseId,
  decodeCourseFirstScore,
  decodeCourseReceipt,
  invalidCourse,
  matchCourseReceipt,
  type CourseFirstScore,
  type CourseReceipt,
} from './contract';
export interface PendingCourseRating {
  readonly version: 1;
  readonly accountId: string;
  readonly courseId: string;
  readonly payload: CourseFirstScore;
}
const equal = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
const unavailable = (): ClientError =>
  new ClientError('storage', 'Course rating recovery storage unavailable');
function decode(raw: unknown, accountId: string): PendingCourseRating {
  exact(raw, ['version', 'accountId', 'courseId', 'payload']);
  if (
    raw.version !== 1 ||
    !courseId(accountId) ||
    raw.accountId !== accountId ||
    !courseId(raw.courseId)
  )
    invalidCourse();
  return Object.freeze({
    version: 1,
    accountId,
    courseId: raw.courseId,
    payload: decodeCourseFirstScore(raw.payload),
  });
}
/** Dedicated course-only account/origin journal. Never shares the generic mutable 1–5 score path. */
export class PendingCourseRatingStore {
  constructor(
    private readonly storage: Storage,
    private readonly origin: string,
  ) {}
  private key(accountId: string): string {
    if (!courseId(accountId)) throw unavailable();
    return `whaleu.course-rating.pending.v1:${this.origin}:${accountId}`;
  }
  load(accountId: string): PendingCourseRating | null {
    try {
      const raw = this.storage.get(this.key(accountId));
      return raw === undefined || raw === null || raw === ''
        ? null
        : decode(raw, accountId);
    } catch {
      throw unavailable();
    }
  }
  freeze(raw: PendingCourseRating): PendingCourseRating {
    try {
      const value = decode(raw, raw.accountId),
        old = this.load(value.accountId);
      if (old && !equal(old, value)) throw unavailable();
      if (!old) this.storage.set(this.key(value.accountId), value);
      this.assertOriginal(value);
      return value;
    } catch {
      throw unavailable();
    }
  }
  assertOriginal(value: PendingCourseRating): void {
    if (!equal(this.load(value.accountId), value)) throw unavailable();
  }
  settle(value: PendingCourseRating, raw: CourseReceipt): CourseReceipt {
    const result = decodeCourseReceipt(raw);
    matchCourseReceipt(value.courseId, value.payload, result);
    this.assertOriginal(value);
    try {
      this.storage.remove(this.key(value.accountId));
      if (this.load(value.accountId)) throw unavailable();
    } catch {
      // A failed removal/read-back must retain the only recovery key.
      try {
        this.storage.set(this.key(value.accountId), value);
      } catch {
        /* Unknown remains blocked. */
      }
      throw unavailable();
    }
    return result;
  }
}
