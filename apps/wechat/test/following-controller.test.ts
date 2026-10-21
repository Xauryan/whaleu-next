import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import type { FollowState, FollowReceipt } from '../src/following/contract';
import {
  FollowController,
  initialFollowView,
} from '../src/following/controller';
import { PendingFollowStore } from '../src/following/pending';
import type { CommunityRuntime } from '../src/community/runtime';
import type { Feed, Post } from '../src/community/contract';
import {
  FeedController,
  initialFeedView,
} from '../src/pages/community-feed/controller';
import {
  post,
  requestId,
  setup,
  spaceId,
  space,
  commentId,
} from './community-helpers';
import { namedPost, profileId, publicProfile } from './discovery-helpers';
import { deferred, flush, MemoryStorage } from './helpers';
import { wireCredentials } from './identity-helpers';

const applied = (
  profileId: string,
  following: boolean,
  originalRequestId = requestId,
): FollowReceipt => ({
  requestId: originalRequestId,
  profileId,
  following,
  outcome: 'applied',
});

function fixture(loggedIn = true) {
  const base = setup(loggedIn);
  const calls: { method: string; args: unknown[] }[] = [];
  const behavior: NonNullable<CommunityRuntime['following']> = {
    feed: async () => ({
      items: [namedPost()],
      continuation: 'end',
      nextCursor: null,
    }),
    status: async (id) => ({ profileId: id, following: false }),
    set: async (id, following, idempotencyKey) =>
      applied(id, following, idempotencyKey),
  };
  const runtime: CommunityRuntime = {
    ...base.runtime,
    pendingFollowing: new PendingFollowStore(base.storage, 'test'),
    following: {
      feed: (...args) => {
        calls.push({ method: 'feed', args });
        return behavior.feed(...args);
      },
      status: (...args) => {
        calls.push({ method: 'status', args });
        return behavior.status(...args);
      },
      set: (...args) => {
        calls.push({ method: 'set', args });
        return behavior.set(...args);
      },
    },
  };
  let view = initialFollowView();
  const controller = new FollowController(runtime, (value) => {
    view = value;
  });
  return { ...base, runtime, calls, behavior, controller, view: () => view };
}

test('follow only binds available non-own named public profiles; guests and missing runtime never send', async () => {
  const s = fixture();
  for (const target of [
    null,
    publicProfile({ isOwn: true }),
    { status: 'unavailable' as const, profileId },
    publicProfile({ profileId: 'anonymous-persona' }),
  ]) {
    await s.controller.setProfile(target);
    await s.controller.toggle();
    await s.controller.retry();
  }
  assert.equal(s.calls.length, 0);
  const guest = fixture(false);
  await guest.controller.setProfile(publicProfile());
  await guest.controller.toggle();
  await guest.controller.retry();
  assert.equal(guest.calls.length, 0);
  const absent = new FollowController(setup().runtime, () => undefined);
  await absent.setProfile(publicProfile());
  await absent.toggle();
  assert.equal(s.calls.length, 0);
  s.controller.dispose();
  guest.controller.dispose();
  absent.dispose();
});

test('follow coalesces taps, persists before dispatch, retries the same UUID and refreshes historical acknowledgements', async () => {
  const s = fixture();
  await s.controller.setProfile(publicProfile());
  s.behavior.set = async () => {
    throw new ClientError('network', 'Lost acknowledgement');
  };
  const first = s.controller.toggle();
  await s.controller.toggle();
  await first;
  const pending = s.runtime.pendingFollowing!.load(s.accountId)!;
  assert.equal(pending.requestId, requestId);
  assert.equal(pending.following, true);
  assert.equal(s.view().frozen, true);
  assert.equal(s.view().following, null);
  assert.equal(s.calls.filter((c) => c.method === 'set').length, 1);
  await s.controller.load();
  await s.controller.toggle();
  assert.equal(s.calls.filter((c) => c.method === 'set').length, 1);
  // The recorded request says "followed", but a subsequent device unfollowed.
  s.behavior.set = async (id, following, idempotencyKey) => {
    assert.equal(idempotencyKey, pending.requestId);
    assert.deepEqual(s.runtime.pendingFollowing!.load(s.accountId), pending);
    return applied(id, following, idempotencyKey);
  };
  s.behavior.status = async (id) => ({ profileId: id, following: false });
  await s.controller.retry();
  assert.equal(s.view().following, false);
  assert.equal(s.view().frozen, false);
  assert.equal(s.runtime.pendingFollowing!.load(s.accountId), null);
  assert.equal(s.calls.filter((c) => c.method === 'set').length, 2);
  assert.equal(s.calls.filter((c) => c.method === 'status').length, 2);
  s.controller.dispose();
});

