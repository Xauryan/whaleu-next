import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);

// Emitted handlers, API transport and strict decoders; synthetic responses, not physical-device QA.
export async function smokeSearch({
  app,
  dist,
  mountPage,
  flush,
  postWire,
  tradingWire,
}) {
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
    browseFails = false,
    aggregateSparse = false,
    aggregateLoginRequired = false,
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
          if (browseFails)
            return {
              status: 404,
              headers: {},
              body: { error: { code: 'CAMPUS_NOT_FOUND' } },
            };
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
        const scope = url.searchParams.get('scope');
        assert.equal(url.searchParams.get('spaceId'), scope ? null : spaceId);
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
        if (scope) {
          assert.ok(['all', 'regional', 'global'].includes(scope));
          assert.equal(url.searchParams.has('campusId'), false);
          const category = url.searchParams.get('category');
          const subtype = url.searchParams.get('tradingSubtype');
          if (scope !== 'regional') {
            assert.equal(category, null);
            assert.equal(subtype, null);
          }
          if (subtype) assert.equal(category, 'trading');
          if (aggregateLoginRequired)
            return response({
              items: [],
              continuation: 'login_required',
              nextCursor: null,
            });
          if (aggregateSparse && !after)
            return response({
              items: [],
              continuation: 'scan_pending',
              nextCursor: token,
            });
          const globalPost = (id) => ({
            ...postWire(),
            id,
            component: { kind: 'none' },
            space: { id, kind: 'global', name: '合成全站社区' },
          });
          const globals = [
            globalPost('11111111-1111-4111-8111-111111111111'),
            globalPost('22222222-2222-4222-8222-222222222222'),
          ];
          const trading = {
            ...tradingWire(),
            trading: {
              ...tradingWire().trading,
              urgency: 'urgent',
              resolution: 'resolved',
            },
          };
          return response({
            items:
              scope === 'global'
                ? globals
                : scope === 'all'
                  ? [trading, ...globals]
                  : category === 'trading'
                    ? [trading]
                    : [
                        {
                          ...postWire(),
                          category: category ?? 'discussion',
                          component: { kind: 'none' },
                        },
                      ],
            continuation: 'end',
            nextCursor: null,
          });
        }
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
    page.onUnload();

    // New public all-community entry works with no remembered campus and no directory lookup.
    const beforeBrowse = requests.filter((r) =>
      r.url.includes('/spaces?'),
    ).length;
    page = mountPage(
      path.join(dist, 'pages/community-search/community-search.js'),
      { scope: 'all' },
    );
    await flush();
    assert.equal(page.data.scopeLoaded, true);
    page.onInput({ detail: { value: '  校园 İ%_\\  ' } });
    page.onSubmit();
    await flush();
    assert.equal(page.data.loaded, true);
    assert.equal(page.data.posts.length, 3);
    assert.equal(page.data.posts[0].trading.urgency, 'urgent');
    assert.equal(page.data.posts[0].trading.resolution, 'resolved');
    assert.equal(new Set(page.data.posts.map((p) => p.space.id)).size, 3);
    assert.equal(
      requests.filter((r) => r.url.includes('/spaces?')).length,
      beforeBrowse,
    );
    page.onInput({ detail: { value: 'unsent aggregate' } });
    page.onCategory({ currentTarget: { dataset: { key: 'trading' } } });
    assert.equal(page.data.selectedScope, 'regional');
    assert.deepEqual(page.data.posts, []);
    await flush();
    page.onTradingSubtype({ currentTarget: { dataset: { key: 'shuma' } } });
    await flush();
    const tradingRequest = new URL(requests.at(-1).url);
    assert.equal(tradingRequest.searchParams.get('scope'), 'regional');
    assert.equal(tradingRequest.searchParams.get('tradingSubtype'), 'shuma');
    assert.equal(page.data.posts[0].trading.resolution, 'resolved');
    page.onAggregateScope({ currentTarget: { dataset: { scope: 'global' } } });
    await flush();
    assert.equal(page.data.category, 'all');
    assert.equal(page.data.tradingSubtype, '');
    assert.equal(page.data.posts.length, 2);
    assert.ok(page.data.posts.every((p) => p.space.kind === 'global'));
    assert.equal(page.data.inputDraft, 'unsent aggregate');
    const count = requests.length;
    page.onCategory({ currentTarget: { dataset: { key: 'discussion' } } });
    await flush();
    assert.equal(requests.length, count);
    page.onAggregateScope({
      currentTarget: { dataset: { scope: 'regional' } },
    });
    await flush();
    assert.ok(page.data.posts.every((p) => p.space.kind === 'regional'));
    aggregateSparse = true;
    page.onRefresh();
    await flush();
    assert.equal(page.data.continuation, 'scan_pending');
    expired = true;
    page.onNext();
    await flush();
    assert.equal(page.data.restartRequired, true);
    assert.deepEqual(page.data.posts, []);
    assert.equal(page.data.canPrevious, false);
    expired = false;
    aggregateSparse = false;
    page.onRefresh();
    await flush();
    app.community.privateViews.clear();
    page.onHide();
    assert.equal(page.data.submittedQuery, '');
    page.onShow();
    await flush();
    assert.equal(page.data.selectedScope, 'regional');
    assert.equal(page.data.inputDraft, 'unsent aggregate');
    assert.equal(page.data.posts.length, 1);
    aggregateLoginRequired = true;
    page.onRefresh();
    await flush();
    assert.equal(page.data.continuation, 'login_required');
    assert.equal(page.data.canNext, false);
    assert.deepEqual(page.data.posts, []);
    aggregateLoginRequired = false;
    page.onUnload();

    // Stale optional browsing context cannot disable an otherwise valid aggregate query.
    browseFails = true;
    page = mountPage(
      path.join(dist, 'pages/community-search/community-search.js'),
      { scope: 'all', campusId },
    );
    await flush();
    page.onInput({ detail: { value: '校园 İ%_\\' } });
    page.onSubmit();
    await flush();
    assert.equal(page.data.loaded, true);
    assert.equal(page.data.posts.length, 3);
    assert.equal(page.data.error, '');
    assert.match(page.data.browseNotice, /仍可使用/);
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
    'Search compiled native smoke passed: explicit and all/regional/global scopes, no-campus entry, stale optional browse, urgent/resolved and source-space decoding, visible category transitions, frozen query, sparse continuation, fresh previous, membership restart, hide/reopen and account clearing. No physical-device claim.',
  );
}
