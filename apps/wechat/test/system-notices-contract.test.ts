import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeSystemNotice,
  decodeSystemNoticeRead,
  decodeSystemNoticesList,
  decodeSystemNoticesUnread,
} from '../src/community/system-notices-contract';
import { createdAt, otherId, requestId } from './community-helpers';
import { systemNotice, systemNotices } from './system-notices-helpers';

test('system notices decode only source-free removal outcomes with canonical UTC milliseconds', () => {
  for (const notice of [
    systemNotice(),
    systemNotice({ keepVotes: 0, removeVotes: 1 }),
    systemNotice({ keepVotes: 0, removeVotes: 6, readAt: createdAt }),
  ]) {
    assert.deepEqual(decodeSystemNotice(notice), notice);
    assert.ok(Object.isFrozen(decodeSystemNotice(notice)));
  }
  const value = systemNotices([systemNotice()], 'opaque_cursor', 25);
  const decoded = decodeSystemNoticesList(value);
  assert.deepEqual(decoded, value);
  assert.ok(Object.isFrozen(decoded));
  assert.ok(Object.isFrozen(decoded.items));
});

test('system notices reject every extra source, identity, content and lifecycle field at every DTO boundary', () => {
  for (const key of [
    'postId',
    'source',
    'target',
    'preview',
    'text',
    'images',
    'accountId',
    'author',
    'authorId',
    'reporterId',
    'jurorId',
    'juryId',
    'studentNumber',
    'phone',
    'reason',
    'note',
    'status',
    'deliveredAt',
    'providerStatus',
  ]) {
    for (const [decode, value] of [
      [decodeSystemNotice, systemNotice()],
      [decodeSystemNoticesList, systemNotices()],
      [decodeSystemNoticesUnread, { unreadCount: 1 }],
      [
        decodeSystemNoticeRead,
        { noticeId: requestId, readAt: createdAt, unreadCount: 0 },
      ],
    ] as const)
      assert.throws(() => decode({ ...value, [key]: otherId }), {
        kind: 'protocol',
      });
  }
});

test('system notice shape, counts and removal majority must all be exact', () => {
  for (const value of [
    null,
    [],
    {},
    { ...systemNotice(), noticeId: 'bad' },
    { ...systemNotice(), kind: 'post_jury_kept' },
    { ...systemNotice(), readAt: true },
    { ...systemNotice(), keepVotes: -1 },
    { ...systemNotice(), removeVotes: 7 },
    { ...systemNotice(), keepVotes: 6, removeVotes: 6 },
    { ...systemNotice(), keepVotes: 5, removeVotes: 7 },
    { ...systemNotice(), keepVotes: 5, removeVotes: 5 },
    { ...systemNotice(), keepVotes: 7, removeVotes: 4 },
    { ...systemNotice(), keepVotes: 0, removeVotes: 0 },
    { ...systemNotice(), keepVotes: 1.5 },
    { ...systemNotice(), removeVotes: '7' },
    { ...systemNotice(), removeVotes: NaN },
  ])
    assert.throws(() => decodeSystemNotice(value), { kind: 'protocol' });
  for (const date of [
    'yesterday',
    '2026-10-07T00:00:00Z',
    '2026-10-07T00:00:00.0Z',
    '2026-10-07T00:00:00.000+00:00',
    '2026-02-30T00:00:00.000Z',
    '2026-10-07T00:00:00.0000Z',
    1791331200000,
  ]) {
    assert.throws(
      () => decodeSystemNotice({ ...systemNotice(), createdAt: date }),
      { kind: 'protocol' },
    );
    assert.throws(
      () => decodeSystemNotice({ ...systemNotice(), readAt: date }),
      { kind: 'protocol' },
    );
    assert.throws(
      () =>
        decodeSystemNoticeRead({
          noticeId: requestId,
          readAt: date,
          unreadCount: 0,
        }),
      { kind: 'protocol' },
    );
  }
});

test('system notice list and read/count DTOs reject invalid pagination, duplicates and unsafe unread counts', () => {
  for (const unreadCount of [-1, 1.5, '1', NaN, Infinity, 2147483648]) {
    assert.throws(
      () => decodeSystemNoticesList({ ...systemNotices(), unreadCount }),
      { kind: 'protocol' },
    );
    assert.throws(() => decodeSystemNoticesUnread({ unreadCount }), {
      kind: 'protocol',
    });
    assert.throws(
      () =>
        decodeSystemNoticeRead({
          noticeId: requestId,
          readAt: createdAt,
          unreadCount,
        }),
      { kind: 'protocol' },
    );
  }
  for (const value of [
    systemNotices([], 'cursor'),
    systemNotices([systemNotice()], null, 0),
    systemNotices([systemNotice(), systemNotice()]),
    systemNotices([
      systemNotice({ noticeId: otherId }),
      systemNotice({ noticeId: otherId.toUpperCase() }),
    ]),
    systemNotices(Array.from({ length: 51 }, () => systemNotice())),
    { ...systemNotices(), nextCursor: 'bad&cursor' },
    { ...systemNotices(), nextCursor: '' },
  ])
    assert.throws(() => decodeSystemNoticesList(value), { kind: 'protocol' });
  assert.deepEqual(
    decodeSystemNoticesList(systemNotices([])),
    systemNotices([]),
  );
  assert.deepEqual(decodeSystemNoticesUnread({ unreadCount: 2147483647 }), {
    unreadCount: 2147483647,
  });
  assert.deepEqual(
    decodeSystemNoticeRead({
      noticeId: requestId,
      readAt: createdAt,
      unreadCount: 0,
    }),
    { noticeId: requestId, readAt: createdAt, unreadCount: 0 },
  );
  assert.throws(
    () =>
      decodeSystemNoticeRead({
        noticeId: requestId,
        readAt: null,
        unreadCount: 0,
      }),
    { kind: 'protocol' },
  );
});
