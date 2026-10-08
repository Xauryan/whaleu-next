import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);

// Emitted handlers, API transport and strict decoders; synthetic responses, not physical-device QA.
export async function smokeSearch({ app, dist, mountPage, flush, postWire }) {
  const { ApiClient } = require(path.join(dist, 'api/client.js'));
  const { HttpSearchGateway } = require(
    path.join(dist, 'community/search-gateway.js'),
  );
  const { HttpCommunityGateway } = require(
    path.join(dist, 'community/gateway.js'),
  );
  const original = {
    search: app.community.search,
    gateway: app.community.gateway,
    credentials: app.identity.sessions.snapshot().credentials,
  };
  const campusId = '33333333-3333-4333-8333-333333333333';
  const spaceId = postWire().space.id;
  const token = Buffer.alloc(32, 1).toString('base64url');
  const requests = [];
  let expired = false,
    unavailable = false,
    deleted = false,
    page;
  const api = new ApiClient(
    'https://api.example',
    {
      send: async (request) => {
        requests.push(request);
        const url = new URL(request.url);
        const response = (body) => ({ status: 200, headers: {}, body });
        assert.equal(request.method, 'GET');
        assert.equal(request.body, undefined);
        if (url.pathname === '/v1/community/spaces') {
          assert.equal(url.searchParams.get('campusId'), campusId);
          return response({
            regional: unavailable
              ? null
              : {
                  id: spaceId,
                  name: postWire().space.name,
                  kind: 'regional',
                  isActive: true,
                  operatingRegionId: '99999999-9999-4999-8999-999999999999',
                },
            global: [],
          });
        }
        assert.equal(url.pathname, '/v1/community/search');
        assert.equal(url.searchParams.get('spaceId'), spaceId);
        assert.equal(url.searchParams.get('q'), '校园 İ%_\\');
        assert.equal(url.searchParams.get('limit'), '10');
        if (url.searchParams.has('cursor') && expired)
          return {
            status: 409,
            headers: {},
            body: { error: { code: 'DISCOVERY_RESTART_REQUIRED' } },
          };
        const after = url.searchParams.get('cursor');
        if (after) assert.equal(after, token);
        return response(
          after || deleted
            ? {
                items: deleted ? [] : [postWire()],
                continuation: 'end',
                nextCursor: null,
              }
            : { items: [], continuation: 'scan_pending', nextCursor: token },
        );
      },
    },
    app.identity.sessions,
    {
      refresh: async () => {
        throw new Error('No refresh expected');
      },
    },
  );
  app.community.search = new HttpSearchGateway(api);
  app.community.gateway = new HttpCommunityGateway(api);
  try {
    page = mountPage(
      path.join(dist, 'pages/community-search/community-search.js'),
      { campusId, spaceId },
    );
    await flush();
    assert.equal(page.data.scopeLoaded, true);
    assert.equal(page.data.loaded, false);
    assert.equal(requests.filter((r) => r.url.includes('/search?')).length, 0);
    page.onInput({ detail: { value: '  校园 İ%_\\  ' } });
    page.onSubmit();
    await flush();
    assert.equal(page.data.continuation, 'scan_pending');
    assert.deepEqual(page.data.posts, []);
    page.onInput({ detail: { value: 'unsent' } });
    page.onNext();
    page.onNext();
    await flush();
    assert.equal(page.data.pageNumber, 2);
    assert.equal(page.data.posts.length, 1);
    assert.equal(page.data.submittedQuery, '校园 İ%_\\');
    assert.equal(page.data.inputDraft, 'unsent');
    page.onPrevious();
    await flush();
    assert.equal(page.data.pageNumber, 1);
    assert.deepEqual(page.data.posts, []);
    expired = true;
    page.onNext();
    await flush();
    assert.equal(page.data.restartRequired, true);
    assert.equal(page.data.canNext, false);
    expired = false;
    page.onRefresh();
    await flush();
    assert.equal(page.data.continuation, 'scan_pending');
    app.community.privateViews.clear();
    page.onHide();
    assert.deepEqual(page.data.posts, []);
    assert.equal(page.data.submittedQuery, '');
    deleted = true;
    page.onShow();
    await flush();
    assert.equal(page.data.submittedQuery, '校园 İ%_\\');
    assert.deepEqual(page.data.posts, []);
    assert.equal(page.data.continuation, 'end');
    unavailable = true;
    page.onRefresh();
    await flush();
    assert.equal(page.data.space, null);
    assert.deepEqual(page.data.posts, []);
    page.onHide();
    app.identity.sessions.logout();
    assert.equal(page.resume, null);
    page.onShow();
    await flush();
    assert.equal(page.data.inputDraft, '');
  } finally {
    page?.onUnload();
    app.community.search = original.search;
    app.community.gateway = original.gateway;
    if (original.credentials)
      app.identity.sessions.completeLogin(
        app.identity.sessions.beginLogin(),
        original.credentials,
      );
  }
  console.log(
    'Search compiled native smoke passed: explicit scope, strict real gateway decoding, frozen query, manual sparse continuation, fresh previous, restart, hide/reopen, scope deactivation and account clearing. No physical-device claim.',
  );
}
