import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { WhaleuApp } from '../src/app';
import type { WxApi } from '../src/platform/wechat';
import type {
  SearchController,
  SearchResume,
  SearchView,
} from '../src/pages/community-search/controller';
import type { SearchPage } from '../src/community/search-contract';
import { deferred, flush } from './helpers';
import { otherId, space, spaceId } from './community-helpers';
import { wireCredentials } from './identity-helpers';
import { searchHarness, searchPage, searchRoute } from './search-helpers';
interface NativeSearchPage {
  data: SearchView;
  resume: SearchResume | null;
  controller: SearchController | undefined;
  setData(patch: Record<string, unknown>): void;
  onLoad(query: unknown): void;
  onShow(): void;
  onHide(): void;
  onUnload(): void;
  onSubmit(): void;
  onInput(event: { detail: { value: string } }): void;
  onAggregateScope(event: {
    currentTarget: { dataset: { scope: string } };
  }): void;
  onScope(event: { currentTarget: { dataset: { id: string } } }): void;
  onCategory(event: { currentTarget: { dataset: { key: string } } }): void;
  onTradingSubtype(event: {
    currentTarget: { dataset: { key: string } };
  }): void;
  onRefresh(): void;
  onNext(): void;
  onPrevious(): void;
  onCancel(): void;
}
let registeredDefinition: NativeSearchPage | undefined;
test('native lifecycle clears hidden DTOs, freshly resumes intent, fences account/session swaps while hidden and removes listeners on unload', async () => {
  const s = searchHarness();
  let definition: NativeSearchPage | undefined;
  const nativeGlobal = globalThis as typeof globalThis & { wx: WxApi };
  const prior = {
    Page: globalThis.Page,
    getApp: globalThis.getApp,
    wx: nativeGlobal.wx,
  };
  globalThis.Page = ((options: object) => {
    definition = options as NativeSearchPage;
    registeredDefinition = definition;
  }) as typeof Page;
  globalThis.getApp = (() =>
    ({ community: s.runtime }) as WhaleuApp) as typeof getApp;
  nativeGlobal.wx = {} as WxApi;
  try {
    await import('../src/pages/community-search/community-search.js');
    assert.ok(definition);
    const page: NativeSearchPage = {
      ...definition,
      data: { ...definition.data },
      setData(patch) {
        this.data = { ...this.data, ...patch };
      },
    };
    page.onLoad(searchRoute);
    page.onShow();
    await flush();
    page.onInput({ detail: { value: 'private-query' } });
    page.onSubmit();
    await flush();
    assert.equal(page.data.loaded, true);
    assert.equal(page.data.posts.length, 1);
    page.onInput({ detail: { value: 'editing' } });
    page.onHide();
    assert.equal(page.data.posts.length, 0);
    assert.equal(page.data.inputDraft, '');
    assert.equal(page.resume?.submittedQuery, 'private-query');
    assert.equal('posts' in page.resume!, false);
    s.behavior.search = async () => searchPage({ items: [] });
    page.onShow();
    await flush();
    assert.equal(page.data.submittedQuery, 'private-query');
    assert.equal(page.data.inputDraft, 'editing');
    assert.deepEqual(page.data.posts, []);
    assert.equal(s.calls[s.calls.length - 1]![1], null);
    // App root-hide runs before the mini-program's page onHide callback.
    s.runtime.privateViews?.clear();
    page.onHide();
    assert.equal(page.data.submittedQuery, '');
    assert.equal(page.resume?.submittedQuery, 'private-query');
    page.onShow();
    await flush();
    assert.equal(page.data.submittedQuery, 'private-query');
    page.onHide();
    s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('b'));
    assert.equal(page.resume, null);
    assert.equal(page.data.submittedQuery, '');
    const before = s.calls.length;
    page.onShow();
    await flush();
    assert.equal(s.calls.length, before);
    assert.equal(page.data.submittedQuery, '');
    page.onInput({ detail: { value: 'other private query' } });
    page.onSubmit();
    await flush();
    page.onHide();
    s.sessions.completeLogin(s.sessions.beginLogin(), {
      ...wireCredentials('c'),
      accountId: otherId,
    });
    assert.equal(page.resume, null);
    page.onShow();
    await flush();
    assert.equal(page.data.inputDraft, '');
    const pending = deferred<SearchPage>();
    s.behavior.search = async () => pending.promise;
    page.onInput({ detail: { value: 'late' } });
    page.onSubmit();
    await flush();
    page.onUnload();
    pending.resolve(searchPage());
    await flush();
    assert.deepEqual(page.data.posts, []);
    assert.equal(page.resume, null);
    assert.equal(page.data.submittedQuery, '');
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
    globalThis.Page = prior.Page;
    globalThis.getApp = prior.getApp;
    nativeGlobal.wx = prior.wx;
    s.controller.dispose();
  }
});
test('native registration, explicit feed link and plain result rendering contain no keyword URL, history, totals or highlighting', () => {
  const read = (path: string) =>
    readFileSync(join(__dirname, '../src', path), 'utf8');
  const app = JSON.parse(read('app.json')) as { pages: string[] };
  assert.ok(app.pages.includes('pages/community-search/community-search'));
  const feed = read('pages/community-feed/community-feed.wxml');
  assert.match(feed, /community-search\/community-search\?campusId=.*spaceId=/);
  assert.match(feed, /tradingSubtype=/);
  assert.match(feed, /community-search\/community-search\?scope=all/);
  const page = read('pages/community-search/community-search.wxml');
  assert.match(page, /\{\{item.text\}\}/);
  assert.match(page, /继续查找/);
  assert.match(page, /data-scope="all" bindtap="onAggregateScope"/);
  assert.match(page, /data-scope="regional" bindtap="onAggregateScope"/);
  assert.match(page, /data-scope="global" bindtap="onAggregateScope"/);
  assert.match(page, /选择下方分类会切换到跨校园分类搜索/);
  assert.match(page, /普通、急出和已完成/);
  assert.match(
    page,
    /wx:if="\{\{selectedScope === 'all' \|\| selectedScope === 'regional' \|\| selectedScope === 'explicit'/,
  );
  assert.doesNotMatch(page, /每次只搜索|跨校园聚合及/);
  assert.match(page, /community-detail\/community-detail\?postId=/);
  assert.doesNotMatch(page, /rich-text|highlight|total|[?&]q=/i);
  for (const path of [
    'community/search-contract.ts',
    'community/search-gateway.ts',
    'pages/community-search/controller.ts',
    'pages/community-search/community-search.ts',
  ]) {
    const source = read(path);
    assert.doesNotMatch(
      source,
      /toLowerCase\(|toLocaleLowerCase\(|setStorage|\.storage\.|console\.|reportExposure|search_history/,
    );
  }
});

test('actual native aggregate route and scope/category bindings preserve frozen intent and fence late optional choices across Hide/Show', async () => {
  const s = searchHarness(),
    delayed = deferred<Awaited<ReturnType<typeof s.gateway.spacesImpl>>>();
  const nativeGlobal = globalThis as typeof globalThis & { wx: WxApi };
  const prior = { getApp: globalThis.getApp, wx: nativeGlobal.wx };
  globalThis.getApp = (() =>
    ({ community: s.runtime }) as WhaleuApp) as typeof getApp;
  nativeGlobal.wx = {} as WxApi;
  if (!registeredDefinition) {
    const previousPage = globalThis.Page;
    globalThis.Page = ((options: object) => {
      registeredDefinition = options as NativeSearchPage;
    }) as typeof Page;
    try {
      await import('../src/pages/community-search/community-search.js');
    } finally {
      globalThis.Page = previousPage;
    }
  }
  assert.ok(registeredDefinition);
  const mount = (route: unknown): NativeSearchPage => {
    const page: NativeSearchPage = {
      ...registeredDefinition!,
      data: { ...registeredDefinition!.data },
      setData(patch) {
        this.data = { ...this.data, ...patch };
      },
    };
    page.onLoad(route);
    page.onShow();
    return page;
  };
  let page: NativeSearchPage | undefined;
  try {
    page = mount({ scope: 'all' });
    await flush();
    assert.equal(s.gateway.calls.length, 0);
    assert.equal(page.data.scopeLoaded, true);
    page.onInput({ detail: { value: 'submitted' } });
    page.onSubmit();
    await flush();
    assert.equal(page.data.loaded, true);
    page.onInput({ detail: { value: 'UNSENT' } });
    page.onCategory({ currentTarget: { dataset: { key: 'trading' } } });
    assert.equal(page.data.selectedScope, 'regional');
    assert.deepEqual(page.data.posts, []);
    await flush();
    page.onTradingSubtype({ currentTarget: { dataset: { key: 'shuma' } } });
    await flush();
    assert.deepEqual(s.calls[s.calls.length - 1]![0], {
      scope: 'regional',
      category: 'trading',
      tradingSubtype: 'shuma',
      q: 'submitted',
    });
    page.onAggregateScope({ currentTarget: { dataset: { scope: 'global' } } });
    await flush();
    assert.deepEqual(s.calls[s.calls.length - 1]![0], {
      scope: 'global',
      q: 'submitted',
    });
    assert.equal(page.data.category, 'all');
    assert.equal(page.data.tradingSubtype, '');
    page.onHide();
    assert.equal(page.resume?.route.scope, 'global');
    assert.equal(page.data.submittedQuery, '');
    page.onShow();
    await flush();
    assert.equal(page.data.inputDraft, 'UNSENT');
    assert.equal(page.data.submittedQuery, 'submitted');
    assert.equal(page.data.selectedScope, 'global');
    assert.equal(s.calls[s.calls.length - 1]![1], null);
    page.onUnload();

    // Aggregate results finish before its optional browse lookup. Hide must cancel it even
    // after the base read has cleared its own active-request cancellation reference.
    s.gateway.spacesImpl = async () => delayed.promise;
    page = mount({ scope: 'all', campusId: searchRoute.campusId });
    await flush();
    page.onInput({ detail: { value: 'submitted' } });
    page.onSubmit();
    await flush();
    assert.equal(page.data.loaded, true);
    page.onHide();
    s.gateway.spacesImpl = async () => ({ regional: null, global: [] });
    page.onShow();
    await flush();
    assert.equal(page.data.loaded, true);
    delayed.resolve({
      regional: space(),
      global: [space({ id: otherId, kind: 'global', operatingRegionId: null })],
    });
    await flush();
    assert.equal(page.data.regional, null);
    assert.deepEqual(page.data.globalSpaces, []);
    assert.match(page.data.browseNotice, /仍可使用/);

    s.gateway.spacesImpl = async () => ({ regional: space(), global: [] });
    page.onRefresh();
    await flush();
    page.onScope({ currentTarget: { dataset: { id: spaceId } } });
    await flush();
    assert.equal(page.data.selectedScope, 'explicit');
    assert.deepEqual(s.calls[s.calls.length - 1]![0], {
      spaceId,
      q: 'submitted',
    });
    page.onAggregateScope({
      currentTarget: { dataset: { scope: 'regional' } },
    });
    await flush();
    s.runtime.safetyChanges.invalidate(s.accountId);
    await flush();
    assert.equal(page.data.selectedScope, 'regional');
    assert.deepEqual(s.calls[s.calls.length - 1]![0], {
      scope: 'regional',
      q: 'submitted',
    });
    page.onHide();
    s.sessions.completeLogin(s.sessions.beginLogin(), {
      ...wireCredentials('z'),
      accountId: otherId,
    });
    assert.equal(page.resume, null);
    page.onShow();
    await flush();
    assert.equal(page.data.inputDraft, '');
    assert.equal(page.data.submittedQuery, '');
    assert.deepEqual(page.data.posts, []);
  } finally {
    page?.onUnload();
    globalThis.getApp = prior.getApp;
    nativeGlobal.wx = prior.wx;
    s.controller.dispose();
  }
});