test('unknown follow never replays on profile change, hide, account replacement or later entry', async () => {
  const s = fixture();
  await s.controller.setProfile(publicProfile());
  const ack = deferred<FollowReceipt>();
  s.behavior.set = async () => ack.promise;
  const action = s.controller.toggle();
  await flush();
  await s.controller.setProfile(publicProfile({ profileId: commentId }));
  await s.controller.retry();
  assert.equal(s.view().recoveryProfileId, profileId);
  assert.equal(s.calls.filter((c) => c.method === 'set').length, 1);
  ack.resolve(applied(profileId, true));
  await action;
  assert.ok(s.runtime.pendingFollowing!.load(s.accountId));
  assert.equal(s.calls.filter((c) => c.method === 'status').length, 1);
  s.controller.dispose();
  const next = new FollowController(s.runtime, () => undefined);
  await next.setProfile(publicProfile());
  assert.equal(s.calls.filter((c) => c.method === 'set').length, 1);
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: commentId,
  });
  await next.setProfile(publicProfile());
  await next.retry();
  assert.equal(s.calls.filter((c) => c.method === 'set').length, 1);
  assert.equal(s.runtime.pendingFollowing!.load(commentId), null);
  assert.ok(s.runtime.pendingFollowing!.load(s.accountId));
  next.dispose();
});

test('hide and cancellation ignore late follow status and preserve unresolved mutations', async () => {
  for (const dispose of [false, true]) {
    const s = fixture();
    await s.controller.setProfile(publicProfile());
    const ack = deferred<FollowReceipt>();
    s.behavior.set = async () => ack.promise;
    const action = s.controller.toggle();
    await flush();
    if (dispose) s.runtime.privateViews!.clear();
    else s.controller.cancel();
    ack.resolve(applied(profileId, true));
    await action;
    assert.equal(s.view().following, null);
    assert.ok(s.runtime.pendingFollowing!.load(s.accountId));
    assert.equal(s.calls.filter((c) => c.method === 'status').length, 1);
    s.controller.dispose();
  }
  const s = fixture();
  const gate = deferred<FollowState>();
  s.behavior.status = async () => gate.promise;
  const request = s.controller.setProfile(publicProfile());
  await flush();
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('c'));
  gate.resolve({ profileId, following: true });
  await request;
  assert.equal(s.view().following, null);
  assert.equal(s.view().profileId, '');
  s.controller.dispose();
});

test('journal rejects corrupt, overwritten, wrong-target and unacknowledged removals; storage failure sends nothing', async () => {
  const s = fixture();
  const pending = {
    version: 1 as const,
    accountId: s.accountId,
    profileId,
    following: true,
    requestId,
  };
  s.runtime.pendingFollowing!.freeze(pending);
  assert.throws(() =>
    s.runtime.pendingFollowing!.freeze({ ...pending, following: false }),
  );
  assert.throws(() =>
    s.runtime.pendingFollowing!.settle(pending, applied(commentId, true)),
  );
  assert.ok(s.runtime.pendingFollowing!.load(s.accountId));
  s.controller.dispose();
  const storage = new MemoryStorage();
  storage.set = () => {
    throw new Error('Full');
  };
  const isolated = fixture();
  const controller = new FollowController(
    {
      ...isolated.runtime,
      pendingFollowing: new PendingFollowStore(storage, 'broken'),
    },
    () => undefined,
  );
  await controller.setProfile(publicProfile());
  await controller.toggle();
  assert.equal(isolated.calls.filter((c) => c.method === 'set').length, 0);
  controller.dispose();
  isolated.controller.dispose();
});

