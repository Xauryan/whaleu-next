import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { registerRatingCategoryScopedPage } from '../src/ratings/category-scoped-page';
import {
  categoryIconHarness,
  iconPreparation,
  iconCategory,
  iconId,
} from './category-icon-helpers';
import {
  managedRoute,
  managedCampus,
  flushManagement,
} from './category-scoped-helpers';
import { accountId } from './identity-helpers';
import { ratingCategoryScopedOperations } from '../src/ratings/category-scoped-contract';
test('all nine original management flows prepare protocol5 and require explicit commit', async () => {
  for (const operation of ratingCategoryScopedOperations) {
    const h = categoryIconHarness();
    try {
      await h.controller.load(
        operation === 'create_categories_scoped' ||
          operation === 'create_system_category_scoped'
          ? { scope: 'campus', campusId: managedCampus }
          : managedRoute,
      );
      h.controller.selectOperation(operation);
      if (operation === 'create_categories_scoped')
        h.controller.setNodeText('n0', 'name', '类别');
      if (operation === 'create_system_category_scoped') {
        h.controller.selectSystemKey('synthetic_general');
        h.controller.setText('name', '系统');
      }
      await h.controller.prepare();
      assert.ok(h.view().preview, `${operation}: ${h.view().error}`);
      assert.equal(h.prepared.length, 1);
      assert.equal(h.prepared[0]!.protocolVersion, 5);
      assert.equal(h.committed.length, 0);
      assert.ok(h.store.load(accountId).command);
      await h.controller.commit();
      assert.equal(h.committed.length, 1);
      assert.equal(h.store.load(accountId).command, null);
    } finally {
      h.controller.dispose();
    }
  }
});
test('replace schedule freezes text and node identities before picker and preserves unknown request', async () => {
  const h = categoryIconHarness();
  try {
    await h.controller.load({ scope: 'campus', campusId: managedCampus });
    h.controller.selectOperation('create_categories_scoped');
    h.controller.setNodeText('n0', 'name', '原名称');
    h.controller.addNode('n0');
    h.controller.setNodeText('n1', 'name', '子项');
    h.controller.chooseIcon('new:n0', 'replace');
    h.controller.chooseIcon('new:n1', 'replace');
    await h.controller.prepare();
    assert.equal(h.view().iconFrozen, true);
    assert.equal(h.prepared.length, 0);
    const frozen = h.store.load(accountId).uploads!;
    assert.equal(frozen.identity.slots.length, 2);
    assert.equal(JSON.stringify(frozen).includes('assetId'), false);
    h.controller.setNodeText('n0', 'name', '不得修改');
    h.controller.removeNode('n0');
    assert.deepEqual(h.store.load(accountId).uploads, frozen);
    await h.controller.recover();
    assert.equal(h.calls[h.calls.length - 1], 'receipt');
    assert.ok(h.store.load(accountId).uploads);
    h.controller.requestCancel();
    await h.controller.confirmCancel();
    assert.equal(h.store.load(accountId).uploads, null);
  } finally {
    h.controller.dispose();
  }
});
test('preview paginates every affected scope plus icon change and closing never submits', async () => {
  const h = categoryIconHarness();
  try {
    h.gateway.prepare = async (intent) => ({
      ...iconPreparation(intent),
      affectedScopeKeys: Array.from(
        { length: 45 },
        (_, i) => `campus:${iconId(i + 1)}`,
      ),
      changedIconCount: 1,
      iconChanges: [
        {
          categoryId: iconCategory().id,
          kind: 'base',
          campusId: null,
          before: { state: 'unavailable', appearanceId: null },
          after: { state: 'absent', appearanceId: null },
        },
      ],
    });
    await h.controller.load(managedRoute);
    h.controller.selectOperation('edit_category_base_scoped');
    await h.controller.prepare();
    assert.equal(h.view().preview!.changeCount, 47);
    assert.equal(h.view().preview!.to, 20);
    h.controller.pagePreview(1);
    assert.equal(h.view().preview!.from, 21);
    h.controller.pagePreview(1);
    assert.equal(h.view().preview!.to, 47);
    assert.ok(
      h
        .view()
        .preview!.lines.some((line) => line.includes('不可用（不代表无图）')),
    );
    h.controller.closePreview();
    assert.equal(h.committed.length, 0);
    assert.ok(h.store.load(accountId).command);
    await h.controller.preparePending();
    assert.ok(h.view().preview);
  } finally {
    h.controller.dispose();
  }
});
test('source native editor Page registration binds icon choice upload preview and original handlers without tokens in setData', async () => {
  const h = categoryIconHarness();
  h.controller.dispose();
  h.current.now = Date.now();
  const globals = globalThis as typeof globalThis & {
      Page?: unknown;
      getApp?: unknown;
      wx?: unknown;
    },
    old = { Page: globals.Page, getApp: globals.getApp, wx: globals.wx };
  type Native = {
    data: Record<string, unknown>;
    setData: (patch: Record<string, unknown>) => void;
    onLoad: (query: unknown) => void;
    onShow: () => void;
    onUnload: () => void;
    [key: string]: unknown;
  };
  let page: Native | undefined;
  try {
    Object.assign(globals, {
      Page: (value: Native) => {
        page = value;
        value.setData = (patch) => {
          value.data = { ...value.data, ...patch };
        };
      },
      getApp: () => ({ community: h.runtime }),
      wx: { navigateTo: ({ success }: { success: () => void }) => success() },
    });
    registerRatingCategoryScopedPage(true);
    assert.ok(page);
    const native = page as Native;
    native.onLoad(managedRoute);
    native.onShow();
    await flushManagement();
    const wxml = readFileSync(
      path.resolve(__dirname, '../src/ratings/category-scoped.wxml'),
      'utf8',
    );
    for (const match of wxml.matchAll(/bind(?:tap|input)="([A-Za-z]+)"/g))
      assert.equal(typeof native[match[1]!], 'function');
    assert.equal(native.data.iconEnabled, true);
    const tap = (name: string, dataset: Record<string, string>) =>
      (native[name] as (this: Native, event: unknown) => void).call(native, {
        currentTarget: { dataset },
        detail: { value: '' },
      });
    tap('onOperation', { operation: 'edit_category_base_scoped' });
    tap('onIconChoice', { key: `base:${iconCategory().id}`, value: 'clear' });
    tap('onPrepare', {});
    await flushManagement();
    assert.ok(native.data.preview);
    assert.equal(h.committed.length, 0);
    const serialized = JSON.stringify(native.data);
    assert.equal(serialized.includes('contextToken'), false);
    assert.equal(serialized.includes('tokenDigest'), false);
    tap('onCommit', {});
    await flushManagement();
    assert.equal(h.committed.length, 1);
    native.onUnload();
  } finally {
    page?.onUnload();
    Object.assign(globals, old);
  }
});
