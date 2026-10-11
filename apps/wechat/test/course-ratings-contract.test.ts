import assert from 'node:assert/strict';
import test from 'node:test';
import {
  courseScoreChoices,
  decodeCourse,
  decodeCourseDetail,
  decodeCourseFirstScore,
  decodeCourseOwnScore,
  decodeCoursePage,
  decodeCourseQuery,
  decodeCourseReceipt,
  decodeCourseSummary,
  matchCourseReceipt,
} from '../src/course-ratings/contract';
import {
  catalogRevision,
  course,
  detail,
  id,
  otherId,
  page,
  payload,
  receipt,
} from './course-ratings-helpers';

test('all ten half-step choices are independent on all three course axes', () => {
  assert.equal(courseScoreChoices.length, 10);
  for (const gradeScore of courseScoreChoices)
    for (const abilityScore of courseScoreChoices)
      for (const overallScore of courseScoreChoices) {
        assert.deepEqual(
          decodeCourseFirstScore(
            payload({ gradeScore, abilityScore, overallScore }),
          ),
          payload({ gradeScore, abilityScore, overallScore }),
        );
      }
  for (const value of [0, 0.25, 0.75, 5.5, NaN, Infinity, '0.5', null])
    for (const axis of ['gradeScore', 'abilityScore', 'overallScore'])
      assert.throws(() =>
        decodeCourseFirstScore({ ...payload(), [axis]: value }),
      );
  assert.throws(() => decodeCourseFirstScore({ ...payload(), score: 4 }));
});
test('course catalog preserves the source fields and only explicit legacy departments group under 99', () => {
  assert.deepEqual(decodeCourse(course()), course());
  for (const department of [1, 54, 90, 95, 99])
    assert.equal(decodeCourse(course({ department })).department, department);
  for (const department of [0, 55, 89, 100])
    assert.throws(() => decodeCourse(course({ department })));
  assert.deepEqual(decodeCourseQuery({ sort: 'rating', department: 99 }), {
    sort: 'rating',
    department: 99,
  });
  assert.throws(() =>
    decodeCourseQuery({ sort: 'rating', department: 1, category: '课程' }),
  );
  assert.throws(() => decodeCourseQuery({ sort: 'rating', department: 90 }));
  assert.throws(() =>
    decodeCourseQuery({ sort: 'rating', search: 'x'.repeat(81) }),
  );
  assert.throws(() => decodeCourseQuery({ sort: 'rating', regionId: id }));
});
test('unavailable is never own not-submitted or known-empty summary; no derived overall average', () => {
  assert.deepEqual(decodeCourseOwnScore({ kind: 'unavailable' }), {
    kind: 'unavailable',
  });
  assert.deepEqual(decodeCourseOwnScore({ kind: 'not_submitted' }), {
    kind: 'not_submitted',
  });
  assert.throws(() =>
    decodeCourseOwnScore({ kind: 'not_submitted', accountId: id }),
  );
  assert.deepEqual(
    decodeCourseSummary({
      kind: 'known',
      count: 3,
      gradeScore: 1 / 3 + 1,
      abilityScore: 4.5,
      overallScore: 0.5,
    }),
    {
      kind: 'known',
      count: 3,
      gradeScore: 1 / 3 + 1,
      abilityScore: 4.5,
      overallScore: 0.5,
    },
  );
  assert.throws(() =>
    decodeCourseSummary({
      kind: 'known',
      count: 0,
      gradeScore: 0,
      abilityScore: 0,
      overallScore: 0,
    }),
  );
  assert.throws(() =>
    decodeCourseSummary({
      kind: 'known',
      count: 1,
      gradeScore: null,
      abilityScore: 1,
      overallScore: 1,
    }),
  );
  assert.throws(() => decodeCourseSummary({ kind: 'unavailable', count: 0 }));
});
test('catalog/detail reject unknown fields, duplicate course IDs and invalid revisions', () => {
  assert.deepEqual(decodeCourseDetail(detail()), detail());
  assert.deepEqual(decodeCoursePage(page({ items: [] })), page({ items: [] }));
  for (const raw of [
    page({ items: [course(), course()] }),
    page({ scoreRevision: '0' }),
    page({ catalogRevision: 'not-a-revision' }),
    { ...page(), nextCursor: 'abc', continuation: 'end' },
    { ...page(), secret: 'no' },
  ])
    assert.throws(() => decodeCoursePage(raw));
  assert.throws(() => decodeCourseDetail({ ...detail(), accountId: id }));
});
test('only an exact original course/request/tuple or typed rejected receipt settles', () => {
  const input = payload();
  matchCourseReceipt(id, input, decodeCourseReceipt(receipt()));
  for (const raw of [
    receipt(input, otherId),
    receipt({ ...input, overallScore: 5 }),
    { ...receipt(), requestId: otherId },
  ])
    assert.throws(() =>
      matchCourseReceipt(id, input, decodeCourseReceipt(raw)),
    );
  for (const code of ['COURSE_ALREADY_RATED', 'COURSE_REVISION_CONFLICT'])
    matchCourseReceipt(
      id,
      input,
      decodeCourseReceipt({
        requestId: input.clientRequestId,
        operation: 'course.first-score.v1',
        outcome: 'rejected',
        courseId: id,
        code,
      }),
    );
  assert.throws(() =>
    decodeCourseReceipt({
      requestId: input.clientRequestId,
      operation: 'course.first-score.v1',
      outcome: 'rejected',
      courseId: id,
      code: 'REQUEST_NOT_FOUND',
    }),
  );
  assert.notEqual(input.expectedCourseRevision, catalogRevision);
});
