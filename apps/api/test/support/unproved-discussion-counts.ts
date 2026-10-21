import type { CurrentDiscussionCount } from '../../src/community/discussion/counts.js';
/** ONLY legacy integration suites replacing canonical authority/review/media.
 * Those synthetic approvals cannot prove production counts. Explicit unknown
 * results keep all actual visibility/pagination/mutation assertions meaningful.
 * large-discussion.test.ts instead uses unmodified AppModule and real proofs. */
export class UnprovedFixtureDiscussionCounts {
  async read(): Promise<CurrentDiscussionCount> {
    return { status: 'unavailable', value: null, optionalUntil: null };
  }
  bind(): void {
    /* No numeric value was produced, so no proof can be registered. */
  }
}
