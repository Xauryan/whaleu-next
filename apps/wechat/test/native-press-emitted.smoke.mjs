/** Existing emitted artifacts only. Synthetic host fixtures test the harness;
 * the final case exercises actual emitted campus Pages/controllers/runtime.
 * Neither proves DevTools/device acceptance or real permission grants. */
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { mountEmittedPage } from './text-review-emitted-harness.mjs';
const require = createRequire(import.meta.url);
const dist = path.resolve(
  process.env.WHALEU_WECHAT_DIST ??
    fileURLToPath(new URL('../dist/', import.meta.url)),
);
const emitted = (name) => require(path.join(dist, `${name}.js`));
const fixture = (t, body, lifecycleMethods = '') => {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), 'emitted-press-fixture-'),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const page = path.join(directory, 'pages/probe/probe');
  mkdirSync(path.dirname(page), { recursive: true });
  const usingComponents = {};
  for (const name of [
    'button',
    'list-item',
    'list',
    'block',
    'input',
    'searchbar',
  ]) {
    const component = `f7-${name}`;
    cpSync(
      path.join(dist, 'components', component),
      path.join(directory, 'components', component),
      { recursive: true },
    );
    usingComponents[`wu-${component}`] =
      `../../components/${component}/${component}`;
  }
  // Deliberately synthetic harness owner. Its controls are unmodified emitted
  // components; production Page behavior is covered separately below.
  writeFileSync(
    `${page}.js`,
    `Page({ data: { shown: true, hidden: false, disabled: false, loading: false, link: true, id: 'row-a', count: 6, revision: 'r1', parentHidden: false, parentDisabled: false, style: '', ancestorCalls: 0, calls: [] }, onHit(event) { this.data.calls.push(event); }, onAncestor() { this.data.ancestorCalls++; }, ${lifecycleMethods} });`,
  );
  writeFileSync(`${page}.wxml`, body);
  writeFileSync(`${page}.json`, JSON.stringify({ usingComponents }));
  return mountEmittedPage('probe', {}, {}, { dist: directory });
};
const button = `<wu-f7-button wx:if="{{shown}}" hidden="{{hidden}}" disabled="{{disabled}}" loading="{{loading}}" data-id="{{id}}" data-count="{{count}}" data-view-id="{{revision}}" data-label="literal" bind:press="onHit">Hit</wu-f7-button>`;
const item = `<wu-f7-list-item wx:if="{{shown}}" hidden="{{hidden}}" link="{{link}}" disabled="{{disabled}}" loading="{{loading}}" data-id="{{id}}" data-count="{{count}}" data-view-id="{{revision}}" bind:press="onHit" />`;

test('emitted Button and ListItem register, execute onPress and deliver isolated complete typed host datasets', (t) => {
  for (const markup of [button, item]) {
    const h = fixture(
      t,
      `<view bindtap="onAncestor"><wu-f7-list>${markup}</wu-f7-list></view>`,
    );
    const control = h.capturePress('onHit', { id: 'row-a' });
    assert.equal(typeof control.definition.methods.onPress, 'function');
    let invoked = 0;
    const onPress = control.definition.methods.onPress;
    control.definition.methods.onPress = function (event) {
      invoked++;
      return onPress.call(this, event);
    };
    const hostileNativeEvent = {
      detail: { code: 'not-a-grant', forged: true },
      currentTarget: { dataset: { id: 'wrong-inner-id' } },
    };
    assert.equal(control.press(hostileNativeEvent), true);
    assert.equal(invoked, 1, 'actual registered Component onPress is executed');
    assert.deepEqual(h.page.data.calls[0], {
      type: 'press',
      detail: {},
      currentTarget: {
        dataset: {
          id: 'row-a',
          count: 6,
          viewId: 'r1',
          ...(markup === button ? { label: 'literal' } : {}),
        },
      },
      target: {
        dataset: {
          id: 'row-a',
          count: 6,
          viewId: 'r1',
          ...(markup === button ? { label: 'literal' } : {}),
        },
      },
    });
    assert.deepEqual(h.componentEvents[0].options, {
      bubbles: false,
      composed: false,
    });
    assert.equal(h.page.data.ancestorCalls, 0);
    assert.throws(
      () => h.tap('onHit', { id: 'forged-host-id' }),
      /Actual WXML renders/,
    );
    h.event('bind:press', 'onHit', { injected: true }, { id: 'row-a' });
    assert.deepEqual(
      h.page.data.calls[1].detail,
      {},
      'caller detail cannot replace Component event detail',
    );
  }
});

