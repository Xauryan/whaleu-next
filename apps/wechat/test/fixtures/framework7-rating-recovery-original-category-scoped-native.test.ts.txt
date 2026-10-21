import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { registerRatingCategoryScopedPage } from '../src/ratings/category-scoped-page';
import { registerRatingScopedPage } from '../src/ratings/scoped-page';
import { wireCredentials } from './identity-helpers';
import { deferred } from './helpers';
import { categoryTestId } from './category-management-helpers';
import { scopedContext, scopedHarness } from './rating-scoped-helpers';
import { ratingCategoryScopedOperations } from '../src/ratings/category-scoped-contract';
import {
  categoryScopedHarness,
  flushManagement,
  managedCampus,
  managedId,
  managedCategory,
  managedRoute,
  managementContext,
} from './category-scoped-helpers';
type NativePage = {
  data: Record<string, unknown>;
  setData(patch: Record<string, unknown>): void;
  onLoad(query: unknown): void;
  onShow(): void;
  onHide(): void;
  onUnload(): void;
  [key: string]: unknown;
};
const tap = (dataset: Record<string, string> = {}) => ({
  currentTarget: { dataset },
  detail: { value: '' },
});
function invoke(page: NativePage, name: string, event: unknown = tap()): void {
  const handler = page[name];
  assert.equal(typeof handler, 'function');
  (handler as (this: NativePage, event: unknown) => void).call(page, event);
}

test('real native manage/editor registrations bind every rendered action and all nine prepare→preview→commit flows', async () => {
  const globals = globalThis as typeof globalThis & {
    Page?: unknown;
    getApp?: unknown;
    wx?: unknown;
  };
  const old = { Page: globals.Page, getApp: globals.getApp, wx: globals.wx };
  let page: NativePage | undefined;
  const wxml = readFileSync(
    path.resolve(__dirname, '../src/ratings/category-scoped.wxml'),
    'utf8',
  );
  const app = JSON.parse(
    readFileSync(path.resolve(__dirname, '../src/app.json'), 'utf8'),
  ) as { pages: string[] };
  assert.ok(
    app.pages.includes('pages/rating-category-manage/rating-category-manage'),
  );
  assert.ok(
    app.pages.includes('pages/rating-category-editor/rating-category-editor'),
  );
  try {
    for (const operation of ratingCategoryScopedOperations) {
      const s = categoryScopedHarness();
      s.controller.dispose();
      s.current.now = Date.now();
      Object.assign(globals, {
        Page: (value: NativePage) => {
          page = value;
          value.setData = (patch) => {
            value.data = { ...value.data, ...patch };
          };
        },
        getApp: () => ({ community: s.runtime }),
        wx: { navigateTo: ({ success }: { success: () => void }) => success() },
      });
      registerRatingCategoryScopedPage(true);
      assert.ok(page);
      const native = page as NativePage;
      for (const match of wxml.matchAll(/bind(?:tap|input)="([A-Za-z]+)"/g))
        assert.equal(
          typeof native[match[1]!],
          'function',
          `Missing rendered handler ${match[1]}`,
        );
      native.onLoad(
        operation === 'create_categories_scoped' ||
          operation === 'create_system_category_scoped'
          ? { scope: 'campus', campusId: managedCampus }
          : managedRoute,
      );
      native.onShow();
      await flushManagement();
      assert.equal(native.data.loaded, true);
      invoke(native, 'onOperation', tap({ operation }));
      if (operation === 'create_categories_scoped')
        invoke(native, 'onNodeText', {
          currentTarget: { dataset: { key: 'n0', field: 'name' } },
          detail: { value: '原生新分类' },
        });
      if (operation === 'create_system_category_scoped') {
        invoke(native, 'onSystemKey', tap({ key: 'synthetic_general' }));
        invoke(native, 'onText', {
          currentTarget: { dataset: { field: 'name' } },
          detail: { value: '原生系统分类' },
        });
      }
      if (operation === 'set_category_override_scoped')
        invoke(native, 'onResetOverride');
      invoke(native, 'onPrepare');
      await flushManagement();
      assert.ok(native.data.preview, `${operation}: ${native.data.error}`);
      assert.equal(s.committed.length, 0);
      assert.equal(s.pending()?.version, 10);
      invoke(native, 'onCommit');
      await flushManagement();
      assert.equal(s.committed.length, 1);
      assert.equal(s.pending(), null);
      assert.equal(native.data.preview, null);
      native.onUnload();
    }
  } finally {
    page?.onUnload();
    Object.assign(globals, old);
  }
});
test('native Back/Close/app hide clears unsaved atomic batch drafts and preserves request recovery without current source reads', async () => {
  const s = categoryScopedHarness();
  s.controller.dispose();
  s.current.now = Date.now();
  const globals = globalThis as typeof globalThis & {
    Page?: unknown;
    getApp?: unknown;
    wx?: unknown;
  };
  const old = { Page: globals.Page, getApp: globals.getApp, wx: globals.wx };
  let page: NativePage | undefined;
  Object.assign(globals, {
    Page: (value: NativePage) => {
      page = value;
      value.setData = (patch) => {
        value.data = { ...value.data, ...patch };
      };
    },
    getApp: () => ({ community: s.runtime }),
    wx: { navigateTo: ({ success }: { success: () => void }) => success() },
  });
  try {
    registerRatingCategoryScopedPage(true);
    assert.ok(page);
    const native = page as NativePage;
    native.onLoad(managedRoute);
    native.onShow();
    await flushManagement();
    invoke(
      native,
      'onOperation',
      tap({ operation: 'batch_update_subcategories_scoped' }),
    );
    invoke(native, 'onAddNode');
    invoke(native, 'onNodeText', {
      currentTarget: { dataset: { key: 'n1', field: 'name' } },
      detail: { value: 'private unsaved name' },
    });
    native.onHide();
    assert.equal(
      JSON.stringify(native.data).includes('private unsaved name'),
      false,
    );
    assert.equal(s.pending(), null);
    native.onShow();
    await flushManagement();
    invoke(
      native,
      'onOperation',
      tap({ operation: 'set_category_visibility_scoped' }),
    );
    invoke(native, 'onPrepare');
    await flushManagement();
    const bytes = JSON.stringify(s.pending());
    native.onHide();
    assert.equal(native.data.preview, null);
    s.calls.length = 0;
    native.onShow();
    await flushManagement();
    assert.deepEqual(s.calls, ['receipt']);
    assert.equal(native.data.frozen, true);
    assert.equal(JSON.stringify(s.pending()), bytes);
  } finally {
    page?.onUnload();
    Object.assign(globals, old);
  }
});

