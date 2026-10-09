import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parse, render } from './smoke-ratings.mjs';
const require = createRequire(import.meta.url);

/** Native handlers, actual runtime + authenticated HTTPS transport and rendered WXML.
 * This exercises the emitted build as well as TS; it is not device or API/PG QA. */
export async function smokeRatingCategoryManagement({
  app,
  dist,
  flush,
  extension = 'js',
}) {
  const module = (name) => require(path.join(dist, `${name}.${extension}`));
  const { ApiClient } = module('api/client');
  const { WechatTransport } = module('platform/wechat');
  const { createCommunityRuntime } = module('community/runtime');
  const sessions = app.identity.sessions;
  const original = {
    community: app.community,
    wx: globalThis.wx,
    credentials: sessions.snapshot().credentials,
  };
  const id = (n) => `${String(n).padStart(8, '0')}-ca73-4ca7-8ca7-ca73ca73ca73`;
  const regionId = id(1),
    campusIds = [id(2), id(3)],
    requestId = id(4),
    parentId = id(5);
  const context = {
    regionId,
    catalogRevision: id(6),
    scopeRevision: 's'.repeat(43),
    campusIds,
    parents: [
      {
        id: parentId,
        revision: id(7),
        name: 'Native reviewed parent',
        level: 1,
      },
    ],
    maximumNodes: 32,
    maximumDepth: 3,
  };
  const nodes = [
    {
      key: 'n0',
      parentKey: null,
      name: 'New root category',
      description: 'Root exact content',
    },
    {
      key: 'n1',
      parentKey: 'n0',
      name: 'New child category',
      description: 'Child exact content',
    },
    { key: 'n2', parentKey: 'n1', name: 'New leaf category', description: '' },
  ];
  const payload = {
    clientRequestId: requestId,
    regionId,
    expectedCatalogRevision: context.catalogRevision,
    expectedScopeRevision: context.scopeRevision,
    parentId: null,
    expectedParentRevision: null,
    nodes,
    assetIds: [],
  };
  const categories = nodes.map((node, index) => ({
    key: node.key,
    id: id(20 + index),
    revision: id(30 + index),
    parentId: index === 0 ? null : id(19 + index),
    level: index + 1,
  }));
  const prepared = { requestId, contextRevision: 'p'.repeat(43), categories };
  const applied = {
    requestId,
    operation: 'create_categories',
    outcome: 'applied',
    releaseId: id(40),
    categories,
    catalogs: [{ regionId, catalogRevision: id(41) }],
    occurredAt: '2026-10-09T12:00:00.123456Z',
  };
  const rejected = {
    requestId,
    operation: 'create_categories',
    outcome: 'rejected',
    code: 'RATING_CATEGORY_CANCELLED',
  };
  const prefix = '/v1/ratings/category-management',
    origin = 'https://ratings.example';
  const store = new Map(),
    server = new Map(),
    requests = [],
    pages = [],
    navigations = [],
    changes = [];
  const state = {
    denyContext: false,
    losePrepare: false,
    loseCommit: false,
    loseCancel: false,
    hideReceipt: false,
    reviewUnknown: false,
    holdContext: null,
    holdPrepare: null,
    holdCommit: null,
    writes: 0,
    holdNavigation: false,
    pendingNavigation: null,
  };
  const journal = () =>
    app.community.pendingRatings.load(
      sessions.snapshot().credentials.accountId,
    );
  const reject = (options, code, statusCode = 503) =>
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
      if (state.holdNavigation) state.pendingNavigation = options;
      else options.success();
    },
    request: (options) => {
      const url = new URL(options.url);
      assert.equal(url.origin, origin);
      assert.ok(options.header.Authorization);
      requests.push({
        path: url.pathname,
        search: url.search,
        method: options.method,
        body: structuredClone(options.data),
      });
      void Promise.resolve().then(async () => {
        const route = url.pathname;
        if (route === '/v1/ratings/categories') {
          assert.equal(options.method, 'GET');
          return options.success({
            statusCode: 200,
            data: {
              context: {
                regionId: url.searchParams.get('regionId'),
                parentId: null,
                catalogRevision: context.catalogRevision,
              },
              items: [],
              continuation: 'end',
              nextCursor: null,
            },
          });
        }
        if (route === `${prefix}/context`) {
          assert.equal(options.method, 'GET');
          assert.equal(options.data, undefined);
          if (state.holdContext) await state.holdContext;
          if (state.denyContext)
            return reject(options, 'AUTHORIZATION_UNAVAILABLE');
          return options.success({
            statusCode: 200,
            data: { ...context, regionId: url.searchParams.get('regionId') },
          });
        }
        if (route.startsWith(`${prefix}/requests/`)) {
          assert.equal(options.method, 'GET');
          assert.equal(options.data, undefined);
          assert.equal(url.search, '');
          const receipt = server.get(route.slice(`${prefix}/requests/`.length));
          if (!receipt || state.hideReceipt)
            return reject(options, 'REQUEST_NOT_FOUND', 404);
          return options.success({ statusCode: 200, data: receipt });
        }
        assert.equal(options.method, 'POST');
        assert.equal(url.search, '');
        assert.deepEqual(journal(), {
          version: 8,
          accountId: sessions.snapshot().credentials.accountId,
          intent: { operation: 'create_categories', payload },
        });
        if (route === `${prefix}/prepare`) {
          assert.deepEqual(options.data, payload);
          if (state.holdPrepare) await state.holdPrepare;
          if (state.losePrepare)
            return options.fail({ errMsg: 'lost prepare' });
          if (state.reviewUnknown)
            return reject(options, 'CONTENT_REVIEW_UNAVAILABLE');
          return options.success({
            statusCode: 200,
            data:
              server.get(requestId)?.outcome === 'rejected'
                ? server.get(requestId)
                : prepared,
          });
        }
        if (route === `${prefix}/categories`) {
          assert.deepEqual(options.data, {
            ...payload,
            expectedContextRevision: prepared.contextRevision,
          });
          if (!server.has(requestId)) {
            server.set(requestId, applied);
            state.writes++;
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
          if (!server.has(requestId)) server.set(requestId, rejected);
          if (state.loseCancel) return options.fail({ errMsg: 'lost cancel' });
          return options.success({
            statusCode: 200,
            data: server.get(requestId),
          });
        }
        throw new Error(`Unexpected category request ${route}`);
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
  app.community.ratingCatalogChanges.subscribe((change) =>
    changes.push(change),
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
  const pageName = 'rating-category-create';
  const source = readFileSync(
      path.join(dist, `pages/${pageName}/${pageName}.wxml`),
      'utf8',
    ),
    tree = parse(source);
  const visible = (page) =>
    JSON.stringify(render(tree.children, page.data, templates));
  function mount(name = pageName, query = { regionId }) {
    let page;
    const oldPage = globalThis.Page;
    globalThis.Page = (definition) => {
      page = definition;
    };
    const file = path.join(dist, `pages/${name}/${name}.${extension}`);
    try {
      delete require.cache[require.resolve(file)];
      require(file);
    } finally {
      globalThis.Page = oldPage;
    }
    page.setData = (patch) => {
      page.data = { ...page.data, ...patch };
    };
    const wxml = readFileSync(
      path.join(dist, `pages/${name}/${name}.wxml`),
      'utf8',
    );
    for (const [
      ,
      handler,
    ] of `${wxml}${commonSource.split('<template name="rating-like">')[0]}`.matchAll(
      /bind(?:tap|input)="([^"]+)"/g,
    ))
      assert.equal(typeof page[handler], 'function', `${name}: ${handler}`);
    if (name === pageName) {
      assert.equal(page.data.ready, false);
      assert.deepEqual(page.data.nodes, []);
      assert.deepEqual(page.data.campusIds, []);
      assert.equal(page.data.creationConfirmation, false);
      assert.equal(page.data.canCancelCategoryCreation, false);
      assert.equal('loaded' in page.data, false);
    }
    pages.push(page);
    page.onLoad(query);
    page.onShow();
    return page;
  }
  const event = (key, value = '') => ({
    currentTarget: { dataset: { key } },
    detail: { value },
  });
  function fill(page) {
    page.onAddChild(event('n0'));
    page.onAddChild(event('n1'));
    for (const node of nodes) {
      page.onName(event(node.key, ` ${node.name} `));
      page.onDescription(event(node.key, ` ${node.description} `));
    }
  }
  const seed = () =>
    app.community.pendingRatings.freeze({
      version: 8,
      accountId: sessions.snapshot().credentials.accountId,
      intent: { operation: 'create_categories', payload },
    });
  const noDraft = (page) => {
    assert.deepEqual(page.data.nodes, []);
    assert.deepEqual(page.data.campusIds, []);
    assert.deepEqual(page.data.parents, []);
    assert.doesNotMatch(
      visible(page),
      /New root category|Root exact content|New child category|Native reviewed parent/,
    );
  };
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(dist, 'app.json'), 'utf8'),
    );
    assert.ok(manifest.pages.includes(`pages/${pageName}/${pageName}`));
    assert.match(
      readFileSync(
        path.join(dist, 'pages/rating-catalog/rating-catalog.wxml'),
        'utf8',
      ),
      /bindtap="onCreateCategories"/,
    );
    assert.match(
      readFileSync(
        path.join(dist, 'pages/rating-recovery/rating-recovery.wxml'),
        'utf8',
      ),
      /rating-category-create/,
    );
    const catalog = mount('rating-catalog');
    await flush();
    assert.equal(catalog.data.loaded, true);
    catalog.onCreateCategories();
    assert.equal(
      navigations.at(-1),
      `/pages/${pageName}/${pageName}?regionId=${regionId}`,
    );
    let releaseContext;
    state.holdContext = new Promise((resolve) => {
      releaseContext = resolve;
    });
    const page = mount();
    await flush();
    assert.equal(page.data.ready, false);
    assert.deepEqual(page.data.nodes, []);
    page.onCreate();
    page.onConfirmCreate();
    assert.equal(journal(), null);
    releaseContext();
    await flush();
    state.holdContext = null;
    assert.equal(page.data.ready, true);
    assert.deepEqual(page.data.campusIds, campusIds);
    for (const campusId of campusIds)
      assert.ok(visible(page).includes(campusId));
    assert.ok(visible(page).includes(regionId));
    fill(page);
    page.onCreate();
    assert.equal(page.data.creationConfirmation, true);
    assert.match(visible(page), /确认提交以上范围与全部 3 个分类/);
    assert.match(visible(page), /第 3 级/);
    page.onName(event('n0', 'not confirmed'));
    assert.equal(page.data.nodes[0].name, nodes[0].name);
    page.onDismissCreate();
    page.onConfirmCreate();
    await flush();
    assert.equal(journal(), null);
    state.losePrepare = true;
    page.onCreate();
    page.onConfirmCreate();
    page.onConfirmCreate();
    await flush();
    assert.equal(requests.filter((r) => r.path.endsWith('/prepare')).length, 1);
    assert.equal(state.writes, 0);
    assert.equal(page.data.frozen, true);
    noDraft(page);
    const originalJournal = structuredClone(journal());
    assert.equal(originalJournal.version, 8);
    page.onCancel();
    page.onHide();
    const reopened = mount(pageName, { regionId: id(99) });
    await flush();
    assert.deepEqual(journal(), originalJournal);
    noDraft(reopened);
    assert.equal(
      requests.filter((r) => r.path === `${prefix}/context`).length,
      1,
    );
    state.losePrepare = false;
    state.reviewUnknown = true;
    reopened.onRetry();
    await flush();
    assert.deepEqual(journal(), originalJournal);
    assert.equal(state.writes, 0);
    assert.equal(reopened.data.receiptStatus, '');
    state.reviewUnknown = false;
    state.loseCommit = true;
    state.hideReceipt = true;
    reopened.onRetry();
    await flush();
    assert.equal(state.writes, 1);
    assert.deepEqual(journal(), originalJournal);
    assert.equal(changes.length, 0);
    reopened.onHide();
    const recovery = mount('rating-recovery', {});
    await flush();
    assert.equal(recovery.data.frozen, true);
    assert.equal(recovery.data.recoveryOperation, '管理员创建评分分类');
    recovery.onRetry();
    await flush();
    assert.equal(state.writes, 1);
    for (const request of requests.filter((r) => r.path.endsWith('/prepare')))
      assert.deepEqual(request.body, payload);
    const commits = requests.filter((r) => r.path === `${prefix}/categories`);
    assert.equal(commits.length, 2);
    assert.deepEqual(commits[0].body, commits[1].body);
    state.loseCommit = false;
    state.hideReceipt = false;
    recovery.onRecover();
    await flush();
    assert.equal(journal(), null);
    assert.equal(changes.length, 1);
    assert.deepEqual(changes[0], {
      releaseId: applied.releaseId,
      catalogs: applied.catalogs,
    });
    assert.equal(catalog.data.loaded, false);
    assert.deepEqual(catalog.data.categories, []);
    assert.equal(recovery.data.confirmedTargetId, '');
    assert.match(recovery.data.receiptStatus, /当前状态需重新读取/);
    recovery.onUnload();
    catalog.onUnload();

    server.clear();
    seed();
    state.loseCancel = true;
    const cancellation = mount(pageName, null);
    await flush();
    noDraft(cancellation);
    cancellation.onConfirmCancelCategoryCreation();
    await flush();
    assert.equal(
      requests.some((r) => r.path.endsWith('/cancel')),
      false,
    );
    cancellation.onCancelCategoryCreation();
    assert.match(visible(cancellation), /不会回退已经发布/);
    cancellation.onDismissCancelCategoryCreation();
    cancellation.onConfirmCancelCategoryCreation();
    await flush();
    assert.equal(
      requests.some((r) => r.path.endsWith('/cancel')),
      false,
    );
    cancellation.onCancelCategoryCreation();
    cancellation.onConfirmCancelCategoryCreation();
    await flush();
    assert.deepEqual(journal(), originalJournal);
    cancellation.onHide();
    state.loseCancel = false;
    const cancelled = mount(pageName, { nonsense: 'invalid' });
    await flush();
    assert.equal(journal(), null);
    assert.match(cancelled.data.receiptStatus, /已撤销/);
    noDraft(cancelled);
    cancelled.onUnload();
    seed();
    state.hideReceipt = true;
    const closed = mount(pageName, null);
    await flush();
    const beforeCommit = requests.filter(
      (r) => r.path === `${prefix}/categories`,
    ).length;
    closed.onRetry();
    await flush();
    assert.equal(journal(), null);
    assert.equal(
      requests.filter((r) => r.path === `${prefix}/categories`).length,
      beforeCommit,
    );
    assert.match(closed.data.receiptStatus, /已撤销/);
    closed.onUnload();
    state.hideReceipt = false;

    state.denyContext = true;
    const denied = mount();
    await flush();
    assert.equal(denied.data.ready, false);
    noDraft(denied);
    denied.onCreate();
    denied.onConfirmCreate();
    await flush();
    assert.equal(journal(), null);
    const independent = mount('rating-catalog');
    await flush();
    assert.equal(independent.data.loaded, true);
    independent.onUnload();
    denied.onUnload();
    state.denyContext = false;

    // An already published result wins explicit cancellation without inventing a rollback.
    seed();
    server.set(requestId, applied);
    state.hideReceipt = true;
    const published = mount(pageName, null);
    await flush();
    published.onCancelCategoryCreation();
    published.onConfirmCancelCategoryCreation();
    await flush();
    assert.equal(journal(), null);
    assert.match(published.data.receiptStatus, /历史操作/);
    noDraft(published);
    published.onUnload();
    state.hideReceipt = false;

    server.clear();
    let releaseCommit;
    state.holdCommit = new Promise((resolve) => {
      releaseCommit = resolve;
    });
    const late = mount();
    await flush();
    fill(late);
    late.onCreate();
    late.onConfirmCreate();
    await flush();
    const saved = structuredClone(journal()),
      beforeHideChanges = changes.length;
    app.community.privateViews.clear();
    noDraft(late);
    releaseCommit();
    await flush();
    assert.deepEqual(journal(), saved);
    assert.equal(changes.length, beforeHideChanges);
    state.holdCommit = null;
    late.onHide();
    const restart = mount(pageName, null);
    await flush();
    assert.equal(journal(), null);
    assert.match(restart.data.receiptStatus, /历史操作/);
    noDraft(restart);
    restart.onUnload();

    server.clear();
    let releasePrepare;
    state.holdPrepare = new Promise((resolve) => {
      releasePrepare = resolve;
    });
    const sessionPage = mount();
    await flush();
    fill(sessionPage);
    sessionPage.onCreate();
    sessionPage.onConfirmCreate();
    await flush();
    const owned = structuredClone(journal()),
      beforeSessionCommits = requests.filter(
        (r) => r.path === `${prefix}/categories`,
      ).length;
    sessions.completeLogin(sessions.beginLogin(), {
      ...original.credentials,
      sessionId: id(90),
    });
    releasePrepare();
    await flush();
    state.holdPrepare = null;
    assert.deepEqual(journal(), owned);
    assert.equal(
      requests.filter((r) => r.path === `${prefix}/categories`).length,
      beforeSessionCommits,
    );
    noDraft(sessionPage);
    sessionPage.onUnload();
    const newSession = mount(pageName, null);
    await flush();
    noDraft(newSession);
    assert.equal(journal().version, 8);
    newSession.onCancelCategoryCreation();
    newSession.onConfirmCancelCategoryCreation();
    await flush();
    assert.equal(journal(), null);
    newSession.onReturnCatalog();
    assert.equal(navigations.at(-1), '/pages/rating-catalog/rating-catalog');
    newSession.onUnload();

    const parentPage = mount();
    await flush();
    parentPage.onParent({ currentTarget: { dataset: { id: parentId } } });
    assert.equal(parentPage.data.parentLevel, 1);
    assert.equal(parentPage.data.nodes[0].level, 2);
    parentPage.onAddChild(event('n0'));
    parentPage.onAddChild(event('n1'));
    assert.equal(parentPage.data.nodes.length, 2);
    assert.equal(parentPage.data.nodes[1].level, 3);
    parentPage.onRemoveNode(event('n1'));
    assert.equal(parentPage.data.nodes.length, 1);
    parentPage.onRemoveNode(event('n0'));
    assert.equal(parentPage.data.nodes.length, 1);
    parentPage.onUnload();
    for (const boundary of ['session', 'root-hide']) {
      const navigating = mount();
      await flush();
      assert.equal(navigating.data.ready, true);
      state.holdNavigation = true;
      navigating.onReturnCatalog();
      const callback = state.pendingNavigation;
      assert.ok(callback);
      if (boundary === 'session')
        sessions.completeLogin(sessions.beginLogin(), {
          ...original.credentials,
          sessionId: id(91),
        });
      else app.community.privateViews.clear();
      const cleared = navigating.data;
      callback.fail({ errMsg: 'late navigation failure' });
      assert.equal(
        navigating.data,
        cleared,
        'Late navigation must not repaint a cleared page',
      );
      assert.equal(navigating.navigator, undefined);
      noDraft(navigating);
      state.holdNavigation = false;
      state.pendingNavigation = null;
      navigating.onUnload();
    }
  } finally {
    for (const page of pages) page.onUnload();
    sessions.completeLogin(sessions.beginLogin(), original.credentials);
    app.community = original.community;
    globalThis.wx = original.wx;
  }
}