test('template and loop hosts preserve typed datasets without borrowing caller fields', (t) => {
  const h = fixture(
    t,
    `<template name="row"><wu-f7-button data-id="{{id}}" data-count="{{count}}" data-enabled="{{enabled}}" data-label="row-{{id}}" bind:press="onHit" /></template><view wx:for="{{[6, 7]}}" wx:key="*this"><template is="row" data="{{id: item, count: index, enabled: true}}" /></view>`,
  );
  h.tap('onHit', { id: 7 });
  assert.deepEqual(h.page.data.calls[0].currentTarget.dataset, {
    id: 7,
    count: 1,
    enabled: true,
    label: 'row-7',
  });
});

test('disabled, loading, static, hidden and hidden/disabled ancestors emit no component or Page event', (t) => {
  for (const markup of [button, item]) {
    const h = fixture(
      t,
      `<view hidden="{{parentHidden}}" disabled="{{parentDisabled}}" style="{{style}}">${markup}</view>`,
    );
    for (const patch of [
      { disabled: true },
      { loading: true },
      { hidden: true },
      { parentHidden: true },
      { parentDisabled: true },
      { style: 'display: none;' },
      { style: 'visibility:hidden' },
      ...(markup === item ? [{ link: false }] : []),
    ]) {
      h.page.setData({
        disabled: false,
        loading: false,
        hidden: false,
        parentHidden: false,
        parentDisabled: false,
        style: '',
        link: true,
        ...patch,
      });
      assert.equal(
        h.capturePress('onHit').press(),
        false,
        JSON.stringify(patch),
      );
    }
    assert.equal(h.componentEvents.length, 0);
    assert.equal(h.page.data.calls.length, 0);
    h.page.setData({ shown: false });
    assert.throws(() => h.capturePress('onHit'), /Actual WXML renders/);
  }
});

test('actual Component disabled/loading and static-link guards remain independently effective', (t) => {
  for (const markup of [button, item]) {
    const h = fixture(t, markup);
    const control = h.capturePress('onHit');
    for (const patch of [
      { disabled: true },
      { loading: true },
      ...(markup === item ? [{ link: false }] : []),
    ]) {
      Object.assign(
        control.instance.properties,
        { disabled: false, loading: false, link: true },
        patch,
      );
      assert.equal(control.press(), false, JSON.stringify(patch));
    }
    assert.equal(h.componentEvents.length, 0);
    Object.assign(control.instance.properties, {
      disabled: false,
      loading: false,
      link: true,
    });
    assert.equal(control.press(), true);
  }
});

test('captured controls cannot relabel stale hosts, survive removal, hide/show, detach or unload', (t) => {
  for (const markup of [button, item]) {
    const h = fixture(t, markup);
    const stale = h.capturePress('onHit');
    h.page.setData({ id: 'row-b', revision: 'r2' });
    assert.equal(stale.press(), false);
    const removed = h.capturePress('onHit');
    h.page.setData({ shown: false });
    h.page.setData({ shown: true });
    assert.equal(
      removed.press(),
      false,
      'wx:if remove/recreate cannot revive a captured control',
    );
    const hidden = h.capturePress('onHit');
    h.page.onHide();
    assert.equal(hidden.press(), false);
    assert.equal(
      h.capturePress('onHit').press(),
      false,
      'hidden Page cannot emit from a fresh handle either',
    );
    const capturedWhileHidden = h.capturePress('onHit');
    h.page.onShow();
    assert.equal(
      capturedWhileHidden.press(),
      false,
      'a tap cannot originate on a hidden Page',
    );
    assert.equal(hidden.press(), false, 'show does not revive a pre-hide tap');
    const detached = h.capturePress('onHit');
    detached.detach();
    assert.equal(detached.press(), false);
    const live = h.capturePress('onHit');
    assert.equal(live.press(), true);
    assert.equal(h.page.data.calls[0].currentTarget.dataset.id, 'row-b');
    h.page.onUnload();
    h.page.onShow();
    assert.equal(live.press(), false);
    assert.equal(
      h.capturePress('onHit').press(),
      false,
      'unload cannot be reversed by show',
    );
    assert.equal(h.componentEvents.length, 1);
  }
});

