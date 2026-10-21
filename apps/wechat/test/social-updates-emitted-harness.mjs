/** Actual native social Page + F7 controls + category gateways.
 * Real HTTP is supplied by PostgreSQL acceptance; this bridge creates no server
 * results. Source mode is only for isolated offline tests, not emitted evidence.
 * Native event delivery is modeled, never Tencent rendering/device acceptance. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createNativePressBridge } from './native-press-emitted-harness.mjs';
const require = createRequire(import.meta.url);
export function createSocialUpdatesJourney({
  dist,
  origin,
  credentials,
  transport,
  storage = new Map(),
  refresh,
  extension = 'js',
}) {
  dist = path.resolve(dist);
  assert.ok(extension === 'js' || extension === 'ts');
  const nativeModule = (name) =>
    require(path.join(dist, `${name}.${extension}`));
  const { SessionStore } = nativeModule('auth/session');
  const { ApiClient } = nativeModule('api/client');
  const { PrivateViewLifecycle } = nativeModule('identity-privacy/overlay');
  const { SafetyChanges } = nativeModule('community/safety-changes');
  const sessions = new SessionStore();
  if (credentials) sessions.completeLogin(sessions.beginLogin(), credentials);
  const privateViews = new PrivateViewLifecycle();
  const safetyChanges = new SafetyChanges(privateViews);
  const api = new ApiClient(origin, transport, sessions, {
    async refresh(ticket) {
      if (!refresh)
        throw Error('Journey requires explicit current test credentials');
      return refresh(ticket, sessions);
    },
  });
  const app = {
    identity: { sessions, api },
    community: { sessions, privateViews, safetyChanges },
  };
  const previous = {
    wx: globalThis.wx,
    getApp: globalThis.getApp,
    Page: globalThis.Page,
  };
  const pages = new Map(),
    navigations = [];
  let failNavigation = false;
  globalThis.wx = {
    getStorageSync: (key) =>
      storage.has(key) ? structuredClone(storage.get(key)) : undefined,
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    removeStorageSync: (key) => storage.delete(key),
    stopPullDownRefresh() {},
    navigateTo(options) {
      navigations.push(options.url);
      if (failNavigation) options.fail({});
      else options.success();
    },
    login() {
      throw Error('Social notifications must not request provider credentials');
    },
  };
  globalThis.getApp = () => app;
  function mount(kind) {
    assert.ok(['likes', 'followers', 'comments'].includes(kind));
    let definition, bridge, mountFailure;
    globalThis.Page = (value) => {
      definition = value;
    };
    const file = path.join(dist, 'pages/social-notices/social-notices');
    delete require.cache[require.resolve(`${file}.${extension}`)];
    require(`${file}.${extension}`);
    assert.ok(definition, 'Actual entrypoint registers the native social Page');
    const page = {
      ...definition,
      data: structuredClone(definition.data),
      setData(patch, callback) {
        Object.assign(this.data, structuredClone(patch));
        bridge?.sync();
        callback?.();
      },
    };
    bridge = createNativePressBridge({ page, pageFile: file, dist, extension });
    page.onLoad({ kind });
    Promise.resolve(page.onShow()).catch((error) => {
      mountFailure = error;
    });
    pages.set(page, bridge);
    return {
      page,
      async idle() {
        await Promise.resolve();
        const until = Date.now() + 20_000;
        while (page.data.busy) {
          assert.ok(
            Date.now() < until,
            'Social notification page did not settle',
          );
          await delay(5);
        }
        if (mountFailure) throw mountFailure;
        await Promise.resolve();
        return page.data;
      },
      capture: (handler, dataset = {}) => bridge.capture(handler, dataset),
      press(handler, dataset = {}) {
        const control = bridge.capture(handler, dataset);
        try {
          return control.press();
        } finally {
          control.detach();
        }
      },
      async show() {
        bridge.lifecycle('show');
        await page.onShow();
      },
      hide() {
        bridge.lifecycle('hide');
        page.onHide();
      },
      unload() {
        bridge.lifecycle('detach');
        page.onUnload();
        pages.delete(page);
      },
    };
  }
  return {
    mount,
    sessions,
    storage,
    navigations,
    app,
    setNavigationFailure(value) {
      failNavigation = value;
    },
    hideApp() {
      privateViews.clear();
    },
    invalidateSafety(accountId) {
      safetyChanges.invalidate(accountId);
    },
    close() {
      for (const [page, bridge] of pages) {
        bridge.lifecycle('detach');
        page.onUnload();
      }
      pages.clear();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    },
  };
}