test('following feed uses real named-only projection and no community fallback; stale cursors clear on source switches', async () => {
  const s = fixture();
  let view = initialFeedView();
  const controller = new FeedController(s.runtime, (value) => {
    view = value;
  });
  await controller.load();
  const ordinaryReads = s.gateway.calls.filter(
    (c) => c.method === 'feed',
  ).length;
  s.behavior.feed = async (query) => ({
    items: [namedPost()],
    nextCursor: query.cursor ? null : 'next',
    continuation: query.cursor ? 'end' : 'available',
  });
  await controller.setFollowing(true);
  assert.equal(view.following, true);
  assert.equal(view.posts[0]?.author.kind, 'named');
  assert.equal(
    s.gateway.calls.filter((c) => c.method === 'feed').length,
    ordinaryReads,
  );
  assert.equal(
    (s.calls.find((c) => c.method === 'feed')!.args[0] as { spaceId: string })
      .spaceId,
    spaceId,
  );
  await controller.more();
  assert.equal(view.posts.length, 1);
  await controller.setFollowing(false);
  assert.equal(view.following, false);
  assert.equal(view.canLoadMore, false);
  s.behavior.feed = async () => ({
    items: [post()],
    nextCursor: null,
    continuation: 'end',
  });
  await controller.setFollowing(true);
  assert.equal(view.posts.length, 0);
  assert.equal(view.loaded, false);
  assert.ok(view.error);
  controller.dispose();
  s.controller.dispose();
});

test('following feed guests send no requests; tab replacement, account change and hide fence late results', async () => {
  const guest = fixture(false);
  const guestFeed = new FeedController(guest.runtime, () => undefined);
  await guestFeed.setFollowing(true);
  await guestFeed.load();
  await guestFeed.more();
  assert.equal(guest.calls.length, 0);
  assert.equal(guest.gateway.calls.length, 0);
  guestFeed.dispose();
  guest.controller.dispose();
  for (const stop of ['tab', 'account', 'hide', 'cancel']) {
    const s = fixture();
    let view = initialFeedView();
    const feed = new FeedController(s.runtime, (value) => {
      view = value;
    });
    await feed.load();
    const gate = deferred<Feed>();
    s.behavior.feed = async () => gate.promise;
    const loading = feed.setFollowing(true);
    await flush();
    if (stop === 'tab') await feed.setFollowing(false);
    if (stop === 'account') s.sessions.logout();
    if (stop === 'hide') s.runtime.privateViews!.clear();
    if (stop === 'cancel') feed.cancel();
    gate.resolve({
      items: [namedPost()],
      continuation: 'end',
      nextCursor: null,
    });
    await loading;
    assert.ok(!view.posts.some((item) => item.author.kind === 'named'));
    feed.dispose();
    s.controller.dispose();
  }
});

test('native Following presentation shares real cards, but excludes pinned content and preserves source-specific exposure fencing', () => {
  const source = (file: string) =>
    readFileSync(join(__dirname, '../src/', file), 'utf8');
  const template = source('pages/community-feed/community-feed.wxml');
  assert.match(
    template,
    /<template wx:if="\{\{!following\}\}" is="scoped-post-pin"/,
  );
  assert.match(template, /不会用推荐帖子代替你的关注/);
  assert.doesNotMatch(template, /关注信息流暂未开放/);
  const page = source('pages/community-feed/community-feed.ts');
  assert.match(page, /!view.loaded \|\| view.following/);
  assert.match(page, /this\.data\.following \? '' : this\.pinRenderedId/);
  assert.match(page, /view.following\s*\? 'following'/);
  const profile = source('pages/public-profile/public-profile.wxml');
  assert.match(profile, /bind:press="onFollow"/);
  assert.match(profile, /bind:press="onFollowRetry"/);
  assert.match(profile, /follow.recoveryProfileId === profile.profileId/);
});