test('synchronous onShow controller cleanup is not a platform component hide', (t) => {
  const h = fixture(
    t,
    button,
    `
    onShow() { this.onHide(); this.data.showCompleted = true; },
    onHide() { this.data.cleanupCalls = (this.data.cleanupCalls ?? 0) + 1; }
  `,
  );
  h.page.onShow();
  assert.equal(h.page.data.cleanupCalls, 1, 'original controller cleanup runs');
  assert.equal(h.page.data.showCompleted, true);
  assert.equal(h.capturePress('onHit').press(), true);
  h.page.setData({ disabled: true });
  assert.equal(h.capturePress('onHit').press(), false);
  h.page.setData({ disabled: false, hidden: true });
  assert.equal(h.capturePress('onHit').press(), false);
  h.page.setData({ hidden: false });
  const stale = h.capturePress('onHit');
  h.page.onHide();
  assert.equal(h.page.data.cleanupCalls, 2);
  assert.equal(stale.press(), false);
  assert.equal(h.capturePress('onHit').press(), false);
  h.page.onShow();
  assert.equal(stale.press(), false, 'show cannot revive a cancelled handle');
  assert.equal(h.capturePress('onHit').press(), true);
  h.page.onUnload();
  h.page.onShow();
  assert.equal(h.capturePress('onHit').press(), false);
});

test('pending onShow completion never reopens a hidden or unloaded page', async (t) => {
  for (const ending of ['onHide', 'onUnload']) {
    const h = fixture(
      t,
      button,
      `
      async onShow() {
        this.onHide();
        await new Promise((resolve) => { this.finishShow = resolve; });
        this.setData({ showCompleted: true });
      },
      onHide() { this.data.cleanupCalls = (this.data.cleanupCalls ?? 0) + 1; }
    `,
    );
    const pending = h.page.onShow();
    const late = h.capturePress('onHit');
    assert.equal(late.press(), true);
    h.page[ending]();
    h.page.finishShow();
    await pending;
    assert.equal(h.page.data.showCompleted, true);
    assert.equal(late.press(), false);
    late.instance.triggerEvent(
      'press',
      {},
      { bubbles: false, composed: false },
    );
    assert.equal(h.capturePress('onHit').press(), false);
    assert.equal(h.componentEvents.length, 1);
  }
});

test('onHide after the synchronous onShow stack still cancels component delivery', async (t) => {
  const h = fixture(
    t,
    button,
    `async onShow() { await Promise.resolve(); this.onHide(); }`,
  );
  await h.page.onShow();
  assert.equal(h.capturePress('onHit').press(), false);
});

test('onShow cleanup does not make unsupported component ancestors interactive', (t) => {
  const h = fixture(
    t,
    `<wu-f7-button>${button}</wu-f7-button>`,
    `onShow() { this.onHide(); }`,
  );
  h.page.onShow();
  assert.equal(h.capturePress('onHit').press(), false);
  assert.equal(h.componentEvents.length, 0);
});

test('onShow failure restores the boundary and nested unload remains terminal', (t) => {
  const failed = fixture(
    t,
    button,
    `onShow() { this.onHide(); throw new Error('show failure'); }`,
  );
  assert.throws(() => failed.page.onShow(), /show failure/);
  failed.page.onHide();
  assert.equal(failed.capturePress('onHit').press(), false);
  const unloaded = fixture(t, button, `onShow() { this.onUnload(); }`);
  unloaded.page.onShow();
  assert.equal(unloaded.capturePress('onHit').press(), false);
});

test('F7 cannot impersonate permission/open-type controls or unsupported custom events', (t) => {
  const h = fixture(
    t,
    button.replace(
      'bind:press="onHit"',
      'open-type="getPhoneNumber" bindgetphonenumber="onHit" bind:press="onHit"',
    ),
  );
  assert.equal(h.capturePress('onHit').press(), false);
  assert.equal(h.button('bindgetphonenumber', 'onHit'), undefined);
  assert.throws(
    () => h.event('bindgetphonenumber', 'onHit', { code: 'synthetic' }),
    /native permission|Unsupported custom/,
  );
  assert.equal(h.componentEvents.length, 0);
  assert.equal(h.page.data.calls.length, 0);
});

