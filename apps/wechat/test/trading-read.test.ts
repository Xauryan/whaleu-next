import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import type { Feed, TradingList } from '../src/community/contract';
import type { FeedQuery } from '../src/community/gateway';
import type { Cancellation } from '../src/platform/contracts';
import {
  FeedController,
  type FeedView,
} from '../src/pages/community-feed/controller';
import {
  MineController,
  type MineView,
} from '../src/pages/community-mine/controller';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import { campusId } from './profile-helpers';
import {
  otherId,
  post,
  postId,
  requestId,
  setup,
  space,
  spaceId,
  tradingPost,
  tradingView,
} from './community-helpers';

function feed(loggedIn = true) {
  const s = setup(loggedIn),
    views: FeedView[] = [];
  const controller = new FeedController(s.runtime, (view) => views.push(view));
  return {
    ...s,
    controller,
    view: () => views[views.length - 1]!,
    queries: () =>
      s.gateway.calls
        .filter((call) => call.method === 'feed')
        .map((call) => call.args[0] as FeedQuery),
  };
}
function mine() {
  const s = setup(),
    views: MineView[] = [];
  const controller = new MineController(s.runtime, (view) => views.push(view));
  return { ...s, controller, view: () => views[views.length - 1]! };
}
const result = (items = [tradingPost()]): Feed => ({
  items,
  nextCursor: null,
  continuation: 'end',
});

test('ordinary feed omits category while explicit regional trading carries exact subtype and clears it when leaving', async () => {
  const s = feed();
  await s.controller.load();
  assert.equal(s.view().category, 'all');
  assert.deepEqual(s.queries(), [{ spaceId }]);
  await s.controller.setCategory('trading');
  assert.deepEqual(s.queries().slice(-1)[0], { spaceId, category: 'trading' });
  await s.controller.setTradingSubtype('shujia');
  assert.deepEqual(s.queries().slice(-1)[0], {
    spaceId,
    category: 'trading',
    tradingSubtype: 'shujia',
  });
  assert.equal(s.view().posts[0]!.trading?.subtype.kind, 'known');
  await s.controller.setCategory('all');
  assert.equal(s.view().tradingSubtype, '');
  assert.deepEqual(s.queries().slice(-1)[0], { spaceId });
  const calls = s.queries().length;
  await s.controller.setTradingSubtype('shuma');
  await s.controller.setCategory('unknown');
  assert.equal(s.queries().length, calls);
  assert.equal(
    s.gateway.calls.some((call) => call.method === 'tradingContacts'),
    false,
  );
  s.controller.dispose();
});

test('global feed cannot become trading and returning regional restores ordinary unfiltered browsing', async () => {
  const s = feed();
  s.gateway.spacesImpl = async () => ({
    regional: space(),
    global: [space({ id: otherId, kind: 'global', operatingRegionId: null })],
  });
  s.gateway.feedImpl = async (query) =>
    result([
      post({
        space: {
          id: query.spaceId,
          kind: query.spaceId === otherId ? 'global' : 'regional',
          name: 'scope',
        },
      }),
    ]);
  await s.controller.load();
  await s.controller.setCategory('trading');
  await s.controller.setTradingSubtype('shuma');
  await s.controller.chooseGlobal(otherId);
  assert.equal(s.view().tradingSubtype, '');
  assert.equal(s.view().category, 'discussion');
  assert.deepEqual(s.queries().slice(-1)[0], {
    spaceId: otherId,
    category: 'discussion',
  });
  const calls = s.queries().length;
  await s.controller.setCategory('trading');
  await s.controller.setTradingSubtype('shuma');
  await s.controller.setCategory('all');
  assert.equal(s.queries().length, calls);
  await s.controller.chooseRegional();
  assert.equal(s.view().category, 'all');
  assert.deepEqual(s.queries().slice(-1)[0], { spaceId });
  s.controller.dispose();
});

