import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { registerRatingScopedPage } from '../src/ratings/scoped-page';
import { scopedContext, scopedHarness } from './rating-scoped-helpers';
import { otherId, targetId } from './ratings-helpers';

test('one registered native scoped page wires rendered flows, real lifecycle disposal and preserves legacy cleanup routes', async () => {
  const s = scopedHarness();
  s.controller.dispose();
  s.gateway.contextWork = async (request) => scopedContext(request, Date.now());
  const globals = globalThis as typeof globalThis & {
    Page?: unknown;
    getApp?: unknown;
    wx?: unknown;
  };
  const old = { Page: globals.Page, getApp: globals.getApp, wx: globals.wx };
  type NativePage = {
    data: Record<string, unknown>;
    setData(patch: Record<string, unknown>): void;
    onLoad(query: unknown): void;
    onShow(): void;
    onHide(): void;
    onUnload(): void;
    onCompose(event: unknown): void;
    onText(event: unknown): void;
    onCloseComposer(): void;
    onCampus(event: unknown): void;
    onSection(event: unknown): void;
    [key: string]: unknown;
  };
  let page: NativePage | undefined;
  const destinations: string[] = [];
  Object.assign(globals, {
    Page: (value: NativePage) => {
      page = value;
      value.setData = (patch) => {
        value.data = { ...value.data, ...patch };
      };
    },
    getApp: () => ({ community: s.runtime }),
    wx: {
      navigateTo: ({ url, success }: { url: string; success: () => void }) => {
        destinations.push(url);
        success();
      },
    },
  });
  try {
    registerRatingScopedPage();
    assert.ok(page);
    const native = page as NativePage;
    const wxml = readFileSync(
      path.resolve(__dirname, '../src/pages/rating-scoped/rating-scoped.wxml'),
      'utf8',
    );
    for (const match of wxml.matchAll(/bind(?:tap|input)="([A-Za-z]+)"/g))
      assert.equal(
        typeof native[match[1]!],
        'function',
        `Missing native handler ${match[1]}`,
      );
    const app = JSON.parse(
      readFileSync(path.resolve(__dirname, '../src/app.json'), 'utf8'),
    ) as { pages: string[] };
    assert.ok(app.pages.includes('pages/rating-scoped/rating-scoped'));
    assert.match(wxml, /全部版本原请求恢复/);
    assert.match(wxml, /明确选择校园/);
    assert.match(wxml, /完整候选范围/);
    native.onLoad({
      mode: 'detail',
      scope: 'campus',
      campusId: otherId,
      targetId,
    });
    native.onShow();
    for (let i = 0; i < 100; i++) await Promise.resolve();
    assert.equal(native.data.loaded, true);
    native.onSection({ currentTarget: { dataset: { mode: 'subscriptions' } } });
    assert.match(
      destinations[0]!,
      new RegExp(`scope=campus&campusId=${otherId}`),
    );
    native.onCompose({ currentTarget: { dataset: {} } });
    native.onText({ detail: { value: 'Sensitive draft' } });
    assert.equal(native.data.text, 'Sensitive draft');
    native.onCloseComposer();
    assert.equal(native.data.text, '');
    native.onCampus({ currentTarget: { dataset: {} } });
    for (let i = 0; i < 100; i++) await Promise.resolve();
    assert.equal(native.data.viewCampusId, null);
    native.onHide();
    assert.equal(native.data.loaded, false);
    assert.equal(native.data.text, '');
    native.onShow();
    for (let i = 0; i < 100; i++) await Promise.resolve();
    assert.equal(native.data.loaded, true);
    assert.equal(native.data.viewCampusId, null);
    native.onUnload();
  } finally {
    page?.onUnload();
    Object.assign(globals, old);
  }
});