test('a journaled original profile remains explicitly recoverable when unavailable, without permitting a new follow', async () => {
  const s = fixture();
  await s.controller.setProfile(publicProfile());
  s.behavior.set = async () => {
    throw new ClientError('network', 'Unknown');
  };
  await s.controller.toggle();
  await s.controller.setProfile({ status: 'unavailable', profileId });
  assert.equal(s.view().frozen, true);
  assert.equal(s.view().recoveryProfileId, profileId);
  await s.controller.toggle();
  assert.equal(s.calls.filter((c) => c.method === 'set').length, 1);
  s.behavior.set = async (id, following, idempotencyKey) =>
    applied(id, following, idempotencyKey);
  s.behavior.status = async () => {
    throw new ClientError('forbidden', 'Profile unavailable');
  };
  await s.controller.retry();
  assert.equal(s.runtime.pendingFollowing!.load(s.accountId), null);
  assert.equal(s.view().following, null);
  await s.controller.toggle();
  assert.equal(s.calls.filter((c) => c.method === 'set').length, 2);
  s.controller.dispose();
});

test('native Home stops pin reads in Following, retains followed pin-ID rows, and exposes no hidden or late rows', async () => {
  const { PinFeedController } = await import('../src/post-pins/controller.js');
  const originalPinLoad = PinFeedController.prototype.load;
  const nativeGlobal = globalThis as typeof globalThis & { wx: typeof wx };
  const previous = {
    Page: globalThis.Page,
    getApp: globalThis.getApp,
    wx: nativeGlobal.wx,
  };
  type NativeHome = {
    data: ReturnType<typeof initialFeedView> & {
      homeTab: string;
      postColumns: readonly (readonly Post[])[];
      showHomeMenu: boolean;
    };
    setData(patch: object, callback?: () => void): void;
    onShow(): void;
    onFollowing(): void;
    onToggleHomeMenu(): void;
    onHomeCampus(): Promise<void>;
    onHide(): void;
    renderOrdinaryPins(): void;
    pinRenderedId: string;
    viewObserver: {
      render(ids: readonly string[], scope: string): () => void;
      dispose(): void;
    };
  };
  let definition: NativeHome | undefined;
  globalThis.Page = ((value: unknown) => {
    definition = value as NativeHome;
  }) as typeof Page;
  await import('../src/pages/community-feed/community-feed.js');
  assert.ok(definition);
  const s = fixture();
  globalThis.getApp = (() => ({ community: s.runtime })) as typeof getApp;
  nativeGlobal.wx = {} as typeof wx;
  let pinReads = 0;
  PinFeedController.prototype.load = async function (...args) {
    pinReads++;
    return originalPinLoad.apply(this, args);
  };
  const page: NativeHome = {
    ...definition,
    data: { ...definition.data },
    setData(patch, callback) {
      this.data = { ...this.data, ...patch };
      callback?.();
    },
  };
  const exposures: {
    ids: readonly string[];
    scope: string;
    homeTab: string;
    following: boolean;
  }[] = [];
  try {
    page.onShow();
    await flush();
    const initialPins = pinReads;
    assert.ok(initialPins > 0);
    page.viewObserver = {
      render(ids, scope) {
        exposures.push({
          ids,
          scope,
          homeTab: page.data.homeTab,
          following: scope.startsWith('following:'),
        });
        return () => {
          if (ids.length)
            assert.deepEqual(
              [...page.data.postColumns.flat().map((post) => post.id)].sort(),
              [...ids].sort(),
              'viewport observation attaches only after the same final column render',
            );
        };
      },
      dispose() {},
    };
    page.onToggleHomeMenu();
    assert.equal(page.data.showHomeMenu, true);
    page.onFollowing();
    await flush();
    assert.equal(page.data.showHomeMenu, false);
    assert.equal(page.data.following, true);
    assert.equal(page.data.posts[0]?.author.kind, 'named');
    assert.equal(pinReads, initialPins);
    page.pinRenderedId = namedPost().id;
    page.renderOrdinaryPins();
    assert.equal(
      page.data.posts.length,
      1,
      'Following never de-duplicates against an unrelated campus pin',
    );
    assert.deepEqual(page.data.postColumns.flat(), page.data.posts);
    assert.ok(exposures.some((entry) => entry.ids.length && entry.following));
    assert.ok(
      exposures.every(
        (entry) =>
          !entry.ids.length ||
          (entry.homeTab === 'following') === entry.following,
      ),
    );
    await page.onHomeCampus();
    assert.equal(page.data.following, false);
    page.pinRenderedId = post().id;
    page.renderOrdinaryPins();
    assert.deepEqual(page.data.posts, []);
    assert.deepEqual(
      page.data.postColumns.flat(),
      [],
      'campus pin de-duplication happens before column layout',
    );
    const late = deferred<Feed>();
    s.behavior.feed = async () => late.promise;
    page.onFollowing();
    await flush();
    page.onHide();
    const before = exposures.length;
    late.resolve({
      items: [namedPost()],
      continuation: 'end',
      nextCursor: null,
    });
    await flush();
    assert.equal(exposures.length, before);
    assert.deepEqual(page.data.posts, []);
    assert.deepEqual(page.data.postColumns.flat(), []);
  } finally {
    page.onHide();
    s.controller.dispose();
    PinFeedController.prototype.load = originalPinLoad;
    globalThis.Page = previous.Page;
    globalThis.getApp = previous.getApp;
    nativeGlobal.wx = previous.wx;
  }
});