test('replacing subtype cancels the prior request, clears old cards and ignores a late mismatched page', async () => {
  const s = feed();
  await s.controller.load();
  await s.controller.setCategory('trading');
  const late = deferred<Feed>();
  let cancelled: Cancellation | undefined;
  s.gateway.feedImpl = (query, cancel) => {
    if (query.tradingSubtype === 'shuma') {
      cancelled = cancel;
      return late.promise;
    }
    return Promise.resolve(
      result([
        tradingPost({
          id: otherId,
          trading: tradingView({
            subtype: { kind: 'known', key: 'shujia', legacyText: null },
          }),
        }),
      ]),
    );
  };
  const old = s.controller.setTradingSubtype('shuma');
  assert.deepEqual(s.view().posts, []);
  await flush();
  await s.controller.setTradingSubtype('shujia');
  assert.equal(cancelled?.isCancelled, true);
  late.resolve(result());
  await old;
  assert.equal(s.view().tradingSubtype, 'shujia');
  assert.deepEqual(
    s.view().posts.map((item) => item.id),
    [otherId],
  );
  assert.deepEqual(s.queries().slice(-1)[0], {
    spaceId,
    category: 'trading',
    tradingSubtype: 'shujia',
  });
  s.controller.dispose();
});

test('trading pagination captures subtype, deduplicates cards and resets cursor on ordinary/campus transition', async () => {
  const s = feed();
  await s.controller.load();
  s.gateway.feedImpl = async () => ({
    items: [tradingPost()],
    nextCursor: 'trading_next',
    continuation: 'available',
  });
  await s.controller.setCategory('trading');
  await s.controller.setTradingSubtype('shuma');
  s.gateway.feedImpl = async () =>
    result([tradingPost(), tradingPost({ id: otherId })]);
  await s.controller.more();
  assert.deepEqual(s.queries().slice(-1)[0], {
    spaceId,
    category: 'trading',
    tradingSubtype: 'shuma',
    cursor: 'trading_next',
  });
  assert.equal(s.view().posts.length, 2);
  await s.controller.chooseCampus(campusId);
  assert.equal(s.view().category, 'all');
  assert.equal(s.view().tradingSubtype, '');
  assert.deepEqual(s.queries().slice(-1)[0], { spaceId });
  s.controller.dispose();
});

test('guest trading preview does not read contacts or permit continuation and account/app hide rejects late trading data', async () => {
  const guest = feed(false);
  await guest.controller.load();
  await guest.controller.chooseCampus(campusId);
  guest.gateway.feedImpl = async () => ({
    items: [tradingPost({ trading: tradingView({ urgency: 'urgent' }) })],
    nextCursor: null,
    continuation: 'login_required',
  });
  await guest.controller.setCategory('trading');
  assert.equal(guest.view().posts[0]!.trading?.urgency, 'urgent');
  await guest.controller.more();
  assert.equal(
    guest.gateway.calls.some((call) => call.method === 'tradingContacts'),
    false,
  );
  assert.equal(guest.view().canLoadMore, false);
  guest.controller.dispose();
  for (const boundary of ['login', 'hide']) {
    const s = feed();
    await s.controller.load();
    const late = deferred<Feed>();
    s.gateway.feedImpl = () => late.promise;
    const old = s.controller.setCategory('trading');
    await flush();
    if (boundary === 'login')
      s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('c'));
    else s.runtime.privateViews!.clear();
    assert.deepEqual(s.view().posts, []);
    late.resolve(result());
    await old;
    assert.deepEqual(s.view().posts, []);
    assert.equal(s.view().loaded, false);
    s.controller.dispose();
  }
});

test('my trading preserves urgent and raw legacy displays, changes filters without loading contacts, and returns to minimal publications', async () => {
  const s = mine();
  await s.controller.load();
  assert.equal(s.gateway.calls[0]!.method, 'mine');
  const historical = tradingPost({
    trading: tradingView({
      price: { kind: 'legacy', text: '面议' },
      subtype: { kind: 'legacy', text: '原始旧类别' },
      location: '旧地点\r\n' + '长'.repeat(300),
      urgency: 'urgent',
    }),
  });
  s.gateway.ownTradingImpl = async () => ({
    items: [historical],
    nextCursor: null,
  });
  await s.controller.setTradingOnly(true);
  assert.equal(s.view().onlyTrading, true);
  assert.deepEqual(s.view().tradingPosts, [historical]);
  assert.deepEqual(s.view().publications, []);
  s.gateway.ownTradingImpl = async (_after, _cancel, subtype) => ({
    items: [
      tradingPost({
        trading: tradingView({
          subtype: { kind: 'known', key: subtype ?? 'shuma', legacyText: null },
          urgency: 'urgent',
        }),
      }),
    ],
    nextCursor: null,
  });
  await s.controller.setTradingSubtype('shuma');
  const ownCall = s.gateway.calls
    .filter((call) => call.method === 'ownTrading')
    .slice(-1)[0]!;
  assert.equal(ownCall.args[0], null);
  assert.equal(ownCall.args[2], 'shuma');
  assert.equal(s.view().tradingPosts[0]!.trading?.urgency, 'urgent');
  await s.controller.setTradingOnly(false);
  assert.deepEqual(s.view().tradingPosts, []);
  assert.equal(s.view().tradingSubtype, '');
  assert.equal(s.view().publications.length, 1);
  assert.equal(
    s.gateway.calls.some((call) =>
      ['post', 'tradingContacts'].includes(call.method),
    ),
    false,
  );
  s.controller.dispose();
});

