import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parse, render } from './smoke-ratings.mjs';
const require = createRequire(import.meta.url);
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};

/** Synthetic emitted-page/strict-HTTP/WXML verification only. This proves no
 * device rendering, PostgreSQL transition, XP settlement or real notice worker. */
export async function smokeRatingsR2C({ app, dist, flush }) {
  const { ApiClient } = require(path.join(dist, 'api/client.js'));
  const { ClientError } = require(path.join(dist, 'api/errors.js'));
  const { HttpRatingsGateway } = require(path.join(dist, 'ratings/gateway.js'));
  const { HttpRatingDiscussionGateway } = require(
    path.join(dist, 'ratings/discussion-gateway.js'),
  );
  const { HttpRatingUpdatesGateway } = require(
    path.join(dist, 'ratings/updates-gateway.js'),
  );
  const { HttpRatingLikesGateway } = require(
    path.join(dist, 'ratings/like-gateway.js'),
  );
  const { HttpRatingLikeUpdatesGateway } = require(
    path.join(dist, 'ratings/like-updates-gateway.js'),
  );
  const { HttpRatingSubscriptionsGateway } = require(
    path.join(dist, 'ratings/subscription-gateway.js'),
  );
  const { HttpRatingSubscriptionUpdatesGateway } = require(
    path.join(dist, 'ratings/subscription-updates-gateway.js'),
  );
  const { PendingRatingStore } = require(path.join(dist, 'ratings/pending.js'));
  const { readRatingSubscriptionStates } = require(
    path.join(dist, 'ratings/subscription-controller.js'),
  );
  const { Cancellation } = require(path.join(dist, 'platform/contracts.js'));
  const original = Object.fromEntries(
    [
      'ratings',
      'ratingDiscussion',
      'ratingUpdates',
      'ratingLikes',
      'ratingLikeUpdates',
      'ratingSubscriptions',
      'ratingSubscriptionUpdates',
      'pendingRatings',
      'newRequestId',
    ].map((k) => [k, app.community[k]]),
  );
  const credentials = app.identity.sessions.snapshot().credentials,
    oldNavigate = globalThis.wx.navigateTo;
  assert.ok(credentials);
  const id = (n) => `${String(n).padStart(8, '0')}-cccc-4ccc-8ccc-cccccccccccc`;
  const targetId = id(1),
    rootId = id(2),
    replyId = id(3),
    revision = id(4),
    categoryId = id(5),
    personaId = id(6),
    noticeId = id(7),
    replyNoticeId = id(8),
    otherAccount = id(9);
  const now = '2026-10-09T01:00:00.123456Z',
    rootBody = '合成 R2C 当前评价',
    replyBody = '合成 R2C 当前回复',
    authorName = '合成评分目标分身';
  const pages = [],
    requests = [],
    commands = [],
    reads = [],
    navigation = [],
    receipts = new Map(),
    stored = new Map(),
    holds = new Map();
  let minted = 0,
    sequence = 1000,
    transitions = 0,
    activeReads = 0,
    peakReads = 0;
  const state = {
    active: true,
    unknown: false,
    batchUnknown: false,
    lose: false,
    missingReceipt: false,
    badReceipt: false,
    failWrite: false,
    failReadBack: false,
    failRemove: false,
    noticeAvailable: true,
    subscribed: false,
    count: 0,
    revision,
    read: new Map(),
  };
  const author = {
    mode: 'anonymous',
    targetId,
    personaId,
    displayName: authorName,
  };
  const target = (currentId = targetId) => ({
    id: currentId,
    categoryId,
    name: `合成 R2C 目标 ${currentId}`,
    description: 'synthetic only',
    revision,
    allowedActions: {
      setScore: true,
      createComment: true,
      authorModes: ['named', 'anonymous'],
    },
  });
  const root = () => ({
    id: rootId,
    targetId,
    revision,
    createdAt: now,
    body: rootBody,
    author,
    isMine: true,
    allowedActions: { delete: true },
  });
  const reply = () => ({
    id: replyId,
    targetId,
    rootId,
    revision,
    createdAt: now,
    body: replyBody,
    author,
    isMine: true,
    allowedActions: { reply: true, delete: true },
    replyTo: { kind: 'root' },
  });
  const context = () => ({
    regionId: null,
    catalogRevision: revision,
    targetId,
    rootId,
  });
  const replyPage = () => ({
    context: { ...context(), order: 'oldest' },
    items: [reply()],
    nextCursor: null,
    continuation: 'end',
  });
  const locator = (notice) => ({
    regionId: null,
    targetId,
    rootId,
    replyId: notice === replyNoticeId ? replyId : null,
  });
  const current = (currentId) =>
    state.unknown
      ? { status: 'unavailable' }
      : {
          status: 'known',
          targetId: currentId,
          subscribed: state.subscribed,
          count: state.count,
          revision: state.revision,
          allowedActions: { setSubscription: true },
        };
  const notice = (notice) => ({
    noticeId: notice,
    createdAt: now,
    readAt: state.read.get(notice) ?? null,
    ...(state.noticeAvailable
      ? {
          status: 'available',
          domain: 'ratings',
          kind: 'subscription',
          reason: 'target_subscription',
          activity: notice === replyNoticeId ? 'reply' : 'root',
          target: locator(notice),
          preview: {
            text: notice === replyNoticeId ? replyBody : rootBody,
            author,
          },
        }
      : { status: 'unavailable' }),
  });
  const ok = (body) => ({ status: 200, headers: {}, body });
  const error = (status, code) => ({
    status,
    headers: {},
    body: { error: { code } },
  });
  async function respond(kind, result) {
    const copy = structuredClone(result);
    if (holds.has(kind)) await holds.get(kind).promise;
    return copy;
  }
  async function supplemental(kind, result) {
    activeReads++;
    peakReads = Math.max(peakReads, activeReads);
    try {
      return await respond(kind, result);
    } finally {
      activeReads--;
    }
  }
  async function server(request) {
    requests.push(request);
    assert.ok(request.headers.Authorization);
    const url = new URL(request.url),
      pathname = url.pathname;
    if (pathname.includes('/subscription-requests/')) {
      const result = receipts.get(pathname.split('/').pop());
      return respond(
        'receipt',
        state.missingReceipt || !result
          ? error(404, 'REQUEST_NOT_FOUND')
          : ok(result),
      );
    }
    if (pathname === '/v1/ratings/subscription-states/query') {
      assert.equal(request.method, 'POST');
      assert.deepEqual(Object.keys(request.body).sort(), [
        'regionId',
        'targets',
      ]);
      assert.ok(
        request.body.targets.length >= 1 && request.body.targets.length <= 20,
      );
      assert.equal(
        new Set(request.body.targets.map((t) => t.targetId)).size,
        request.body.targets.length,
      );
      for (const item of request.body.targets) {
        assert.deepEqual(Object.keys(item).sort(), [
          'expectedTargetRevision',
          'targetId',
        ]);
        assert.equal(item.expectedTargetRevision, revision);
      }
      return supplemental(
        'batch',
        state.batchUnknown
          ? error(503, 'RATING_UNAVAILABLE')
          : ok({
              items: request.body.targets.map((t) => ({
                targetId: t.targetId,
                state: current(t.targetId),
              })),
            }),
      );
    }
    if (pathname.endsWith('/subscription')) {
      const currentId = pathname.split('/')[4];
      if (request.method === 'GET')
        return supplemental(
          'state',
          state.active
            ? ok(current(currentId))
            : error(404, 'RATING_NOT_FOUND'),
        );
      assert.equal(request.method, 'PUT');
      assert.equal(stored.size, 1, 'v3 journal precedes PUT');
      commands.push(structuredClone({ url: request.url, body: request.body }));
      const body = request.body;
      assert.deepEqual(Object.keys(body).sort(), [
        'clientRequestId',
        'expectedSubscriptionRevision',
        'expectedTargetRevision',
        'regionId',
        'subscribed',
      ]);
      let result = receipts.get(body.clientRequestId);
      if (!result) {
        const changed = state.subscribed !== body.subscribed;
        if (changed) {
          transitions++;
          state.subscribed = body.subscribed;
          state.count += body.subscribed ? 1 : -1;
          state.revision = id(sequence++);
        }
        result = {
          requestId: body.clientRequestId,
          operation: 'set_target_subscription',
          outcome: changed ? 'applied' : 'noop',
          targetId: currentId,
          subscribed: body.subscribed,
          revision: state.revision,
          occurredAt: now,
        };
        receipts.set(body.clientRequestId, result);
      }
      if (holds.has('command')) await holds.get('command').promise;
      if (state.lose)
        throw new ClientError(
          'timeout',
          'Synthetic subscription committed response loss',
        );
      return ok(
        state.badReceipt
          ? { ...result, subscribed: !result.subscribed }
          : result,
      );
    }
    if (pathname.startsWith('/v1/me/ratings/subscription-updates')) {
      const item = pathname.split('/')[5];
      if (pathname.endsWith('/target'))
        return respond(
          'notice-target',
          ok({
            noticeId: item,
            ...(state.noticeAvailable
              ? { status: 'available', target: locator(item) }
              : { status: 'unavailable' }),
          }),
        );
      if (pathname.endsWith('/read')) {
        reads.push(request);
        if (!state.read.has(item)) state.read.set(item, now);
        return ok({
          noticeId: item,
          readAt: state.read.get(item),
          unreadCount: 2 - state.read.size,
        });
      }
      if (pathname.endsWith('/unread-count'))
        return ok({ unreadCount: 2 - state.read.size });
      return respond(
        'updates',
        ok({
          items: [notice(noticeId), notice(replyNoticeId)],
          nextCursor: null,
          unreadCount: 2 - state.read.size,
        }),
      );
    }
    if (
      pathname === '/v1/me/ratings/updates' ||
      pathname === '/v1/me/ratings/like-updates'
    )
      return ok({ items: [], nextCursor: null, unreadCount: 0 });
    if (pathname.endsWith('/like'))
      return supplemental('like', ok({ status: 'unavailable' }));
    if (!state.active) return error(404, 'RATING_NOT_FOUND');
    if (pathname === '/v1/ratings/categories') {
      const parentId = url.searchParams.get('parentId'),
        scope = url.searchParams.get('regionId');
      return ok({
        context: { regionId: scope, catalogRevision: revision, parentId },
        items: parentId
          ? []
          : [
              {
                id: categoryId,
                parentId: null,
                level: 1,
                kind: 'general',
                systemKey: null,
                name: '合成 R2C 分类',
                description: 'synthetic',
                revision,
              },
            ],
        nextCursor: null,
        continuation: 'end',
      });
    }
    if (pathname === '/v1/ratings/targets')
      return ok({
        context: {
          regionId: url.searchParams.get('regionId'),
          categoryId: url.searchParams.get('categoryId'),
          catalogRevision: revision,
        },
        items: Array.from(
          { length: Number(url.searchParams.get('limit')) },
          (_, n) => target(n === 0 ? targetId : id(n + 20)),
        ),
        nextCursor: null,
        continuation: 'end',
      });
    if (pathname.endsWith('/discussion'))
      return ok({
        context: context(),
        root: root(),
        allowedActions: {
          createReply: true,
          authorModes: ['named', 'anonymous'],
        },
      });
    if (pathname.endsWith('/position'))
      return respond(
        'position',
        ok({
          context: replyPage().context,
          anchorReplyId: replyId,
          page: replyPage(),
        }),
      );
    if (pathname.endsWith('/replies')) return ok(replyPage());
    if (pathname.endsWith('/my-score')) return ok({ myScore: null });
    if (pathname.endsWith('/score-summary'))
      return ok({ status: 'unavailable' });
    if (pathname.endsWith('/comments'))
      return ok({
        context: { regionId: null, catalogRevision: revision, targetId },
        items: [root()],
        nextCursor: null,
        continuation: 'end',
      });
    if (pathname === `/v1/ratings/targets/${targetId}`) return ok(target());
    throw new Error(
      `Unexpected R2C synthetic request ${request.method} ${pathname}`,
    );
  }
  const api = new ApiClient(
    'https://ratings-r2c.invalid',
    { send: server },
    app.identity.sessions,
    { refresh: async () => undefined },
  );
  Object.assign(app.community, {
    ratings: new HttpRatingsGateway(api),
    ratingDiscussion: new HttpRatingDiscussionGateway(api),
    ratingUpdates: new HttpRatingUpdatesGateway(api),
    ratingLikes: new HttpRatingLikesGateway(api),
    ratingLikeUpdates: new HttpRatingLikeUpdatesGateway(api),
    ratingSubscriptions: new HttpRatingSubscriptionsGateway(api),
    ratingSubscriptionUpdates: new HttpRatingSubscriptionUpdatesGateway(api),
  });
  app.community.pendingRatings = new PendingRatingStore(
    {
      get: (key) => (state.failReadBack ? undefined : stored.get(key)),
      set: (key, value) => {
        if (state.failWrite) throw new Error('Synthetic storage write failed');
        stored.set(key, value);
      },
      remove: (key) => {
        if (state.failRemove)
          throw new Error('Synthetic storage remove failed');
        stored.delete(key);
      },
    },
    'synthetic-ratings-r2c',
  );
  app.community.newRequestId = async () => {
    minted++;
    return id(sequence++);
  };
  globalThis.wx.navigateTo = ({ url, success }) => {
    navigation.push(url);
    success?.();
  };
  const source = (mode) =>
      readFileSync(
        path.join(dist, `pages/rating-${mode}/rating-${mode}.wxml`),
        'utf8',
      ),
    common = readFileSync(path.join(dist, 'ratings/common.wxml'), 'utf8');
  const templates = Object.fromEntries(
    parse(common)
      .children.filter((n) => typeof n !== 'string')
      .map((n) => [n.attrs.name, n]),
  );
  const shown = (mode, page) =>
      render(parse(source(mode)).children, page.data, templates),
    visible = (mode, page) => JSON.stringify(shown(mode, page));
  const nodes = (items) =>
    items.flatMap((n) =>
      typeof n === 'string' ? [] : [n, ...nodes(n.children)],
    );
  const buttons = (mode, page, handler) =>
    nodes(shown(mode, page)).filter((n) => n.attrs.bindtap === handler);
  const tap = (page, handler, dataset = {}) =>
    page[handler]({ currentTarget: { dataset } });
  const mount = (mode, route = {}) => {
    let page;
    const oldPage = globalThis.Page;
    globalThis.Page = (definition) => {
      page = definition;
    };
    const file = path.join(dist, `pages/rating-${mode}/rating-${mode}.js`);
    try {
      delete require.cache[require.resolve(file)];
      require(file);
    } finally {
      globalThis.Page = oldPage;
    }
    page.setData = (data) => {
      page.data = { ...page.data, ...data };
    };
    for (const [, handler] of (
      source(mode) + (source(mode).includes('<template') ? common : '')
    ).matchAll(/bind(?:tap|input)="([^"]+)"/g))
      assert.equal(
        typeof page[handler],
        'function',
        `emitted ${mode}.${handler}`,
      );
    pages.push(page);
    page.onLoad(route);
    page.onShow();
    return page;
  };
  const login = (owner = credentials) =>
    app.identity.sessions.completeLogin(
      app.identity.sessions.beginLogin(),
      owner,
    );
  const release = async (kind) => {
    const hold = holds.get(kind);
    holds.delete(kind);
    hold.resolve();
    await flush();
  };
  const clear = (mode, page) => {
    assert.equal(page.data.loaded, false);
    if (mode === 'detail' || mode === 'catalog')
      assert.deepEqual(page.data.subscriptions, {});
    assert.equal(visible(mode, page).includes(rootBody), false);
    assert.equal(visible(mode, page).includes(replyBody), false);
  };
  const batchRequests = () =>
    requests.filter(
      (r) =>
        new URL(r.url).pathname === '/v1/ratings/subscription-states/query',
    );
  try {
    let detail = mount('detail', { targetId });
    await flush();
    assert.equal(detail.data.loaded, true);
    assert.equal(buttons('detail', detail, 'onSubscription').length, 1);
    assert.ok(visible('detail', detail).includes('0 人码住'));
    assert.equal(batchRequests().length, 0);
    assert.equal(peakReads, 1);
    tap(detail, 'onSubscription', { id: targetId });
    tap(detail, 'onSubscription', { id: targetId });
    await flush();
    assert.equal(commands.length, 1);
    assert.equal(minted, 1);
    assert.equal(transitions, 1);
    assert.equal(commands[0].body.subscribed, true);
    assert.ok(visible('detail', detail).includes('取消码住'));
    assert.ok(visible('detail', detail).includes('1 人码住'));
    assert.doesNotMatch(detail.data.receiptStatus, /经验.*到账|送达/);
    tap(detail, 'onSubscription', { id: targetId });
    await flush();
    assert.equal(commands[1].body.subscribed, false);
    assert.equal(stored.size, 0);
    detail.onUnload();
    state.unknown = true;
    detail = mount('detail', { targetId });
    await flush();
    assert.equal(detail.data.loaded, true);
    assert.ok(visible('detail', detail).includes(rootBody));
    assert.equal(buttons('detail', detail, 'onSubscription').length, 0);
    assert.ok(visible('detail', detail).includes('订阅状态和人数暂不可用'));
    assert.equal(visible('detail', detail).includes('0 人码住'), false);
    detail.onUnload();
    state.unknown = false;
    // The emitted helper supports the contract maximum, while the real catalog
    // currently requests 20 cards. Never make the synthetic server violate limit.
    const maximumBefore = batchRequests().length;
    const maximumStates = await readRatingSubscriptionStates(
      app.community.ratingSubscriptions,
      null,
      Array.from({ length: 50 }, (_, n) => ({
        targetId: id(n + 100),
        expectedTargetRevision: revision,
      })),
      new Cancellation(),
    );
    assert.equal(Object.keys(maximumStates).length, 50);
    assert.deepEqual(
      batchRequests()
        .slice(maximumBefore)
        .map((r) => r.body.targets.length),
      [20, 20, 10],
    );
    const beforeBatches = batchRequests().length;
    let catalog = mount('catalog', { parentId: categoryId });
    await flush();
    assert.equal(catalog.data.loaded, true);
    assert.equal(catalog.data.targets.length, 20);
    assert.equal(buttons('catalog', catalog, 'onSubscription').length, 20);
    assert.deepEqual(
      batchRequests()
        .slice(beforeBatches)
        .map((r) => r.body.targets.length),
      [20],
    );
    assert.equal(peakReads, 1);
    tap(catalog, 'onSubscription', { id: targetId });
    await flush();
    assert.equal(commands.at(-1).body.subscribed, true);
    assert.ok(visible('catalog', catalog).includes('1 人码住'));
    state.batchUnknown = true;
    catalog.onRefresh();
    await flush();
    assert.equal(catalog.data.loaded, true);
    assert.equal(buttons('catalog', catalog, 'onSubscription').length, 0);
    assert.equal(visible('catalog', catalog).includes('1 人码住'), false);
    assert.equal(visible('catalog', catalog).includes('0 人码住'), false);
    catalog.onUnload();
    state.batchUnknown = false;
    holds.set('batch', deferred());
    const beforeCancel = batchRequests().length;
    catalog = mount('catalog', { parentId: categoryId });
    await flush();
    assert.equal(batchRequests().length, beforeCancel + 1);
    catalog.onCancel();
    await release('batch');
    clear('catalog', catalog);
    assert.equal(batchRequests().length, beforeCancel + 1);
    catalog.onUnload();
    holds.set('batch', deferred());
    catalog = mount('catalog', { parentId: categoryId });
    await flush();
    const beforeRegion = batchRequests().length;
    tap(catalog, 'onRegion', { id: '' });
    await flush();
    await release('batch');
    assert.equal(batchRequests().length, beforeRegion);
    assert.equal(catalog.data.loaded, true);
    assert.equal(catalog.data.regionId, null);
    assert.deepEqual(catalog.data.subscriptions, {});
    catalog.onUnload();
    let updates = mount('updates');
    await flush();
    assert.equal(updates.data.category, 'reply');
    tap(updates, 'onCategory', { category: 'subscription' });
    await flush();
    assert.equal(updates.data.category, 'subscription');
    assert.ok(visible('updates', updates).includes(authorName));
    assert.ok(visible('updates', updates).includes('码住的目标有新评价'));
    assert.ok(visible('updates', updates).includes('码住的目标有新回复'));
    for (const currentNotice of [noticeId, replyNoticeId]) {
      const before = reads.length;
      tap(updates, 'onOpen', { id: currentNotice });
      await flush();
      assert.equal(reads.length, before);
      const route = Object.fromEntries(
        new URL(navigation.at(-1), 'https://native.invalid').searchParams,
      );
      assert.equal(route.subscriptionNoticeId, currentNotice);
      assert.equal(route.noticeId, undefined);
      assert.equal(route.likeNoticeId, undefined);
      assert.equal(
        route.replyId,
        currentNotice === replyNoticeId ? replyId : undefined,
      );
      const page = mount('thread', route);
      await flush();
      assert.equal(page.data.loaded, true);
      assert.equal(reads.length, before + 1);
      assert.ok(
        reads
          .at(-1)
          .url.endsWith(`/subscription-updates/${currentNotice}/read`),
      );
      page.onUnload();
    }
    updates.onRefresh();
    await flush();
    assert.equal(updates.data.unreadCount, 0);
    tap(updates, 'onCategory', { category: 'like' });
    await flush();
    assert.equal(updates.data.items.length, 0);
    assert.equal(updates.data.unreadCount, 0);
    updates.onUnload();
    state.noticeAvailable = false;
    const readBefore = reads.length;
    let page = mount('thread', {
      targetId,
      rootId,
      subscriptionNoticeId: noticeId,
    });
    await flush();
    clear('thread', page);
    assert.equal(reads.length, readBefore);
    page.onUnload();
    state.read.clear();
    updates = mount('updates');
    await flush();
    tap(updates, 'onCategory', { category: 'subscription' });
    await flush();
    assert.equal(visible('updates', updates).includes(authorName), false);
    assert.equal(visible('updates', updates).includes(rootBody), false);
    tap(updates, 'onRead', { id: noticeId });
    await flush();
    assert.equal(updates.data.unreadCount, 1);
    updates.onUnload();
    state.noticeAvailable = true;
    state.lose = true;
    detail = mount('detail', { targetId });
    await flush();
    tap(detail, 'onSubscription', { id: targetId });
    await flush();
    clear('detail', detail);
    assert.equal(detail.data.frozen, true);
    const frozen = structuredClone(
        app.community.pendingRatings.load(credentials.accountId),
      ),
      originalBody = structuredClone(commands.at(-1).body),
      beforeMint = minted;
    assert.equal(frozen.version, 3);
    state.lose = false;
    state.missingReceipt = true;
    detail.onRecover();
    await flush();
    assert.deepEqual(
      app.community.pendingRatings.load(credentials.accountId),
      frozen,
    );
    state.badReceipt = true;
    const beforeTransition = transitions;
    detail.onRetry();
    await flush();
    assert.deepEqual(commands.at(-1).body, originalBody);
    assert.equal(transitions, beforeTransition);
    assert.equal(minted, beforeMint);
    assert.deepEqual(
      app.community.pendingRatings.load(credentials.accountId),
      frozen,
    );
    state.badReceipt = false;
    state.missingReceipt = false;
    state.subscribed = false;
    state.count = 17;
    state.revision = id(sequence++);
    const beforeCommands = commands.length;
    detail.onRecover();
    await flush();
    assert.equal(stored.size, 0);
    assert.equal(commands.length, beforeCommands);
    assert.equal(detail.data.subscriptions[targetId].subscribed, false);
    assert.equal(detail.data.subscriptions[targetId].count, 17);
    detail.onUnload();
    for (const failure of ['failWrite', 'failReadBack']) {
      detail = mount('detail', { targetId });
      await flush();
      state[failure] = true;
      const before = commands.length;
      tap(detail, 'onSubscription', { id: targetId });
      await flush();
      assert.equal(commands.length, before);
      assert.equal(detail.data.frozen, true);
      clear('detail', detail);
      state[failure] = false;
      stored.clear();
      detail.onUnload();
    }
    for (const [label, boundary] of [
      ['hide', (p) => p.onHide()],
      ['unload', (p) => p.onUnload()],
      ['logout', () => app.identity.sessions.logout()],
      ['epoch', () => login()],
      ['account', () => login({ ...credentials, accountId: otherAccount })],
      ['app hide', () => app.community.privateViews.clear()],
    ]) {
      login();
      holds.set('state', deferred());
      detail = mount('detail', { targetId });
      await flush();
      boundary(detail);
      await release('state');
      clear('detail', detail);
      detail.onUnload();
      login();
      holds.set('position', deferred());
      page = mount('thread', {
        targetId,
        rootId,
        replyId,
        subscriptionNoticeId: replyNoticeId,
      });
      await flush();
      const before = reads.length;
      boundary(page);
      await release('position');
      clear('thread', page);
      assert.equal(reads.length, before, label);
      page.onUnload();
    }
    login();
    detail = mount('detail', { targetId });
    await flush();
    holds.set('command', deferred());
    tap(detail, 'onSubscription', { id: targetId });
    await flush();
    const ownerPending = structuredClone(
      app.community.pendingRatings.load(credentials.accountId),
    );
    assert.ok(ownerPending);
    login({ ...credentials, accountId: otherAccount });
    await release('command');
    clear('detail', detail);
    assert.deepEqual(
      app.community.pendingRatings.load(credentials.accountId),
      ownerPending,
    );
    assert.equal(app.community.pendingRatings.load(otherAccount), null);
    detail.onUnload();
    login();
    state.active = false;
    page = mount('recovery');
    await flush();
    assert.equal(stored.size, 0);
    assert.equal(visible('recovery', page).includes(rootBody), false);
    page.onUnload();
    state.active = true;
  } finally {
    for (const hold of holds.values()) hold.resolve();
    holds.clear();
    for (const page of pages) page.onUnload?.();
    Object.assign(app.community, original);
    globalThis.wx.navigateTo = oldNavigate;
    login();
  }
  console.log(
    'Ratings R2C emitted handlers + strict HTTP gateways + bounded WXML smoke passed: detail current subscription, 50-card serial batches, unknown/cancellation/region fences, immutable v3 recovery and independent subscription root/reply notice read (synthetic only; no device/PostgreSQL/XP/notice-worker/external delivery proof).',
  );
}
