import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatSchoolUid,
  schoolUidInputSchema,
  schoolUidValueSchema,
  schoolUidSchema,
  schoolUidLookupQuerySchema,
  schoolUidLookupSchema,
} from '../src/school-uid/contracts.js';
test('school UID decimal contract preserves every bigint and never accepts numeric JSON', () => {
  for (const value of [
    '1',
    '999999',
    '1000000',
    '9007199254740993',
    '9223372036854775807',
  ]) {
    assert.equal(schoolUidValueSchema.parse(value), value);
    assert.equal(schoolUidInputSchema.parse(value), value);
    assert.equal(formatSchoolUid(value), value.padStart(6, '0'));
  }
  assert.equal(schoolUidInputSchema.parse('000001'), '1');
  assert.equal(schoolUidInputSchema.parse('0000000000000000001'), '1');
  for (const value of [
    1,
    Number('9007199254740993'),
    null,
    '',
    '0',
    '0000',
    ' 1',
    '1 ',
    '+1',
    '-1',
    '1e3',
    '1.0',
    '１２３',
    '1x',
    '9223372036854775808',
    '00000000000000000001',
  ])
    assert.equal(
      schoolUidInputSchema.safeParse(value).success,
      false,
      String(value),
    );
  assert.equal(schoolUidValueSchema.safeParse('000001').success, false);
});
test('school UID assigned output is strict and ties canonical number to its exact formatting', () => {
  const assigned = {
    status: 'assigned',
    school: { code: '12345', name: '合成学校' },
    uid: '9007199254740993',
    formattedUid: '9007199254740993',
  };
  assert.deepEqual(schoolUidSchema.parse(assigned), assigned);
  for (const value of [
    { ...assigned, uid: 1 },
    { ...assigned, uid: '0' },
    { ...assigned, uid: '9223372036854775808' },
    { ...assigned, formattedUid: '000001' },
    { ...assigned, school: { ...assigned.school, institutionId: 'private' } },
    { ...assigned, allocationId: 'private' },
    { status: 'unavailable', school: assigned.school },
    { status: 'unassigned', uid: '1' },
  ])
    assert.equal(schoolUidSchema.safeParse(value).success, false);
  assert.deepEqual(schoolUidSchema.parse({ status: 'unavailable' }), {
    status: 'unavailable',
  });
});
test('lookup requires exact school namespace and only returns an existing public profile reference', () => {
  assert.deepEqual(
    schoolUidLookupQuerySchema.parse({ schoolCode: '12345', uid: '000123' }),
    { schoolCode: '12345', uid: '123' },
  );
  for (const query of [
    { schoolCode: '1234', uid: '1' },
    { schoolCode: 12345, uid: '1' },
    { schoolCode: '12345', uid: '1', accountId: 'hidden' },
    { uid: '1' },
  ])
    assert.equal(schoolUidLookupQuerySchema.safeParse(query).success, false);
  assert.equal(
    schoolUidLookupSchema.safeParse({
      status: 'found',
      target: {
        profileId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        displayName: '合成',
        accountId: 'hidden',
      },
    }).success,
    false,
  );
});