test('legacy raw native tap, disabled checks and phone event payload semantics are unchanged', (t) => {
  const h = fixture(
    t,
    '<button disabled="{{disabled}}" open-type="getPhoneNumber" data-id="native" bindtap="onHit" bindgetphonenumber="onHit" />',
  );
  assert.equal(
    h.button('bindgetphonenumber', 'onHit').attrs['open-type'],
    'getPhoneNumber',
  );
  const detail = { errMsg: 'getPhoneNumber:fail user deny' },
    dataset = { id: 'native' };
  h.event('bindgetphonenumber', 'onHit', detail, dataset);
  assert.equal(h.page.data.calls[0].detail, detail);
  assert.equal(h.page.data.calls[0].currentTarget.dataset, dataset);
  h.tap('onHit', dataset);
  assert.deepEqual(h.page.data.calls[1].detail, {});
  h.page.setData({ disabled: true });
  assert.throws(() => h.tap('onHit', dataset), /must be enabled/);
  assert.equal(h.componentEvents.length, 0);
});

test('actual emitted campus hub Component to Page to runtime navigation with raw map controls preserved', async () => {
  const previous = {
    wx: globalThis.wx,
    Page: globalThis.Page,
    getApp: globalThis.getApp,
  };
  const fixtures = require('./campus-tools-fixtures.ts');
  const { SessionStore } = emitted('auth/session');
  const { MediaLocalFiles } = emitted('media/local-files');
  const { createCampusToolsRuntime } = emitted('campus-tools/runtime');
  const entries = [fixtures.entry('map')],
    navigations = [],
    requests = [];
  const wx = {
    navigateTo(options) {
      navigations.push(options.url);
      options.success();
    },
    getStorageSync() {},
    setStorageSync() {},
    removeStorageSync() {},
    getLocation() {
      assert.fail('No real provider/location permission request');
    },
    login() {
      assert.fail('No real provider login');
    },
  };
  const files = { remove: async () => undefined };
  const app = {
    campusTools: createCampusToolsRuntime({
      api: {
        async request(endpoint) {
          requests.push(endpoint);
          return endpoint.decode(
            endpoint.path.endsWith('/tools')
              ? { ...fixtures.hub(), entries }
              : { ...fixtures.detail(), entry: entries[0] },
          );
        },
      },
      sessions: new SessionStore(),
      origin: 'https://synthetic-tools.invalid',
      wx,
      files,
      registry: new MediaLocalFiles(files),
      auth: { refresh: async () => assert.fail('No auth grant') },
      clock: { now: () => 1000, schedule: () => () => undefined },
    }),
  };
  const tick = async () => {
    for (let n = 0; n < 200; n++) await Promise.resolve();
  };
  const pages = [];
  try {
    const h = mountEmittedPage('campus-tools', app, wx);
    pages.push(h);
    h.page.onLoad({ campusId: fixtures.campusId });
    h.page.onShow();
    await tick();
    assert.equal(h.page.data.entries.length, 1);
    assert.ok(h.button('bindtap', 'onRefresh'));
    h.tap('onOpen', { id: entries[0].id });
    assert.match(navigations[0], /campus-tools-map\?campusId=/);
    assert.equal(h.componentEvents[0].tag, 'wu-f7-list-item');
    h.tap('onRefresh');
    await tick();
    assert.equal(h.componentEvents[1].tag, 'wu-f7-button');
    h.page.onHide();
    const map = mountEmittedPage('campus-tools-map', app, wx);
    pages.push(map);
    map.page.onLoad({
      campusId: fixtures.campusId,
      catalogId: fixtures.catalogId,
      entryId: entries[0].id,
    });
    map.page.onShow();
    await tick();
    assert.equal(map.button('bindtap', 'onLocate').attrs.disabled, 'true');
    assert.throws(() => map.tap('onLocate'), /must be enabled|live enabled/);
    map.tap('onMarker', { id: entries[0].markers[0].id });
    assert.equal(map.page.data.marker.id, entries[0].markers[0].id);
    map.tap('onReset');
    assert.deepEqual(map.page.data.center, { latitude: 40, longitude: 116 });
    assert.ok(
      requests.every((request) => request.authentication === 'optional'),
    );
  } finally {
    pages.forEach((h) => h.page.onUnload());
    app.campusTools.hide();
    Object.assign(globalThis, previous);
  }
});

