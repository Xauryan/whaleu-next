import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { WhaleuApp } from '../src/app';
import type { Feed, Post } from '../src/community/contract';
import type { ViewObservationSink } from '../src/community/view-observer';
import type { ViewRuntime } from '../src/community/view-runtime';
import type { FeedView } from '../src/pages/community-feed/controller';
import { systemClock } from '../src/platform/clock';
import type { WxApi } from '../src/platform/wechat';
import { otherId, post, requestId, setup, space } from './community-helpers';
import { deferred, FakeClock, flush } from './helpers';
import { campusId } from './profile-helpers';

type HomeTab = 'campus' | 'following' | 'global';
interface HomePage {
  data: FeedView & {
    homeTab: HomeTab;
    showCampusPicker: boolean;
    expandedPostId: string;
  };
  ordinaryPosts: readonly Post[];
  setData(patch: Record<string, unknown>, callback?: () => void): void;
  onShow(): void;
  onUnload(): void;
  onFollowing(): void;
  onHomeCampus(): Promise<void>;
  onHomeGlobal(): Promise<void>;
  onHotUnavailable(): void;
  onGlobal(event: { currentTarget: { dataset: { id: string } } }): void;
  onCampus(event: { currentTarget: { dataset: { id: string } } }): void;
  onPostMenu(event: { currentTarget: { dataset: { id: string } } }): void;
}
let definition: HomePage | undefined;
async function loadDefinition(): Promise<HomePage> {
  if (!definition) {
    const prior = globalThis.Page;
    globalThis.Page = ((options: object) => {
      definition = options as HomePage;
    }) as typeof Page;
    try {
      await import('../src/pages/community-feed/community-feed.js');
    } finally {
      globalThis.Page = prior;
    }
  }
  assert.ok(definition);
  return definition;
}

async function mount() {
  const s = setup();
  const clock = new FakeClock();
  const observations: {
    selector: string;
    disconnected: boolean;
    callback: (value: { intersectionRatio: number }) => void;
  }[] = [];
  const events: string[] = [];
  const sink: ViewObservationSink = {
    captureOwner: () => s.sessions.snapshot(),
    canPresent: (owner) => owner.epoch === s.sessions.snapshot().epoch,
    canObserve: (owner) => owner.epoch === s.sessions.snapshot().epoch,
    observe: (_kind, id) => events.push(id),
    subscribeInvalidation: () => () => undefined,
  };
  const nativeGlobal = globalThis as typeof globalThis & { wx: WxApi };
  const prior = {
    getApp: globalThis.getApp,
    wx: nativeGlobal.wx,
    clock: { ...systemClock },
  };
  globalThis.getApp = (() =>
    ({
      community: { ...s.runtime, views: sink as ViewRuntime },
    }) as WhaleuApp) as typeof getApp;
  systemClock.now = () => clock.now();
  systemClock.schedule = (callback, delay) => clock.schedule(callback, delay);
  nativeGlobal.wx = {
    nextTick(callback) {
      callback();
    },
    createIntersectionObserver() {
      const observation = {
        selector: '',
        disconnected: false,
        callback: (_value: { intersectionRatio: number }) => {},
      };
      observations.push(observation);
      return {
        relativeToViewport() {
          return this;
        },
        observe(selector, callback) {
          observation.selector = selector;
          observation.callback = callback;
        },
        disconnect() {
          observation.disconnected = true;
        },
      };
    },
  } as Partial<WxApi> as WxApi;
  const registered = await loadDefinition();
  const page: HomePage = {
    ...registered,
    data: { ...registered.data },
    ordinaryPosts: [],
    setData(patch, callback) {
      this.data = { ...this.data, ...patch };
      callback?.();
    },
  };
  return {
    ...s,
    page,
    clock,
    observations,
    events,
    active: () => observations.filter((item) => !item.disconnected),
    dispose() {
      page.onUnload();
      globalThis.getApp = prior.getApp;
      nativeGlobal.wx = prior.wx;
      Object.assign(systemClock, prior.clock);
    },
  };
}

