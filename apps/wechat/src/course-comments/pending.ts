import { ClientError } from '../api/errors';
import { exact } from '../community/contract';
import type { Storage } from '../platform/contracts';
import { courseId, invalidCourse } from '../course-ratings/contract';
import {
  decodeCourseCommentIntent,
  decodeCourseCommentReceipt,
  matchCourseCommentReceipt,
  type CourseCommentIntent,
  type CourseCommentReceipt,
} from './contract';
export interface PendingCourseComment {
  readonly version: 1;
  readonly accountId: string;
  readonly intent: CourseCommentIntent;
}
const equal = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
const unavailable = (): ClientError =>
  new ClientError('storage', 'Course comment recovery storage unavailable');
function decode(raw: unknown, accountId: string): PendingCourseComment {
  exact(raw, ['version', 'accountId', 'intent']);
  if (raw.version !== 1 || !courseId(accountId) || raw.accountId !== accountId)
    invalidCourse();
  return Object.freeze({
    version: 1,
    accountId,
    intent: decodeCourseCommentIntent(raw.intent),
  });
}
/** Separate account/origin journal. Navigation or a receipt miss never means cancellation. */
export class PendingCourseCommentStore {
  constructor(
    private readonly storage: Storage,
    private readonly origin: string,
  ) {}
  private key(accountId: string): string {
    if (!courseId(accountId)) throw unavailable();
    return `whaleu.course-comments.pending.v1:${this.origin}:${accountId}`;
  }
  load(accountId: string): PendingCourseComment | null {
    try {
      const value = this.storage.get(this.key(accountId));
      return value === undefined || value === null || value === ''
        ? null
        : decode(value, accountId);
    } catch {
      throw unavailable();
    }
  }
  freeze(raw: PendingCourseComment): PendingCourseComment {
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
  assertOriginal(value: PendingCourseComment): void {
    if (!equal(this.load(value.accountId), value)) throw unavailable();
  }
  settle(
    value: PendingCourseComment,
    raw: CourseCommentReceipt,
  ): CourseCommentReceipt {
    const result = decodeCourseCommentReceipt(raw);
    matchCourseCommentReceipt(value.intent, result);
    this.assertOriginal(value);
    try {
      this.storage.remove(this.key(value.accountId));
      if (this.load(value.accountId)) throw unavailable();
    } catch {
      try {
        this.storage.set(this.key(value.accountId), value);
      } catch {
        /* Keep blocked. */
      }
      throw unavailable();
    }
    return result;
  }
}
