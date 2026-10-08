import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { hotRanges, type HotPage } from '../src/community/hot-contract';
import {
  HotController,
  initialHotView,
} from '../src/pages/community-hot/controller';
import { otherId, post, requestId, spaceId } from './community-helpers';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import { hotHarness, hotPage, hotRoute, hotToken } from './hot-helpers';

test('explicit scope and day default use no profile/campus lookup or inherited feed category', async () => {
  const s = hotHarness(false);
  await s.controller.load(hotRoute);
  assert.deepEqual(s.calls[0]!.slice(0, 2), [{ spaceId, range: 'day' }, null]);
  assert.ok(Object.isFrozen(s.calls[0]![0]));
  assert.equal(s.gateway.calls.length, 0);
  assert.equal(s.profiles.calls.length, 0);
  assert.equal(s.view().loaded, true);
  assert.equal(s.view().hasSession, false);
  for (const range of hotRanges.slice(1)) {
    await s.controller.setRange(range.key);
    assert.deepEqual(s.calls[s.calls.length - 1]!.slice(0, 2), [
      { spaceId, range: range.key },
      null,
    ]);
  }
  const before = s.calls.length;
  await s.controller.setRange('all');
  await s.controller.setRange('history');
  await s.controller.load({ spaceId, category: 'trading' });
  assert.equal(s.calls.length, before);
  assert.equal(s.view().selectedSpaceId, '');
  assert.equal(s.view().space, null);
  assert.deepEqual(s.view().posts, []);
  assert.equal(s.storage.data.size, 0);
});
test('scope/range replacements clear cards and labels immediately and fence old success/error/finally', async () => {
  for (const lateError of [false, true]) {
    const s = hotHarness(),
      old = deferred<HotPage>(),
      newer = deferred<HotPage>();
    await s.controller.load(hotRoute);
    s.behavior.hot = async (intent) =>
      intent.range === 'week' ? old.promise : newer.promise;
    const first = s.controller.setRange('week');
    assert.deepEqual(s.view().posts, []);
    assert.equal(s.view().space, null);
    await flush();
    const second = s.controller.load({ spaceId: otherId, range: 'month' });
    await flush();
    assert.equal(s.calls[1]![2].isCancelled, true);
    assert.equal(s.view().selectedSpaceId, otherId);
    if (lateError) old.reject(new ClientError('network', 'private raw detail'));
    else old.resolve(hotPage());
    await first;
    assert.equal(s.view().busy, true);
    assert.equal(s.view().error, '');
    assert.deepEqual(s.view().posts, []);
    newer.resolve(
      hotPage({
        items: [
          post({
            id: requestId,
            space: { id: otherId, kind: 'global', name: '当前全站话题' },
          }),
        ],
      }),
    );
    await second;
    assert.equal(s.view().range, 'month');
    assert.equal(s.view().space?.name, '当前全站话题');
    assert.equal(s.view().busy, false);
    s.behavior.hot = async () => hotPage({ items: [] });
    await s.controller.refresh();
    assert.equal(
      s.view().space,
      null,
      'empty refresh cannot retain a stale space label',
    );
  }
});
test('live movement can repeat IDs across pages; Previous is fresh and discards old forward successors', async () => {
  const s = hotHarness();
  s.behavior.hot = async (_intent, after) =>
    hotPage({
      items: [post()],
      continuation: 'scan_pending',
      nextCursor:
        after === null
          ? hotToken(1)
          : after === hotToken(1)
            ? hotToken(2)
            : hotToken(3),
    });
  await s.controller.load(hotRoute);
  await s.controller.next();
  assert.equal(s.view().posts.length, 1);
  assert.equal(s.view().posts[0]!.id, post().id);
  await s.controller.next();
  assert.equal(s.view().canPrevious, true);
  s.behavior.hot = async () =>
    hotPage({
      items: [post({ text: 'current body after movement' })],
      continuation: 'scan_pending',
      nextCursor: hotToken(2),
    });
  await s.controller.previous();
  assert.equal(s.calls[s.calls.length - 1]![1], hotToken(1));
  assert.equal(s.view().posts[0]!.text, 'current body after movement');
  assert.equal(s.view().error, '');
  s.behavior.hot = async () => hotPage({ items: [] });
  await s.controller.previous();
  assert.equal(s.calls[s.calls.length - 1]![1], null);
  assert.deepEqual(s.view().posts, []);
  assert.equal(s.view().canPrevious, false);
  assert.equal(s.storage.data.size, 0);
});
test('rapid Next, Previous and refresh taps dispatch one request; current bodies disappear during waits', async () => {
  const s = hotHarness();
  s.behavior.hot = async () =>
    hotPage({ continuation: 'scan_pending', nextCursor: hotToken() });
  await s.controller.load(hotRoute);
  for (const operation of ['next', 'previous', 'refresh'] as const) {
    if (operation === 'previous') assert.equal(s.view().canPrevious, true);
    const pending = deferred<HotPage>();
    s.behavior.hot = async () => pending.promise;
    const before = s.calls.length;
    const first = s.controller[operation](),
      twice = s.controller[operation]();
    await flush();
    assert.equal(s.calls.length, before + 1);
    assert.deepEqual(s.view().posts, []);
    pending.resolve(
      hotPage({ continuation: 'scan_pending', nextCursor: hotToken(2) }),
    );
    await Promise.all([first, twice]);
  }
});
test('cursor cycles fail closed, while Previous may legitimately return its old successor', async () => {
  for (const repeated of [1, 2, 3]) {
    const s = hotHarness();
    let sequence = 0;
    s.behavior.hot = async () =>
      hotPage({
        items: [],
        continuation: 'scan_pending',
        nextCursor: hotToken(++sequence),
      });
    await s.controller.load(hotRoute);
    await s.controller.next();
    await s.controller.next();
    s.behavior.hot = async () =>
      hotPage({
        items: [post()],
        continuation: 'scan_pending',
        nextCursor: hotToken(repeated),
      });
    await s.controller.next();
    assert.deepEqual(s.view().posts, []);
    assert.equal(s.view().loaded, false);
    assert.equal(s.view().canNext, false);
    assert.equal(s.view().canPrevious, false);
  }
});
test('only 32 input cursors remain; older bodies are never cached and fresh Previous stops at retained boundary', async () => {
  const s = hotHarness();
  let sequence = 0;
  s.behavior.hot = async () =>
    hotPage({
      items: [],
      continuation: 'scan_pending',
      nextCursor: hotToken(++sequence),
    });
  await s.controller.load(hotRoute);
  for (let n = 0; n < 40; n++) await s.controller.next();
  for (let n = 0; n < 31; n++) await s.controller.previous();
  assert.equal(s.view().canPrevious, false);
  assert.equal(s.calls[s.calls.length - 1]![1], hotToken(9));
  const count = s.calls.length;
  await s.controller.previous();
  assert.equal(s.calls.length, count);
  assert.deepEqual(s.controller.snapshot(), { spaceId, range: 'day' });
  assert.equal('pageNumber' in s.view(), false);
  assert.equal('rank' in s.view(), false);
});
test('sparse, login and phone continuation are distinct from end and never trigger automatic scanning', async () => {
  for (const continuation of [
    'scan_pending',
    'login_required',
    'phone_verification_required',
  ] as const) {
    const s = hotHarness(continuation !== 'login_required');
    s.behavior.hot = async () =>
      hotPage({
        items: [],
        continuation,
        nextCursor: continuation === 'scan_pending' ? hotToken() : null,
      });
    await s.controller.load(hotRoute);
    await flush();
    assert.equal(s.calls.length, 1);
    assert.equal(s.view().loaded, true);
    assert.doesNotMatch(s.view().status, /暂无|末尾/);
    assert.equal(s.view().canNext, continuation === 'scan_pending');
    assert.equal(s.view().space, null);
    if (continuation !== 'scan_pending') {
      await s.controller.next();
      assert.equal(s.calls.length, 1);
    }
  }
});
test('unconfigured/unavailable, unavailable scope and expired cursors clear cards without claiming an empty board', async () => {
  const s = hotHarness();
  let unconfigured = initialHotView();
  const { hot, ...unconfiguredRuntime } = s.runtime;
  assert.ok(hot);
  const controller = new HotController(unconfiguredRuntime, (view) => {
    unconfigured = view;
  });
  await controller.load(hotRoute);
  assert.equal(unconfigured.configured, false);
  assert.equal(unconfigured.loaded, false);
  assert.match(unconfigured.error, /尚未配置热门/);
  controller.dispose();
  for (const serverCode of [
    'DISCOVERY_RESTART_REQUIRED',
    'BAD_REQUEST',
    'HOT_FEED_UNAVAILABLE',
    'COMMUNITY_SCOPE_UNAVAILABLE',
    'COMMUNITY_UNAVAILABLE',
  ]) {
    s.behavior.hot = async () =>
      hotPage({ continuation: 'scan_pending', nextCursor: hotToken() });
    await s.controller.load(hotRoute);
    s.behavior.hot = async () => {
      throw new ClientError('business', 'private server message', {
        serverCode,
      });
    };
    await s.controller.next();
    assert.equal(s.view().loaded, false);
    assert.equal(s.view().space, null);
    assert.deepEqual(s.view().posts, []);
    assert.equal(s.view().canNext, false);
    assert.equal(s.view().canPrevious, false);
    assert.equal(
      s.view().restartRequired,
      ['DISCOVERY_RESTART_REQUIRED', 'BAD_REQUEST'].includes(serverCode),
    );
    assert.doesNotMatch(s.view().error, /private server message/);
    if (serverCode === 'HOT_FEED_UNAVAILABLE')
      assert.match(s.view().status, /暂不可用/);
    s.behavior.hot = async () => hotPage();
    await s.controller.refresh();
    assert.equal(s.calls[s.calls.length - 1]![1], null);
    assert.equal(s.view().loaded, true);
  }
});
test('safety invalidation re-reads selected intent from the start and never retains old cards', async () => {
  const s = hotHarness(),
    pending = deferred<HotPage>();
  await s.controller.load({ spaceId, range: 'year' });
  s.behavior.hot = async () => pending.promise;
  s.runtime.safetyChanges.invalidate(s.accountId);
  assert.deepEqual(s.view().posts, []);
  assert.equal(s.view().space, null);
  await flush();
  assert.deepEqual(s.calls[s.calls.length - 1]!.slice(0, 2), [
    { spaceId, range: 'year' },
    null,
  ]);
  pending.resolve(hotPage({ items: [] }));
  await flush();
  assert.equal(s.view().loaded, true);
  assert.deepEqual(s.view().posts, []);
});
test('account/relogin/auth/cancel/hide/unload fences delayed callbacks and erases navigation', async () => {
  for (const action of [
    'logout',
    'same',
    'other',
    'auth',
    'cancel',
    'dispose',
    'root-hide',
  ] as const) {
    const s = hotHarness(),
      delayed = deferred<HotPage>();
    await s.controller.load(hotRoute);
    s.behavior.hot = async () => delayed.promise;
    const work = s.controller.refresh();
    await flush();
    if (action === 'logout') s.sessions.logout();
    if (action === 'same' || action === 'other')
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('b'),
        ...(action === 'other' ? { accountId: otherId } : {}),
      });
    if (action === 'cancel') s.controller.cancel();
    if (action === 'dispose') s.controller.dispose();
    if (action === 'root-hide') s.runtime.privateViews?.clear();
    assert.deepEqual(s.view().posts, []);
    if (action === 'auth')
      delayed.reject(new ClientError('auth-required', 'private'));
    else delayed.resolve(hotPage());
    await work;
    await flush();
    assert.deepEqual(s.view().posts, []);
    assert.equal(s.view().space, null);
    assert.equal(s.view().canNext, false);
    assert.equal(s.view().canPrevious, false);
    if (action !== 'cancel') assert.equal(s.controller.snapshot(), null);
    s.controller.dispose();
    assert.equal(s.storage.data.size, 0);
  }
});