const input = `<wu-f7-input wx:if="{{shown}}" hidden="{{hidden}}" disabled="{{disabled}}" read-only="{{readOnly}}" value="{{value}}" maxlength="-1" cursor-spacing="12" data-id="{{id}}" data-count="{{count}}" bind:input="onHit" />`;

test('emitted f7-input executes the actual model and isolates IME value/cursor and typed host dataset', (t) => {
  const h = fixture(t, `<wu-f7-list>${input}</wu-f7-list>`);
  h.page.setData({ value: '原值', readOnly: false });
  h.event(
    'bindinput',
    'onHit',
    {
      value: '拼音中',
      cursor: 3,
      keyCode: 229,
      composing: true,
      code: 'not-a-grant',
    },
    { id: 'row-a' },
  );
  assert.deepEqual(h.page.data.calls[0], {
    type: 'input',
    detail: { value: '拼音中', cursor: 3 },
    currentTarget: { dataset: { id: 'row-a', count: 6 } },
    target: { dataset: { id: 'row-a', count: 6 } },
  });
  assert.equal(
    h.page.data.value,
    '原值',
    'bridge does not rewrite the owner/editor buffer',
  );
  const control = h.captureInput('onHit');
  assert.equal(control.instance.properties.maxlength, -1);
  assert.equal(control.instance.properties.cursorSpacing, 12);
  assert.equal(control.instance.properties.readOnly, false);
  assert.equal(control.instance.data.nativeMaxlength, -1);
  const actual = control.definition.methods.onInput;
  let invoked = 0,
    result = 'not-called';
  control.definition.methods.onInput = function (event) {
    invoked++;
    result = actual.call(this, event);
    return result;
  };
  assert.equal(
    control.input({
      detail: { value: '中文', cursor: 2 },
      currentTarget: { dataset: { id: 'forged' } },
    }),
    true,
  );
  assert.equal(invoked, 1);
  assert.equal(
    result,
    undefined,
    'actual model never returns an IME replacement string',
  );
  assert.equal(h.page.data.calls[1].currentTarget.dataset.id, 'row-a');
  assert.deepEqual(h.inputComponentEvents[0].options, {
    bubbles: false,
    composed: false,
  });
  for (const cursor of [-1, 1.5, '2', Infinity]) {
    assert.equal(control.input({ detail: { value: '文本', cursor } }), true);
    assert.deepEqual(h.page.data.calls.at(-1).detail, { value: '文本' });
  }
  for (const detail of [{ value: 3 }, {}, null])
    assert.equal(control.input({ detail }), false);
  assert.throws(
    () => h.event('bindinput', 'onHit', { value: 'wrong' }, { id: 'forged' }),
    /Actual WXML renders/,
  );
});

test('input bridge rejects disabled, readOnly, hidden, unsupported ancestry and permission impersonation', (t) => {
  const h = fixture(
    t,
    `<view hidden="{{parentHidden}}" disabled="{{parentDisabled}}" style="{{style}}">${input}</view>`,
  );
  for (const patch of [
    { disabled: true },
    { readOnly: true },
    { hidden: true },
    { parentHidden: true },
    { parentDisabled: true },
    { style: 'display:none' },
  ]) {
    h.page.setData({
      disabled: false,
      readOnly: false,
      hidden: false,
      parentHidden: false,
      parentDisabled: false,
      style: '',
      ...patch,
    });
    assert.equal(
      h.captureInput('onHit').input({ detail: { value: 'blocked' } }),
      false,
    );
  }
  assert.equal(h.page.data.calls.length, 0);
  for (const markup of [
    `<wu-f7-button>${input}</wu-f7-button>`,
    input.replace('bind:input=', 'open-type="getPhoneNumber" bind:input='),
  ]) {
    const denied = fixture(t, markup);
    assert.equal(
      denied.captureInput('onHit').input({ detail: { value: 'blocked' } }),
      false,
    );
    assert.equal(denied.inputComponentEvents.length, 0);
  }
  const unknown = fixture(t, '<wu-f7-list bind:input="onHit" />');
  assert.throws(
    () => unknown.event('bind:input', 'onHit', { value: 'no' }),
    /Unsupported custom/,
  );
});