test('native public profile shows authoritative follow state, coalesces taps and clears hidden state', async () => {
  const { discoverySetup } = await import('./discovery-helpers.js');
  const nativeGlobal = globalThis as typeof globalThis & { wx: typeof wx };
  const previous = {
    Page: globalThis.Page,
    getApp: globalThis.getApp,
    wx: nativeGlobal.wx,
  };
  type ProfilePage = {
    data: { follow: ReturnType<typeof initialFollowView>; loaded: boolean };
    setData(patch: object): void;
    onLoad(query: { profileId: string }): void;
    onShow(): void;
    onFollow(): void;
    onHide(): void;
  };
  let definition: ProfilePage | undefined;
  globalThis.Page = ((value: unknown) => {
    definition = value as ProfilePage;
  }) as typeof Page;
  await import('../src/pages/public-profile/public-profile.js');
  assert.ok(definition);
  const s = fixture();
  const discovery = discoverySetup();
  const app = { community: { ...s.runtime, discovery: discovery.discovery } };
  globalThis.getApp = (() => app) as typeof getApp;
  nativeGlobal.wx = {} as typeof wx;
  const page: ProfilePage = {
    ...definition,
    data: { ...definition.data },
    setData(patch) {
      this.data = { ...this.data, ...patch };
    },
  };
  try {
    page.onLoad({ profileId });
    page.onShow();
    await flush();
    assert.equal(page.data.loaded, true);
    assert.equal(page.data.follow.following, false);
    const gate = deferred<FollowReceipt>();
    s.behavior.set = async () => gate.promise;
    page.onFollow();
    page.onFollow();
    await flush();
    assert.equal(s.calls.filter((c) => c.method === 'set').length, 1);
    page.onHide();
    gate.resolve(applied(profileId, true));
    await flush();
    assert.equal(page.data.follow.following, null);
    assert.equal(page.data.follow.profileId, '');
    assert.ok(s.runtime.pendingFollowing!.load(s.accountId));
    page.onShow();
    await flush();
    assert.equal(page.data.follow.frozen, true);
    assert.equal(page.data.follow.recoveryProfileId, profileId);
    assert.equal(s.calls.filter((c) => c.method === 'set').length, 1);
  } finally {
    page.onHide();
    s.controller.dispose();
    globalThis.Page = previous.Page;
    globalThis.getApp = previous.getApp;
    nativeGlobal.wx = previous.wx;
  }
});

