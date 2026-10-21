import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeSocialUpdate,
  decodeSocialUpdatesPage,
  decodeSocialUpdateRead,
  decodeSocialUpdateResolution,
  decodeSocialUpdateUnread,
  type SocialUpdateCategory,
} from '../src/notifications/social-updates/contract';
import { commentId, replyId } from './community-helpers';
import {
  noticeId,
  otherId,
  postId,
  socialCreatedAt,
  socialNotice,
  socialPage,
  socialRead,
  socialResolution,
} from './social-updates-helpers';

for (const category of ['likes', 'saves', 'followers'] as const) {
  test(`social ${category} exact available, neutral unavailable and unknown count contracts`, () => {
    const available = socialNotice(category);
    assert.deepEqual(decodeSocialUpdate(available, category), available);
    assert.deepEqual(
      decodeSocialUpdatesPage(socialPage(category), category),
      socialPage(category),
    );
    assert.deepEqual(
      decodeSocialUpdateResolution(socialResolution(category), category),
      socialResolution(category),
    );
    const unavailable = {
      noticeId,
      createdAt: socialCreatedAt,
      readAt: null,
      status: 'unavailable',
    };
    assert.deepEqual(decodeSocialUpdate(unavailable, category), unavailable);
    assert.deepEqual(
      decodeSocialUpdateResolution(
        { noticeId, status: 'unavailable' },
        category,
      ),
      { noticeId, status: 'unavailable' },
    );
    assert.deepEqual(
      decodeSocialUpdatesPage(
        socialPage(category, {
          unreadCount: null,
          unreadCountStatus: 'unavailable',
        }),
        category,
      ).unreadCount,
      null,
    );
    for (const leaked of [
      { actor: { profileId: otherId } },
      { reason: 'blocked' },
      { kind: 'like' },
      { target: { postId } },
      { preview: 'private' },
    ])
      assert.throws(
        () => decodeSocialUpdate({ ...unavailable, ...leaked }, category),
        { kind: 'protocol' },
      );
    for (const key of ['noticeId', 'createdAt', 'readAt', 'status']) {
      const incomplete: Record<string, unknown> = { ...unavailable };
      delete incomplete[key];
      assert.throws(() => decodeSocialUpdate(incomplete, category), {
        kind: 'protocol',
      });
    }
  });
}
test('social strict decoders reject actor inference, category crossing and malformed target ancestry', () => {
  for (const category of ['likes', 'saves'] as const) {
    for (const extra of [
      { actor: { profileId: otherId, displayName: '虚构测试同学' } },
      { preview: { text: 'not allowed' } },
      { actorMode: 'anonymous' },
      { domain: 'community' },
    ])
      assert.throws(
        () =>
          decodeSocialUpdate({ ...socialNotice(category), ...extra }, category),
        { kind: 'protocol' },
      );
    assert.throws(
      () => decodeSocialUpdate(socialNotice(category), 'followers'),
      { kind: 'protocol' },
    );
  }
  assert.throws(() => decodeSocialUpdate(socialNotice('saves'), 'likes'), {
    kind: 'protocol',
  });
  assert.throws(
    () => decodeSocialUpdate(socialNotice(), 'bad' as SocialUpdateCategory),
    { kind: 'protocol' },
  );
  for (const target of [
    { type: 'community', postId, commentId: null, replyId },
    { type: 'community', postId, commentId: postId, replyId: null },
    { type: 'community', postId, commentId, replyId: commentId },
    { type: 'community', postId, commentId, replyId: 'bad' },
    { type: 'community', postId, commentId, replyId: null, accountId: otherId },
    { type: 'profile', profileId: otherId },
  ])
    assert.throws(
      () => decodeSocialUpdate({ ...socialNotice(), target }, 'likes'),
      { kind: 'protocol' },
    );
  assert.throws(
    () =>
      decodeSocialUpdate(
        {
          ...socialNotice('saves'),
          target: { type: 'community', postId, commentId, replyId: null },
        },
        'saves',
      ),
    { kind: 'protocol' },
  );
  assert.equal(
    decodeSocialUpdate(
      {
        ...socialNotice(),
        target: { type: 'community', postId, commentId, replyId },
      },
      'likes',
    ).status,
    'available',
  );
  for (const actor of [
    { profileId: postId, displayName: '虚构测试同学' },
    { profileId: otherId, displayName: '' },
    { profileId: otherId, displayName: ' '.repeat(3) },
    { profileId: otherId, displayName: 'x'.repeat(101) },
    { profileId: otherId, displayName: 'hidden\nactor' },
    { profileId: otherId, displayName: '虚构测试同学', accountId: noticeId },
  ])
    assert.throws(
      () =>
        decodeSocialUpdate(
          { ...socialNotice('followers'), actor },
          'followers',
        ),
      { kind: 'protocol' },
    );
});
test('social counts remain authoritative pairs, never fabricated zero or sums', () => {
  for (const value of [
    { unreadCount: null, unreadCountStatus: 'available' },
    { unreadCount: 0, unreadCountStatus: 'unavailable' },
    { unreadCount: -1, unreadCountStatus: 'available' },
    { unreadCount: 1.5, unreadCountStatus: 'available' },
    { unreadCount: 2147483648, unreadCountStatus: 'available' },
    { unreadCount: 7 },
    { unreadCount: 7, unreadCountStatus: 'available', total: 7 },
  ])
    assert.throws(() => decodeSocialUpdateUnread(value), { kind: 'protocol' });
  assert.deepEqual(
    decodeSocialUpdateUnread({
      unreadCount: 0,
      unreadCountStatus: 'available',
    }),
    { unreadCount: 0, unreadCountStatus: 'available' },
  );
  assert.deepEqual(decodeSocialUpdateRead(socialRead()), socialRead());
  assert.throws(
    () => decodeSocialUpdateRead({ ...socialRead(), unreadCount: null }),
    { kind: 'protocol' },
  );
});
test('social contracts validate exact timestamps, UUIDs, page uniqueness and cursor bounds', () => {
  for (const createdAt of [
    '2026-02-30T10:00:00Z',
    '2026-10-20',
    '2026-10-20T25:00:00Z',
    '2026-10-20T10:00:00.0000001Z',
    '2026-10-20T10:00:00+01:00',
  ])
    assert.throws(
      () => decodeSocialUpdate({ ...socialNotice(), createdAt }, 'likes'),
      { kind: 'protocol' },
    );
  assert.throws(
    () =>
      decodeSocialUpdate(
        { ...socialNotice(), readAt: '2026-10-20T10:00:00.000000Z' },
        'likes',
      ),
    { kind: 'protocol' },
  );
  assert.throws(
    () =>
      decodeSocialUpdate(
        { ...socialNotice(), noticeId: `${noticeId}?accountId=${otherId}` },
        'likes',
      ),
    { kind: 'protocol' },
  );
  for (const patch of [
    { nextCursor: 'bad' },
    { items: [socialNotice(), socialNotice()] },
    { items: Array.from({ length: 21 }, () => socialNotice()) },
    { count: 1 },
  ])
    assert.throws(
      () => decodeSocialUpdatesPage({ ...socialPage(), ...patch }, 'likes'),
      { kind: 'protocol' },
    );
});