test('input capture and late events cannot outlive host replacement, hide, detach or unload', (t) => {
  for (const ending of [
    'hide',
    'unload',
    'remove',
    'relabel',
    'disable',
    'readonly',
    'detach',
  ]) {
    const h = fixture(t, input, 'onShow() { this.onHide(); }');
    h.page.onShow();
    const stale = h.captureInput('onHit');
    assert.equal(stale.input({ detail: { value: 'live' } }), true);
    if (ending === 'hide') h.page.onHide();
    if (ending === 'unload') h.page.onUnload();
    if (ending === 'remove') {
      h.page.setData({ shown: false });
      h.page.setData({ shown: true });
    }
    if (ending === 'relabel') h.page.setData({ id: 'row-b' });
    if (ending === 'disable') h.page.setData({ disabled: true });
    if (ending === 'readonly') h.page.setData({ readOnly: true });
    if (ending === 'detach') stale.detach();
    assert.equal(stale.input({ detail: { value: 'late' } }), false, ending);
    stale.instance.triggerEvent(
      'input',
      { value: 'late' },
      { bubbles: false, composed: false },
    );
    assert.equal(h.page.data.calls.length, 1, ending);
    if (ending === 'hide' || ending === 'unload') {
      const hidden = h.captureInput('onHit');
      h.page.onShow();
      assert.equal(hidden.input({ detail: { value: 'hidden' } }), false);
      assert.equal(stale.input({ detail: { value: 'stale' } }), false);
      assert.equal(
        h.captureInput('onHit').input({ detail: { value: 'new' } }),
        ending === 'hide',
      );
    }
  }
});

test('input Component guards remain independent and async show completion cannot reopen input', async (t) => {
  const h = fixture(
    t,
    input,
    `async onShow() { this.onHide(); await new Promise(resolve => { this.finishShow = resolve; }); }`,
  );
  const pending = h.page.onShow();
  const control = h.captureInput('onHit');
  for (const property of ['disabled', 'readOnly']) {
    control.instance.properties[property] = true;
    assert.equal(control.input({ detail: { value: 'no' } }), false);
    control.instance.properties[property] = false;
  }
  assert.equal(control.input({ detail: { value: 'yes' } }), true);
  h.page.onHide();
  h.page.finishShow();
  await pending;
  assert.equal(
    h.captureInput('onHit').input({ detail: { value: 'late' } }),
    false,
  );
  assert.equal(h.page.data.calls.length, 1);
});

test('actual emitted profile nickname input reaches the owner through its emitted Component', () => {
  const previous = {
    wx: globalThis.wx,
    Page: globalThis.Page,
    getApp: globalThis.getApp,
  };
  try {
    const h = mountEmittedPage('profile', {}, {});
    const values = [];
    h.page.controller = {
      setNickname(value) {
        values.push(value);
      },
    };
    h.page.setData({
      loaded: true,
      loading: false,
      saving: false,
      needsReload: false,
    });
    h.event('bindinput', 'onNickname', {
      value: '测试昵称',
      cursor: 4,
      keyCode: 229,
    });
    assert.deepEqual(values, ['测试昵称']);
    assert.equal(h.inputComponentEvents[0].tag, 'wu-f7-input');
    h.page.setData({ saving: true });
    assert.throws(
      () => h.event('bindinput', 'onNickname', { value: 'blocked' }),
      /live enabled/,
    );
    assert.deepEqual(values, ['测试昵称']);
  } finally {
    Object.assign(globalThis, previous);
  }
});

const searchbar = input.replace('wu-f7-input', 'wu-f7-searchbar');