test('actual management Page rebuilds navigation across logout/relogin while rejecting stale native completions', async () => {
  const s = categoryScopedHarness();
  s.controller.dispose();
  s.current.now = Date.now();
  const globals = globalThis as typeof globalThis & {
    Page?: unknown;
    getApp?: unknown;
    wx?: unknown;
  };
  const old = { Page: globals.Page, getApp: globals.getApp, wx: globals.wx };
  const navigations: { url: string; success: () => void; fail: () => void }[] =
    [];
  let page: NativePage | undefined;
  Object.assign(globals, {
    Page: (value: NativePage) => {
      page = value;
      value.setData = (patch) => {
        value.data = { ...value.data, ...patch };
      };
    },
    getApp: () => ({ community: s.runtime }),
    wx: {
      navigateTo: (request: {
        url: string;
        success: () => void;
        fail: () => void;
      }) => navigations.push(request),
    },
  });
  try {
    registerRatingCategoryScopedPage();
    assert.ok(page);
    const native = page as NativePage;
    native.onLoad(managedRoute);
    native.onShow();
    await flushManagement();
    assert.equal(native.data.loaded, true);
    invoke(native, 'onOpenEditor', tap({ id: managedId }));
    assert.equal(navigations.length, 1);
    s.sessions.logout();
    assert.equal(native.data.hasSession, false);
    invoke(native, 'onLogin');
    assert.equal(navigations.length, 2);
    assert.equal(navigations[1]!.url, '/pages/login/login');
    const loggedOutError = native.data.error;
    navigations[0]!.fail();
    assert.equal(
      native.data.error,
      loggedOutError,
      'Old navigation failure cannot overwrite the new epoch',
    );
    s.sessions.completeLogin(
      s.sessions.beginLogin(),
      wireCredentials('relogin'),
    );
    invoke(native, 'onRefresh');
    await flushManagement();
    assert.equal(native.data.loaded, true);
    invoke(native, 'onOpenEditor', tap({ id: managedId }));
    assert.equal(navigations.length, 3);
    assert.match(navigations[2]!.url, /rating-category-editor/);
    navigations[1]!.fail();
    assert.equal(native.data.error, '');
    navigations[2]!.success();
    s.sessions.completeLogin(s.sessions.beginLogin(), {
      ...wireCredentials('other'),
      accountId: managedCampus,
    });
    invoke(native, 'onRefresh');
    await flushManagement();
    assert.equal(native.data.loaded, true);
    invoke(native, 'onReturnCatalog');
    assert.equal(navigations.length, 4);
    assert.match(
      navigations[3]!.url,
      new RegExp(`scope=campus&campusId=${managedCampus}`),
    );
    native.onHide();
    const before = navigations.length;
    s.sessions.completeLogin(
      s.sessions.beginLogin(),
      wireCredentials('hidden'),
    );
    invoke(native, 'onLogin');
    assert.equal(
      navigations.length,
      before,
      'Hidden pages cannot recreate a navigation latch',
    );
    navigations[3]!.fail();
    assert.equal(native.data.loaded, false);
  } finally {
    page?.onUnload();
    Object.assign(globals, old);
  }
});

