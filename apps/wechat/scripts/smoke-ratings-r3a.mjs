import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parse, render } from './smoke-ratings.mjs';
const require = createRequire(import.meta.url);
/** Synthetic compiled handlers + strict HTTP DTOs + bounded WXML, never device or database proof. */
export async function smokeRatingsR3A({ app, dist, flush }) {
  const { ApiClient } = require(path.join(dist, 'api/client.js'));
  const { ClientError } = require(path.join(dist, 'api/errors.js'));
  const { HttpRatingDeletionGateway } = require(
    path.join(dist, 'ratings/deletion-gateway.js'),
  );
  const { PendingRatingStore } = require(path.join(dist, 'ratings/pending.js'));
  const original = Object.fromEntries(
    ['ratingDeletion', 'pendingRatings', 'newRequestId'].map((key) => [
      key,
      app.community[key],
    ]),
  );
  const credentials = app.identity.sessions.snapshot().credentials;
  const id = (n) => `${String(n).padStart(8, '0')}-dddd-4ddd-8ddd-dddddddddddd`;
  const targetId = id(1),
    rootId = id(2),
    revision = id(3);
  const locator = {
    subjectKind: 'comment',
    targetId,
    rootId,
    subjectId: rootId,
  };
  const requests = [],
    commands = [],
    stored = new Map(),
    receipts = new Map(),
    pages = [];
  let authorized = false,
    deleted = false,
    lose = false,
    minted = 0;
  const api = new ApiClient(
    'https://ratings-r3a.example',
    {
      async send(request) {
        requests.push(request);
        const url = new URL(request.url),
          ok = (data) => ({ status: 200, headers: {}, body: data });
        assert.equal(url.search, '');
        assert.equal(
          request.headers.Authorization,
          `Bearer ${credentials.accessToken}`,
        );
        if (url.pathname.endsWith('/deletion-context')) {
          assert.equal(request.method, 'GET');
          if (!authorized)
            throw new ClientError('http', 'Synthetic no authority', {
              httpStatus: 404,
              serverCode: 'RATING_NOT_FOUND',
            });
          return ok({
            ...locator,
            regionId: null,
            targetRevision: revision,
            rootRevision: deleted ? id(4) : revision,
            revision: deleted ? id(4) : revision,
            deleted,
            contextRevision: 'z'.repeat(43),
          });
        }
        if (request.method === 'DELETE') {
          commands.push(request);
          assert.equal(url.pathname, `/v1/ratings/admin/comments/${rootId}`);
          assert.deepEqual(
            Object.keys(request.body).sort(),
            [
              'clientRequestId',
              'targetId',
              'expectedTargetRevision',
              'expectedRevision',
              'expectedContextRevision',
            ].sort(),
          );
          const result = {
            requestId: request.body.clientRequestId,
            operation: 'admin_delete_comment',
            outcome: 'applied',
            targetId,
            rootId,
            subjectId: rootId,
            revision: id(4),
            occurredAt: '2026-10-09T01:00:00.123456Z',
          };
          receipts.set(result.requestId, result);
          deleted = true;
          if (lose) throw new ClientError('timeout', 'Synthetic lost response');
          return ok(result);
        }
        if (url.pathname.startsWith('/v1/ratings/admin/requests/')) {
          const result = receipts.get(url.pathname.split('/').at(-1));
          assert.ok(result);
          return ok(result);
        }
        throw new Error(
          `Unexpected R3A request ${request.method} ${url.pathname}`,
        );
      },
    },
    app.identity.sessions,
    { refresh: async () => app.identity.sessions.snapshot() },
  );
  app.community.ratingDeletion = new HttpRatingDeletionGateway(api);
  app.community.pendingRatings = new PendingRatingStore(
    {
      get: (key) => stored.get(key),
      set: (key, value) => stored.set(key, value),
      remove: (key) => stored.delete(key),
    },
    'r3a-synthetic',
  );
  app.community.newRequestId = async () => id(100 + ++minted);
  const source = readFileSync(
    path.join(dist, 'pages/rating-deletion/rating-deletion.wxml'),
    'utf8',
  );
  const common = readFileSync(path.join(dist, 'ratings/common.wxml'), 'utf8');
  const templates = Object.fromEntries(
    parse(common)
      .children.filter((n) => typeof n !== 'string')
      .map((n) => [n.attrs.name, n]),
  );
  const nodes = (items) =>
    items.flatMap((n) =>
      typeof n === 'string' ? [] : [n, ...nodes(n.children)],
    );
  const shown = (page) => render(parse(source).children, page.data, templates);
  const buttons = (page, handler) =>
    nodes(shown(page)).filter((n) => n.attrs.bindtap === handler);
  const mount = () => {
    let page;
    const old = globalThis.Page,
      file = path.join(dist, 'pages/rating-deletion/rating-deletion.js');
    globalThis.Page = (definition) => {
      page = definition;
    };
    try {
      delete require.cache[require.resolve(file)];
      require(file);
    } finally {
      globalThis.Page = old;
    }
    page.setData = (data) => {
      page.data = { ...page.data, ...data };
    };
    for (const [, handler] of (source + common).matchAll(
      /bind(?:tap|input)="([^"]+)"/g,
    ))
      if (handler !== 'onLike')
        assert.equal(typeof page[handler], 'function', `R3A ${handler}`);
    pages.push(page);
    page.onLoad(locator);
    page.onShow();
    return page;
  };
  try {
    let page = mount();
    await flush();
    assert.equal(requests.length, 0);
    assert.equal(buttons(page, 'onConfirm').length, 0);
    page.onAdmin();
    await flush();
    assert.equal(buttons(page, 'onConfirm').length, 0);
    assert.equal(commands.length, 0);
    authorized = true;
    page.onAdmin();
    await flush();
    assert.equal(buttons(page, 'onConfirm').length, 1);
    assert.match(JSON.stringify(shown(page)), /确认以管理员身份删除/);
    assert.equal(JSON.stringify(page.data).includes('contextRevision'), false);
    page.onCancel();
    assert.equal(buttons(page, 'onConfirm').length, 0);
    assert.equal(minted, 0);
    page.onAdmin();
    await flush();
    lose = true;
    page.onConfirm();
    page.onConfirm();
    await flush();
    assert.equal(commands.length, 1);
    assert.equal(minted, 1);
    assert.equal(stored.size, 1);
    assert.equal(buttons(page, 'onConfirm').length, 0);
    page.onHide();
    assert.equal(page.data.loaded, false);
    page.onUnload();
    authorized = false;
    page = mount();
    await flush();
    assert.equal(stored.size, 0);
    assert.match(page.data.receiptStatus, /历史操作/);
    assert.equal(page.data.context, null);
    assert.equal(buttons(page, 'onConfirm').length, 0);
    assert.equal(commands.length, 1);
    app.community.privateViews.clear();
    assert.equal(page.data.loaded, false);
    assert.equal(page.data.context, null);
  } finally {
    for (const page of pages) page.onUnload();
    Object.assign(app.community, original);
  }
  console.log(
    'Ratings R3A emitted deletion panel + strict HTTP + WXML smoke passed: explicit minimal authority read, cancel, admin confirmation, single v4 command, lost-response recovery after role revocation, and app-hide clearing (synthetic only).',
  );
}
