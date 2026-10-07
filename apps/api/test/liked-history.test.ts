import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import {
  likedPageQuerySchema,
  emptyLikedBodySchema,
} from '../src/community/liked/contracts.js';
import {
  compareLikedAnchors,
  decodeLikedCursor,
  encodeLikedCursor,
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
test('liked cursors bind account, session, limit and kind without carrying private identifiers', () => {
  const cursor = encodeLikedCursor(anchor, owner, session, 20);
  assert.deepEqual(decodeLikedCursor(cursor, owner, session, 20), anchor);
  assert.deepEqual(
    decodeLikedCursor(
      encodeLikedCursor({ ...anchor, at: null }, owner, session, 20),
      owner,
      session,
      20,
    ),
    { ...anchor, at: null },
  );
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  assert.ok(!raw.includes(owner));
  assert.ok(!raw.includes(session));
  assert.ok(!raw.includes('accountId'));
  for (const [otherOwner, otherSession, limit] of [
    [randomUUID(), session, 20],
    [owner, randomUUID(), 20],
    [owner, session, 10],
  ] as const)
    assert.throws(
      () => decodeLikedCursor(cursor, otherOwner, otherSession, limit),
      BadRequestException,
    );
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  for (const patch of [
    { v: 2 },
    { kind: 'profile_posts' },
    { scope: 'bad' },
    { targetKind: 'saved' },
    { at: '2026-01-01' },
    { at: '2026-01-01T00:00:00Z' },
    { id: '1' },
    { accountId: owner },
    { limit: 51 },
    { after: anchor },
  ]) {
    const changed = Buffer.from(
      JSON.stringify({ ...parsed, ...patch }),
    ).toString('base64url');
    assert.throws(
      () => decodeLikedCursor(changed, owner, session, 20),
      BadRequestException,
    );
  }
  for (const bad of [
    '',
    cursor + '=',
    '*',
    'x'.repeat(1025),
    Buffer.from('null').toString('base64url'),
  ])
    assert.throws(
      () => decodeLikedCursor(bad, owner, session, 20),
      BadRequestException,
    );
  assert.equal(decodeLikedCursor(undefined, owner, session, 20), null);
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