test('actual scoped Page rejects an old awaited management entry and allows a fresh entry after same-page relogin', async () => {
  const s = scopedHarness(),
    management = categoryScopedHarness();
  s.controller.dispose();
  management.controller.dispose();
  s.gateway.contextWork = async (request) => scopedContext(request, Date.now());
  const waiting = deferred<ReturnType<typeof managementContext>>();
  management.gateway.context = async () => waiting.promise;
  const runtime = { ...s.runtime, ratingCategoryScoped: management.gateway };
  const globals = globalThis as typeof globalThis & {
    Page?: unknown;
    getApp?: unknown;
    wx?: unknown;
  };
  const old = { Page: globals.Page, getApp: globals.getApp, wx: globals.wx };
  const destinations: string[] = [];
  let page: NativePage | undefined;
  Object.assign(globals, {
    Page: (value: NativePage) => {
      page = value;
      value.setData = (patch) => {
        value.data = { ...value.data, ...patch };
      };
    },
    getApp: () => ({ community: runtime }),
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
    native.onLoad({
      mode: 'catalog',
      scope: 'campus',
      campusId: managedCampus,
    });
    native.onShow();
    await flushManagement();
    assert.equal(native.data.loaded, true);
    const oldEntry = (
      native['onCategoryManagement'] as () => Promise<void>
    ).call(native);
    await flushManagement();
    assert.equal(native.data.busy, true);
    s.sessions.completeLogin(
      s.sessions.beginLogin(),
      wireCredentials('replacement'),
    );
    waiting.resolve(
      managementContext(
        { kind: 'campus', campusId: managedCampus },
        Date.now(),
      ),
    );
    await oldEntry;
    assert.deepEqual(
      destinations,
      [],
      'An old context completion must not open in the replacement session',
    );
    invoke(native, 'onRefresh');
    await flushManagement();
    assert.equal(native.data.loaded, true);
    management.gateway.context = async (selector) =>
      managementContext(selector, Date.now());
    await (native['onCategoryManagement'] as () => Promise<void>).call(native);
    assert.equal(destinations.length, 1);
    assert.match(destinations[0]!, /rating-category-manage/);
  } finally {
    page?.onUnload();
    Object.assign(globals, old);
  }
});

test('real editor Page rejects an oversized complete ordering without journal/network and still prepares a normal equivalent order', async () => {
  const globals = globalThis as typeof globalThis & {
    Page?: unknown;
    getApp?: unknown;
    wx?: unknown;
  };
  const old = { Page: globals.Page, getApp: globals.getApp, wx: globals.wx };
  let page: NativePage | undefined;
  try {
    for (const count of [10000, 8]) {
      const s = categoryScopedHarness();
      s.controller.dispose();
      s.current.now = Date.now();
      s.current.rows = [
        managedCategory({ ordinal: '0' }),
        ...Array.from({ length: count - 1 }, (_, index) =>
          managedCategory({
            id: categoryTestId(15000 + index),
            ordinal: String(index + 1),
          }),
        ),
      ];
      let freezes = 0;
      const store = s.runtime.pendingRatings!,
        freeze = store.freeze.bind(store);
      store.freeze = (attempt) => {
        freezes++;
        return freeze(attempt);
      };
      Object.assign(globals, {
        Page: (value: NativePage) => {
          page = value;
          value.setData = (patch) => {
            value.data = { ...value.data, ...patch };
          };
        },
        getApp: () => ({ community: s.runtime }),
        wx: { navigateTo: ({ success }: { success: () => void }) => success() },
      });
      registerRatingCategoryScopedPage(true);
      assert.ok(page);
      const native = page as NativePage;
      native.onLoad(managedRoute);
      native.onShow();
      await flushManagement();
      assert.equal(native.data.loaded, true);
      invoke(
        native,
        'onOperation',
        tap({ operation: 'reorder_categories_scoped' }),
      );
      assert.equal(native.data.orderCount, count);
      const before = [...s.calls];
      invoke(native, 'onPrepare');
      await flushManagement();
      if (count === 10000) {
        assert.equal(freezes, 0);
        assert.equal(s.pending(), null);
        assert.deepEqual(s.calls, before);
        assert.equal(native.data.frozen, false);
        assert.equal(native.data.loaded, true);
        assert.equal(native.data.preview, null);
        assert.equal(native.data.orderCount, 10000);
        assert.match(String(native.data.error), /不能截断或拆分提交/);
        assert.match(String(native.data.error), /请联系管理者/);
        invoke(
          native,
          'onMove',
          tap({ key: categoryTestId(15000), direction: 'up' }),
        );
        assert.equal(
          (native.data.order as { key: string }[])[0]!.key,
          categoryTestId(15000),
          'Oversized draft remains editable',
        );
      } else {
        assert.equal(freezes, 1);
        assert.equal(s.pending()?.version, 10);
        assert.ok(native.data.preview);
        const intent = s.prepared[0]!;
        assert.equal(intent.operation, 'reorder_categories_scoped');
        if (intent.operation === 'reorder_categories_scoped')
          assert.deepEqual(
            intent.payload.orderedIds,
            s.current.rows.map((row) => row.id),
          );
        invoke(native, 'onCommit');
        await flushManagement();
        assert.equal(s.pending(), null);
        assert.equal(s.committed.length, 1);
      }
      native.onUnload();
    }
  } finally {
    page?.onUnload();
    Object.assign(globals, old);
  }
});
