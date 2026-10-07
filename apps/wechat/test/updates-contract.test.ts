import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeCommunityUpdate,
  decodeUpdatesList,
  decodeUpdatesUnread,
  decodeUpdateRead,
  decodeResolvedUpdateTarget,
} from '../src/community/updates-contract';
import { createdAt, otherId, requestId } from './community-helpers';
import { update, unavailable, updates } from './updates-helpers';

test('Updates decode only canonical current root/reply persona-safe previews and content-free unavailable rows', () => {
  for (const item of [
    update(),
    update('reply'),
    unavailable(),
    { ...update(), reason: 'direct' },
  ]) {
    assert.deepEqual(decodeCommunityUpdate(item), item);
    assert.ok(Object.isFrozen(decodeCommunityUpdate(item)));
  }
  const page = updates([update(), unavailable(otherId)], null, 15);
  assert.deepEqual(decodeUpdatesList(page), page);
  assert.equal(
    decodeUpdatesList(page).unreadCount,
    15,
    'all owner notices count, not just loaded available items',
  );
  for (const field of [
    'accountId',
    'actorId',
    'studentNumber',
    'contacts',
    'providerStatus',
    'deliveredAt',
  ]) {
    assert.throws(
      () => decodeCommunityUpdate({ ...update(), [field]: otherId }),
      { kind: 'protocol' },
    );
    assert.throws(
      () => decodeCommunityUpdate({ ...unavailable(), [field]: otherId }),
      { kind: 'protocol' },
    );
    assert.throws(
      () =>
        decodeCommunityUpdate({
          ...update(),
          preview: { ...update().preview, [field]: otherId },
        }),
      { kind: 'protocol' },
    );
    assert.throws(
      () =>
        decodeCommunityUpdate({
          ...update(),
          preview: {
            ...update().preview,
            author: { ...update().preview.author, [field]: otherId },
          },
        }),
      { kind: 'protocol' },
    );
  }
});

test('Updates reject malformed shape, target ancestry, saved reply fanout, stale tombstones and media/persona leaks', () => {
  for (const bad of [
    null,
    [],
    {},
    { ...update(), noticeId: 'bad' },
    { ...update(), createdAt: 'yesterday' },
    { ...update(), readAt: true },
    { ...update(), status: 'delivered' },
    { ...update(), kind: 'like' },
    { ...update(), reason: 'author' },
    { ...update('reply'), reason: 'saved' },
    { ...update(), target: update('reply').target },
    { ...update('reply'), target: update().target },
    { ...update(), target: { ...update().target, actorId: otherId } },
    { ...unavailable(), preview: update().preview },
    { ...unavailable(), target: update().target },
    { ...update(), preview: { ...update().preview, text: '', images: [] } },
    { ...update(), preview: { ...update().preview, text: '\ud800' } },
    { ...update(), preview: { ...update().preview, images: [null] } },
    {
      ...update(),
      preview: {
        ...update().preview,
        author: { ...update().preview.author, profileId: otherId },
      },
    },
  ])
    assert.throws(() => decodeCommunityUpdate(bad), { kind: 'protocol' });
});

test('Updates list and exact read/count/target DTOs fail closed on extras, duplicates, unsafe counts and mismatched shapes', () => {
  for (const count of [-1, 1.5, '1', NaN, Infinity, 2147483648]) {
    assert.throws(
      () => decodeUpdatesList({ ...updates(), unreadCount: count }),
      { kind: 'protocol' },
    );
    assert.throws(() => decodeUpdatesUnread({ unreadCount: count }), {
      kind: 'protocol',
    });
    assert.throws(
      () =>
        decodeUpdateRead({
          noticeId: requestId,
          readAt: createdAt,
          unreadCount: count,
        }),
      { kind: 'protocol' },
    );
  }
  for (const bad of [
    { ...updates(), nextCursor: 'bad&cursor' },
    updates([], 'cursor'),
    updates([update(), update()]),
    updates([update('root', otherId), update('root', otherId.toUpperCase())]),
    updates([update()], null, 0),
    updates(Array.from({ length: 51 }, () => update())),
    { ...updates(), owner: otherId },
  ])
    assert.throws(() => decodeUpdatesList(bad), { kind: 'protocol' });
  assert.deepEqual(
    decodeUpdateRead({
      noticeId: requestId,
      readAt: createdAt,
      unreadCount: 0,
    }),
    { noticeId: requestId, readAt: createdAt, unreadCount: 0 },
  );
  assert.deepEqual(decodeUpdatesUnread({ unreadCount: 0 }), { unreadCount: 0 });
  for (const value of [
    { noticeId: requestId, status: 'unavailable' },
    { noticeId: requestId, status: 'available', target: update().target },
  ])
    assert.deepEqual(decodeResolvedUpdateTarget(value), value);
  for (const value of [
    { noticeId: requestId, status: 'unavailable', target: update().target },
    { noticeId: requestId, status: 'available' },
    {
      noticeId: requestId,
      status: 'available',
      target: { ...update().target, actorId: otherId },
    },
    { noticeId: requestId, status: 'deleted' },
  ])
    assert.throws(() => decodeResolvedUpdateTarget(value), {
      kind: 'protocol',
    });
  assert.throws(
    () =>
      decodeUpdateRead({ noticeId: requestId, readAt: null, unreadCount: 0 }),
    { kind: 'protocol' },
  );
  assert.throws(
    () => decodeUpdatesUnread({ unreadCount: 1, actorId: otherId }),
    { kind: 'protocol' },
  );
});
