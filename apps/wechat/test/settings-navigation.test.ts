import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { SessionStore } from '../src/auth/session';
import { MemoryStorage, flush } from './helpers';
const root = path.join(__dirname, '../src');
const read = (name: string) => readFileSync(path.join(root, name), 'utf8');
test('settings lives outside profile editor and all menu targets are registered', () => {
  const profile = read('pages/profile/profile.wxml');
  assert.doesNotMatch(
    profile,
    /使用偏好|账户与更多功能|bindchange="onPreference"/,
  );
  const settings = read('pages/settings/settings.wxml');
  assert.match(settings, /<wu-f7-toggle[^>]*bind:change="onPreference"/);
  assert.match(settings, /disabled="{{loading \|\| saving \|\| needsReload}}"/);
  assert.match(settings, /bind:press="onSavePreferences"/);
  assert.match(settings, /bind:press="onCancelEdits"/);
  assert.match(settings, /bind:press="onCancelOperation"/);
  const config = JSON.parse(read('app.json')) as { pages: string[] };
  const menu = read('pages/account-menu/account-menu.ts');
  for (const match of menu.matchAll(/url: '([^']+)'/g))
    assert.ok(config.pages.includes(match[1]!.slice(1)));
  assert.ok(config.pages.includes('pages/settings/settings'));
  const me = read('pages/me/me.wxml');
  assert.match(me, /class="menu-footer"/);
  for (const target of [
    'pages/settings/settings',
    'pages/school-services/school-services',
  ])
    assert.ok(me.includes(target));
  assert.match(me, /bindtap="onScan"/);
  assert.doesNotMatch(me, /class="menu-row-note"/);
});
test('settings uses current authenticated owner controller and erases drafts on hide', async () => {
  const oldPage = Reflect.get(globalThis, 'Page');
  const oldApp = Reflect.get(globalThis, 'getApp');
  type Mounted = {
    data: Record<string, unknown>;
    controller?: unknown;
    setData(v: Record<string, unknown>): void;
    onShow(): void;
    onHide(): void;
    onUnload(): void;
  };
  let page!: Mounted;
  const sessions = new SessionStore(new MemoryStorage());
  Reflect.set(globalThis, 'Page', (value: Mounted) => {
    page = value;
  });
  Reflect.set(globalThis, 'getApp', () => ({ identity: { sessions } }));
  try {
    await import('../src/pages/settings/settings.js');
    page.setData = (value) => {
      page.data = { ...page.data, ...value };
    };
    page.onShow();
    await flush();
    assert.ok(page.controller);
    assert.equal(page.data['hasSession'], false);
    assert.equal(page.data['loaded'], false);
    page.setData({
      preferences: [{ key: 'hideProfilePosts', checked: true }],
      preferencesDirty: true,
    });
    page.onHide();
    assert.equal(page.controller, undefined);
    assert.deepEqual(page.data['preferences'], []);
    assert.equal(page.data['preferencesDirty'], false);
    page.onUnload();
  } finally {
    Reflect.set(globalThis, 'Page', oldPage);
    Reflect.set(globalThis, 'getApp', oldApp);
  }
});
