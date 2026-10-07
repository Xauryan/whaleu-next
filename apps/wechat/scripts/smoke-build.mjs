import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This runs compiled CommonJS with synthetic native globals. It is not WeChat DevTools QA.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const dist = path.join(root, 'dist');
let app;
let page;
let calls = 0;
let storageCalls = 0;
const storage = new Map();
const forbiddenNativeCall = () => {
  calls += 1;
  throw new Error(
    'Unconfigured build must not call a native provider, storage, or network',
  );
};
globalThis.wx = {
  request: forbiddenNativeCall,
  login: forbiddenNativeCall,
  getStorageSync: (key) => {
    storageCalls += 1;
    return storage.get(key);
  },
  setStorageSync: (key, value) => storage.set(key, value),
  removeStorageSync: (key) => storage.delete(key),
};
globalThis.App = (options) => {
  app = options;
};
globalThis.getApp = () => app;
globalThis.Page = (options) => {
  page = options;
};
require(path.join(dist, 'app.js'));
assert.ok(app);
app.onLaunch();
assert.ok(app.identity);
const configured = app.identity.auth !== undefined;
if (!configured) assert.equal(storageCalls, 0);
const config = JSON.parse(readFileSync(path.join(dist, 'app.json'), 'utf8'));
assert.equal(config.pages[0], 'pages/login/login');
for (const route of config.pages) {
  for (const extension of ['js', 'json', 'wxml', 'wxss'])
    assert.ok(statSync(path.join(dist, `${route}.${extension}`)).size > 0);
}
require(path.join(dist, 'pages/login/login.js'));
assert.ok(page);
page.setData = (data) => {
  page.data = { ...page.data, ...data };
};
page.onLoad();
assert.equal(page.data.configured, configured);
assert.equal(page.data.verified, false);
if (!configured) assert.ok(page.data.error);
const wxml = readFileSync(path.join(dist, 'pages/login/login.wxml'), 'utf8');
for (const match of wxml.matchAll(/(?:bindtap|catchtap)="([^"]+)"/g))
  assert.equal(typeof page[match[1]], 'function');
assert.equal(/accessToken|refreshToken/.test(wxml), false);
if (!configured) await page.controller.login();
assert.equal(page.data.verified, false);
page.onUnload();
for (const route of ['pages/profile/profile', 'pages/campus/campus']) {
  require(path.join(dist, `${route}.js`));
  const current = page;
  current.setData = (data) => {
    current.data = { ...current.data, ...data };
  };
  current.onShow();
  assert.equal(current.data.loaded, false);
  assert.ok(current.data.error);
  const template = readFileSync(path.join(dist, `${route}.wxml`), 'utf8');
  for (const match of template.matchAll(
    /(?:bind|catch)(?:tap|input|change|confirm)="([^"]+)"/g,
  ))
    assert.equal(typeof current[match[1]], 'function', `${route}: ${match[1]}`);
  assert.equal(/accessToken|refreshToken/.test(template), false);
  for (const match of template.matchAll(/url="\/([^"]+)"/g))
    assert.ok(
      config.pages.includes(match[1]),
      `Unregistered navigation: ${match[1]}`,
    );
  current.onHide();
  assert.equal(current.controller, undefined);
  assert.equal(current.data.loaded, false);
  current.onShow();
  assert.ok(current.controller);
  current.onUnload();
}
assert.equal(calls, 0);
console.log(
  'Native build smoke passed: local bootstrap, all identity/campus/profile handlers, hide/show cancellation, assets, navigation, and configuration gating',
);
