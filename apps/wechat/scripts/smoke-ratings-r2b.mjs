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

/** Emitted handlers, strict HTTP gateways and bounded WXML evaluation against a
 * synthetic server. This does not prove native-device rendering, DB transitions,
 * actual XP settlement, notification materialization or external delivery. */
export async function smokeRatingsR2B({ app, dist, flush }) {
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
  const { PendingRatingStore } = require(path.join(dist, 'ratings/pending.js'));
  const original = Object.fromEntries(
    [
      'ratings',
      'ratingDiscussion',
      'ratingUpdates',
      'ratingLikes',
      'ratingLikeUpdates',
      'pendingRatings',
      'newRequestId',
    ].map((key) => [key, app.community[key]]),
  );
  const credentials = app.identity.sessions.snapshot().credentials,
    oldNavigate = globalThis.wx.navigateTo;
  assert.ok(credentials);
  const id = (n) => `${String(n).padStart(8, '0')}-eeee-4eee-8eee-eeeeeeeeeeee`;
  const targetId = id(1),
    rootId = id(2),
    replyId = id(3),
    revision = id(4),
    categoryId = id(5),
    personaId = id(6),
    noticeId = id(7),
    replyNoticeId = id(8),
    otherAccount = id(9),
    otherRoot = id(10);
  const now = '2026-10-09T01:00:00.123456Z',
    rootBody = '合成 R2B 被赞评价',
    replyBody = '合成 R2B 被赞回复',
    actorName = '合成实名点赞者',
    cursor = 'a'.repeat(43);
  const pages = [],
    requests = [],
    commands = [],
    reads = [],
    navigation = [],
    receipts = new Map(),
    stored = new Map(),
    holds = new Map();
  let sequence = 100,
    minted = 0,
    transitions = 0;
  const state = {
    active: true,
    unknown: false,
    sortUnknown: false,
    restart: false,
    lose: false,
    missingReceipt: false,
    badReceipt: false,
    failWrite: false,
    failReadBack: false,
    failRemove: false,
    noticeAvailable: true,
    likes: new Map([
      [rootId, { liked: false, count: 0, revision }],
      [replyId, { liked: false, count: 0, revision }],
    ]),
    read: new Map(),
  };
  const author = {
    mode: 'anonymous',
    targetId,
    personaId,
    displayName: '本目标合成分身',
  };
  const target = () => ({
    id: targetId,
    categoryId,
    name: '合成 R2B 评分目标',
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
  const notice = (notice) => ({
    noticeId: notice,
    createdAt: now,
    readAt: state.read.get(notice) ?? null,
    ...(state.noticeAvailable
      ? {
          status: 'available',
          domain: 'ratings',
          kind: 'like',
          reason: 'like',
          actor: {
            mode: 'named',
            profileId: personaId,
            displayName: actorName,
          },
          target: locator(notice),
          preview: { text: notice === replyNoticeId ? replyBody : rootBody },
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
  async function server(request) {
    requests.push(request);
    assert.ok(request.headers.Authorization);
    const url = new URL(request.url),
      pathname = url.pathname;
    if (pathname.includes('/like-requests/')) {
      const result = receipts.get(pathname.split('/').pop());
      return respond(
        'receipt',
        state.missingReceipt || !result
          ? error(404, 'REQUEST_NOT_FOUND')
          : ok(result),
      );
    }
    if (pathname.startsWith('/v1/me/ratings/like-updates')) {
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
        state.read.set(item, now);
        return respond(
          'read',
          ok({ noticeId: item, readAt: now, unreadCount: 2 - state.read.size }),
        );
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
    if (pathname === '/v1/me/ratings/updates')
      return ok({ items: [], nextCursor: null, unreadCount: 0 });
    if (pathname.endsWith('/like')) {
      const subjectId = pathname.split('/')[4],
        isReply = pathname.includes('/replies/');
      if (request.method === 'GET') {
        if (!state.active) return error(404, 'RATING_NOT_FOUND');
        return respond(
          'state',
          ok(
            state.unknown
              ? { status: 'unavailable' }
              : {
                  status: 'known',
                  targetId,
                  rootId,
                  replyId: isReply ? subjectId : null,
                  ...state.likes.get(subjectId),
                  allowedActions: { setLike: true },
                },
          ),
        );
      }
      commands.push({
        method: request.method,
        url: request.url,
        body: structuredClone(request.body),
      });
      assert.equal(stored.size, 1, 'journal is durable before PUT');
      const body = request.body,
        operation = isReply ? 'set_reply_like' : 'set_comment_like';
      let result = receipts.get(body.clientRequestId);
      if (!result) {
        const current = state.likes.get(subjectId),
          changed = current.liked !== body.liked;
        if (changed) {
          transitions++;
          state.likes.set(subjectId, {
            liked: body.liked,
            count: current.count + (body.liked ? 1 : -1),
            revision: id(sequence++),
          });
        }
        result = {
          requestId: body.clientRequestId,
          operation,
          outcome: changed ? 'applied' : 'noop',
          targetId,
          rootId,
          replyId: isReply ? replyId : null,
          liked: body.liked,
          revision: state.likes.get(subjectId).revision,
          occurredAt: now,
        };
        receipts.set(body.clientRequestId, result);
      }
      if (holds.has('command')) await holds.get('command').promise;
      if (state.lose)
        throw new ClientError('timeout', 'Synthetic committed response loss');
      return ok(
        state.badReceipt ? { ...result, liked: !result.liked } : result,
      );
    }
    if (!state.active) return error(404, 'RATING_NOT_FOUND');
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
    if (pathname.endsWith('/comments')) {
      if (url.searchParams.get('sort') === 'likes' && state.sortUnknown)
        return error(503, 'RATING_UNAVAILABLE');
      if (url.searchParams.has('cursor') && state.restart)
        return error(409, 'DISCOVERY_RESTART_REQUIRED');
      return ok({
        context: { regionId: null, catalogRevision: revision, targetId },
        items: [root()],
        nextCursor: cursor,
        continuation: 'more',
      });
    }
    if (pathname === `/v1/ratings/targets/${targetId}`) return ok(target());
    throw new Error(
      `Unexpected R2B synthetic request ${request.method} ${pathname}`,
    );
  }
  const api = new ApiClient(
    'https://ratings-r2b.invalid',
    { send: server },
    app.identity.sessions,
    { refresh: async () => undefined },
  );
  app.community.ratings = new HttpRatingsGateway(api);
  app.community.ratingDiscussion = new HttpRatingDiscussionGateway(api);
  app.community.ratingUpdates = new HttpRatingUpdatesGateway(api);
  app.community.ratingLikes = new HttpRatingLikesGateway(api);
  app.community.ratingLikeUpdates = new HttpRatingLikeUpdatesGateway(api);
  app.community.pendingRatings = new PendingRatingStore(
    {
      get: (key) => (state.failReadBack ? undefined : stored.get(key)),
      set: (key, value) => {
        if (state.failWrite) throw new Error('synthetic write failed');
        stored.set(key, value);
      },
      remove: (key) => {
        if (state.failRemove) throw new Error('synthetic remove failed');
        stored.delete(key);
      },
    },
    'synthetic-ratings-r2b',
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
    );
  const common = readFileSync(path.join(dist, 'ratings/common.wxml'), 'utf8');
  const templates = Object.fromEntries(
    parse(common)
      .children.filter((n) => typeof n !== 'string')
      .map((n) => [n.attrs.name, n]),
  );
  const shown = (mode, page) =>
    render(parse(source(mode)).children, page.data, templates);
  const visible = (mode, page) => JSON.stringify(shown(mode, page));
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
  const thread = (route = {}) =>
    mount('thread', { targetId, rootId, ...route });
  const routeFrom = (url) =>
    Object.fromEntries(new URL(url, 'https://native.invalid').searchParams);
  const login = (owner = credentials) =>
    app.identity.sessions.completeLogin(
      app.identity.sessions.beginLogin(),
      owner,
    );
  const clear = (mode, page) => {
    assert.equal(page.data.loaded, false);
    assert.deepEqual(page.data.likes, {});
    const text = visible(mode, page);
    assert.equal(text.includes(rootBody), false);
    assert.equal(text.includes(replyBody), false);
  };
  const release = async (kind) => {
    const hold = holds.get(kind);
    holds.delete(kind);
    hold.resolve();
    await flush();
  };
  try {
    let page = thread();
    await flush();
    assert.equal(page.data.loaded, true);
    assert.equal(buttons('thread', page, 'onLike').length, 2);
    assert.ok(visible('thread', page).includes('0 赞'));
    tap(page, 'onLike', { id: rootId });
    tap(page, 'onLike', { id: rootId });
    await flush();
    assert.equal(commands.length, 1);
    assert.equal(minted, 1);
    assert.equal(transitions, 1);
    assert.equal(commands[0].body.liked, true);
    assert.equal(commands[0].body.expectedLikeRevision, revision);
    assert.ok(visible('thread', page).includes('取消赞'));
    assert.ok(visible('thread', page).includes('1 赞'));
    tap(page, 'onLike', { id: rootId });
    await flush();
    assert.equal(commands[1].body.liked, false);
    assert.equal(transitions, 2);
    tap(page, 'onLike', { id: replyId });
    await flush();
    assert.ok(commands[2].url.endsWith(`/replies/${replyId}/like`));
    assert.equal(commands[2].body.expectedRootRevision, revision);
    assert.doesNotMatch(
      JSON.stringify(commands[2].body),
      /recipient|authorMode|profileId|personaId|points|count/,
    );
    assert.equal(stored.size, 0);
    page.onUnload();

    state.unknown = true;
    page = thread();
    await flush();
    assert.equal(buttons('thread', page, 'onLike').length, 0);
    assert.ok(visible('thread', page).includes('暂时未知'));
    assert.equal(visible('thread', page).includes('0 赞'), false);
    page.onUnload();
    state.unknown = false;
    let detail = mount('detail', { targetId });
    await flush();
    const initialQuery = new URL(
      requests
        .filter((r) => new URL(r.url).pathname.endsWith('/comments'))
        .at(-1).url,
    ).searchParams;
    assert.equal(initialQuery.has('sort'), false);
    assert.equal(initialQuery.has('order'), false);
    for (const sort of ['time', 'likes'])
      for (const order of ['asc', 'desc']) {
        tap(detail, 'onSort', { sort, order });
        await flush();
        const request = requests
          .filter((r) => new URL(r.url).pathname.endsWith('/comments'))
          .at(-1);
        assert.equal(new URL(request.url).searchParams.get('sort'), sort);
        assert.equal(new URL(request.url).searchParams.get('order'), order);
        assert.equal(detail.data.commentSort, sort);
        assert.equal(detail.data.commentOrder, order);
      }
    state.restart = true;
    detail.onMoreComments();
    await flush();
    clear('detail', detail);
    assert.match(detail.data.error, /排序|重新加载/);
    state.restart = false;
    state.sortUnknown = true;
    tap(detail, 'onSort', { sort: 'likes', order: 'desc' });
    await flush();
    clear('detail', detail);
    assert.equal(
      buttons('detail', detail, 'onSort').length,
      4,
      'unknown like coverage retains a usable time-sort exit',
    );
    tap(detail, 'onSort', { sort: 'time', order: 'asc' });
    await flush();
    assert.equal(detail.data.loaded, true);
    detail.onUnload();
    state.sortUnknown = false;

    let updates = mount('updates');
    await flush();
    assert.equal(updates.data.category, 'reply');
    assert.equal(updates.data.items.length, 0);
    tap(updates, 'onCategory', { category: 'like' });
    await flush();
    assert.equal(updates.data.category, 'like');
    assert.ok(visible('updates', updates).includes(actorName));
    assert.ok(visible('updates', updates).includes('有人赞了你的评价'));
    assert.ok(visible('updates', updates).includes('有人赞了你的回复'));
    for (const currentNotice of [noticeId, replyNoticeId]) {
      const before = reads.length;
      tap(updates, 'onOpen', { id: currentNotice });
      await flush();
      assert.equal(reads.length, before);
      const route = routeFrom(navigation.at(-1));
      assert.equal(route.likeNoticeId, currentNotice);
      assert.equal(route.noticeId, undefined);
      assert.equal(
        route.replyId,
        currentNotice === replyNoticeId ? replyId : undefined,
      );
      page = mount('thread', route);
      await flush();
      assert.equal(page.data.loaded, true);
      assert.equal(reads.length, before + 1);
      assert.ok(
        reads.at(-1).url.endsWith(`/like-updates/${currentNotice}/read`),
      );
      page.onUnload();
    }
    updates.onRefresh();
    await flush();
    assert.equal(updates.data.unreadCount, 0);
    assert.ok(visible('updates', updates).includes('已读'));
    updates.onUnload();
    state.noticeAvailable = false;
    page = thread({ likeNoticeId: noticeId });
    const beforeDenied = reads.length;
    await flush();
    clear('thread', page);
    assert.equal(reads.length, beforeDenied);
    page.onUnload();
    updates = mount('updates');
    await flush();
    tap(updates, 'onCategory', { category: 'like' });
    await flush();
    assert.equal(visible('updates', updates).includes(actorName), false);
    assert.equal(visible('updates', updates).includes(rootBody), false);
    updates.onUnload();
    state.noticeAvailable = true;

    state.lose = true;
    page = thread();
    await flush();
    const beforeLost = commands.length;
    tap(page, 'onLike', { id: rootId });
    await flush();
    clear('thread', page);
    assert.equal(page.data.frozen, true);
    const frozen = structuredClone(
      app.community.pendingRatings.load(credentials.accountId),
    );
    const originalBody = structuredClone(commands.at(-1).body);
    const beforeMint = minted;
    page.onLike({ currentTarget: { dataset: { id: rootId } } });
    await flush();
    assert.equal(minted, beforeMint);
    assert.equal(commands.length, beforeLost + 1);
    state.lose = false;
    state.missingReceipt = true;
    page.onRecover();
    await flush();
    assert.deepEqual(
      app.community.pendingRatings.load(credentials.accountId),
      frozen,
    );
    state.badReceipt = true;
    const transitionsBeforeRetry = transitions;
    page.onRetry();
    await flush();
    assert.deepEqual(commands.at(-1).body, originalBody);
    assert.deepEqual(
      app.community.pendingRatings.load(credentials.accountId),
      frozen,
    );
    assert.equal(transitions, transitionsBeforeRetry);
    // A newer server membership differs from old applied history. Receipt recovery must GET current state, never re-like.
    state.badReceipt = false;
    state.missingReceipt = false;
    state.likes.set(rootId, {
      liked: false,
      count: 0,
      revision: id(sequence++),
    });
    const beforeRecoveryCommands = commands.length;
    page.onRecover();
    await flush();
    assert.equal(stored.size, 0);
    assert.equal(commands.length, beforeRecoveryCommands);
    assert.equal(page.data.likes[rootId].liked, false);
    page.onUnload();

    for (const failure of ['failWrite', 'failReadBack']) {
      page = thread();
      await flush();
      state[failure] = true;
      const before = commands.length;
      tap(page, 'onLike', { id: rootId });
      await flush();
      assert.equal(commands.length, before);
      assert.equal(page.data.frozen, true);
      clear('thread', page);
      state[failure] = false;
      page.onUnload();
      stored.clear();
    }
    page = thread();
    await flush();
    state.failRemove = true;
    tap(page, 'onLike', { id: rootId });
    await flush();
    assert.equal(page.data.frozen, true);
    assert.equal(stored.size, 1);
    state.failRemove = false;
    state.active = false;
    page.onRecover();
    await flush();
    assert.equal(stored.size, 0);
    clear('thread', page);
    page.onUnload();
    state.active = true;

    for (const [label, boundary] of [
      ['hide', (p) => p.onHide()],
      ['unload', (p) => p.onUnload()],
      ['logout', () => app.identity.sessions.logout()],
      ['same-account login', () => login()],
      [
        'other account',
        () => login({ ...credentials, accountId: otherAccount }),
      ],
      ['app hide', () => app.community.privateViews.clear()],
    ]) {
      login();
      holds.set('state', deferred());
      page = thread();
      await flush();
      const request = requests.at(-1);
      boundary(page);
      clear('thread', page);
      assert.equal(request.cancellation.isCancelled, true, label);
      await release('state');
      clear('thread', page);
      page.onUnload();
      login();
      holds.set('position', deferred());
      page = thread({ replyId, likeNoticeId: replyNoticeId });
      await flush();
      const readsBefore = reads.length;
      boundary(page);
      await release('position');
      clear('thread', page);
      assert.equal(reads.length, readsBefore, label);
      page.onUnload();
    }
    login();
    holds.set('command', deferred());
    page = thread();
    await flush();
    tap(page, 'onLike', { id: replyId });
    await flush();
    const ownerPending = structuredClone(
      app.community.pendingRatings.load(credentials.accountId),
    );
    assert.ok(ownerPending);
    login({ ...credentials, accountId: otherAccount });
    await release('command');
    clear('thread', page);
    assert.deepEqual(
      app.community.pendingRatings.load(credentials.accountId),
      ownerPending,
    );
    assert.equal(app.community.pendingRatings.load(otherAccount), null);
    page.onUnload();
    login();
    state.active = false;
    page = mount('recovery');
    await flush();
    assert.equal(stored.size, 0);
    assert.equal(visible('recovery', page).includes(rootBody), false);
    page.onUnload();
    state.active = true;

    // A newer route fences an older resolver before it can use or acknowledge a locator.
    holds.set('notice-target', deferred());
    page = thread({ likeNoticeId: noticeId });
    await flush();
    const beforeRouteRead = reads.length;
    page.onLoad({ targetId, rootId: otherRoot });
    page.onShow();
    await flush();
    await release('notice-target');
    assert.equal(reads.length, beforeRouteRead);
    page.onUnload();
  } finally {
    for (const hold of holds.values()) hold.resolve();
    holds.clear();
    for (const page of pages) page.onUnload?.();
    Object.assign(app.community, original);
    globalThis.wx.navigateTo = oldNavigate;
    login();
  }
  console.log(
    'Ratings R2B emitted handlers + real ApiClient/strict gateways + bounded WXML smoke passed: root/reply desired-state likes, independent unknown/current state, immutable single-slot recovery, sort/restart/unknown coverage exit, separate like notices with receiving-page read, and lifecycle stale-response fences (synthetic only; no device/provider/PostgreSQL/XP/notice-worker/push proof).',
  );
}
