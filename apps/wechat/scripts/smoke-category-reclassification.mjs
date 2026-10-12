import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);

/** Emitted runtime, exact HTTP contracts, journal and registered native handlers.
 * Synthetic policy/transport only; this is not production, device or PG proof. */
export async function smokeCategoryReclassification({ dist }) {
  const emitted = (name) => require(path.join(dist, `${name}.js`));
  const { ApiClient } = emitted('api/client');
  const { ClientError } = emitted('api/errors');
  const { SessionStore } = emitted('auth/session');
  const { createCommunityRuntime } = emitted('community/runtime');
  const { CategoryReclassificationController } = emitted(
    'category-reclassification/controller',
  );
  const id = (n) => `${String(n).padStart(8, '0')}-ca71-4ca7-8ca7-ca71ca71ca71`;
  const accountId = id(1),
    postId = id(2),
    origin = 'https://category.example';
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), {
    accountId,
    sessionId: id(3),
    accessToken: `wu_a_${'a'.repeat(43)}`,
    refreshToken: `wu_r_${'b'.repeat(43)}`,
    expiresAt: 1900000000000,
    refreshExpiresAt: 1900600000000,
  });
  const storage = new Map(),
    receipts = new Map(),
    requests = [];
  const native = {
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    removeStorageSync: (key) => storage.delete(key),
  };
  let currentCategory = 'pets',
    revision = 0,
    counter = 100;
  let loseResponse = false,
    managementUnavailable = false,
    writes = 0,
    runtime;
  const transport = {
    async send(request) {
      const url = new URL(request.url);
      assert.equal(url.origin, origin);
      assert.ok(request.headers.Authorization);
      requests.push({
        method: request.method,
        path: url.pathname,
        body: request.body,
      });
      let body;
      if (
        url.pathname === `/v1/community/posts/${postId}/category-management`
      ) {
        if (managementUnavailable)
          throw new ClientError('http', 'Current authority unavailable');
        body = {
          postId,
          currentCategory,
          revision,
          canChange: true,
          targets: ['pets', 'scenery'],
        };
      } else if (
        url.pathname === '/v1/community/category-commands' ||
        url.pathname.endsWith('/cancel')
      ) {
        assert.equal(request.method, 'POST');
        const command = request.body;
        const pending = runtime.pendingCategoryReclassification.load(accountId);
        assert.deepEqual(
          pending.command,
          command,
          'Exact original is durable before dispatch',
        );
        assert.deepEqual(Object.keys(command).sort(), [
          'clientRequestId',
          'expectedRevision',
          'postId',
          'targetCategory',
        ]);
        const cancelling = url.pathname.endsWith('/cancel');
        assert.equal(pending.phase, cancelling ? 'cancel' : 'submit');
        body = receipts.get(command.clientRequestId);
        if (!body) {
          const metadata = {
            requestId: command.clientRequestId,
            postId: command.postId,
            expectedRevision: command.expectedRevision,
            targetCategory: command.targetCategory,
          };
          if (cancelling)
            body = {
              ...metadata,
              outcome: 'rejected',
              code: 'POST_CATEGORY_CANCELLED',
            };
          else if (command.expectedRevision !== revision)
            body = {
              ...metadata,
              outcome: 'rejected',
              code: 'POST_CATEGORY_STALE',
            };
          else {
            revision++;
            writes++;
            currentCategory = command.targetCategory;
            body = {
              ...metadata,
              outcome: 'applied',
              revision,
              eventId: id(counter++),
              recordedAt: '2026-10-12T00:00:00.000Z',
            };
          }
          receipts.set(command.clientRequestId, body);
        }
        if (loseResponse) {
          loseResponse = false;
          throw new ClientError('timeout', 'Synthetic lost response');
        }
      } else if (url.pathname.startsWith('/v1/community/category-requests/')) {
        assert.equal(request.method, 'GET');
        const found = receipts.get(url.pathname.split('/').at(-1));
        body = found
          ? { state: 'recorded', receipt: found }
          : { state: 'not_recorded' };
      } else
        throw new Error(`Unexpected native category route: ${url.pathname}`);
      return { status: 200, headers: {}, body };
    },
  };
  const api = new ApiClient(origin, transport, sessions, {
    refresh: async () => {
      throw new Error('No automatic auth replay');
    },
  });
  runtime = createCommunityRuntime({ api, sessions }, native, origin);
  runtime.newRequestId = async () => id(counter++);
  const previousPage = globalThis.Page;
  let definition, page;
  const controllers = [];
  const flush = async () => {
    for (let n = 0; n < 100; n++) await Promise.resolve();
  };
  const mount = () => {
    page = {
      ...definition,
      data: structuredClone(definition.data),
      setData(patch) {
        Object.assign(this.data, patch);
      },
    };
    page.onLoad({ postId });
    page.categoryController = new CategoryReclassificationController(
      runtime,
      (view) => page.setData({ categoryManagement: view }),
    );
    controllers.push(page.categoryController);
    return page.categoryController.load(postId);
  };
  try {
    globalThis.Page = (value) => {
      definition = value;
    };
    const file = path.join(dist, 'pages/community-detail/community-detail.js');
    delete require.cache[require.resolve(file)];
    require(file);
    assert.ok(definition?.onCategoryChoose);
    const wxml = readFileSync(
      path.join(dist, 'pages/community-detail/community-detail.wxml'),
      'utf8',
    );
    assert.match(wxml, /<template is="category-reclassification"/);
    const template = readFileSync(
      path.join(dist, 'category-reclassification/management.wxml'),
      'utf8',
    );
    assert.match(template, /category\.management\.canChange/);
    assert.match(template, /category\.management\.targets/);
    await mount();
    page.onCategoryChoose({
      currentTarget: { dataset: { id: postId, category: 'scenery' } },
    });
    await flush();
    assert.equal(page.data.categoryManagement.confirming, 'change');
    page.onCategorySubmit();
    page.onCategorySubmit();
    await flush();
    assert.equal(writes, 1);
    assert.equal(currentCategory, 'scenery');
    assert.equal(runtime.pendingCategoryReclassification.load(accountId), null);
    page.onCategoryChoose({
      currentTarget: { dataset: { id: postId, category: 'pets' } },
    });
    await flush();
    loseResponse = true;
    page.onCategorySubmit();
    await flush();
    assert.equal(writes, 2);
    assert.equal(currentCategory, 'pets');
    assert.equal(page.data.categoryManagement.frozen, true);
    const original = runtime.pendingCategoryReclassification.load(accountId);
    page.categoryController.dispose();
    managementUnavailable = true;
    await mount();
    assert.equal(
      page.data.categoryManagement.pendingRequestId,
      original.command.clientRequestId,
    );
    page.onCategoryRecover();
    await flush();
    assert.equal(runtime.pendingCategoryReclassification.load(accountId), null);
    assert.equal(
      writes,
      2,
      'Recovery does not replay publication or classification',
    );
    assert.equal(page.data.categoryManagement.frozen, false);
    assert.deepEqual(
      requests
        .filter((r) => r.path === '/v1/community/category-commands')
        .map((r) => r.body.expectedRevision),
      [0, 1],
    );
  } finally {
    for (const controller of controllers) controller.dispose();
    globalThis.Page = previousPage;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await smokeCategoryReclassification({
    dist: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist'),
  });
  console.log(
    'Emitted category reclassification smoke passed (synthetic transport; not device/PG acceptance)',
  );
}
