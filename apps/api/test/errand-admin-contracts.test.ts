import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  errandAdminQuerySchema,
  errandAdminTotalSchema,
  errandAdminOrderSchema,
} from '../src/errands/admin-contracts.js';
import { matchesErrandAdmin } from '../src/errands/admin-service.js';

test('admin inputs preserve literal Unicode and six exact status filters', () => {
  assert.deepEqual(errandAdminQuerySchema.parse({}), {
    status: 'all',
    keyword: '',
    limit: 20,
  });
  for (const status of [
    'all',
    'pending',
    'accepted',
    'completed',
    'cancelled',
    'deleted',
  ])
    assert.equal(errandAdminQuerySchema.parse({ status }).status, status);
  assert.equal(
    errandAdminQuerySchema.parse({ keyword: '  %_🐋\r\n  ' }).keyword,
    '%_🐋',
  );
  assert.equal(
    errandAdminQuerySchema.parse({ keyword: '🐋'.repeat(100) }).keyword.length,
    200,
  );
  for (const bad of [
    { status: 'banned' },
    { limit: 51 },
    { limit: 0 },
    { keyword: '🐋'.repeat(101) },
    { regionId: '1' },
    { accountId: randomUUID() },
    { status: ['all', 'pending'] },
    { keyword: 'bad\u0000' },
  ])
    assert.equal(errandAdminQuerySchema.safeParse(bad).success, false);
});
test('one public-only match predicate distinguishes unknown profiles and exact references', () => {
  const id = randomUUID(),
    row = {
      title: 'A literal %_鲸鱼',
      public_text: 'Parcel 123',
      accepter_id: null,
    };
  const available = {
    status: 'available' as const,
    profileId: id,
    displayName: 'Alice鲸',
  };
  const missing = { status: 'unavailable' as const };
  for (const word of [
    '',
    '%_',
    '鲸鱼',
    '123',
    'ALICE',
    '鲸',
    id,
    id.toUpperCase(),
  ])
    assert.equal(matchesErrandAdmin(row, available, null, word), true);
  assert.equal(matchesErrandAdmin(row, available, null, id.slice(0, 8)), false);
  assert.equal(matchesErrandAdmin(row, available, null, 'not-found'), false);
  assert.equal(matchesErrandAdmin(row, missing, null, 'not-found'), null);
  assert.equal(matchesErrandAdmin(row, missing, null, 'Parcel'), true);
  assert.equal(
    matchesErrandAdmin(
      { ...row, accepter_id: randomUUID() },
      available,
      missing,
      'not-found',
    ),
    null,
  );
});
test('decimal totals do not lose large integers and admin DTO has no private or action fields', () => {
  assert.deepEqual(
    errandAdminTotalSchema.parse({
      status: 'known',
      value: '9007199254740993123456789',
    }),
    { status: 'known', value: '9007199254740993123456789' },
  );
  for (const value of [0, '01', '-1', '1.0', '1e3'])
    assert.equal(
      errandAdminTotalSchema.safeParse({ status: 'known', value }).success,
      false,
    );
  assert.deepEqual(errandAdminTotalSchema.parse({ status: 'unavailable' }), {
    status: 'unavailable',
  });
  const keys = Object.keys(errandAdminOrderSchema.shape);
  for (const field of [
    'accountId',
    'privateText',
    'publisherContacts',
    'oppositeContact',
    'capabilities',
    'scope',
    'studentNumber',
  ])
    assert.ok(!keys.includes(field));
});