test(
  'leaving Following switches source and target atomically without fetching or waiting for the hidden old scope',
  { timeout: 1000 },
  async () => {
    const s = fixture();
    const global = space({
      id: commentId,
      kind: 'global',
      operatingRegionId: null,
    });
    s.gateway.spacesImpl = async () => ({
      regional: space(),
      global: [global],
    });
    let view = initialFeedView();
    const feed = new FeedController(s.runtime, (value) => {
      view = value;
    });
    await feed.load();
    await feed.chooseGlobal(global.id);
    await feed.setFollowing(true);
    const hidden = deferred<Feed>();
    const reads: string[] = [];
    s.gateway.feedImpl = async (query) => {
      reads.push(query.spaceId);
      if (query.spaceId === global.id) return hidden.promise;
      return { items: [post()], nextCursor: null, continuation: 'end' };
    };
    const campusSwitch = feed.showCommunity('regional');
    assert.equal(view.space?.id, spaceId);
    assert.equal(view.following, false);
    await campusSwitch;
    assert.deepEqual(reads, [spaceId]);
    await feed.setFollowing(true);
    reads.length = 0;
    s.gateway.feedImpl = async (query) => {
      reads.push(query.spaceId);
      if (query.spaceId === spaceId) return hidden.promise;
      return {
        items: [post({ space: global })],
        nextCursor: null,
        continuation: 'end',
      };
    };
    const globalSwitch = feed.showCommunity('global');
    assert.equal(view.space?.id, global.id);
    await globalSwitch;
    assert.deepEqual(reads, [global.id]);
    feed.dispose();
    s.controller.dispose();
  },
);

test('verified terminal rejection settles only the original intent, releases the actor barrier, and never projects its desired bit', async () => {
  for (const code of [
    'POST_NOT_FOUND',
    'FOLLOW_SELF_NOT_ALLOWED',
    'SAFETY_ACTION_RESTRICTED',
    'SAFETY_ACCESS_SUSPENDED',
  ] as const) {
    const s = fixture();
    await s.controller.setProfile(publicProfile());
    s.behavior.set = async () => {
      throw new ClientError('network', 'Lost response');
    };
    await s.controller.toggle();
    assert.ok(s.runtime.pendingFollowing!.load(s.accountId));
    s.behavior.set = async (id, following, originalRequestId) => ({
      requestId: originalRequestId,
      profileId: id,
      following,
      outcome: 'rejected',
      code,
    });
    await s.controller.retry();
    assert.equal(s.runtime.pendingFollowing!.load(s.accountId), null);
    assert.equal(s.view().frozen, false);
    assert.equal(s.view().following, null);
    assert.ok(s.view().receiptStatus);
    assert.equal(
      s.calls.filter((call) => call.method === 'status').length,
      1,
      'a rejection is not current follow truth',
    );
    await s.controller.load();
    assert.equal(s.view().following, false);
    assert.equal(s.view().receiptStatus, '');
    s.controller.dispose();
  }
});

test('an unverified policy error or mismatched rejected receipt never discards a pending follow', async () => {
  const s = fixture();
  await s.controller.setProfile(publicProfile());
  s.behavior.set = async () => {
    throw new ClientError('forbidden', 'Target unavailable', {
      serverCode: 'POST_NOT_FOUND',
      httpStatus: 404,
    });
  };
  await s.controller.toggle();
  const pending = s.runtime.pendingFollowing!.load(s.accountId)!;
  assert.ok(pending);
  const rejected: FollowReceipt = {
    requestId,
    profileId,
    following: true,
    outcome: 'rejected',
    code: 'POST_NOT_FOUND',
  };
  for (const receipt of [
    { ...rejected, requestId: commentId },
    { ...rejected, profileId: commentId },
    { ...rejected, following: false },
  ]) {
    assert.throws(() => s.runtime.pendingFollowing!.settle(pending, receipt));
    assert.deepEqual(s.runtime.pendingFollowing!.load(s.accountId), pending);
  }
  s.controller.dispose();
});
