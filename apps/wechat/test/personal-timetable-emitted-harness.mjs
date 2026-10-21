/** Emitted native Page + F7 components + exact gateway/journal journey hooks.
 * Supply a real HTTP transport for PG acceptance; this file never fakes server success.
 * Native platform callbacks are modeled, not Tencent/device rendering proof. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createNativePressBridge } from './native-press-emitted-harness.mjs';
const require = createRequire(import.meta.url);
export function createTimetableJourney({
  dist,
  origin,
  credentials,
  transport,
  storage = new Map(),
  newRequestId = async () => randomUUID(),
}) {
  const emitted = (name) => require(path.join(dist, `${name}.js`));
  const { SessionStore } = emitted('auth/session');
  const { ApiClient } = emitted('api/client');
  const { PrivateViewLifecycle } = emitted('identity-privacy/overlay');
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), credentials);
  const privateViews = new PrivateViewLifecycle();
  const api = new ApiClient(origin, transport, sessions, {
    async refresh() {
      throw Error('Journey requires explicit current test credentials');
    },
  });
  const app = {
    identity: { sessions, api },
    community: { privateViews, newRequestId },
  };
  const previous = {
    wx: globalThis.wx,
    getApp: globalThis.getApp,
    Page: globalThis.Page,
  };
  const config = emitted('config'),
    savedConfiguration = config.clientConfiguration;
  config.clientConfiguration = Object.freeze({
    apiOrigin: origin,
    providerLoginEnabled: false,
  });
  const navigations = [],
    pages = new Map();
  let failNavigation = false;
  const native = {
    getStorageSync: (key) =>
      storage.has(key) ? structuredClone(storage.get(key)) : undefined,
    setStorageSync: (key, value) => {
      storage.set(key, structuredClone(value));
    },
    removeStorageSync: (key) => {
      storage.delete(key);
    },
    navigateTo(options) {
      navigations.push(options.url);
      if (failNavigation) options.fail({});
      else options.success();
    },
    login() {
      throw Error(
        'Timetable must not request academic or provider credentials',
      );
    },
  };
  globalThis.wx = native;
  globalThis.getApp = () => app;
  function mount(name, query = {}) {
    assert.ok(
      [
        'personal-timetable',
        'personal-timetable-term',
        'personal-timetable-entry',
      ].includes(name),
    );
    let definition;
    globalThis.Page = (value) => {
      definition = value;
    };
    const file = path.join(dist, `pages/${name}/${name}`);
    delete require.cache[require.resolve(`${file}.js`)];
    require(`${file}.js`);
    assert.ok(definition);
    const page = {
      ...definition,
      data: structuredClone(definition.data),
      setData(patch, callback) {
        Object.assign(this.data, structuredClone(patch));
        callback?.();
      },
    };
    const bridge = createNativePressBridge({ page, pageFile: file, dist });
    page.onLoad(query);
    page.onShow();
    pages.set(page, bridge);
    return {
      page,
      async idle() {
        const until = Date.now() + 20_000;
        while (page.data.busy) {
          assert.ok(
            Date.now() < until,
            'Timetable page did not settle in time',
          );
          await delay(5);
        }
        await Promise.resolve();
        return page.data;
      },
      press(handler, dataset = {}) {
        const control = bridge.capture(handler, dataset);
        const sent = control.press();
        control.detach();
        return sent;
      },
      input(handler, field, value) {
        // Execute the actual emitted native input's onInput method, not a direct controller call.
        let component;
        const previousComponent = globalThis.Component;
        globalThis.Component = (value) => {
          component = value;
        };
        const componentFile = path.join(
          dist,
          'components/f7-input/f7-input.js',
        );
        delete require.cache[require.resolve(componentFile)];
        require(componentFile);
        globalThis.Component = previousComponent;
        const instance = {
          properties: Object.fromEntries(
            Object.entries(component.properties).map(([key, property]) => [
              key,
              structuredClone(property.value),
            ]),
          ),
          data: structuredClone(component.data),
          setData(patch) {
            Object.assign(this.data, patch);
          },
          triggerEvent(type, detail, options) {
            assert.deepEqual(options, { bubbles: false, composed: false });
            if (type === 'input')
              page[handler]({ detail, currentTarget: { dataset: { field } } });
          },
          ...component.methods,
        };
        component.lifetimes.attached.call(instance);
        component.methods.onInput.call(instance, {
          detail: { value, cursor: value.length },
        });
        component.lifetimes.detached.call(instance);
      },
      picker(handler, value) {
        page[handler]({ detail: { value } });
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
    close() {
      for (const [page, bridge] of pages) {
        bridge.lifecycle('detach');
        page.onUnload();
      }
      pages.clear();
      config.clientConfiguration = savedConfiguration;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    },
  };
}