test('searchbar actual emitted input model preserves IME and does not alias cancel or other custom events', (t) => {
  const h = fixture(
    t,
    searchbar.replace(
      'bind:input=',
      'show-cancel="{{showCancel}}" bind:cancel="onAncestor" bind:confirm="onAncestor" bind:input=',
    ),
  );
  h.page.setData({ showCancel: false });
  h.event(
    'bindinput',
    'onHit',
    { value: '搜索中', cursor: 3, keyCode: 229, forged: true },
    { id: 'row-a' },
  );
  assert.deepEqual(h.page.data.calls[0].detail, { value: '搜索中', cursor: 3 });
  assert.deepEqual(h.page.data.calls[0].currentTarget.dataset, {
    id: 'row-a',
    count: 6,
  });
  assert.equal(h.inputComponentEvents[0].tag, 'wu-f7-searchbar');
  const control = h.captureInput('onHit');
  assert.equal(control.instance.properties.maxlength, -1);
  assert.equal(control.instance.data.nativeCursorSpacing, 12);
  const actual = control.definition.methods.onInput;
  let called = 0,
    returned = 'not-called';
  control.definition.methods.onInput = function (event) {
    called++;
    returned = actual.call(this, event);
    return returned;
  };
  assert.equal(control.input({ detail: { value: '中文', cursor: 2 } }), true);
  assert.equal(called, 1);
  assert.equal(returned, undefined);
  control.instance.onCancel();
  assert.equal(
    h.page.data.ancestorCalls,
    0,
    'hidden cancel control cannot emit',
  );
  control.instance.properties.showCancel = true;
  control.instance.properties.disabled = true;
  control.instance.onCancel();
  control.instance.properties.disabled = false;
  control.instance.properties.readOnly = true;
  control.instance.onCancel();
  control.instance.properties.readOnly = false;
  assert.throws(
    () => control.instance.onCancel(),
    /Only the emitted isolated input event/,
  );
  assert.throws(
    () => h.event('bind:cancel', 'onAncestor'),
    /Unsupported custom event/,
  );
  assert.throws(
    () => h.event('bind:confirm', 'onAncestor', { value: 'no' }),
    /Unsupported custom event/,
  );
  assert.equal(
    h.page.data.ancestorCalls,
    0,
    'input bridge must never forward cancel/confirm as input',
  );
  h.page.onHide();
  control.instance.onCancel();
  assert.equal(h.page.data.calls.length, 2);
});

test('searchbar input rejects stale, disabled, readOnly, hidden and unloaded delivery', (t) => {
  for (const change of [
    'disable',
    'readonly',
    'hide',
    'unload',
    'remove',
    'relabel',
  ]) {
    const h = fixture(t, searchbar, 'onShow() { this.onHide(); }');
    h.page.onShow();
    const stale = h.captureInput('onHit');
    assert.equal(stale.input({ detail: { value: 'before' } }), true);
    if (change === 'disable') h.page.setData({ disabled: true });
    if (change === 'readonly') h.page.setData({ readOnly: true });
    if (change === 'hide') h.page.onHide();
    if (change === 'unload') h.page.onUnload();
    if (change === 'remove') {
      h.page.setData({ shown: false });
      h.page.setData({ shown: true });
    }
    if (change === 'relabel') h.page.setData({ id: 'other' });
    assert.equal(stale.input({ detail: { value: 'late' } }), false, change);
    stale.instance.triggerEvent(
      'input',
      { value: 'late' },
      { bubbles: false, composed: false },
    );
    assert.equal(h.page.data.calls.length, 1, change);
    if (['disable', 'readonly', 'hide', 'unload'].includes(change))
      assert.equal(
        h.captureInput('onHit').input({ detail: { value: 'blocked' } }),
        false,
        change,
      );
  }
  for (const markup of [
    `<wu-f7-button>${searchbar}</wu-f7-button>`,
    `<view hidden="true">${searchbar}</view>`,
    searchbar.replace('bind:input=', 'open-type="getPhoneNumber" bind:input='),
  ]) {
    const h = fixture(t, markup);
    assert.equal(
      h.captureInput('onHit').input({ detail: { value: 'no' } }),
      false,
    );
    assert.equal(h.inputComponentEvents.length, 0);
  }
});

