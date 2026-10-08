import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import path from 'node:path';
const require = createRequire(import.meta.url);

export async function smokeViewReporting({
  app,
  dist,
  mountPage,
  flush,
  postWire,
}) {
  // Resolve actual emitted CommonJS in a Mini Program-like realm without process,
  // Node crypto, Buffer, TextEncoder, npm resolution or browser globals.
  const cache = new Map();
  const context = vm.createContext({});
  function load(filename) {
    filename = path.resolve(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const source = readFileSync(filename, 'utf8');
    const module = { exports: {} };
    cache.set(filename, module);
    const localRequire = (id) => {
      assert.ok(id.startsWith('.'), `Unbundled emitted dependency ${id}`);
      return load(path.resolve(path.dirname(filename), `${id}.js`));
    };
    const factory = new vm.Script(
      `(function(require,module,exports){${source}\n})`,
      { filename },
    ).runInContext(context);
    factory(localRequire, module, module.exports);
    return module.exports;
  }
  const contract = load(path.join(dist, 'community/view-contract.js'));
  const a = '11111111-1111-4111-8111-111111111111',
    b = '22222222-2222-4222-8222-222222222222';
  assert.equal(
    contract.viewFingerprint({ kind: 'list_exposure', postIds: [a, b, a] }),
    '67d9f41e18ae9de8bb391d5a656f0d9d299e93da7f99f6fc46cceedbb66fd414',
  );
  const crypto = load(path.join(dist, 'vendor/sha256.js'));
  for (const text of ['', 'abc', '鲸遇校园 🐋'])
    assert.equal(
      crypto.sha256(text),
      createHash('sha256').update(text).digest('hex'),
    );
  assert.match(
    readFileSync(path.join(dist, 'vendor/js-sha256-LICENSE.txt'), 'utf8'),
    /MIT License/,
  );
  const scan = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (entry.name.endsWith('.js'))
        for (const match of readFileSync(file, 'utf8').matchAll(
          /require\(["']([^"']+)["']\)/g,
        ))
          assert.ok(
            match[1].startsWith('.'),
            `Bare runtime import: ${file}: ${match[1]}`,
          );
    }
  };
  scan(dist);
  for (const page of ['community-feed', 'community-detail'])
    assert.match(
      readFileSync(path.join(dist, `pages/${page}/${page}.wxml`), 'utf8'),
      /id="view-\{\{/,
    );
  assert.doesNotMatch(
    readFileSync(
      path.join(dist, 'pages/community-search/community-search.js'),
      'utf8',
    ),
    /view-observer|view-report/,
  );

  const community = app.community,
    saved = {
      gateway: community.gateway,
      profiles: community.profiles,
      views: community.views,
      nextTick: globalThis.wx.nextTick,
      createIntersectionObserver: globalThis.wx.createIntersectionObserver,
    };
  const { systemClock } = require(path.join(dist, 'platform/clock.js'));
  const oldClock = { ...systemClock };
  let now = 1000,
    next = 0;
  const timers = new Map();
  systemClock.now = () => now;
  systemClock.schedule = (callback, delay) => {
    const id = ++next;
    timers.set(id, { callback, at: now + delay });
    return () => timers.delete(id);
  };
  const advance = (amount) => {
    now += amount;
    for (const [id, item] of [...timers])
      if (item.at <= now) {
        timers.delete(id);
        item.callback();
      }
  };
  const observations = [],
    events = [],
    listeners = new Set();
  const sessions = app.identity.sessions;
  if (!sessions.snapshot().credentials)
    sessions.completeLogin(sessions.beginLogin(), {
      accountId: '12345678-1234-4123-8123-123456789abc',
      sessionId: '22345678-1234-4123-8123-123456789abc',
      accessToken: `wu_a_${'a'.repeat(43)}`,
      refreshToken: `wu_r_${'a'.repeat(43)}`,
      expiresAt: 1900000000000,
      refreshExpiresAt: 1900600000000,
    });
  community.views = {
    captureOwner: () => sessions.snapshot(),
    canPresent: (owner) => owner.epoch === sessions.snapshot().epoch,
    canObserve: (owner) => owner.epoch === sessions.snapshot().epoch,
    observe: (kind, id) => events.push({ kind, id }),
    subscribeInvalidation: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  globalThis.wx.nextTick = (callback) => callback();
  globalThis.wx.createIntersectionObserver = () => {
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
  const post = { ...postWire(), component: { kind: 'none' } };
  const campus = { id: b, fullName: '合成校园', isActive: true };
  community.profiles = {
    ...saved.profiles,
    profile: async () => ({
      accountId: sessions.snapshot().credentials.accountId,
      selectedCampus: campus,
    }),
    campuses: async () => ({ items: [campus] }),
  };
  community.gateway = {
    ...saved.gateway,
    post: async () => post,
    comments: async () => ({ items: [], nextCursor: null }),
    spaces: async () => ({
      regional: { ...post.space, isActive: true },
      global: [],
    }),
    feed: async () => ({
      items: [post],
      nextCursor: null,
      continuation: 'end',
    }),
  };
  const mount = (name, query = {}) => {
    const page = mountPage(path.join(dist, `pages/${name}/${name}.js`), query);
    page.setData = (data, callback) => {
      page.data = { ...page.data, ...data };
      callback?.();
    };
    return page;
  };
  const target = () =>
    observations
      .filter(
        (item) => item.selector === `#view-${post.id}` && !item.disconnected,
      )
      .at(-1);
  try {
    const detail = mount('community-detail', { postId: post.id });
    await flush();
    assert.equal(detail.data.loaded, true);
    assert.equal(events.length, 0, 'GET/render alone must not report');
    target().callback({ intersectionRatio: 0.001 });
    assert.equal(events.length, 1);
    detail.onReload();
    await flush();
    assert.equal(
      events.length,
      1,
      'refresh must not create a second presentation',
    );
    detail.onHide();
    detail.onShow();
    await flush();
    target().callback({ intersectionRatio: 0.001 });
    assert.equal(events.length, 2);
    detail.onUnload();
    const feed = mount('community-feed');
    await flush();
    assert.equal(feed.data.loaded, true);
    assert.equal(events.length, 2);
    target().callback({ intersectionRatio: 0.49 });
    advance(1000);
    assert.equal(events.length, 2);
    target().callback({ intersectionRatio: 0.5 });
    advance(999);
    assert.equal(events.length, 2);
    advance(1);
    assert.equal(events.length, 3);
    const stale = target();
    feed.onHide();
    stale.callback({ intersectionRatio: 1 });
    advance(1000);
    assert.equal(events.length, 3);
    feed.onUnload();
    assert.deepEqual(
      events.map((item) => item.kind),
      ['detail_visit', 'detail_visit', 'list_exposure'],
    );
  } finally {
    community.gateway = saved.gateway;
    community.profiles = saved.profiles;
    community.views = saved.views;
    globalThis.wx.nextTick = saved.nextTick;
    globalThis.wx.createIntersectionObserver = saved.createIntersectionObserver;
    Object.assign(systemClock, oldClock);
  }
  console.log(
    'View-reporting emitted smoke passed: vetted browser-only SHA-256/UTF-8 without Node globals or npm imports, license, real feed/detail setData + intersection hooks, once-per-show detail, 50%/1s list, stale hide callbacks and no search instrumentation. No physical-device claim.',
  );
}
