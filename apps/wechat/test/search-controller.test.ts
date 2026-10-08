import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import type { SearchPage } from '../src/community/search-contract';
import {
  SearchController,
  initialSearchView,
} from '../src/pages/community-search/controller';
import { otherId, post, requestId, space, spaceId } from './community-helpers';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  searchHarness,
  searchPage,
  searchRoute,
  searchToken,
} from './search-helpers';

async function start(s: ReturnType<typeof searchHarness>, q = '校园') {
  await s.controller.load(searchRoute);
  s.controller.setInput(q);
  await s.controller.submit();
}
test('explicit active scope is resolved before search, with no campus/default or global fallback', async () => {
  const s = searchHarness(false);
  await s.controller.load(searchRoute);
  assert.equal(s.calls.length, 0);
  assert.equal(s.view().scopeLoaded, true);
  assert.equal(s.profiles.calls.length, 0);
  await s.controller.load({ ...searchRoute, spaceId: otherId });
  s.controller.setInput('x');
  await s.controller.submit();
  assert.equal(s.calls.length, 0);
  assert.equal(s.view().space, null);
  s.gateway.spacesImpl = async () => ({
    regional: space({ isActive: false }),
    global: [space({ id: otherId, kind: 'global', operatingRegionId: null })],
  });
  await s.controller.load(searchRoute);
  assert.equal(s.view().space, null);
  assert.equal(s.view().globalSpaces.length, 1);
  await s.controller.chooseSpace(otherId);
  s.controller.setInput('x');
  await s.controller.submit();
  assert.equal(s.calls[0]![0].spaceId, otherId);
  const count = s.calls.length;
  await s.controller.setCategory('trading');
  assert.equal(s.calls.length, count);
  await s.controller.load(
    { ...searchRoute, spaceId: otherId, category: 'trading' },
    { inputDraft: 'x', submittedQuery: 'x' },
  );
  assert.equal(s.calls.length, count);
  assert.equal(s.view().loaded, false);
  assert.ok(s.view().error);
});
test('draft edits never change frozen query; scopes/categories/subtypes restart the submitted intent', async () => {
  const s = searchHarness();
  s.gateway.spacesImpl = async () => ({
    regional: space(),
    global: [space({ id: otherId, kind: 'global', operatingRegionId: null })],
  });
  s.behavior.search = async () =>
    searchPage({
      items: [],
      continuation: 'scan_pending',
      nextCursor: searchToken(),
    });
  await start(s, '  A\r\n校园  ');
  assert.equal(s.view().submittedQuery, 'A\n校园');
  assert.ok(Object.isFrozen(s.calls[0]![0]));
  s.controller.setInput('UNSENT');
  await s.controller.next();
  assert.equal(s.calls[s.calls.length - 1]![0].q, 'A\n校园');
  await s.controller.setCategory('trading');
  await s.controller.setTradingSubtype('shuma');
  assert.deepEqual(s.calls[s.calls.length - 1]!.slice(0, 2), [
    { spaceId, q: 'A\n校园', category: 'trading', tradingSubtype: 'shuma' },
    null,
  ]);
  await s.controller.chooseSpace(otherId);
  assert.deepEqual(s.calls[s.calls.length - 1]!.slice(0, 2), [
    { spaceId: otherId, q: 'A\n校园' },
    null,
  ]);
  assert.equal(s.view().inputDraft, 'UNSENT');
  assert.equal(s.view().category, 'all');
  assert.equal(s.view().tradingSubtype, '');
  assert.equal(s.storage.data.size, 0);
});
test('input edits during requests preserve current submitted query, and new submit fences stale success/error/finally', async () => {
  for (const lateError of [false, true]) {
    const s = searchHarness(),
      old = deferred<SearchPage>(),
      newer = deferred<SearchPage>();
    await s.controller.load(searchRoute);
    s.behavior.search = async (intent) =>
      intent.q === 'old' ? old.promise : newer.promise;
    s.controller.setInput('old');
    const first = s.controller.submit();
    await flush();
    s.controller.setInput('new');
    const second = s.controller.submit();
    await flush();
    assert.equal(s.view().busy, true);
    assert.equal(s.calls[0]![2].isCancelled, true);
    if (lateError)
      old.reject(new ClientError('network', 'private raw message'));
    else old.resolve(searchPage());
    await first;
    await flush();
    assert.equal(s.view().busy, true);
    assert.equal(s.view().error, '');
    assert.deepEqual(s.view().posts, []);
    s.controller.setInput('still editing');
    newer.resolve(searchPage({ items: [post({ id: requestId })] }));
    await second;
    assert.equal(s.view().submittedQuery, 'new');
    assert.equal(s.view().inputDraft, 'still editing');
    assert.equal(s.view().posts[0]?.id, requestId);
    assert.equal(s.view().busy, false);
  }
});
test('rapid scope and category changes suppress stale scope lookup, request errors and finally', async () => {
  const s = searchHarness(),
    delayed = deferred<Awaited<ReturnType<typeof s.gateway.spacesImpl>>>();
  await start(s);
  s.gateway.spacesImpl = async () => delayed.promise;
  const old = s.controller.setCategory('pets');
  await flush();
  s.gateway.spacesImpl = async () => ({ regional: space(), global: [] });
  await s.controller.setCategory('research');
  const calls = s.calls.length;
  delayed.resolve({ regional: space(), global: [] });
  await old;
  assert.equal(s.calls.length, calls);
  assert.equal(s.calls[s.calls.length - 1]![0].category, 'research');
  assert.equal(s.view().category, 'research');
  assert.equal(s.view().loaded, true);
  assert.equal(s.view().busy, false);
  await s.controller.load({ ...searchRoute, campusId: otherId });
  assert.equal(s.view().submittedQuery, '');
  assert.equal(s.view().inputDraft, '');
  assert.deepEqual(s.view().posts, []);
});
test('Next/Previous are fresh bounded reads, double Next is ignored and trailing end is not a global zero', async () => {
  const s = searchHarness(),
    next = deferred<SearchPage>();
  s.behavior.search = async (_intent, after) =>
    after
      ? next.promise
      : searchPage({ continuation: 'scan_pending', nextCursor: searchToken() });
  await start(s);
  const pending = s.controller.next();
  const twice = s.controller.next();
  await flush();
  assert.equal(s.calls.length, 2);
  assert.deepEqual(s.view().posts, []);
  next.resolve(searchPage({ items: [] }));
  await Promise.all([pending, twice]);
  assert.equal(s.view().pageNumber, 2);
  assert.equal(s.view().status, '已到本次搜索末尾');
  assert.equal(s.view().canPrevious, true);
  s.behavior.search = async () => searchPage({ items: [] });
  await s.controller.previous();
  assert.equal(s.calls[s.calls.length - 1]![1], null);
  assert.deepEqual(s.view().posts, []);
  assert.equal(s.view().pageNumber, 1);
  assert.match(s.view().status, /没有可查看的匹配/);
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'spaces').length,
    4,
  );
});
test('cursor trail keeps at most 32 input refs without bodies and fresh Previous cannot go beyond retained history', async () => {
  const s = searchHarness();
  let sequence = 0;
  s.behavior.search = async () =>
    searchPage({
      items: [],
      continuation: 'scan_pending',
      nextCursor: searchToken(++sequence),
    });
  await start(s);
  for (let n = 0; n < 40; n++) await s.controller.next();
  assert.equal(s.view().pageNumber, 41);
  for (let n = 0; n < 31; n++) await s.controller.previous();
  assert.equal(s.view().pageNumber, 10);
  assert.equal(s.view().canPrevious, false);
  const count = s.calls.length;
  await s.controller.previous();
  assert.equal(s.calls.length, count);
});
test('empty scan_pending and permission states never claim exhausted zero and cannot background scan', async () => {
  for (const continuation of [
    'scan_pending',
    'login_required',
    'phone_verification_required',
  ] as const) {
    const s = searchHarness(continuation !== 'login_required');
    s.behavior.search = async () =>
      searchPage({
        items: [],
        continuation,
        nextCursor: continuation === 'scan_pending' ? searchToken() : null,
      });
    await start(s);
    await flush();
    assert.equal(s.calls.length, 1);
    assert.equal(s.view().loaded, true);
    assert.doesNotMatch(s.view().status, /没有.*匹配|末尾/);
    assert.equal(s.view().canNext, continuation === 'scan_pending');
    if (continuation !== 'scan_pending') {
      await s.controller.next();
      assert.equal(s.calls.length, 1);
    }
    assert.equal('total' in s.view(), false);
  }
});
test('expired/mismatched cursors clear trails and expose a fresh restart, other errors remain retryable', async () => {
  for (const serverCode of [
    'DISCOVERY_RESTART_REQUIRED',
    'BAD_REQUEST',
    'COMMUNITY_UNAVAILABLE',
  ]) {
    const s = searchHarness();
    s.behavior.search = async () =>
      searchPage({ continuation: 'scan_pending', nextCursor: searchToken() });
    await start(s);
    s.behavior.search = async () => {
      throw new ClientError('business', 'server message', { serverCode });
    };
    await s.controller.next();
    assert.deepEqual(s.view().posts, []);
    assert.equal(s.view().canNext, false);
    assert.equal(s.view().canPrevious, false);
    assert.equal(
      s.view().restartRequired,
      serverCode !== 'COMMUNITY_UNAVAILABLE',
    );
    assert.equal(s.view().submittedQuery, '校园');
    assert.equal(s.view().error.includes('server message'), false);
    s.behavior.search = async () => searchPage();
    await s.controller.refresh();
    assert.equal(s.calls[s.calls.length - 1]![1], null);
    assert.equal(s.view().pageNumber, 1);
  }
});
test('same-account safety changes clear immediately then re-resolve scope using only the frozen intent', async () => {
  const s = searchHarness(),
    pending = deferred<SearchPage>();
  await start(s);
  s.controller.setInput('draft');
  s.behavior.search = async () => pending.promise;
  s.runtime.safetyChanges.invalidate(s.accountId);
  await flush();
  assert.deepEqual(s.view().posts, []);
  assert.equal(s.view().submittedQuery, '校园');
  assert.equal(s.calls[s.calls.length - 1]![0].q, '校园');
  assert.equal(s.calls[s.calls.length - 1]![1], null);
  pending.resolve(searchPage({ items: [] }));
  await flush();
  assert.deepEqual(s.view().posts, []);
  assert.equal(s.view().inputDraft, 'draft');
  s.gateway.spacesImpl = async () => ({ regional: null, global: [] });
  s.runtime.safetyChanges.invalidate(s.accountId);
  await flush();
  assert.equal(s.view().space, null);
  assert.deepEqual(s.view().posts, []);
});
test('logout, same-account replacement, account switch, auth rejection and disposal remove query and stale results', async () => {
  for (const action of [
    'logout',
    'same',
    'other',
    'auth',
    'dispose',
    'root-hide',
  ] as const) {
    const s = searchHarness(),
      pending = deferred<SearchPage>();
    await s.controller.load(searchRoute);
    s.controller.setInput('private-query');
    s.behavior.search = async () => pending.promise;
    const work = s.controller.submit();
    await flush();
    if (action === 'logout') s.sessions.logout();
    if (action === 'same' || action === 'other')
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('b'),
        ...(action === 'other' ? { accountId: otherId } : {}),
      });
    if (action === 'dispose') s.controller.dispose();
    if (action === 'root-hide') s.runtime.privateViews?.clear();
    if (action === 'auth')
      pending.reject(new ClientError('auth-required', 'unauthorized'));
    else pending.resolve(searchPage());
    await work;
    assert.deepEqual(s.view().posts, []);
    assert.equal(s.view().inputDraft, '');
    assert.equal(s.view().submittedQuery, '');
    assert.equal(s.controller.snapshot(), null);
    assert.equal(s.view().canNext, false);
    assert.equal(s.view().busy, false);
    assert.equal(s.storage.data.size, 0);
  }
});
test('cancel stops the spinner and late replies; query-only resume re-reads changed/deleted detail with no old cursor', async () => {
  const s = searchHarness(),
    pending = deferred<SearchPage>();
  await start(s);
  s.controller.setInput('draft');
  const resume = s.controller.snapshot();
  assert.ok(resume);
  assert.equal('posts' in resume, false);
  assert.equal('nextCursor' in resume, false);
  s.behavior.search = async () => pending.promise;
  const wait = s.controller.refresh();
  await flush();
  s.controller.cancel();
  pending.resolve(searchPage());
  await wait;
  assert.equal(s.view().busy, false);
  assert.deepEqual(s.view().posts, []);
  assert.equal(s.view().submittedQuery, '校园');
  s.controller.dispose();
  let view = initialSearchView();
  const fresh = new SearchController(s.runtime, (v) => {
    view = v;
  });
  s.behavior.search = async () => searchPage({ items: [] });
  await fresh.load(resume.route, resume);
  assert.deepEqual(view.posts, []);
  assert.equal(view.inputDraft, 'draft');
  assert.equal(view.submittedQuery, '校园');
  assert.equal(s.calls[s.calls.length - 1]![1], null);
  fresh.dispose();
  const count = s.calls.length;
  s.runtime.safetyChanges.invalidate(s.accountId);
  await flush();
  assert.equal(s.calls.length, count);
});

test('invalid resubmit cancels the old request without adopting a new intent or leaking a late result', async () => {
  const s = searchHarness(),
    pending = deferred<SearchPage>();
  await s.controller.load(searchRoute);
  s.behavior.search = async () => pending.promise;
  s.controller.setInput('original');
  const work = s.controller.submit();
  await flush();
  s.controller.setInput('\v');
  await s.controller.submit();
  assert.equal(s.view().busy, false);
  assert.match(s.view().error, /1–200/);
  assert.equal(s.view().submittedQuery, 'original');
  pending.resolve(searchPage());
  await work;
  assert.deepEqual(s.view().posts, []);
  assert.equal(s.view().loaded, false);
  assert.match(s.view().error, /1–200/);
  assert.equal(s.calls.length, 1);
});
