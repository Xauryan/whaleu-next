import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);

// Actual emitted page/controller/API/decoders and native rendering hooks; synthetic server responses.
export async function smokeHot({ app, dist, mountPage, flush, postWire }) {
  const { ApiClient } = require(path.join(dist, 'api/client.js'));
  const { HttpHotGateway } = require(
    path.join(dist, 'community/hot-gateway.js'),
  );
  const { systemClock } = require(path.join(dist, 'platform/clock.js'));
  const sessions = app.identity.sessions;
  const saved = {
    hot: app.community.hot,
    views: app.community.views,
    credentials: sessions.snapshot().credentials,
    clock: { ...systemClock },
    nextTick: globalThis.wx.nextTick,
    createIntersectionObserver: globalThis.wx.createIntersectionObserver,
  };
  const post = { ...postWire(), component: { kind: 'none' } };
  const token = Buffer.alloc(32, 1).toString('base64url');
  const requests = [],
    observations = [],
    events = [],
    listeners = new Set();
  let mode = 'normal',
    currentText = post.text,
    page,
    now = 1000,
    sequence = 0;
  const timers = new Map();
  const ranges = ['day', 'week', 'month', 'half_year', 'year', 'history'];
  systemClock.now = () => now;
  systemClock.schedule = (callback, delay) => {
    const id = ++sequence;
    timers.set(id, { at: now + delay, callback });
    return () => timers.delete(id);
  };
  const advance = (amount) => {
    now += amount;
    for (const [id, timer] of [...timers])
      if (timer.at <= now) {
        timers.delete(id);
        timer.callback();
      }
  };
  const login = (suffix) =>
    sessions.completeLogin(sessions.beginLogin(), {
      accountId: '12345678-1234-4123-8123-123456789abc',
      sessionId: '22345678-1234-4123-8123-123456789abc',
      accessToken: `wu_a_${suffix.repeat(43)}`,
      refreshToken: `wu_r_${suffix.repeat(43)}`,
      expiresAt: 1900000000000,
      refreshExpiresAt: 1900600000000,
    });
  if (!sessions.snapshot().credentials) login('a');
  app.community.views = {
    captureOwner: () => sessions.snapshot(),
    canPresent: (owner) =>
      !!owner.credentials && owner.epoch === sessions.snapshot().epoch,
    canObserve: (owner) =>
      !!owner.credentials && owner.epoch === sessions.snapshot().epoch,
    observe: (kind, postId) => events.push({ kind, postId }),
    subscribeInvalidation: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  globalThis.wx.nextTick = (callback) => callback();
  globalThis.wx.createIntersectionObserver = (_page, options) => {
    assert.deepEqual(options, { thresholds: [0, 0.5], initialRatio: 0 });
    const record = { selector: '', callback: null, disconnected: false };
    observations.push(record);
    return {
      relativeToViewport() {
        return this;
      },
      observe(selector, callback) {
        record.selector = selector;
        record.callback = callback;
      },
      disconnect() {
        record.disconnected = true;
      },
    };
  };
  const target = () =>
    observations
      .filter(
        (record) =>
          record.selector === `#view-${post.id}` && !record.disconnected,
      )
      .at(-1);
  app.community.hot = new HttpHotGateway(
    new ApiClient(
      'https://api.example',
      {
        send: async (request) => {
          requests.push(request);
          assert.equal(request.method, 'GET');
          assert.equal(request.body, undefined);
          const url = new URL(request.url);
          assert.equal(url.pathname, '/v1/community/hot');
          assert.equal(url.searchParams.get('spaceId'), post.space.id);
          assert.equal(url.searchParams.get('limit'), '10');
          assert.ok(ranges.includes(url.searchParams.get('range')));
          assert.ok(
            [...url.searchParams.keys()].every((key) =>
              ['spaceId', 'range', 'limit', 'cursor'].includes(key),
            ),
          );
          const after = url.searchParams.get('cursor');
          if (after) assert.equal(after, token);
          const response = (body) => ({ status: 200, headers: {}, body });
          if (mode === 'unavailable')
            return {
              status: 503,
              headers: {},
              body: { error: { code: 'HOT_FEED_UNAVAILABLE' } },
            };
          if (mode === 'expired' && after)
            return {
              status: 409,
              headers: {},
              body: { error: { code: 'DISCOVERY_RESTART_REQUIRED' } },
            };
          if (mode === 'deleted')
            return response({
              items: [],
              nextCursor: null,
              continuation: 'end',
            });
          if (mode === 'guest' || mode === 'phone')
            return response({
              items: [post],
              nextCursor: null,
              continuation:
                mode === 'guest'
                  ? 'login_required'
                  : 'phone_verification_required',
            });
          if (mode === 'private')
            return response({
              items: [{ ...post, score: '1.0000' }],
              nextCursor: null,
              continuation: 'end',
            });
          const item = { ...post, text: currentText };
          return response(
            after && mode !== 'loop'
              ? { items: [item], nextCursor: null, continuation: 'end' }
              : {
                  items: [item],
                  nextCursor: token,
                  continuation: 'scan_pending',
                },
          );
        },
      },
      sessions,
      {
        refresh: async () => {
          throw new Error('No refresh expected');
        },
      },
    ),
  );
  try {
    page = mountPage(path.join(dist, 'pages/community-hot/community-hot.js'), {
      spaceId: post.space.id,
    });
    page.setData = (data, callback) => {
      page.data = { ...page.data, ...data };
      callback?.();
    };
    await flush();
    assert.equal(page.data.range, 'day');
    assert.equal(page.data.loaded, true);
    assert.equal(page.data.continuation, 'scan_pending');
    assert.equal(page.data.posts.length, 1);
    assert.equal(events.length, 0);
    target().callback({ intersectionRatio: 0.49 });
    advance(1000);
    assert.equal(events.length, 0);
    target().callback({ intersectionRatio: 0.5 });
    advance(999);
    assert.equal(events.length, 0);
    advance(1);
    assert.deepEqual(events, [{ kind: 'list_exposure', postId: post.id }]);
    const old = target();
    const before = requests.length;
    page.onNext();
    page.onNext();
    assert.deepEqual(page.data.posts, []);
    old.callback({ intersectionRatio: 1 });
    advance(1000);
    assert.equal(events.length, 1);
    await flush();
    assert.equal(requests.length, before + 1);
    assert.equal(
      page.data.posts[0].id,
      post.id,
      'same moved post on next page remains valid',
    );
    assert.equal(page.data.canPrevious, true);
    currentText = '重新读取后的当前正文';
    page.onPrevious();
    page.onPrevious();
    await flush();
    assert.equal(page.data.posts[0].text, currentText);
    assert.equal(page.data.canPrevious, false);
    assert.equal(new URL(requests.at(-1).url).searchParams.get('cursor'), null);
    for (const range of ranges.slice(1)) {
      page.onRange({ currentTarget: { dataset: { key: range } } });
      assert.deepEqual(page.data.posts, []);
      assert.equal(page.data.space, null);
      await flush();
      assert.equal(page.data.range, range);
      assert.equal(
        new URL(requests.at(-1).url).searchParams.get('cursor'),
        null,
      );
    }
    mode = 'expired';
    page.onNext();
    await flush();
    assert.equal(page.data.restartRequired, true);
    assert.equal(page.data.canPrevious, false);
    assert.deepEqual(page.data.posts, []);
    mode = 'normal';
    page.onRefresh();
    await flush();
    mode = 'loop';
    page.onNext();
    await flush();
    assert.equal(page.data.loaded, false);
    assert.equal(page.data.canNext, false);
    mode = 'unavailable';
    page.onRefresh();
    await flush();
    assert.equal(page.data.loaded, false);
    assert.match(page.data.status, /暂不可用/);
    mode = 'private';
    page.onRefresh();
    await flush();
    assert.deepEqual(page.data.posts, []);
    assert.equal(JSON.stringify(page.data).includes('1.0000'), false);
    mode = 'normal';
    page.onRefresh();
    await flush();
    target().callback({ intersectionRatio: 0.5 });
    advance(500);
    const stale = target();
    app.community.privateViews.clear();
    stale.callback({ intersectionRatio: 1 });
    advance(1000);
    assert.equal(events.length, 1);
    page.onHide();
    assert.deepEqual(page.data.posts, []);
    assert.equal(listeners.size, 0);
    mode = 'deleted';
    page.onShow();
    await flush();
    assert.equal(page.data.range, 'history');
    assert.equal(page.data.space, null);
    assert.deepEqual(page.data.posts, []);
    assert.equal(page.data.continuation, 'end');
    page.onHide();
    login('b');
    assert.equal(page.resume, null);
    mode = 'phone';
    page.onShow();
    await flush();
    assert.equal(page.data.range, 'day');
    assert.equal(page.data.continuation, 'phone_verification_required');
    assert.equal(page.data.canNext, false);
    page.onHide();
    sessions.logout();
    mode = 'guest';
    const observed = observations.length;
    page.onShow();
    await flush();
    assert.equal(page.data.loaded, true);
    assert.equal(page.data.hasSession, false);
    assert.equal(page.data.continuation, 'login_required');
    assert.equal(observations.length, observed);
    assert.equal(requests.at(-1).headers.Authorization, undefined);
    page.onUnload();
    assert.equal(listeners.size, 0);
    assert.equal(timers.size, 0);
    const template = readFileSync(
      path.join(dist, 'pages/community-hot/community-hot.wxml'),
      'utf8',
    );
    assert.match(template, /id="view-\{\{item.id\}\}"/);
    assert.match(template, /尚未覆盖历史导入内容/);
    assert.doesNotMatch(
      template,
      /\bscore\b|\brank\b|\bindex\b|certificate|accountId/,
    );
  } finally {
    page?.onUnload();
    app.community.hot = saved.hot;
    app.community.views = saved.views;
    globalThis.wx.nextTick = saved.nextTick;
    globalThis.wx.createIntersectionObserver = saved.createIntersectionObserver;
    Object.assign(systemClock, saved.clock);
    if (saved.credentials)
      sessions.completeLogin(sessions.beginLogin(), saved.credentials);
    else sessions.logout();
  }
  console.log(
    'Hot compiled native smoke passed: strict optional-auth GET, six ranges, live cross-page repeats, fresh Previous, cursor loops/restart, unavailable/private-extra rejection, hide/session/guest fences and existing 50%/1s rendered-card exposure hooks. No physical-device claim.',
  );
}
