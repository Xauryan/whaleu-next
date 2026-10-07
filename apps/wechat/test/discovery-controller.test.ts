import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import {
  PublicProfileController,
  initialPublicProfileView,
} from '../src/pages/public-profile/controller';
import {
  LikedController,
  initialLikedView,
} from '../src/pages/community-liked/controller';
import type {
  PublicProfile,
  LikedList,
} from '../src/profile/discovery-contract';
import type { Cancellation } from '../src/platform/contracts';
import { deferred, flush } from './helpers';
import { otherId, postId, requestId } from './community-helpers';
import { wireCredentials } from './identity-helpers';
import {
  discoverySetup,
  likedItem,
  likedList,
  namedPost,
  profileId,
  profileList,
  publicProfile,
} from './discovery-helpers';
function profileHarness(loggedIn = true, target: string | null = profileId) {
  const s = discoverySetup(loggedIn);
  let view = initialPublicProfileView();
  const controller = new PublicProfileController(
    s.runtime,
    target,
    (next) => (view = next),
  );
  return { ...s, controller, view: () => view };
}
function likedHarness(loggedIn = true) {
  const s = discoverySetup(loggedIn);
  let view = initialLikedView();
  const controller = new LikedController(s.runtime, (next) => (view = next));
  return { ...s, controller, view: () => view };
}
test('guest public pages, missing self profile and private liked history remain distinct without phone/student reads', async () => {
  const guest = profileHarness(false);
  await guest.controller.load();
  assert.equal(guest.view().loaded, true);
  assert.deepEqual(
    guest.calls.map((c) => c.method),
    ['profile', 'list'],
  );
  assert.equal(guest.gateway.calls.length, 0);
  const missing = profileHarness(true, null);
  missing.behavior.ownProfileRef = async () => ({ profileId: null });
  await missing.controller.load();
  assert.equal(missing.view().noProfile, true);
  assert.equal(missing.view().total, null);
  assert.equal(missing.view().profile, null);
  assert.deepEqual(
    missing.calls.map((c) => c.method),
    ['ownProfileRef'],
  );
  const own = profileHarness(true, null);
  own.behavior.profile = async () => publicProfile({ isOwn: true });
  await own.controller.load();
  assert.equal(own.view().profile?.status, 'available');
  const likes = likedHarness(false);
  await likes.controller.load();
  assert.equal(likes.calls.length, 0);
  assert.equal(likes.view().visibleLikedCount, null);
});
test('public hidden/basic-visible, outgoing blocked and unavailable clear every list/count/navigation state', async () => {
  for (const state of [
    'hidden',
    'blocked',
    'unavailable',
    'list-hidden',
  ] as const) {
    const s = profileHarness();
    s.behavior.list = async () =>
      profileList({ nextCursor: 'second', total: 2 });
    await s.controller.load();
    if (state === 'hidden')
      s.behavior.profile = async () =>
        publicProfile({ postsHidden: true, postCount: 0, tradeCount: 0 });
    if (state === 'blocked')
      s.behavior.profile = async () => ({
        status: 'blocked_by_you',
        profileId,
        relationship: {
          relationshipId: requestId,
          blocked: true,
          revision: '2',
        },
      });
    if (state === 'unavailable')
      s.behavior.profile = async () => ({ status: 'unavailable', profileId });
    if (state === 'list-hidden')
      s.behavior.list = async () => ({
        status: 'hidden',
        profileId,
        items: [],
        total: 0,
        nextCursor: null,
      });
    await s.controller.more();
    assert.deepEqual(s.view().items, []);
    assert.equal(s.view().total, null);
    assert.equal(s.view().canLoadMore, false);
    assert.equal(s.view().canPrevious, false);
    assert.equal(s.view().loaded, true);
    if (s.view().profile?.status === 'available') {
      const p = s.view().profile;
      assert.ok(p?.status === 'available');
      assert.equal(p.postCount, 0);
      assert.equal(p.tradeCount, 0);
    }
    const count = s.calls.length;
    await s.controller.previous();
    assert.equal(s.calls.length, count);
  }
});
test('profile next/previous replace bodies and freshly recheck old pages after remote hiding, counts remain subtype-independent', async () => {
  const s = profileHarness();
  const second = { ...namedPost(), id: requestId };
  s.behavior.list = async (_id, _kind, after) =>
    after
      ? profileList({ items: [second], total: 1 })
      : profileList({ nextCursor: 'second', total: 2 });
  await s.controller.load();
  await s.controller.more();
  assert.deepEqual(s.view().items, [second]);
  assert.equal(s.view().pageNumber, 2);
  assert.equal(s.view().total, 1);
  assert.equal(s.view().canPrevious, true);
  s.behavior.list = async () => profileList({ items: [], total: 0 });
  await s.controller.previous();
  assert.deepEqual(s.view().items, []);
  assert.equal(s.view().pageNumber, 1);
  assert.equal(
    s.calls.filter((c) => c.method === 'list').slice(-1)[0]!.args[2],
    null,
  );
  s.behavior.profile = async () => publicProfile({ tradeCount: 9 });
  s.behavior.list = async () => profileList({ items: [], total: 2 });
  await s.controller.setTab('trading');
  await s.controller.setTradingSubtype('qiugou');
  const p = s.view().profile;
  assert.ok(p?.status === 'available');
  assert.equal(p.tradeCount, 9);
  assert.equal(s.view().total, 2);
});
test('liked next/previous never resurrect remotely unliked/blocked prior bodies, null historical dates keep server order', async () => {
  const s = likedHarness(),
    second = likedItem({
      targetId: otherId,
      postId: otherId,
      likeId: postId,
      likedAt: null,
    });
  s.behavior.liked = async (after) =>
    after
      ? likedList({ items: [second], visibleLikedCount: 1 })
      : likedList({ nextCursor: 'second', visibleLikedCount: 2 });
  await s.controller.load();
  await s.controller.more();
  assert.deepEqual(s.view().items, [second]);
  assert.equal(s.view().visibleLikedCount, 1);
  s.behavior.liked = async () => likedList({ items: [], visibleLikedCount: 0 });
  await s.controller.previous();
  assert.deepEqual(s.view().items, []);
  assert.equal(s.view().visibleLikedCount, 0);
  assert.equal(s.view().pageNumber, 1);
});
test('scope/tab change suppresses pending profile data and subtype clears when switching back', async () => {
  const s = profileHarness(),
    pending = deferred<PublicProfile>();
  s.behavior.profile = () => pending.promise;
  const old = s.controller.load();
  await flush();
  s.behavior.profile = async (id) => publicProfile({ profileId: id });
  s.behavior.list = async (id) => ({
    status: 'available',
    profileId: id,
    items: [],
    total: 0,
    nextCursor: null,
  });
  await s.controller.setTarget(requestId);
  pending.resolve(publicProfile());
  await old;
  assert.equal(s.view().profile?.profileId, requestId);
  assert.equal((s.calls[0]!.args[1] as Cancellation).isCancelled, true);
  await s.controller.setTab('trading');
  await s.controller.setTradingSubtype('qiugou');
  await s.controller.setTab('posts');
  assert.equal(s.view().tradingSubtype, '');
  assert.equal(s.view().tab, 'posts');
});
test('repeated next tap has one request, stalled/restarted pagination clears bodies/counts and explicit retry starts fresh', async () => {
  for (const kind of ['profile', 'liked'] as const) {
    const s = kind === 'profile' ? profileHarness() : likedHarness();
    s.behavior.profile = async () => publicProfile();
    s.behavior.list = async () => profileList({ nextCursor: 'same', total: 2 });
    s.behavior.liked = async () =>
      likedList({ nextCursor: 'same', visibleLikedCount: 2 });
    await s.controller.load();
    const gate = deferred<void>();
    if (kind === 'profile')
      s.behavior.profile = async () => {
        await gate.promise;
        return publicProfile();
      };
    else
      s.behavior.liked = async () => {
        await gate.promise;
        return likedList({ nextCursor: 'same', visibleLikedCount: 2 });
      };
    const next = s.controller.more();
    await s.controller.more();
    await flush();
    gate.resolve();
    await next;
    assert.deepEqual(s.view().items, []);
    assert.equal(s.view().loaded, false);
    assert.ok(s.view().error);
    if (kind === 'profile')
      s.behavior.profile = async () => {
        throw new ClientError('business', 'safe', {
          serverCode: 'DISCOVERY_RESTART_REQUIRED',
          httpStatus: 409,
        });
      };
    else
      s.behavior.liked = async () => {
        throw new ClientError('business', 'safe', {
          serverCode: 'DISCOVERY_RESTART_REQUIRED',
          httpStatus: 409,
        });
      };
    await s.controller.load();
    assert.match(s.view().error, /旧分页/);
    assert.equal(s.view().canPrevious, false);
  }
});
for (const kind of ['profile', 'liked'] as const)
  for (const lifecycle of [
    'cancel',
    'dispose',
    'app-hide',
    'logout',
    'same-account',
    'other-account',
    'safety',
  ] as const) {
    test(`${kind} ${lifecycle} synchronously clears current content and rejects late callbacks`, async () => {
      const s = kind === 'profile' ? profileHarness() : likedHarness();
      await s.controller.load();
      const pendingProfile = deferred<PublicProfile>(),
        pendingLiked = deferred<LikedList>();
      s.behavior.profile = () => pendingProfile.promise;
      s.behavior.liked = () => pendingLiked.promise;
      const running = s.controller.load();
      await flush();
      if (lifecycle === 'cancel') s.controller.cancel();
      else if (lifecycle === 'dispose') s.controller.dispose();
      else if (lifecycle === 'app-hide') s.runtime.privateViews!.clear();
      else if (lifecycle === 'logout') s.sessions.logout();
      else if (lifecycle === 'safety') {
        s.behavior.profile = async () => ({ status: 'unavailable', profileId });
        s.behavior.liked = async () =>
          likedList({ items: [], visibleLikedCount: 0 });
        s.runtime.safetyChanges.invalidate(s.accountId);
      } else
        s.sessions.completeLogin(s.sessions.beginLogin(), {
          ...wireCredentials('b'),
          ...(lifecycle === 'other-account' ? { accountId: otherId } : {}),
        });
      assert.deepEqual(s.view().items, []);
      assert.equal(s.view().canLoadMore, false);
      pendingProfile.resolve(publicProfile());
      pendingLiked.resolve(likedList());
      await running;
      await flush();
      assert.deepEqual(s.view().items, []);
      if (lifecycle !== 'safety') assert.equal(s.view().loaded, false);
    });
  }
test('failed fresh reads never expose stale bodies or confirmed-zero totals', async () => {
  const profile = profileHarness(),
    liked = likedHarness();
  await profile.controller.load();
  await liked.controller.load();
  profile.behavior.profile = async () => {
    throw new ClientError('network', 'safe');
  };
  liked.behavior.liked = async () => {
    throw new ClientError('forbidden', 'safe', {
      serverCode: 'ACCOUNT_BLOCKED',
      httpStatus: 403,
    });
  };
  await profile.controller.load();
  await liked.controller.load();
  assert.equal(profile.view().profile, null);
  assert.equal(profile.view().total, null);
  assert.equal(liked.view().visibleLikedCount, null);
  assert.equal(profile.view().loaded, false);
  assert.equal(liked.view().loaded, false);
});