const choose = (id: string) => ({ currentTarget: { dataset: { id } } });

test('Home with missing following runtime cancels old feed and never substitutes hidden content', async (t) => {
  const s = await mount();
  t.after(() => s.dispose());
  const pending = deferred<Feed>();
  s.gateway.feedImpl = () => pending.promise;
  s.page.onShow();
  await flush();
  s.page.onFollowing();
  pending.resolve({ items: [post()], nextCursor: null, continuation: 'end' });
  await flush();
  assert.equal(s.page.data.homeTab, 'following');
  assert.equal(s.page.data.loaded, false);
  assert.deepEqual(s.active(), []);
  assert.deepEqual(s.events, []);
  const reads = s.gateway.calls.filter((call) => call.method === 'feed').length;
  s.page.onFollowing();
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'feed').length,
    reads,
  );
  await s.page.onHomeCampus();
  assert.equal(s.active().length, 1);
  const stale = s.active()[0]!;
  stale.callback({ intersectionRatio: 0.6 });
  s.clock.advance(500);
  s.page.onFollowing();
  stale.callback({ intersectionRatio: 1 });
  s.clock.advance(1500);
  assert.equal(stale.disconnected, true);
  assert.deepEqual(
    s.events,
    [],
    'a hidden Home tab never completes a visibility interval',
  );
  await s.page.onHomeCampus();
  s.active()[0]!.callback({ intersectionRatio: 0.6 });
  s.clock.advance(1000);
  assert.deepEqual(s.events, [post().id]);
});

test('Home keeps explicit global selection, does not aggregate spaces, and fences late scope reads', async (t) => {
  const s = await mount();
  t.after(() => s.dispose());
  const first = space({
    id: otherId,
    kind: 'global',
    name: '合成校际甲',
    operatingRegionId: null,
  });
  const second = space({
    id: requestId,
    kind: 'global',
    name: '合成校际乙',
    operatingRegionId: null,
  });
  s.gateway.spacesImpl = async () => ({
    regional: space(),
    global: [first, second],
  });
  s.page.onShow();
  await flush();
  const before = s.gateway.calls.filter(
    (call) => call.method === 'feed',
  ).length;
  s.page.onHomeGlobal();
  assert.equal(s.page.data.homeTab, 'global');
  assert.deepEqual(
    s.active(),
    [],
    'regional cards are not shown as the global feed',
  );
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'feed').length,
    before,
  );
  const late = deferred<Feed>();
  s.gateway.feedImpl = async (query) =>
    query.spaceId === otherId
      ? late.promise
      : { items: [post()], nextCursor: null, continuation: 'end' };
  s.page.onGlobal(choose(otherId));
  await flush();
  assert.equal(s.page.data.space?.id, otherId);
  assert.equal(s.page.data.posts.length, 0);
  s.page.onHomeCampus();
  await flush();
  late.resolve({
    items: [post({ id: otherId, text: '旧校际响应', space: first })],
    nextCursor: null,
    continuation: 'end',
  });
  await flush();
  assert.equal(s.page.data.homeTab, 'campus');
  assert.equal(s.page.data.space?.id, space().id);
  assert.equal(s.page.data.posts[0]?.id, post().id);
  assert.ok(!s.page.data.posts.some((row) => row.text === '旧校际响应'));
  assert.equal(s.page.data.campusId, campusId);
});

