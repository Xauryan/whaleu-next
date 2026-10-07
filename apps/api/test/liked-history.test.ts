import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  likedPageQuerySchema,
  emptyLikedBodySchema,
} from '../src/community/liked/contracts.js';
import {
  compareLikedAnchors,
  likedCursorScope,
} from '../src/community/liked/cursor.js';
import type { LikedAnchor } from '../src/community/liked/cursor.js';

const owner = randomUUID(),
  session = randomUUID();
const anchor: LikedAnchor = {
  targetKind: 'reply',
  at: '2026-01-01T00:00:00.000Z',
  id: randomUUID(),
};

test('liked query only accepts exact bounded decimal limits and no owner overrides', () => {
  assert.deepEqual(likedPageQuerySchema.parse({}), { limit: 20 });
  for (let limit = 1; limit <= 50; limit++)
    assert.equal(
      likedPageQuerySchema.parse({ limit: String(limit) }).limit,
      limit,
    );
  for (const limit of [
    '0',
    '51',
    '-1',
    '1.0',
    '1e1',
    '0x10',
    '01',
    ' 20 ',
    '',
    ['1'],
    true,
    false,
    null,
    1,
    {},
  ])
    assert.equal(likedPageQuerySchema.safeParse({ limit }).success, false);
  for (const key of [
    'accountId',
    'user_id',
    'profileId',
    'publicProfileId',
    'sessionId',
    'kind',
    'subtype',
  ]) {
    assert.equal(
      likedPageQuerySchema.safeParse({ [key]: randomUUID() }).success,
      false,
    );
    assert.equal(
      emptyLikedBodySchema.safeParse({ [key]: randomUUID() }).success,
      false,
    );
  }
  for (const cursor of ['', 'a='.repeat(10), 'a'.repeat(1025), ['abc'], {}])
    assert.equal(likedPageQuerySchema.safeParse({ cursor }).success, false);
  assert.deepEqual(emptyLikedBodySchema.parse({}), {});
  assert.equal(emptyLikedBodySchema.parse(undefined), undefined);
});
test('liked opaque-coordinate scopes bind account, session and limit', () => {
  const scope = likedCursorScope(owner, session, 20);
  assert.ok(!scope.includes(owner));
  assert.ok(!scope.includes(session));
  assert.equal(scope, likedCursorScope(owner, session, 20));
  assert.notEqual(scope, likedCursorScope(randomUUID(), session, 20));
  assert.notEqual(scope, likedCursorScope(owner, randomUUID(), 20));
  assert.notEqual(scope, likedCursorScope(owner, session, 10));
});
test('liked order retains undated rows after dated rows and deterministically orders ties', () => {
  const ids = Array.from({ length: 5 }, randomUUID).sort();
  const values: LikedAnchor[] = [
    { targetKind: 'post', at: null, id: ids[0]! },
    { targetKind: 'comment', at: '1900-01-01T00:00:00.000Z', id: ids[4]! },
    { targetKind: 'reply', at: null, id: ids[3]! },
    { targetKind: 'post', at: anchor.at, id: ids[1]! },
    { targetKind: 'reply', at: anchor.at, id: ids[2]! },
  ];
  assert.deepEqual(
    values.sort(compareLikedAnchors).map((value) => value.id),
    [ids[2], ids[1], ids[4], ids[3], ids[0]],
  );
  assert.ok(
    compareLikedAnchors(
      { ...anchor, targetKind: 'post' },
      { ...anchor, targetKind: 'reply' },
    ) > 0,
  );
});
