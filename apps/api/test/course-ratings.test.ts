import type { PoolClient } from 'pg';
import {
  currentCatalog,
  currentHistory,
} from '../src/ratings/courses/proof.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  courseFirstScoreSchema,
  courseQuerySchema,
  courseSummarySchema,
  courseReceiptSchema,
} from '../src/ratings/courses/contracts.js';
import { courseIntentHash } from '../src/ratings/courses/service.js';
const baseline = {
  clientRequestId: randomUUID(),
  expectedCatalogRevision: randomUUID(),
  expectedCourseRevision: randomUUID(),
  gradeScore: 0.5,
  abilityScore: 3,
  overallScore: 5,
};
test('every course axis independently accepts all ten half-steps and rejects missing/coerced/non-half scores', () => {
  for (const axis of ['gradeScore', 'abilityScore', 'overallScore'] as const) {
    for (let half = 1; half <= 10; half++)
      assert.equal(
        courseFirstScoreSchema.parse({ ...baseline, [axis]: half / 2 })[axis],
        half / 2,
      );
    for (const invalid of [
      undefined,
      null,
      '3',
      true,
      {},
      [],
      0,
      0.1,
      0.75,
      5.5,
      -0.5,
      Infinity,
      NaN,
    ])
      assert.equal(
        courseFirstScoreSchema.safeParse({ ...baseline, [axis]: invalid })
          .success,
        false,
        String(invalid),
      );
  }
  assert.equal(
    courseFirstScoreSchema.safeParse({ ...baseline, user_id: randomUUID() })
      .success,
    false,
  );
  assert.equal(
    courseFirstScoreSchema.safeParse({ ...baseline, openid: 'untrusted' })
      .success,
    false,
  );
  assert.deepEqual(
    courseFirstScoreSchema.parse(baseline),
    baseline,
    'overall is its own answer',
  );
});
test('exclusive department/category and executable legacy99 group; name query and bounded continuation', () => {
  for (const department of ['1', '54', '99'])
    assert.equal(courseQuerySchema.safeParse({ department }).success, true);
  for (const department of ['0', '55', '90', '98', '100', '01'])
    assert.equal(courseQuerySchema.safeParse({ department }).success, false);
  assert.equal(
    courseQuerySchema.safeParse({ department: '99', category: 'x' }).success,
    false,
  );
  assert.equal(courseQuerySchema.safeParse({ limit: '51' }).success, false);
  assert.equal(
    courseQuerySchema.safeParse({ search: 'x'.repeat(81) }).success,
    false,
  );
  assert.equal(
    courseQuerySchema.safeParse({ university_id: 1 }).success,
    false,
  );
});
test('unknown history is never zero or not-submitted; summary axes are independent', () => {
  assert.equal(
    courseSummarySchema.safeParse({
      kind: 'known',
      count: 0,
      gradeScore: 0,
      abilityScore: 0,
      overallScore: 0,
    }).success,
    false,
  );
  assert.deepEqual(
    courseSummarySchema.parse({
      kind: 'known',
      count: 0,
      gradeScore: null,
      abilityScore: null,
      overallScore: null,
    }),
    {
      kind: 'known',
      count: 0,
      gradeScore: null,
      abilityScore: null,
      overallScore: null,
    },
  );
  assert.equal(
    courseSummarySchema.safeParse({
      kind: 'known',
      count: 1,
      gradeScore: null,
      abilityScore: 3,
      overallScore: 4,
    }).success,
    false,
  );
  assert.deepEqual(courseSummarySchema.parse({ kind: 'unavailable' }), {
    kind: 'unavailable',
  });
});
test('course commands are separately typed and hash exact actor/course/original tuple', () => {
  const actor = randomUUID(),
    course = randomUUID(),
    hash = courseIntentHash(actor, course, baseline);
  assert.equal(hash, courseIntentHash(actor, course, { ...baseline }));
  assert.notEqual(
    hash,
    courseIntentHash(actor, course, { ...baseline, overallScore: 1 }),
  );
  assert.notEqual(hash, courseIntentHash(randomUUID(), course, baseline));
  assert.equal(
    courseReceiptSchema.safeParse({
      requestId: baseline.clientRequestId,
      operation: 'set_score_scoped',
      courseId: course,
      outcome: 'applied',
      score: 3,
    }).success,
    false,
  );
});

test('initial authority uses exact database current-time result, never millisecond-truncated Date equality', async () => {
  const rounded = new Date('2026-10-11T12:00:00.000Z');
  // Two different PostgreSQL microsecond instants can become the same JS Date.
  // The owner must honor the SQL boolean even if all projected Date values match.
  const tx = {
    query: async (sql: string) => ({
      rows: [
        {
          id: randomUUID(),
          state: 'accepted',
          coverage: sql.includes('course_history_heads')
            ? 'accepted_empty'
            : 'complete',
          scope_policy: 'authenticated_phone',
          accepted_at: rounded,
          valid_until: new Date(rounded.getTime() + 1000),
          is_current: false,
          fingerprint: ['future by a fraction of a millisecond'],
        },
      ],
    }),
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  try {
    await assert.rejects(
      currentCatalog(tx),
      (error: unknown) =>
        (error as { code?: string }).code === 'COURSE_CATALOG_UNAVAILABLE',
    );
    assert.equal(await currentHistory(randomUUID(), tx), null);
  } finally {
    clearTransactionDeadlines(tx);
  }
});