test('my trading filter replacement and account lifecycle suppress stale results and clear cards', async () => {
  const s = mine();
  await s.controller.setTradingOnly(true);
  const late = deferred<TradingList>();
  let cancelled: Cancellation | undefined;
  s.gateway.ownTradingImpl = (_after, cancel, subtype) => {
    if (subtype === 'shuma') {
      cancelled = cancel;
      return late.promise;
    }
    return Promise.resolve({
      items: [tradingPost({ id: otherId })],
      nextCursor: null,
    });
  };
  const old = s.controller.setTradingSubtype('shuma');
  await flush();
  assert.deepEqual(s.view().tradingPosts, []);
  await s.controller.setTradingSubtype('shujia');
  assert.equal(cancelled?.isCancelled, true);
  late.resolve({ items: [tradingPost()], nextCursor: null });
  await old;
  assert.deepEqual(
    s.view().tradingPosts.map((item) => item.id),
    [otherId],
  );
  const accountRead = deferred<TradingList>();
  s.gateway.ownTradingImpl = () => accountRead.promise;
  const changing = s.controller.load();
  await flush();
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('b'));
  assert.deepEqual(s.view().tradingPosts, []);
  accountRead.resolve({ items: [tradingPost()], nextCursor: null });
  await changing;
  assert.deepEqual(s.view().tradingPosts, []);
  assert.equal(s.view().onlyTrading, false);
  assert.equal(s.view().loaded, false);
  s.controller.dispose();
});

test('my trading paginates, rejects stalled cursors, clears on denied visibility and app hide', async () => {
  const s = mine();
  s.gateway.ownTradingImpl = async () => ({
    items: [tradingPost()],
    nextCursor: 'owner_next',
  });
  await s.controller.setTradingOnly(true);
  await s.controller.setTradingSubtype('shuma');
  s.gateway.ownTradingImpl = async () => ({
    items: [tradingPost(), tradingPost({ id: otherId })],
    nextCursor: null,
  });
  await s.controller.more();
  assert.equal(s.view().tradingPosts.length, 2);
  const own = s.gateway.calls
    .filter((call) => call.method === 'ownTrading')
    .slice(-1)[0]!;
  assert.equal(own.args[0], 'owner_next');
  assert.equal(own.args[2], 'shuma');
  s.gateway.ownTradingImpl = async () => ({
    items: [tradingPost()],
    nextCursor: 'stalled',
  });
  await s.controller.load();
  await s.controller.more();
  assert.deepEqual(s.view().tradingPosts, []);
  assert.equal(s.view().canLoadMore, false);
  s.gateway.ownTradingImpl = async () => {
    throw new ClientError('forbidden', 'safe');
  };
  await s.controller.load();
  assert.deepEqual(s.view().tradingPosts, []);
  s.gateway.ownTradingImpl = async () => ({
    items: [tradingPost()],
    nextCursor: null,
  });
  await s.controller.load();
  assert.equal(s.view().tradingPosts.length, 1);
  s.runtime.privateViews!.clear();
  assert.deepEqual(s.view().tradingPosts, []);
  assert.equal(s.view().loaded, false);
});

test('my publications exposes only account-owned pending trading recovery IDs and does not fetch hidden body', async () => {
  const s = mine();
  s.runtime.pendingTrading.freeze({
    version: 1,
    accountId: s.accountId,
    postId,
    resolution: 'resolved',
    clientRequestId: requestId,
  });
  s.gateway.mineImpl = async () => ({ items: [], nextCursor: null });
  await s.controller.load();
  assert.equal(s.view().tradingRecoveryPostId, postId);
  assert.equal(
    s.gateway.calls.some((call) =>
      ['post', 'tradingContacts', 'tradingReceipt'].includes(call.method),
    ),
    false,
  );
  assert.deepEqual(s.view().tradingPosts, []);
  s.sessions.logout();
  assert.equal(s.view().tradingRecoveryPostId, '');
  assert.ok(s.runtime.pendingTrading.load(s.accountId));
  s.controller.dispose();
});
