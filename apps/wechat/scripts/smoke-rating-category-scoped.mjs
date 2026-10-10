import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);

/** A Node dependency fallback can hide a broken Mini Program package. Inspect
 * every emitted JS file before requiring app/runtime, not just the source TS. */
export function assertCategoryScopedShaPackaging(dist) {
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.name.endsWith('.js'))
        assert.doesNotMatch(
          readFileSync(file, 'utf8'),
          /(?:require\s*\(\s*|from\s*)["']js-sha256(?:["']|\/)/,
          `Bare SHA package import in emitted ${path.relative(dist, file)}`,
        );
    }
  };
  visit(dist);
  assert.match(
    readFileSync(
      path.join(dist, 'ratings/category-scoped-contract.js'),
      'utf8',
    ),
    /require\(["']\.\.\/vendor\/sha256["']\)/,
  );
}

/** Emitted runtime + manage/editor Pages + strict ApiClient/gateway/journal.
 * The transport is synthetic; this is packaging/handler proof, not device or PG proof. */
export async function smokeRatingCategoryScoped({ app, dist }) {
  const emitted = (name) => require(path.join(dist, `${name}.js`));
  const { ApiClient } = emitted('api/client');
  const { ClientError } = emitted('api/errors');
  const { SessionStore } = emitted('auth/session');
  const { createCommunityRuntime } = emitted('community/runtime');
  const { HttpRatingCategoryScopedGateway } = emitted(
    'ratings/category-scoped-gateway',
  );
  const {
    ratingCategoryScopedOperations,
    decodeRatingCategoryScopedIntent,
    ratingCategoryScopedIntentHash,
  } = emitted('ratings/category-scoped-contract');
  const { sha256 } = emitted('vendor/sha256');
  const prior = {
    Page: globalThis.Page,
    getApp: globalThis.getApp,
    wx: globalThis.wx,
  };
  const sessions = new SessionStore();
  const credentials = app.identity.sessions.snapshot().credentials;
  assert.ok(
    credentials,
    'Parent emitted smoke must provide a synthetic session',
  );
  sessions.completeLogin(sessions.beginLogin(), credentials);
  const id = (n) => `${String(n).padStart(8, '0')}-ca10-4ca1-8ca1-ca10ca10ca10`;
  const campusId = id(1),
    categoryId = id(2),
    revision = id(3),
    token = 'q'.repeat(43);
  let counter = 100,
    commits = 0,
    loseCommit = false;
  const nextId = () => id(counter++);
  const requests = [],
    pages = [],
    navigations = [],
    values = new Map(),
    receipts = new Map();
  const category = {
    id: categoryId,
    parentId: null,
    level: 1,
    kind: 'general',
    systemKey: null,
    name: 'Emitted managed category',
    description: 'Shared emitted body',
    revision,
    baseRevision: id(4),
    placementRevision: id(5),
    lifecycleRevision: null,
    overrideRevision: null,
    orderRevision: null,
    ordinal: '0',
    businessState: 'enabled',
    hidden: false,
    scopeKeys: [`campus:${campusId}`],
    baseName: 'Emitted managed category',
    baseDescription: 'Shared emitted body',
    override: { name: { mode: 'inherit' }, description: { mode: 'inherit' } },
    blockedReason: null,
  };
  const context = (selector) => ({
    protocolVersion: 2,
    commandContext: {
      id: nextId(),
      token,
      tokenDigest: sha256(token),
      selector,
      scopeRevision: 'b'.repeat(64),
      protocolGeneration: id(6),
      catalogRevision: id(7),
      headRevision: id(8),
      sourceDigest: 'c'.repeat(64),
    },
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    snapshotRevision: 'a'.repeat(64),
    campusIds: [campusId],
    canManageGlobal: true,
    operations: [...ratingCategoryScopedOperations],
  });
  let runtime;
  const preparation = (intent) => ({
    requestId: intent.payload.clientRequestId,
    contextRevision: 'p'.repeat(43),
    categoryIds: [categoryId],
    affectedScopeKeys: [`campus:${campusId}`],
    changedSourceCount: 1,
    affectedTargetCount: 0,
    previewDigest: 'e'.repeat(64),
    summary: 'Synthetic emitted exact body preview',
    changes: [
      {
        categoryId,
        scopeKeys: [`campus:${campusId}`],
        field: 'body',
        beforeStatus: 'available',
        afterStatus: 'available',
        before: 'Shared emitted body',
        after: intent.payload.description,
      },
    ],
    expiresAt: new Date(Date.now() + 180000).toISOString(),
  });
  const transport = {
    async send(request) {
      assert.ok(
        request.headers.Authorization,
        'Every management request is authenticated',
      );
      const url = new URL(request.url),
        pathname = url.pathname;
      requests.push({ method: request.method, path: pathname });
      let body;
      if (pathname.endsWith('/category-management/contexts'))
        body = context(request.body.selector);
      else if (pathname.endsWith('/category-management/categories'))
        body = {
          items: [category],
          snapshotRevision: 'a'.repeat(64),
          complete: true,
        };
      else if (
        pathname.endsWith(`/category-management/categories/${categoryId}`)
      )
        body = category;
      else if (pathname.endsWith('/category-management/system-options'))
        body = { items: [] };
      else if (pathname.endsWith('/category-management/prepare')) {
        const intent = decodeRatingCategoryScopedIntent(request.body);
        const pending = runtime.pendingRatings.load(credentials.accountId);
        assert.equal(pending.version, 10);
        assert.deepEqual(
          pending.intent,
          intent,
          'Emitted journal is frozen before preparation leaves the device',
        );
        body = preparation(intent);
      } else if (pathname.endsWith('/category-management/commit')) {
        const intent = decodeRatingCategoryScopedIntent(request.body.intent);
        assert.equal(request.body.preparationContextRevision, 'p'.repeat(43));
        assert.deepEqual(
          runtime.pendingRatings.load(credentials.accountId).intent,
          intent,
        );
        body = {
          protocolVersion: 2,
          requestId: intent.payload.clientRequestId,
          operation: intent.operation,
          intentHash: ratingCategoryScopedIntentHash(intent),
          outcome: 'applied',
          result: {
            releaseId: nextId(),
            categoryIds: [categoryId],
            heads: [
              {
                scopeKey: `campus:${campusId}`,
                catalogRevision: id(9),
                headRevision: id(10),
              },
            ],
            occurredAt: new Date().toISOString(),
          },
        };
        receipts.set(body.requestId, body);
        commits++;
        if (loseCommit) {
          loseCommit = false;
          throw new ClientError('network', 'Synthetic lost reply after commit');
        }
      } else if (pathname.startsWith('/v2/ratings/requests/')) {
        body = receipts.get(pathname.split('/').at(-1));
        assert.ok(
          body,
          'Only a real synthetic original outcome may resolve recovery',
        );
      } else
        assert.fail(
          `Unexpected emitted category route ${request.method} ${pathname}`,
        );
      return { status: 200, headers: {}, body };
    },
  };
  const api = new ApiClient(
    'https://emitted-category.example.test',
    transport,
    sessions,
    { refresh: async () => assert.fail('Unexpected provider refresh') },
  );
  const platform = {
    getStorageSync: (key) => values.get(key),
    setStorageSync: (key, value) => values.set(key, value),
    removeStorageSync: (key) => values.delete(key),
  };
  runtime = createCommunityRuntime(
    { sessions, api },
    platform,
    'https://emitted-category.example.test',
  );
  runtime.newRequestId = async () => nextId();
  assert.ok(
    runtime.ratingCategoryScoped instanceof HttpRatingCategoryScopedGateway,
  );
  const localApp = { ...app, community: runtime };
  const source = readFileSync(
    path.join(dist, 'ratings/category-scoped.wxml'),
    'utf8',
  );
  const drain = async () => {
    for (let n = 0; n < 150; n++) await Promise.resolve();
  };
  const mount = (name, query) => {
    let native;
    globalThis.Page = (definition) => {
      native = definition;
    };
    const module = path.join(dist, `pages/${name}/${name}.js`);
    delete require.cache[require.resolve(module)];
    require(module);
    assert.ok(native, `Emitted ${name} Page registered`);
    native.setData = (patch) => {
      native.data = { ...native.data, ...patch };
    };
    for (const [, handler] of source.matchAll(
      /bind(?:tap|input)="([A-Za-z]+)"/g,
    ))
      assert.equal(
        typeof native[handler],
        'function',
        `Emitted handler ${handler}`,
      );
    pages.push(native);
    native.onLoad(query);
    native.onShow();
    return native;
  };
  const tap = (native, handler, dataset = {}) =>
    native[handler]({ currentTarget: { dataset }, detail: { value: '' } });
  const text = (native, value) =>
    native.onText({
      currentTarget: { dataset: { field: 'description' } },
      detail: { value },
    });
  try {
    globalThis.getApp = () => localApp;
    globalThis.wx = {
      ...prior.wx,
      navigateTo: ({ url, success }) => {
        navigations.push(url);
        success?.();
      },
    };
    const manage = mount('rating-category-manage', {
      scope: 'campus',
      campusId,
    });
    await drain();
    assert.equal(manage.data.loaded, true, manage.data.error);
    assert.equal(manage.data.categories[0].id, categoryId);
    tap(manage, 'onOpenEditor', { id: categoryId });
    assert.match(navigations.at(-1), /\/rating-category-editor\//);
    assert.match(navigations.at(-1), new RegExp(`campusId=${campusId}`));
    const editor = mount('rating-category-editor', {
      scope: 'campus',
      campusId,
      categoryId,
    });
    await drain();
    assert.equal(editor.data.loaded, true, editor.data.error);
    tap(editor, 'onOperation', { operation: 'edit_category_base_scoped' });
    text(editor, 'First emitted body');
    tap(editor, 'onPrepare');
    await drain();
    assert.ok(editor.data.preview, editor.data.error);
    assert.equal(commits, 0);
    assert.equal(
      runtime.pendingRatings.load(credentials.accountId).version,
      10,
    );
    assert.equal(JSON.stringify(editor.data).includes('tokenDigest'), false);
    assert.equal(
      JSON.stringify(editor.data).includes('contextRevision'),
      false,
    );
    tap(editor, 'onCommit');
    tap(editor, 'onCommit');
    await drain();
    assert.equal(commits, 1);
    assert.equal(runtime.pendingRatings.load(credentials.accountId), null);
    assert.equal(
      manage.data.loaded,
      false,
      'Existing emitted management page invalidates on a catalog release',
    );
    editor.onRefresh();
    await drain();
    tap(editor, 'onOperation', { operation: 'edit_category_base_scoped' });
    text(editor, 'Second emitted original');
    tap(editor, 'onPrepare');
    await drain();
    assert.ok(editor.data.preview, editor.data.error);
    loseCommit = true;
    tap(editor, 'onCommit');
    await drain();
    assert.equal(commits, 2);
    assert.equal(
      runtime.pendingRatings.load(credentials.accountId).version,
      10,
    );
    runtime.privateViews.clear();
    assert.equal(editor.data.preview, null);
    editor.onHide();
    const start = requests.length;
    editor.onShow();
    await drain();
    assert.equal(runtime.pendingRatings.load(credentials.accountId), null);
    assert.equal(
      requests.length - start,
      1,
      'Recovery is receipt-only and never rereads current authority',
    );
    assert.match(requests.at(-1).path, /^\/v2\/ratings\/requests\//);
    assert.match(editor.data.receiptStatus, /回执已确认/);
    assert.equal(commits, 2);
  } finally {
    for (const native of pages) native.onUnload();
    runtime.privateViews.clear();
    sessions.logout();
    Object.assign(globalThis, prior);
  }
}
