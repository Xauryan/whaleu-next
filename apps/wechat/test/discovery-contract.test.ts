import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeLikedList,
  decodeOwnProfileRef,
  decodeProfileList,
  decodePublicProfile,
} from '../src/profile/discovery-contract';
import { decodeReportTarget } from '../src/community/report-contract';
import { decodeBlockSource } from '../src/community/block-contract';
import {
  anonymous,
  commentId,
  otherId,
  postId,
  replyId,
  requestId,
} from './community-helpers';
import {
  likedItem,
  likedList,
  namedPost,
  profileId,
  profileList,
  publicProfile,
} from './discovery-helpers';

test('public projection admits exact null/unavailable owner fields and profile-owned bio rules', () => {
  assert.deepEqual(decodePublicProfile(publicProfile()), publicProfile());
  assert.deepEqual(
    decodePublicProfile(publicProfile({ bio: 'x\u0085y' })),
    publicProfile({ bio: 'x\u0085y' }),
  );
  assert.deepEqual(decodeOwnProfileRef({ profileId: null }), {
    profileId: null,
  });
  assert.deepEqual(decodeOwnProfileRef({ profileId }), { profileId });
  for (const extra of [
    'accountId',
    'sessionId',
    'openid',
    'phone',
    'studentNumber',
    'institutionId',
    'identityOverlay',
    'approval',
  ]) {
    assert.throws(() =>
      decodePublicProfile({ ...publicProfile(), [extra]: otherId }),
    );
    assert.throws(() => decodeOwnProfileRef({ profileId, [extra]: otherId }));
  }
  for (const field of [
    'avatar',
    'affiliation',
    'publicUid',
    'title',
    'level',
    'totalInteractions',
  ])
    for (const value of [0, 1, 'unverified', {}, '<script>'])
      assert.throws(() =>
        decodePublicProfile({ ...publicProfile(), [field]: value }),
      );
  assert.throws(() =>
    decodePublicProfile(publicProfile({ postsHidden: true })),
  );
  assert.throws(() =>
    decodePublicProfile(
      publicProfile({ postsHidden: true, postCount: 0, isOwn: true }),
    ),
  );
  assert.throws(() => decodePublicProfile(publicProfile({ bio: 'x\u007fy' })));
});

test('hidden, unavailable and outgoing-blocked unions reject metadata/count/profile leakage', () => {
  const unavailable = { status: 'unavailable', profileId };
  const blocked = {
    status: 'blocked_by_you',
    profileId,
    relationship: { relationshipId: requestId, blocked: true, revision: '1' },
  };
  assert.deepEqual(decodePublicProfile(unavailable), unavailable);
  assert.deepEqual(decodePublicProfile(blocked), blocked);
  for (const value of [unavailable, blocked]) {
    assert.deepEqual(decodeProfileList(value), value);
    for (const extra of [
      'displayName',
      'postCount',
      'tradeCount',
      'accountId',
      'incoming',
    ]) {
      assert.throws(() =>
        decodePublicProfile({ ...value, [extra]: 'private' }),
      );
      assert.throws(() => decodeProfileList({ ...value, [extra]: 'private' }));
    }
  }
  assert.throws(() =>
    decodePublicProfile({
      ...blocked,
      relationship: { ...blocked.relationship, blocked: false },
    }),
  );
  assert.throws(() =>
    decodePublicProfile({
      ...blocked,
      relationship: { ...blocked.relationship, targetAccountId: otherId },
    }),
  );
  const hidden = {
    status: 'hidden',
    profileId,
    items: [],
    total: 0,
    nextCursor: null,
  };
  assert.deepEqual(decodeProfileList(hidden), hidden);
  for (const patch of [
    { items: [namedPost()] },
    { total: 1 },
    { nextCursor: 'cursor' },
    { profile: publicProfile() },
  ])
    assert.throws(() => decodeProfileList({ ...hidden, ...patch }));
});

test('profile list is only exact named same-profile canonical posts and no contact-bearing rows', () => {
  assert.deepEqual(decodeProfileList(profileList()), profileList());
  for (const item of [
    { ...namedPost(), author: anonymous() },
    { ...namedPost(), author: { ...namedPost().author, profileId: requestId } },
    { ...namedPost(), contacts: { phone: 'private' } },
    { ...namedPost(), author: { ...namedPost().author, accountId: otherId } },
  ])
    assert.throws(() =>
      decodeProfileList(profileList({ items: [item] as never })),
    );
  assert.throws(() =>
    decodeProfileList(
      profileList({ items: [namedPost(), namedPost()], total: 2 }),
    ),
  );
  assert.throws(() =>
    decodeProfileList(profileList({ items: [], nextCursor: 'nonempty' })),
  );
});

test('liked history preserves target anonymity and nullable historical time, rejects inconsistent locators/private nested data', () => {
  const items = [
    likedItem(),
    likedItem({
      kind: 'comment',
      targetId: commentId,
      rootCommentId: commentId,
      likeId: otherId,
      likedAt: null,
      preview: { ...likedItem().preview, author: anonymous() },
    }),
    likedItem({
      kind: 'reply',
      targetId: replyId,
      rootCommentId: commentId,
      likeId: commentId,
    }),
  ];
  assert.deepEqual(
    decodeLikedList(likedList({ items, visibleLikedCount: 3 })).items,
    items,
  );
  for (const patch of [
    { targetId: otherId },
    { rootCommentId: commentId },
    { likedAt: 0 },
    { likedAt: '' },
    { likedAt: '2026-99-99' },
    { accountId: otherId },
    { preview: { ...likedItem().preview, contacts: {} } },
    {
      preview: {
        ...likedItem().preview,
        author: { ...anonymous(), profileId },
      },
    },
    {
      preview: {
        ...likedItem().preview,
        author: { ...namedPost().author, openid: 'private' },
      },
    },
  ])
    assert.throws(() =>
      decodeLikedList(
        likedList({ items: [{ ...likedItem(), ...patch } as never] }),
      ),
    );
  for (const bad of [
    { ...items[1], rootCommentId: null },
    { ...items[1], rootCommentId: requestId },
    { ...items[2], rootCommentId: replyId },
    { ...items[2], targetId: postId },
  ])
    assert.throws(() => decodeLikedList(likedList({ items: [bad as never] })));
  for (const values of [
    [items[0]!, { ...items[1]!, likeId: requestId }],
    [items[0]!, { ...items[0]!, likeId: commentId }],
  ])
    assert.throws(() =>
      decodeLikedList(likedList({ items: values, visibleLikedCount: 2 })),
    );
});

test('profile sources extend blocks only, never reporting', () => {
  assert.deepEqual(decodeBlockSource({ kind: 'profile', id: profileId }), {
    kind: 'profile',
    id: profileId,
  });
  assert.throws(() => decodeReportTarget({ kind: 'profile', id: profileId }));
});
