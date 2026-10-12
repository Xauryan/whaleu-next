import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  majorDepartmentIdSchema,
  majorQuerySchema,
  majorRelatedQuerySchema,
  majorSummarySchema,
  majorSchema,
  majorDetailSchema,
  majorDepartmentsSchema,
} from '../src/majors/contracts.js';

test('Major department keys retain original int32 domain, independent of Course ranges', () => {
  for (const departmentId of [-2147483648, -1, 0, 55, 89, 100, 2147483647]) {
    assert.equal(majorDepartmentIdSchema.parse(departmentId), departmentId);
    assert.equal(
      majorQuerySchema.parse({ departmentId: String(departmentId) })
        .departmentId,
      departmentId,
    );
  }
  for (const departmentId of [
    '01',
    '+1',
    '-0',
    '1.0',
    '2147483648',
    '-2147483649',
    1,
    null,
    [],
  ])
    assert.equal(majorQuerySchema.safeParse({ departmentId }).success, false);
});

test('Major combined name/college filter and pagination are bounded and strict', () => {
  assert.deepEqual(
    majorQuerySchema.parse({
      departmentId: '55',
      keyword: '  计算机  ',
      limit: '2',
    }),
    {
      departmentId: 55,
      keyword: '计算机',
      limit: 2,
    },
  );
  assert.deepEqual(majorQuerySchema.parse({}), { limit: 20 });
  assert.deepEqual(majorRelatedQuerySchema.parse({}), { limit: 5 });
  for (const value of [
    { keyword: '' },
    { keyword: '   ' },
    { keyword: 'a'.repeat(101) },
    { keyword: 'a\u0000b' },
    { keyword: 'a\nb' },
    { limit: '0' },
    { limit: '51' },
    { limit: 20 },
    { cursor: '' },
    { courseCode: 'M01' },
    { canteenIds: randomUUID() },
    { minRating: '1' },
    { actorId: randomUUID() },
    { universityId: 1 },
  ])
    assert.equal(majorQuerySchema.safeParse(value).success, false);
  for (const value of [
    { cursor: 'cursor' },
    { departmentId: '1' },
    { limit: '51' },
  ])
    assert.equal(majorRelatedQuerySchema.safeParse(value).success, false);
});

test('Major summaries express exact root count/hot text or unavailable, never score or creator claims', () => {
  const empty = { kind: 'known', rootCount: 0, hotComment: null },
    populated = {
      kind: 'known',
      rootCount: 2,
      hotComment: { id: randomUUID(), body: '  原文  ', likes: 3 },
    };
  assert.deepEqual(majorSummarySchema.parse(empty), empty);
  assert.deepEqual(majorSummarySchema.parse(populated), populated);
  assert.deepEqual(majorSummarySchema.parse({ kind: 'unavailable' }), {
    kind: 'unavailable',
  });
  for (const value of [
    { ...empty, rootCount: 1 },
    { ...populated, hotComment: { ...populated.hotComment, body: ' ' } },
    {
      ...populated,
      hotComment: { ...populated.hotComment, body: '🍱'.repeat(2001) },
    },
    { ...populated, rootCount: 0 },
    { ...empty, ratingCount: 0 },
    { ...empty, mean: null },
    { kind: 'unavailable', rootCount: 0 },
    {
      ...populated,
      hotComment: { ...populated.hotComment, actorId: randomUUID() },
    },
  ])
    assert.equal(majorSummarySchema.safeParse(value).success, false);
  const item = {
    id: randomUUID(),
    majorRevision: randomUUID(),
    catalogRevision: randomUUID(),
    campusId: randomUUID(),
    departmentId: 55,
    collegeName: '学院',
    majorName: '专业',
    summary: empty,
  };
  assert.deepEqual(majorSchema.parse(item), item);
  assert.ok(
    majorDetailSchema.safeParse({ catalogRevision: item.catalogRevision, item })
      .success,
  );
  assert.ok(
    majorDepartmentsSchema.safeParse({
      catalogRevision: item.catalogRevision,
      items: [{ departmentId: 55, name: '55系' }],
    }).success,
  );
  for (const extra of [
    { creatorId: randomUUID() },
    { creatorNotice: 'unavailable' },
    { degree: '工学学士' },
    { duration: '四年' },
    { score: 5 },
    { sourceSchoolKey: '1' },
  ])
    assert.equal(majorSchema.safeParse({ ...item, ...extra }).success, false);
});