test('Home campus tab clears hidden global exposure even when no regional scope exists', async (t) => {
  const s = await mount();
  t.after(() => s.dispose());
  const global = space({
    id: otherId,
    kind: 'global',
    operatingRegionId: null,
  });
  s.gateway.spacesImpl = async () => ({ regional: null, global: [global] });
  s.page.onShow();
  await flush();
  assert.equal(s.page.data.space?.id, undefined);
  s.page.onHomeGlobal();
  await flush();
  assert.equal(s.page.data.space?.id, otherId);
  const stale = s.active()[0];
  assert.ok(stale);
  stale.callback({ intersectionRatio: 0.6 });
  s.clock.advance(500);
  s.page.onHomeCampus();
  assert.equal(s.page.data.homeTab, 'campus');
  assert.deepEqual(s.active(), []);
  stale.callback({ intersectionRatio: 1 });
  s.clock.advance(1500);
  assert.deepEqual(s.events, []);
});

test('Home single global tab is explicit, following suppresses its late callback, and invalid menus stay closed', async (t) => {
  const s = await mount();
  t.after(() => s.dispose());
  const global = space({
    id: otherId,
    kind: 'global',
    operatingRegionId: null,
  });
  s.gateway.spacesImpl = async () => ({ regional: space(), global: [global] });
  s.page.onShow();
  await flush();
  const late = deferred<Feed>();
  s.gateway.feedImpl = () => late.promise;
  s.page.onHomeGlobal();
  await flush();
  s.page.onFollowing();
  late.resolve({
    items: [post({ space: global })],
    nextCursor: null,
    continuation: 'end',
  });
  await flush();
  assert.equal(s.page.data.homeTab, 'following');
  assert.equal(s.page.data.space?.id, otherId);
  assert.deepEqual(s.active(), []);
  s.page.onPostMenu(choose('not-a-rendered-post'));
  assert.equal(s.page.data.expandedPostId, '');
  s.page.onPostMenu(choose(post().id));
  assert.equal(
    s.page.data.expandedPostId,
    '',
    'hidden stale posts are not menu targets',
  );
  await s.page.onHomeCampus();
  s.page.onPostMenu(choose(post().id));
  assert.equal(s.page.data.expandedPostId, post().id);
  s.page.onPostMenu(choose(post().id));
  assert.equal(s.page.data.expandedPostId, '');
});

test('Home markup retains actual campus, native shell, scoped recovery, and named-only identity actions', () => {
  const source = readFileSync(
    join(__dirname, '../src/pages/community-feed/community-feed.wxml'),
    'utf8',
  );
  assert.match(source, /\{\{campusName \|\| '选择校园'\}\}/);
  assert.match(
    source,
    /<wu-tab-bar selected="home" space-id="\{\{space \? space.id : ''\}\}"/,
  );
  const following = source.slice(
    source.indexOf('class="home-empty following-empty"'),
    source.indexOf('<block wx:if="{{homeTab !=='),
  );
  assert.match(following, /关注服务暂未连接，不会用推荐帖子代替你的关注/);
  assert.doesNotMatch(following, /wx:for|posts|onAuthor|likeCount/);
  assert.match(
    source,
    /<button wx:if="\{\{item.author.kind === 'named'\}\}"[^>]*bindtap="onAuthorAvatar"/,
  );
  assert.match(source, /<view wx:else class="post-avatar anonymous-avatar"/);
  assert.match(
    source,
    /hasSession &amp;&amp; item.author.kind === 'named' &amp;&amp; !item.viewer.isSelf/,
  );
  assert.match(
    source,
    /postId=\{\{item.id\}\}&amp;viewSpaceId=\{\{space.id\}\}/,
  );
  assert.match(source, /report-progress\?kind=post&amp;id=\{\{item.id\}\}"/);
  assert.match(source, /template is="report-recovery"/);
  assert.match(source, /template is="block-recovery"/);
  assert.match(source, /template is="post-pin-management"/);
  const hot = readFileSync(
    join(__dirname, '../src/pages/community-hot/community-hot.wxml'),
    'utf8',
  );
  assert.match(hot, /<wu-tab-bar selected="hot"/);
  assert.doesNotMatch(
    source,
    /<image[^>]+src="\{\{item.author|privateAuthor|accountId|actorId/,
  );
});