test('actual emitted community search accepts only its real searchbar input delivery', () => {
  const previous = {
    wx: globalThis.wx,
    Page: globalThis.Page,
    getApp: globalThis.getApp,
  };
  try {
    const h = mountEmittedPage('community-search', {}, {});
    const values = [];
    h.page.controller = {
      setInput(value) {
        values.push(value);
      },
    };
    h.event('bindinput', 'onInput', {
      value: '实际搜索',
      cursor: 4,
      keyCode: 229,
    });
    assert.deepEqual(values, ['实际搜索']);
    assert.equal(h.inputComponentEvents[0].tag, 'wu-f7-searchbar');
    assert.deepEqual(h.inputComponentEvents[0].detail, {
      value: '实际搜索',
      cursor: 4,
    });
    assert.throws(
      () => h.event('bind:confirm', 'onSubmit', { value: 'unsupported' }),
      /Unsupported custom event/,
    );
  } finally {
    Object.assign(globalThis, previous);
  }
});

test('searchbar pending show and cancelled captured callbacks never reopen hidden or unloaded input', async (t) => {
  for (const ending of ['onHide', 'onUnload']) {
    const h = fixture(
      t,
      searchbar,
      `async onShow() { this.onHide(); await new Promise(resolve => { this.finishShow = resolve; }); }`,
    );
    const pending = h.page.onShow();
    const late = h.captureInput('onHit');
    assert.equal(late.input({ detail: { value: 'live' } }), true);
    h.page[ending]();
    const hidden = h.captureInput('onHit');
    h.page.finishShow();
    await pending;
    assert.equal(hidden.input({ detail: { value: 'late' } }), false);
    assert.equal(late.input({ detail: { value: 'late' } }), false);
    assert.equal(
      h.captureInput('onHit').input({ detail: { value: 'late' } }),
      false,
    );
    assert.equal(h.page.data.calls.length, 1);
  }
});

test('bridge consumes parser-decoded text once and never reparses dynamic text', (t) => {
  const h = fixture(
    t,
    `<wu-f7-button data-count="{{count}}" bind:press="onHit">&quot;x&quot; &apos;y&apos; &amp;quot; &amp;apos; &amp;gt; {{label}}</wu-f7-button>`,
  );
  h.page.setData({ label: '&quot; &apos; &gt; <button> {{missing}}' });
  assert.deepEqual(h.button('bind:press', 'onHit').children, [
    `"x" 'y' &quot; &apos; &gt; &quot; &apos; &gt; <button> {{missing}}`,
  ]);
  h.tap('onHit');
  assert.deepEqual(h.page.data.calls[0].currentTarget.dataset, { count: 6 });
});

test('Page nodes and emitted F7 models share one attribute decode without re-evaluating runtime data', (t) => {
  const h = fixture(
    t,
    `<wu-f7-list><wu-f7-list-item link="{{true}}" data-id="{{id}}" data-label="{{label}}" aria-label="{{label + &quot;，查看已审核图片&quot;}}" bind:press="onHit" /><wu-f7-input value="{{label}}" data-id="{{id}}" aria-label="{{&apos;输入&apos;}}" bind:input="onHit" /></wu-f7-list>`,
  );
  const label = '&quot; &amp; &lt; <button> {{probe()}}';
  let evaluated = 0;
  h.page.data.probe = () => evaluated++;
  h.page.setData({ label, id: '&amp;quot; {{probe()}}' });
  const host = h
    .nodes()
    .find(
      (node) =>
        typeof node !== 'string' && node.attrs['bind:press'] === 'onHit',
    );
  assert.ok(host);
  assert.equal(host.attrs['aria-label'], label + '，查看已审核图片');
  const press = h.capturePress('onHit');
  assert.equal(press.node.attrs['aria-label'], label + '，查看已审核图片');
  assert.equal(press.press(), true);
  assert.deepEqual(h.page.data.calls[0].currentTarget.dataset, {
    id: '&amp;quot; {{probe()}}',
    label,
  });
  press.detach();
  const input = h.captureInput('onHit');
  assert.equal(input.node.attrs['aria-label'], '输入');
  assert.equal(input.instance.properties.value, label);
  assert.equal(input.input({ detail: { value: label } }), true);
  assert.equal(h.page.data.calls[1].detail.value, label);
  assert.equal(evaluated, 0);
  input.detach();
});
