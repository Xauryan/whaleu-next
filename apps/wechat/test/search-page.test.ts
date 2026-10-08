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
import { otherId } from './community-helpers';
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
}
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
  const page = read('pages/community-search/community-search.wxml');
  assert.match(page, /\{\{item.text\}\}/);
  assert.match(page, /继续查找/);
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
