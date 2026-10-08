import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { WhaleuApp } from '../src/app';
import type { HotIntent, HotPage } from '../src/community/hot-contract';
import type { ViewObservationSink } from '../src/community/view-observer';
import type { ViewRuntime } from '../src/community/view-runtime';
import { systemClock } from '../src/platform/clock';
import type { WxApi } from '../src/platform/wechat';
import type {
  HotController,
  HotView,
} from '../src/pages/community-hot/controller';
import { otherId, post } from './community-helpers';
import { deferred, FakeClock, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import { hotHarness, hotPage, hotRoute } from './hot-helpers';

interface NativeHotPage {
  data: HotView;
  route: HotIntent | null;
  resume: HotIntent | null;
  controller: HotController | undefined;
  setData(patch: Record<string, unknown>, callback?: () => void): void;
  onLoad(query: unknown): void;
  onShow(): void;
  onHide(): void;
  onUnload(): void;
  onRange(event: { currentTarget: { dataset: { key: string } } }): void;
  onRefresh(): void;
  onNext(): void;
  onPrevious(): void;
  onCancel(): void;
}
let definition: NativeHotPage | undefined;
async function loadDefinition(): Promise<NativeHotPage> {
  if (!definition) {
    const previous = globalThis.Page;
    globalThis.Page = ((options: object) => {
      definition = options as NativeHotPage;
    }) as typeof Page;
    try {
      await import('../src/pages/community-hot/community-hot.js');
    } finally {
      globalThis.Page = previous;
    }
  }
  assert.ok(definition);
  return definition;
}
test('actual hot page resets hidden bodies, fresh-reads public intent, and fences sessions changed while hidden', async () => {
  const s = hotHarness();
  const nativeGlobal = globalThis as typeof globalThis & { wx: WxApi };
  const prior = { getApp: globalThis.getApp, wx: nativeGlobal.wx };
  globalThis.getApp = (() =>
    ({ community: s.runtime }) as WhaleuApp) as typeof getApp;
  nativeGlobal.wx = {} as WxApi;
  let page: NativeHotPage | undefined;
  try {
    const registered = await loadDefinition();
    page = {
      ...registered,
      data: { ...registered.data },
      setData(patch, callback) {
        this.data = { ...this.data, ...patch };
        callback?.();
      },
    };
    page.onLoad(hotRoute);
    page.onShow();
    await flush();
    assert.equal(page.data.loaded, true);
    page.onRange({ currentTarget: { dataset: { key: 'week' } } });
    await flush();
    page.onHide();
    assert.equal(page.data.posts.length, 0);
    assert.equal(page.data.space, null);
    assert.deepEqual(page.resume, { ...hotRoute, range: 'week' });
    assert.deepEqual(Object.keys(page.resume!), ['spaceId', 'range']);
    s.behavior.hot = async () => hotPage({ items: [] });
    page.onShow();
    await flush();
    assert.equal(page.data.range, 'week');
    assert.equal(page.data.loaded, true);
    assert.deepEqual(page.data.posts, []);
    assert.equal(s.calls[s.calls.length - 1]![1], null);
    s.runtime.privateViews?.clear();
    assert.equal(page.data.range, 'day');
    assert.equal(page.data.selectedSpaceId, '');
    page.onHide();
    assert.equal(page.resume?.range, 'week');
    page.onShow();
    await flush();
    assert.equal(page.data.range, 'week');
    page.onHide();
    s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('b'));
    assert.equal(page.resume, null);
    page.onShow();
    await flush();
    assert.equal(page.data.range, 'day');
    assert.equal(s.calls[s.calls.length - 1]![1], null);
    page.onRange({ currentTarget: { dataset: { key: 'year' } } });
    await flush();
    page.onHide();
    s.sessions.completeLogin(s.sessions.beginLogin(), {
      ...wireCredentials('c'),
      accountId: otherId,
    });
    assert.equal(page.resume, null);
    page.onShow();
    await flush();
    assert.equal(page.data.range, 'day');
    // Same-page relogin requires a fresh owner and root observer on explicit refresh.
    s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('d'));
    page.onRefresh();
    await flush();
    assert.equal(page.data.loaded, true);
    const pending = deferred<HotPage>();
    s.behavior.hot = async () => pending.promise;
    page.onRefresh();
    await flush();
    page.onUnload();
    pending.resolve(hotPage());
    await flush();
    assert.deepEqual(page.data.posts, []);
    assert.equal(page.resume, null);
    assert.equal(page.route, null);
    const final = page.data,
      count = s.calls.length;
    s.sessions.logout();
    s.runtime.privateViews?.clear();
    s.runtime.safetyChanges.invalidate(s.accountId);
    await flush();
    assert.equal(page.data, final);
    assert.equal(s.calls.length, count);
    assert.equal(s.storage.data.size, 0);
  } finally {
    page?.onUnload();
    globalThis.getApp = prior.getApp;
    nativeGlobal.wx = prior.wx;
    s.controller.dispose();
  }
});
test('hot rendered cards reuse the committed 50%/1s observer with re-entry, range/safety/hide/session fences and no guest/fetch events', async () => {
  const s = hotHarness(),
    clock = new FakeClock();
  const events: { kind: string; postId: string }[] = [];
  const listeners = new Set<() => void>(),
    commits: (() => void)[] = [],
    ticks: (() => void)[] = [];
  const observations: {
    selector: string;
    callback: (value: { intersectionRatio: number }) => void;
    disconnected: boolean;
  }[] = [];
  const sink: ViewObservationSink = {
    captureOwner: () => s.sessions.snapshot(),
    canPresent: (owner) =>
      !!owner.credentials && owner.epoch === s.sessions.snapshot().epoch,
    canObserve: (owner) =>
      !!owner.credentials && owner.epoch === s.sessions.snapshot().epoch,
    observe: (kind, postId) => {
      events.push({ kind, postId });
    },
    subscribeInvalidation: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const nativeGlobal = globalThis as typeof globalThis & { wx: WxApi };
  const prior = {
    getApp: globalThis.getApp,
    wx: nativeGlobal.wx,
    clock: { ...systemClock },
  };
  const runtime = { ...s.runtime, views: sink as ViewRuntime };
  globalThis.getApp = (() =>
    ({ community: runtime }) as WhaleuApp) as typeof getApp;
  systemClock.now = () => clock.now();
  systemClock.schedule = (callback, delay) => clock.schedule(callback, delay);
  nativeGlobal.wx = {
    nextTick(callback) {
      ticks.push(callback);
    },
    createIntersectionObserver(_page, options) {
      assert.deepEqual(options, { thresholds: [0, 0.5], initialRatio: 0 });
      const target = {
        selector: '',
        callback: (_value: { intersectionRatio: number }) => {},
        disconnected: false,
      };
      observations.push(target);
      return {
        relativeToViewport() {
          return this;
        },
        observe(selector, callback) {
          target.selector = selector;
          target.callback = callback;
        },
        disconnect() {
          target.disconnected = true;
        },
      };
    },
  } as WxApi;
  const commit = () => {
    while (commits.length) commits.shift()!();
    while (ticks.length) ticks.shift()!();
  };
  const current = () => {
    const target = observations
      .filter(
        (item) => !item.disconnected && item.selector === `#view-${post().id}`,
      )
      .slice(-1)[0];
    assert.ok(target);
    return target;
  };
  let page: NativeHotPage | undefined;
  try {
    const registered = await loadDefinition();
    page = {
      ...registered,
      data: { ...registered.data },
      setData(patch, callback) {
        this.data = { ...this.data, ...patch };
        if (callback) commits.push(callback);
      },
    };
    page.onLoad(hotRoute);
    page.onShow();
    await flush();
    assert.equal(page.data.loaded, true);
    assert.equal(
      observations.length,
      0,
      'fetch and uncommitted render never observe',
    );
    commit();
    clock.advance(2000);
    assert.equal(events.length, 0, 'offscreen card never qualifies');
    current().callback({ intersectionRatio: 0.49 });
    clock.advance(2000);
    assert.equal(events.length, 0);
    current().callback({ intersectionRatio: 0.5 });
    clock.advance(999);
    assert.equal(events.length, 0);
    clock.advance(1);
    assert.deepEqual(events, [{ kind: 'list_exposure', postId: post().id }]);
    current().callback({ intersectionRatio: 0.9 });
    clock.advance(1000);
    assert.equal(events.length, 1);
    current().callback({ intersectionRatio: 0.1 });
    current().callback({ intersectionRatio: 0.5 });
    clock.advance(1000);
    assert.equal(
      events.length,
      2,
      'qualified viewport re-entry reuses existing semantics',
    );
    let stale = current();
    page.onRange({ currentTarget: { dataset: { key: 'month' } } });
    stale.callback({ intersectionRatio: 1 });
    clock.advance(1000);
    assert.equal(events.length, 2);
    await flush();
    commit();
    current().callback({ intersectionRatio: 0.5 });
    clock.advance(500);
    stale = current();
    runtime.safetyChanges.invalidate(s.accountId);
    assert.equal(stale.disconnected, true);
    stale.callback({ intersectionRatio: 1 });
    clock.advance(1000);
    assert.equal(events.length, 2);
    await flush();
    commit();
    current().callback({ intersectionRatio: 0.5 });
    clock.advance(500);
    stale = current();
    runtime.privateViews?.clear();
    stale.callback({ intersectionRatio: 1 });
    commit();
    clock.advance(1000);
    assert.equal(events.length, 2);
    page.onHide();
    assert.equal(listeners.size, 0);
    page.onShow();
    await flush();
    commit();
    current().callback({ intersectionRatio: 0.5 });
    clock.advance(1000);
    assert.equal(events.length, 3, 'a fresh show can qualify again');
    stale = current();
    s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('new'));
    stale.callback({ intersectionRatio: 1 });
    commit();
    clock.advance(1000);
    assert.equal(events.length, 3);
    page.onRefresh();
    await flush();
    commit();
    current().callback({ intersectionRatio: 0.5 });
    clock.advance(1000);
    assert.equal(
      events.length,
      4,
      'explicit refresh after relogin constructs a current owner',
    );
    page.onHide();
    s.sessions.logout();
    const before = observations.length;
    page.onShow();
    await flush();
    commit();
    clock.advance(2000);
    assert.equal(page.data.loaded, true);
    assert.equal(page.data.hasSession, false);
    assert.equal(
      observations.length,
      before,
      'guest cards never attach a reporting observer',
    );
    assert.equal(events.length, 4);
    page.onUnload();
    assert.equal(listeners.size, 0);
    assert.equal(clock.timers, 0);
    assert.equal(s.storage.data.size, 0);
  } finally {
    page?.onUnload();
    globalThis.getApp = prior.getApp;
    nativeGlobal.wx = prior.wx;
    Object.assign(systemClock, prior.clock);
    s.controller.dispose();
  }
});
test('hot registration and plain card bindings expose no rank/score/private fields or category inheritance', () => {
  const read = (path: string) =>
    readFileSync(join(__dirname, '../src', path), 'utf8');
  const app = JSON.parse(read('app.json')) as { pages: string[] };
  assert.ok(app.pages.includes('pages/community-hot/community-hot'));
  const entry = read('pages/community-feed/community-feed.wxml').match(
    /url="([^"]*community-hot[^"]*)"/,
  );
  assert.equal(
    entry?.[1],
    '/pages/community-hot/community-hot?spaceId={{space.id}}',
  );
  const page = read('pages/community-hot/community-hot.wxml');
  assert.match(page, /id="view-\{\{item.id\}\}"/);
  assert.match(page, /\{\{item.text\}\}/);
  assert.match(page, /翻页内容可能变化/);
  assert.match(page, /尚未覆盖历史导入内容/);
  assert.match(page, /已选择的社区/);
  assert.match(page, /下一页/);
  assert.match(page, /上一页/);
  assert.match(page, /继续查看/);
  assert.match(page, /data-key="\{\{item.key\}\}" bindtap="onRange"/);
  assert.doesNotMatch(
    page,
    /rich-text|\bscore\b|\brank\b|\bindex\b|\btotal\b|accountId|actor|certificate|privateAuthor|本校|大学城/,
  );
  assert.match(
    read('pages/community-hot/community-hot.ts'),
    /viewObserver\?\.render\(/,
  );
  for (const file of [
    'community/hot-contract.ts',
    'community/hot-gateway.ts',
    'pages/community-hot/controller.ts',
    'pages/community-hot/community-hot.ts',
  ])
    assert.doesNotMatch(
      read(file),
      /setStorage|\.storage\.|console\.|identityOverlay|PendingViewStore|new ViewRuntime/,
    );
});
