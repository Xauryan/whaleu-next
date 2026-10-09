import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parse, render } from './smoke-ratings.mjs';
const require = createRequire(import.meta.url);

/** Actual page handlers + runtime + WechatTransport + ApiClient + rendered WXML.
 * The HTTPS transport has a synthetic server; API/PG and device QA are separate. */
export async function smokeRatingOwnerEditing({
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
  const id = (n) => `${String(n).padStart(8, '0')}-ed17-4ed1-8ed1-ed17ed17ed17`;
  const targetId = id(1),
    revision = id(2),
    definitionRevision = id(3),
    after = id(4),
    definitionAfter = id(5),
    requestId = id(6),
    otherTarget = id(7);
  const context = {
    targetId,
    revision,
    definitionRevision,
    contentVersion: 1,
    regionId: null,
    categoryId: id(8),
    categoryRevision: id(9),
    catalogRevision: id(10),
    name: 'Authorized current name',
    description: 'Authorized current description',
  };
  const payload = {
    clientRequestId: requestId,
    targetId,
    regionId: null,
    expectedTargetRevision: revision,
    expectedDefinitionRevision: definitionRevision,
    expectedContentVersion: 1,
    categoryId: context.categoryId,
    expectedCategoryRevision: context.categoryRevision,
    expectedCatalogRevision: context.catalogRevision,
    name: 'New frozen name',
    description: 'New frozen description',
    assetIds: [],
  };
  const prepared = {
    requestId,
    targetId,
    revision: after,
    definitionRevision: definitionAfter,
    contentVersion: 2,
    contextRevision: 'p'.repeat(43),
  };
  const applied = {
    requestId,
    operation: 'edit_target',
    outcome: 'applied',
    targetId,
    revision: after,
    definitionRevision: definitionAfter,
    contentVersion: 2,
    occurredAt: '2026-10-09T12:00:00.123456Z',
  };
  const cancelled = {
    requestId,
    operation: 'edit_target',
    outcome: 'rejected',
    code: 'RATING_EDIT_CANCELLED',
  };
  const prefix = '/v1/ratings/management/owner-edit',
    origin = 'https://ratings.example';
  const store = new Map(),
    server = new Map(),
    requests = [],
    pages = [],
    navigations = [];
  const state = {
    losePrepare: false,
    loseCommit: false,
    hideReceipt: false,
    loseCancel: false,
    denyContext: false,
    holdPrepare: null,
    holdCommit: null,
    noop: false,
    writes: 0,
  };
  const sessions = app.identity.sessions;
  const journal = () =>
    app.community.pendingRatings.load(
      sessions.snapshot().credentials.accountId,
    );
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
      const url = new URL(options.url);
      assert.equal(url.origin, origin);
      assert.equal(url.search, '');
      requests.push({
        path: url.pathname,
        method: options.method,
        body: structuredClone(options.data),
      });
      void Promise.resolve().then(async () => {
        const route = url.pathname;
        assert.ok(options.header.Authorization);
        if (route === `${prefix}/targets/${targetId}/context`) {
          assert.equal(options.method, 'GET');
          assert.equal(options.data, undefined);
          if (state.denyContext) return error(options, 'RATING_NOT_FOUND', 404);
          return options.success({ statusCode: 200, data: context });
        }
        if (route.startsWith(`${prefix}/requests/`)) {
          assert.equal(options.method, 'GET');
          assert.equal(options.data, undefined);
          const receipt = server.get(route.slice(`${prefix}/requests/`.length));
          if (!receipt || state.hideReceipt)
            return error(options, 'REQUEST_NOT_FOUND', 404);
          return options.success({ statusCode: 200, data: receipt });
        }
        assert.equal(options.method, 'POST');
        assert.deepEqual(journal(), {
          version: 7,
          accountId: sessions.snapshot().credentials.accountId,
          intent: { operation: 'edit_target', payload },
        });
        if (route === `${prefix}/prepare`) {
          assert.deepEqual(options.data, payload);
          if (state.holdPrepare) await state.holdPrepare;
          if (state.losePrepare)
            return options.fail({ errMsg: 'lost prepare' });
          return options.success({
            statusCode: 200,
            data:
              server.get(requestId)?.outcome === 'rejected'
                ? server.get(requestId)
                : prepared,
          });
        }
        if (route === `${prefix}/commit`) {
          assert.deepEqual(options.data, {
            ...payload,
            expectedContextRevision: prepared.contextRevision,
          });
          if (!server.has(requestId)) {
            server.set(
              requestId,
              state.noop
                ? {
                    ...applied,
                    outcome: 'noop',
                    revision,
                    definitionRevision,
                    contentVersion: 1,
                  }
                : applied,
            );
            if (!state.noop) state.writes++;
          }
          if (state.holdCommit) await state.holdCommit;
          if (state.loseCommit) return options.fail({ errMsg: 'lost commit' });
          return options.success({
            statusCode: 200,
            data: server.get(requestId),
          });
        }
        if (route === `${prefix}/cancel`) {
          assert.deepEqual(options.data, payload);
          if (!server.has(requestId)) server.set(requestId, cancelled);
          if (state.loseCancel)
            return options.fail({ errMsg: 'lost cancellation' });
          return options.success({
            statusCode: 200,
            data: server.get(requestId),
          });
        }
        throw new Error(
          `Unexpected public, browsing-scope or identity read: ${route}`,
        );
      });
      return { abort() {} };
    },
  };
  globalThis.wx = native;
  const api = new ApiClient(
    origin,
    new WechatTransport(native, clock),
    sessions,
    { refresh: async () => sessions.snapshot() },
  );
  app.community = {
    ...createCommunityRuntime({ sessions, api }, native, origin, clock),
    newRequestId: async () => requestId,
  };
  const source = readFileSync(
    path.join(dist, 'pages/target-owner-edit/target-owner-edit.wxml'),
    'utf8',
  );
  const commonSource = readFileSync(
    path.join(dist, 'ratings/common.wxml'),
    'utf8',
  );
  const templates = Object.fromEntries(
    parse(commonSource)
      .children.filter((node) => node.tag === 'template')
      .map((node) => [node.attrs.name, node]),
  );
  const tree = parse(source),
    visible = (page) =>
      JSON.stringify(render(tree.children, page.data, templates));
  const mount = (query = { targetId }) => {
    const oldPage = globalThis.Page;
    let page;
    globalThis.Page = (definition) => {
      page = definition;
    };
    const file = path.join(
      dist,
      `pages/target-owner-edit/target-owner-edit.${extension}`,
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
    ] of `${source}${commonSource.split('<template name="rating-like">')[0]}`.matchAll(
      /bind(?:tap|input)="([^"]+)"/g,
    ))
      assert.equal(
        typeof page[handler],
        'function',
        `owner edit handler ${handler}`,
      );
    pages.push(page);
    page.onLoad(query);
    page.onShow();
    return page;
  };
  const fill = (page) => {
    page.onName({ detail: { value: `  ${payload.name}  ` } });
    page.onDescription({ detail: { value: `  ${payload.description}  ` } });
  };
  const seed = () =>
    app.community.pendingRatings.freeze({
      version: 7,
      accountId: sessions.snapshot().credentials.accountId,
      intent: { operation: 'edit_target', payload },
    });
  const assertNoText = (page) => {
    assert.equal(page.data.name, '');
    assert.equal(page.data.description, '');
    assert.doesNotMatch(
      visible(page),
      /Authorized current|New frozen|creatorId/,
    );
  };
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(dist, 'app.json'), 'utf8'),
    );
    assert.ok(
      manifest.pages.includes('pages/target-owner-edit/target-owner-edit'),
    );
    assert.match(
      readFileSync(
        path.join(dist, 'pages/rating-detail/rating-detail.wxml'),
        'utf8',
      ),
      /bindtap="onOwnerEditing"/,
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
      /target-owner-edit/,
    );
    const page = mount();
    await flush();
    assert.equal(page.data.ready, true);
    assert.equal(page.data.name, context.name);
    assert.equal(requests.length, 1);
    assert.equal(journal(), null);
    page.onConfirmEdit();
    await flush();
    assert.equal(requests.length, 1);
    fill(page);
    page.onEdit();
    assert.match(visible(page), /已有评分和互动历史会保留/);
    page.onDismissEdit();
    assert.equal(page.data.editConfirmation, false);
    state.losePrepare = true;
    page.onEdit();
    page.onConfirmEdit();
    page.onConfirmEdit();
    await flush();
    assert.equal(requests.filter((r) => r.path.endsWith('/prepare')).length, 1);
    assert.equal(state.writes, 0);
    assert.equal(page.data.frozen, true);
    assertNoText(page);
    const originalJournal = journal();
    assert.equal(originalJournal.version, 7);
    page.onCancel();
    page.onHide();
    const reopened = mount({ targetId: otherTarget });
    await flush();
    assert.deepEqual(journal(), originalJournal);
    assertNoText(reopened);
    assert.equal(requests.filter((r) => r.path.endsWith('/context')).length, 1);
    state.losePrepare = false;
    state.loseCommit = true;
    state.hideReceipt = true;
    reopened.onRetry();
    await flush();
    assert.equal(state.writes, 1);
    assert.deepEqual(journal(), originalJournal);
    assertNoText(reopened);
    reopened.onHide();
    const recovery = mount(null);
    await flush();
    assert.deepEqual(journal(), originalJournal);
    recovery.onRetry();
    await flush();
    assert.equal(state.writes, 1);
    const prepares = requests.filter((r) => r.path.endsWith('/prepare'));
    for (const request of prepares) assert.deepEqual(request.body, payload);
    const commits = requests.filter((r) => r.path.endsWith('/commit'));
    assert.equal(commits.length, 2);
    assert.deepEqual(commits[0].body, commits[1].body);
    state.loseCommit = false;
    state.hideReceipt = false;
    recovery.onRecover();
    await flush();
    assert.equal(journal(), null);
    assert.match(recovery.data.receiptStatus, /历史操作/);
    assertNoText(recovery);
    recovery.onReturnCatalog();
    assert.equal(navigations.at(-1), '/pages/rating-catalog/rating-catalog');
    recovery.onUnload();

    server.clear();
    seed();
    const cancellation = mount({ invalid: 'route' });
    await flush();
    cancellation.onConfirmCancelEditing();
    await flush();
    assert.equal(
      requests.some((r) => r.path.endsWith('/cancel')),
      false,
    );
    cancellation.onCancelEditing();
    assert.match(visible(cancellation), /不会回退已发布的修改/);
    cancellation.onDismissCancelEditing();
    cancellation.onConfirmCancelEditing();
    await flush();
    assert.equal(
      requests.some((r) => r.path.endsWith('/cancel')),
      false,
    );
    state.loseCancel = true;
    cancellation.onCancelEditing();
    cancellation.onConfirmCancelEditing();
    await flush();
    assert.ok(journal());
    cancellation.onHide();
    state.loseCancel = false;
    const cancelledPage = mount(null);
    await flush();
    assert.equal(journal(), null);
    assert.match(cancelledPage.data.receiptStatus, /已撤销/);
    assertNoText(cancelledPage);
    cancelledPage.onUnload();
    // A durable prepare rejection can close history when GET is temporarily unavailable.
    seed();
    state.hideReceipt = true;
    const closedPreparation = mount(null);
    await flush();
    const commitsBeforeClosed = requests.filter((r) =>
      r.path.endsWith('/commit'),
    ).length;
    closedPreparation.onRetry();
    await flush();
    assert.equal(journal(), null);
    assert.match(closedPreparation.data.receiptStatus, /已撤销/);
    assert.equal(
      requests.filter((r) => r.path.endsWith('/commit')).length,
      commitsBeforeClosed,
    );
    assertNoText(closedPreparation);
    closedPreparation.onUnload();
    state.hideReceipt = false;

    state.denyContext = true;
    const denied = mount();
    await flush();
    assert.equal(denied.data.ready, false);
    assertNoText(denied);
    denied.onConfirmEdit();
    await flush();
    assert.equal(journal(), null);
    denied.onUnload();
    state.denyContext = false;

    server.clear();
    let release;
    state.holdCommit = new Promise((resolve) => {
      release = resolve;
    });
    const late = mount();
    await flush();
    fill(late);
    late.onEdit();
    late.onConfirmEdit();
    await flush();
    const saved = journal();
    late.onHide();
    assertNoText(late);
    release();
    await flush();
    assert.deepEqual(journal(), saved);
    state.holdCommit = null;
    const restart = mount();
    await flush();
    assert.equal(journal(), null);
    assert.equal(state.writes, 2);
    restart.onUnload();

    server.clear();
    state.noop = true;
    const changedName = payload.name,
      changedDescription = payload.description;
    payload.name = context.name;
    payload.description = context.description;
    const noop = mount();
    await flush();
    fill(noop);
    noop.onEdit();
    noop.onConfirmEdit();
    await flush();
    assert.equal(journal(), null);
    assert.match(noop.data.receiptStatus, /历史操作/);
    assertNoText(noop);
    assert.equal(state.writes, 2);
    assert.equal(server.get(requestId).outcome, 'noop');
    assert.equal(server.get(requestId).revision, revision);
    assert.equal(server.get(requestId).definitionRevision, definitionRevision);
    assert.equal(server.get(requestId).contentVersion, 1);
    noop.onUnload();
    state.noop = false;
    payload.name = changedName;
    payload.description = changedDescription;

    server.clear();
    let releasePrepare;
    state.holdPrepare = new Promise((resolve) => {
      releasePrepare = resolve;
    });
    const sessionPage = mount();
    await flush();
    fill(sessionPage);
    sessionPage.onEdit();
    sessionPage.onConfirmEdit();
    await flush();
    const owned = journal(),
      commitsBefore = requests.filter((r) => r.path.endsWith('/commit')).length;
    sessions.completeLogin(sessions.beginLogin(), {
      ...original.credentials,
      sessionId: id(99),
    });
    releasePrepare();
    await flush();
    state.holdPrepare = null;
    assert.equal(
      requests.filter((r) => r.path.endsWith('/commit')).length,
      commitsBefore,
    );
    assert.deepEqual(journal(), owned);
    assertNoText(sessionPage);
    sessionPage.onUnload();
    // A new session first looks up history; only an explicit retry prepares again.
    const newSession = mount({ targetId: otherTarget });
    await flush();
    assertNoText(newSession);
    assert.equal(journal().version, 7);
    newSession.onCancelEditing();
    newSession.onConfirmCancelEditing();
    await flush();
    assert.equal(journal(), null);
    newSession.onUnload();
  } finally {
    for (const page of pages) page.onUnload();
    sessions.completeLogin(sessions.beginLogin(), original.credentials);
    app.community = original.community;
    globalThis.wx = original.wx;
  }
}
