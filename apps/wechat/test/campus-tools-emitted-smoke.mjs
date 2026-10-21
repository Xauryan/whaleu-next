/** Emitted registered page + WXML checks, with synthetic source/device ports. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { mountEmittedPage } from './text-review-emitted-harness.mjs';
const require = createRequire(import.meta.url),
  dist = fileURLToPath(new URL('../dist/', import.meta.url)),
  emitted = (name) => require(`${dist}${name}.js`);
const { SessionStore } = emitted('auth/session'),
  { MediaLocalFiles } = emitted('media/local-files'),
  { createCampusToolsRuntime } = emitted('campus-tools/runtime');
const fixtures = require('./campus-tools-fixtures.ts');
const sessions = new SessionStore(),
  copies = [],
  navigations = [],
  entries = ['map', 'shuttle', 'research', 'web-link'].map((kind, ordinal) => ({
    ...fixtures.entry(kind),
    id: `${ordinal + 1}aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    revision: `${ordinal + 5}aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    sourceId: kind === 'web-link' ? 'web' : kind,
    ordinal,
    ...(kind === 'research'
      ? {
          image: {
            ...fixtures.slot,
            bindingId: 'baaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          },
        }
      : {}),
  }));
const tick = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};
const storage = new Map();
const wx = {
  getStorageSync: (key) => storage.get(key),
  setStorageSync: (key, value) => storage.set(key, value),
  removeStorageSync: (key) => storage.delete(key),
  navigateTo: (options) => {
    navigations.push(options.url);
    options.success();
  },
  setClipboardData: (options) => {
    copies.push(options.data);
    options.success();
  },
  navigateBack: (options) => options.fail({}),
  reLaunch: (options) => {
    navigations.push(options.url);
    options.success();
  },
};
const api = {
  async request(endpoint, options = {}) {
    let response;
    if (endpoint.path === `/v1/campuses/${fixtures.campusId}/tools`)
      response = { ...fixtures.hub(), entries };
    else {
      const id = endpoint.path.split('/')[5],
        item = entries.find((entry) => entry.id === id);
      assert.ok(item);
      assert.equal(options.query.catalogId, fixtures.catalogId);
      response = endpoint.path.endsWith('/link')
        ? {
            ...fixtures.link(options.query.action),
            entryId: id,
            entryRevision: item.revision,
          }
        : { ...fixtures.detail(), entry: item };
    }
    assert.equal(endpoint.authentication, 'optional');
    return endpoint.decode(response);
  },
};
const files = { remove: async () => undefined },
  registry = new MediaLocalFiles(files),
  clock = { now: () => 1000, schedule: () => () => undefined };
const app = {
  campusTools: createCampusToolsRuntime({
    api,
    sessions,
    origin: 'https://synthetic-tools.invalid',
    wx,
    files,
    registry,
    auth: {
      refresh: async () => {
        throw Error('No authentication downgrade');
      },
    },
    clock,
  }),
};
const registered = JSON.parse(readFileSync(`${dist}app.json`, 'utf8')).pages;
for (const name of [
  'campus-tools',
  'campus-tools-map',
  'campus-tools-shuttle',
  'campus-tools-research',
  'campus-tools-webview',
])
  assert.ok(registered.includes(`pages/${name}/${name}`));
const mount = (name, query) => {
  const h = mountEmittedPage(name, app, wx);
  h.page.onLoad(query);
  h.page.onShow();
  return h;
};
const hub = mount('campus-tools', { campusId: fixtures.campusId });
await tick();
assert.equal(hub.page.data.entries.length, 4);
// Exercise the emitted native component guard/event, not a synthetic raw tap.
let itemComponent;
const previousComponent = globalThis.Component;
globalThis.Component = (definition) => {
  itemComponent = definition;
};
try {
  const itemPath = require.resolve(
    `${dist}components/f7-list-item/f7-list-item.js`,
  );
  delete require.cache[itemPath];
  require(itemPath);
} finally {
  globalThis.Component = previousComponent;
}
assert.ok(itemComponent);
let emittedPresses = 0;
const itemInstance = {
  properties: { link: true, disabled: true, loading: false },
  triggerEvent(name, detail, options) {
    assert.equal(name, 'press');
    assert.deepEqual(options, { bubbles: false, composed: false });
    assert.deepEqual(detail, {});
    emittedPresses += 1;
  },
};
itemComponent.methods.onPress.call(itemInstance);
assert.equal(
  navigations.length,
  0,
  'disabled component cannot open a campus tool',
);
assert.equal(emittedPresses, 0);
itemInstance.properties.disabled = false;
itemComponent.methods.onPress.call(itemInstance);
assert.equal(emittedPresses, 1);
assert.equal(navigations.length, 0);
assert.equal(hub.capturePress('onOpen', { id: entries[0].id }).press(), true);
assert.match(navigations[0], /campus-tools-map\?campusId=/);
hub.page.onHide();
const route = (item) => ({
  campusId: fixtures.campusId,
  catalogId: fixtures.catalogId,
  entryId: item.id,
});
const map = mount('campus-tools-map', route(entries[0]));
await tick();
assert.equal(map.page.data.located, false);
assert.equal(map.button('bindtap', 'onLocate').attrs.disabled, 'true');
map.tap('onMarker', { id: 6 });
assert.equal(map.page.data.marker.id, 6);
map.tap('onReset');
assert.deepEqual(map.page.data.center, { latitude: 40, longitude: 116 });
map.page.onHide();
const shuttle = mount('campus-tools-shuttle', route(entries[1]));
await tick();
shuttle.tap('onToggleGroup', { id: 'shuttle' });
shuttle.tap('onToggleGroup', { id: 'bus' });
assert.deepEqual(shuttle.page.data.expandedGroups, {
  shuttle: true,
  bus: true,
});
assert.ok(shuttle.button('bindtap', 'onPreview'));
shuttle.page.onHide();
const research = mount('campus-tools-research', route(entries[2]));
await tick();
research.tap('onCopy');
await tick();
assert.deepEqual(copies, ['https://tools.example.com/resource']);
assert.equal(research.page.data.status, '已复制外部链接');
research.page.onHide();
const web = mount('campus-tools-webview', route(entries[3]));
await tick();
assert.equal(web.page.data.state, 'webview_unconfigured');
assert.equal(web.page.data.webviewSrc, '');
assert.ok(
  !web
    .nodes()
    .some((node) => typeof node !== 'string' && node.tag === 'web-view'),
);
web.tap('onBack');
assert.equal(navigations.at(-1), '/pages/campus-tools/campus-tools');
web.page.onHide();
const hostile = mount('campus-tools-webview', {
  ...route(entries[3]),
  url: 'https://attacker.example/',
});
await tick();
assert.equal(hostile.page.data.webviewSrc, '');
assert.match(hostile.page.data.error, /入口无效/);
hostile.page.onHide();
app.campusTools.hide();
app.campusTools = createCampusToolsRuntime({
  api,
  sessions,
  origin: 'https://synthetic-tools.invalid',
  wx,
  files,
  registry,
  auth: {
    refresh: async () => {
      throw Error('No authentication downgrade');
    },
  },
  clock,
  embed: { authorize: async () => true },
});
const firstEmbed = mount('campus-tools-webview', route(entries[3]));
await tick();
const oldEmbed = { ...firstEmbed.page.data };
assert.ok(oldEmbed.webviewSrc);
firstEmbed.page.onHide();
firstEmbed.page.onUnload();
const secondEmbed = mount('campus-tools-webview', route(entries[3]));
await tick();
assert.ok(secondEmbed.page.data.webviewSrc);
assert.notEqual(secondEmbed.page.data.webviewViewId, oldEmbed.webviewViewId);
const late = {
  currentTarget: {
    dataset: { source: oldEmbed.webviewSrc, viewId: oldEmbed.webviewViewId },
  },
};
secondEmbed.page.onWebviewLoad(late);
assert.equal(secondEmbed.page.data.webviewLoaded, false);
secondEmbed.page.onWebviewError(late);
assert.ok(secondEmbed.page.data.webviewSrc);
secondEmbed.page.onHide();
app.campusTools.hide();
console.log('Campus tools emitted Page/WXML smoke passed (synthetic only)');
