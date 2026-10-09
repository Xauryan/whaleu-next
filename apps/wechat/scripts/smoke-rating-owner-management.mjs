import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parse, render } from './smoke-ratings.mjs';
const require = createRequire(import.meta.url);

/** Real native page handlers, runtime wiring, WechatTransport, ApiClient and WXML
 * with a synthetic metadata server. This does not replace API/PG or device tests. */
export async function smokeRatingOwnerManagement({
  app,
  dist,
  flush,
  extension = 'js',
}) {
  const module = (name) => require(path.join(dist, `${name}.${extension}`));
  const { ApiClient } = module('api/client');
  const { WechatTransport } = module('platform/wechat');
  const { createCommunityRuntime } = module('community/runtime');
  const original = {
    community: app.community,
    wx: globalThis.wx,
    credentials: app.identity.sessions.snapshot().credentials,
  };
  const id = (n) => `${String(n).padStart(8, '0')}-eeee-4eee-8eee-eeeeeeeeeeee`;
  const targetId = id(1),
    revision = id(2),
    after = id(3),
    otherTarget = id(4),
    requestId = id(5);
  const prefix = '/v1/ratings/management/owner-deletion';
  const store = new Map(),
    server = new Map(),
    requests = [],
    navigations = [],
    pages = [];
  const state = {
    loseCommand: false,
    hideReceipt: false,
    loseCancel: false,
    denyContext: false,
    hold: null,
    writes: 0,
  };
  const success = (key) => ({
    requestId: key,
    operation: 'delete_target',
    outcome: 'applied',
    targetId,
    revision: after,
    occurredAt: '2026-10-09T12:00:00.123456Z',
  });
  const cancelled = (key) => ({
    requestId: key,
    operation: 'delete_target',
    outcome: 'rejected',
    code: 'RATING_TARGET_DELETION_CANCELLED',
  });
  const error = (options, code, statusCode) =>
    options.success({
      statusCode,
      data: { error: { code, message: 'Synthetic' } },
    });
  const clock = { now: () => 1000, schedule: () => () => undefined };
  const native = {
    getStorageSync: (key) => store.get(key),
    setStorageSync: (key, value) => store.set(key, structuredClone(value)),
    removeStorageSync: (key) => store.delete(key),
    navigateTo: (options) => {
      navigations.push(options.url);
      options.success();
    },
    request: (options) => {
      requests.push({
        path: new URL(options.url).pathname,
        method: options.method,
        body: options.data,
        headers: options.header,
      });
      void Promise.resolve().then(async () => {
        const route = new URL(options.url).pathname;
        assert.ok(options.header.Authorization);
        if (route === `${prefix}/targets/${targetId}/context`) {
          if (state.denyContext) return error(options, 'RATING_NOT_FOUND', 404);
          return options.success({
            statusCode: 200,
            data: {
              targetId,
              revision,
              deletion: { kind: 'not_owner_deleted' },
            },
          });
        }
        if (route.startsWith(`${prefix}/requests/`)) {
          const receipt = server.get(route.slice(`${prefix}/requests/`.length));
          if (!receipt || state.hideReceipt)
            return error(options, 'REQUEST_NOT_FOUND', 404);
          return options.success({ statusCode: 200, data: receipt });
        }
        if (route === `${prefix}/targets/${targetId}`) {
          assert.deepEqual(options.data, {
            clientRequestId: requestId,
            expectedTargetRevision: revision,
          });
          if (!server.has(requestId)) {
            server.set(requestId, success(requestId));
            state.writes++;
          }
          if (state.hold) await state.hold;
          if (state.loseCommand)
            return options.fail({ errMsg: 'network failure' });
          return options.success({
            statusCode: 200,
            data: server.get(requestId),
          });
        }
        if (route === `${prefix}/cancel`) {
          assert.deepEqual(options.data, {
            clientRequestId: requestId,
            targetId,
            expectedTargetRevision: revision,
          });
          if (!server.has(requestId))
            server.set(requestId, cancelled(requestId));
          if (state.loseCancel)
            return options.fail({ errMsg: 'cancel network failure' });
          return options.success({
            statusCode: 200,
            data: server.get(requestId),
          });
        }
        throw new Error(`Unexpected public or identity read: ${route}`);
      });
      return { abort() {} };
    },
  };
  globalThis.wx = native;
  const sessions = app.identity.sessions;
  const api = new ApiClient(
    'https://ratings.example',
    new WechatTransport(native, clock),
    sessions,
    { refresh: async () => sessions.snapshot() },
  );
  app.community = {
    ...createCommunityRuntime(
      { sessions, api },
      native,
      'https://ratings.example',
      clock,
    ),
    newRequestId: async () => requestId,
  };
  const source = readFileSync(
    path.join(dist, 'pages/target-owner-delete/target-owner-delete.wxml'),
    'utf8',
  );
  const common = parse(
    readFileSync(path.join(dist, 'ratings/common.wxml'), 'utf8'),
  );
  const templates = Object.fromEntries(
    common.children
      .filter((node) => node.tag === 'template')
      .map((node) => [node.attrs.name, node]),
  );
  const tree = parse(source);
  const visible = (page) =>
    JSON.stringify(render(tree.children, page.data, templates));
  const mount = (query = { targetId }) => {
    const oldPage = globalThis.Page;
    let page;
    globalThis.Page = (definition) => {
      page = definition;
    };
    const file = path.join(
      dist,
      `pages/target-owner-delete/target-owner-delete.${extension}`,
    );
    try {
      delete require.cache[require.resolve(file)];
      require(file);
    } finally {
      globalThis.Page = oldPage;
    }
    page.setData = (patch) => {
      page.data = { ...page.data, ...patch };
    };
    for (const [
      ,
      handler,
    ] of `${source}${readFileSync(path.join(dist, 'ratings/common.wxml'), 'utf8').split('<template name="rating-like">')[0]}`.matchAll(
      /bind(?:tap|input)="([^"]+)"/g,
    ))
      assert.equal(
        typeof page[handler],
        'function',
        `owner deletion handler ${handler}`,
      );
    pages.push(page);
    page.onLoad(query);
    page.onShow();
    return page;
  };
  const journal = () =>
    app.community.pendingRatings.load(
      sessions.snapshot().credentials.accountId,
    );
  const seed = () =>
    app.community.pendingRatings.freeze({
      version: 6,
      accountId: sessions.snapshot().credentials.accountId,
      intent: {
        operation: 'delete_target',
        payload: {
          clientRequestId: requestId,
          targetId,
          expectedTargetRevision: revision,
        },
      },
    });
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(dist, 'app.json'), 'utf8'),
    );
    assert.ok(
      manifest.pages.includes('pages/target-owner-delete/target-owner-delete'),
    );
    assert.match(
      readFileSync(
        path.join(dist, 'pages/rating-detail/rating-detail.wxml'),
        'utf8',
      ),
      /bindtap="onOwnerDeletion"/,
    );
    assert.match(
      readFileSync(
        path.join(dist, 'pages/rating-recovery/rating-recovery.wxml'),
        'utf8',
      ),
      /target-owner-delete/,
    );
    const page = mount();
    await flush();
    assert.equal(page.data.ready, true);
    assert.equal(requests.length, 1);
    assert.equal(journal(), null);
    page.onConfirmDelete();
    await flush();
    assert.equal(requests.length, 1);
    page.onDelete();
    assert.match(visible(page), /评分和互动历史会保留/);
    assert.match(visible(page), /删除后无法恢复/);
    page.onDismissDelete();
    assert.equal(page.data.deleteConfirmation, false);
    state.loseCommand = true;
    state.hideReceipt = true;
    page.onDelete();
    page.onConfirmDelete();
    page.onConfirmDelete();
    await flush();
    assert.equal(state.writes, 1);
    const originalJournal = journal();
    assert.equal(originalJournal.version, 6);
    assert.equal(page.data.frozen, true);
    page.onCancel();
    page.onHide();
    const recovered = mount({ targetId: otherTarget });
    await flush();
    assert.equal(recovered.data.frozen, true);
    assert.deepEqual(journal(), originalJournal);
    assert.equal(requests.filter((r) => r.path.endsWith('/context')).length, 1);
    recovered.onRetry();
    await flush();
    assert.equal(state.writes, 1);
    assert.deepEqual(journal(), originalJournal);
    state.loseCommand = false;
    state.hideReceipt = false;
    recovered.onRecover();
    await flush();
    assert.equal(journal(), null);
    assert.match(recovered.data.receiptStatus, /历史操作/);
    assert.equal(navigations.at(-1), '/pages/rating-catalog/rating-catalog');
    assert.doesNotMatch(
      visible(recovered),
      /Synthetic target|creatorId|description/,
    );
    recovered.onUnload();

    server.clear();
    seed();
    const cancellation = mount({ invalid: 'route' });
    await flush();
    cancellation.onConfirmCancelDeletion();
    await flush();
    assert.equal(
      requests.some((r) => r.path.endsWith('/cancel')),
      false,
    );
    cancellation.onCancelDeletion();
    assert.match(visible(cancellation), /不会恢复对象/);
    state.loseCancel = true;
    cancellation.onConfirmCancelDeletion();
    await flush();
    assert.ok(journal());
    cancellation.onHide();
    state.loseCancel = false;
    const cancelledPage = mount(null);
    await flush();
    assert.equal(journal(), null);
    assert.match(cancelledPage.data.receiptStatus, /已撤销/);
    assert.equal(cancelledPage.data.returnToCatalog, false);
    cancelledPage.onUnload();

    state.denyContext = true;
    const denied = mount();
    await flush();
    assert.equal(denied.data.ready, false);
    assert.doesNotMatch(
      visible(denied),
      /确认删除<|creatorId|Synthetic target/,
    );
    denied.onUnload();
    state.denyContext = false;

    server.clear();
    let release;
    state.hold = new Promise((resolve) => {
      release = resolve;
    });
    const late = mount();
    await flush();
    late.onDelete();
    late.onConfirmDelete();
    await flush();
    const saved = journal();
    late.onHide();
    release();
    await flush();
    assert.deepEqual(journal(), saved);
    state.hold = null;
    const restart = mount();
    await flush();
    assert.equal(journal(), null);
    assert.equal(state.writes, 2);
    restart.onUnload();
  } finally {
    for (const page of pages) page.onUnload();
    app.community = original.community;
    globalThis.wx = original.wx;
  }
}
