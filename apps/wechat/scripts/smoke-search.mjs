import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { parse, render } from './smoke-ratings.mjs';
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
    navigateTo: globalThis.wx.navigateTo,
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
    discussionMode = false,
    semanticFailure = 'SEMANTIC_SEARCH_DISABLED',
    page;
  const hitWire = (source, kind = 'post') => {
    const rootCommentId =
      kind === 'post' ? null : '88888888-8888-4888-8888-888888888888';
    const replyId =
      kind === 'reply' ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : null;
    return {
      kind,
      contentId: kind === 'post' ? source.id : (replyId ?? rootCommentId),
      postId: source.id,
      rootCommentId,
      replyId,
      space: source.space,
      category: source.category,
      tradingSubtype:
        source.trading?.subtype.kind === 'known'
          ? source.trading.subtype.key
          : null,
      tradingUrgency: source.trading?.urgency ?? null,
      createdAt: source.publishedAt.replace('.000Z', '.000000Z'),
      author: source.author,
      postSummary: [...source.text].slice(0, 80).join(''),
      snippet: {
        segments: [
          {
            text:
              kind === 'post'
                ? source.text
                : '仅在子讨论命中的校园原文 <script>İ%_\\',
            matched: true,
          },
        ],
        truncatedBefore: false,
        truncatedAfter: false,
      },
      target: {
        kind,
        postId: source.id,
        ...(rootCommentId ? { rootCommentId } : {}),
        ...(replyId ? { replyId } : {}),
      },
    };
  };
  const api = new ApiClient(
    'https://api.example',
    {
      send: async (request) => {
        requests.push(request);
        const url = new URL(request.url);
        const response = (body) => ({
          status: 200,
          headers: {},
          body: body.continuation
            ? {
                ...body,
                items: body.items.map((item) =>
                  item.kind ? item : hitWire(item),
                ),
                effectiveTypes:
                  body.effectiveTypes ??
                  (request.headers.Authorization
                    ? ['post', 'comment', 'reply']
                    : ['post']),
              }
            : body,
        });
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
        if (url.pathname === '/v1/community/search/semantic') {
          assert.equal(url.searchParams.has('cursor'), false);
          if (semanticFailure)
            return {
              status: 503,
              headers: {},
              body: { error: { code: semanticFailure } },
            };
          const hit = hitWire(postWire());
          hit.snippet.segments = [
            { text: '语义相关原文 <script>😀', matched: false },
          ];
          return response({
            mode: 'semantic',
            indexStatus: 'current',
            ranking: 'embedding-top32-reranked',
            items: [hit],
          });
        }
        assert.equal(url.pathname, '/v1/community/search');
        if (discussionMode) {
          const type = url.searchParams.get('type') ?? 'all';
          const items = ['post', 'comment', 'reply'].map((kind) =>
            hitWire(postWire(), kind),
          );
          return response({
            items: items.filter((item) => type === 'all' || item.kind === type),
            continuation: 'end',
            nextCursor: null,
            effectiveTypes:
              type === 'all' ? ['post', 'comment', 'reply'] : [type],
          });
        }
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
    assert.deepEqual(page.data.hits, []);
    page.onInput({ detail: { value: 'unsent' } });
    page.onNext();
    page.onNext();
    await flush();
    assert.equal(page.data.pageNumber, 2);
    assert.equal(page.data.hits.length, 1);
    assert.equal(page.data.submittedQuery, '校园 İ%_\\');
    assert.equal(page.data.inputDraft, 'unsent');
    page.onPrevious();
    await flush();
    assert.equal(page.data.pageNumber, 1);
    assert.deepEqual(page.data.hits, []);
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
    assert.deepEqual(page.data.hits, []);
    assert.equal(page.data.submittedQuery, '');
    deleted = true;
    page.onShow();
    await flush();
    assert.equal(page.data.submittedQuery, '校园 İ%_\\');
    assert.deepEqual(page.data.hits, []);
    assert.equal(page.data.continuation, 'end');
    unavailable = true;
    page.onRefresh();
    await flush();
    assert.equal(page.data.space, null);
    assert.deepEqual(page.data.hits, []);
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
    assert.equal(page.data.hits.length, 3);
    assert.equal(page.data.hits[0].tradingUrgency, 'urgent');
    assert.equal(page.data.hits[0].category, 'trading');
    assert.equal(new Set(page.data.hits.map((p) => p.space.id)).size, 3);
    assert.equal(
      requests.filter((r) => r.url.includes('/spaces?')).length,
      beforeBrowse,
    );
    page.onInput({ detail: { value: 'unsent aggregate' } });
    page.onCategory({ currentTarget: { dataset: { key: 'trading' } } });
    assert.equal(page.data.selectedScope, 'regional');
    assert.deepEqual(page.data.hits, []);
    await flush();
    page.onTradingSubtype({ currentTarget: { dataset: { key: 'shuma' } } });
    await flush();
    const tradingRequest = new URL(requests.at(-1).url);
    assert.equal(tradingRequest.searchParams.get('scope'), 'regional');
    assert.equal(tradingRequest.searchParams.get('tradingSubtype'), 'shuma');
    assert.equal(page.data.hits[0].category, 'trading');
    page.onAggregateScope({ currentTarget: { dataset: { scope: 'global' } } });
    await flush();
    assert.equal(page.data.category, 'all');
    assert.equal(page.data.tradingSubtype, '');
    assert.equal(page.data.hits.length, 2);
    assert.ok(page.data.hits.every((p) => p.space.kind === 'global'));
    assert.equal(page.data.inputDraft, 'unsent aggregate');
    const count = requests.length;
    page.onCategory({ currentTarget: { dataset: { key: 'discussion' } } });
    await flush();
    assert.equal(requests.length, count);
    page.onAggregateScope({
      currentTarget: { dataset: { scope: 'regional' } },
    });
    await flush();
    assert.ok(page.data.hits.every((p) => p.space.kind === 'regional'));
    aggregateSparse = true;
    page.onRefresh();
    await flush();
    assert.equal(page.data.continuation, 'scan_pending');
    expired = true;
    page.onNext();
    await flush();
    assert.equal(page.data.restartRequired, true);
    assert.deepEqual(page.data.hits, []);
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
    assert.equal(page.data.hits.length, 1);
    aggregateLoginRequired = true;
    page.onRefresh();
    await flush();
    assert.equal(page.data.continuation, 'login_required');
    assert.equal(page.data.canNext, false);
    assert.deepEqual(page.data.hits, []);
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
    assert.equal(page.data.hits.length, 3);
    assert.equal(page.data.error, '');
    assert.match(page.data.browseNotice, /仍可使用/);
    page.onUnload();
    if (original.credentials)
      app.identity.sessions.completeLogin(
        app.identity.sessions.beginLogin(),
        original.credentials,
      );
    discussionMode = true;
    page = mountPage(
      path.join(dist, 'pages/community-search/community-search.js'),
      { scope: 'all' },
    );
    await flush();
    page.onInput({ detail: { value: '校园 İ%_\\' } });
    page.onSubmit();
    await flush();
    assert.deepEqual(
      page.data.hits.map((item) => item.kind),
      ['post', 'comment', 'reply'],
    );
    assert.ok(
      page.data.hits.every(
        (item) =>
          !('images' in item) &&
          !('viewer' in item) &&
          !('commentCount' in item),
      ),
    );
    page.onInput({ detail: { value: 'draft remains unsubmitted' } });
    page.onType({ currentTarget: { dataset: { key: 'reply' } } });
    await flush();
    page.onFromDate({ detail: { value: '2026-10-01' } });
    await flush();
    page.onToDate({ detail: { value: '2026-10-08' } });
    await flush();
    page.onWithinPost({
      currentTarget: { dataset: { postId: postWire().id } },
    });
    await flush();
    const filtered = new URL(requests.at(-1).url);
    assert.equal(filtered.searchParams.get('type'), 'reply');
    assert.equal(
      filtered.searchParams.get('from'),
      '2026-10-01T00:00:00.000000Z',
    );
    assert.equal(
      filtered.searchParams.get('to'),
      '2026-10-08T00:00:00.000000Z',
    );
    assert.equal(filtered.searchParams.get('postId'), postWire().id);
    assert.equal(page.data.inputDraft, 'draft remains unsubmitted');
    const selected = page.data.hits[0];
    const routes = [];
    globalThis.wx.navigateTo = ({ url, success }) => {
      routes.push(url);
      success();
    };
    page.onHit({
      currentTarget: {
        dataset: { kind: selected.kind, id: selected.contentId },
      },
    });
    assert.deepEqual(page.data.hits, []);
    await flush();
    assert.deepEqual(routes, [
      `/pages/community-thread/community-thread?postId=${selected.postId}&rootCommentId=${selected.rootCommentId}&replyId=${selected.replyId}`,
    ]);
    assert.ok(!routes[0].includes('q=') && !routes[0].includes('snippet'));
    page.onHide();
    page.onShow();
    await flush();
    assert.equal(page.data.searchType, 'reply');
    assert.equal(page.data.withinPostId, selected.postId);
    assert.equal(page.data.hits.length, 1);
    page.onClearDates();
    await flush();
    page.onClearPost();
    await flush();
    assert.equal(page.data.from, '');
    assert.equal(page.data.withinPostId, '');
    page.onType({ currentTarget: { dataset: { key: 'all' } } });
    await flush();
    page.onMode({ currentTarget: { dataset: { mode: 'semantic' } } });
    await flush();
    assert.equal(page.data.mode, 'semantic');
    assert.equal(page.data.semanticDisabled, true);
    assert.equal(page.data.loaded, false);
    assert.match(page.data.error, /尚未开启/);
    assert.equal(page.data.inputDraft, 'draft remains unsubmitted');
    assert.equal(
      new URL(requests.at(-1).url).pathname,
      '/v1/community/search/semantic',
    );
    semanticFailure = 'COMMUNITY_UNAVAILABLE';
    page.onRefresh();
    await flush();
    assert.match(page.data.error, /暂时无法确认/);
    assert.deepEqual(page.data.hits, []);
    semanticFailure = '';
    page.onRefresh();
    await flush();
    assert.equal(page.data.hits.length, 1);
    assert.equal(page.data.hits[0].snippet.segments[0].matched, false);
    assert.equal(page.data.continuation, null);
    assert.equal(page.data.pageNumber, 0);
    assert.equal(page.data.canNext, false);
    assert.equal(page.data.canPrevious, false);
    assert.match(page.data.status, /并非全部匹配/);
    const semanticWxml = readFileSync(
      path.join(dist, 'pages/community-search/community-search.wxml'),
      'utf8',
    );
    const rendered = render(parse(semanticWxml).children, page.data, {});
    const renderedText = JSON.stringify(rendered);
    assert.match(renderedText, /语义相关原文 <script>😀/);
    assert.doesNotMatch(renderedText, /第 0 页|下一页/);
    const flattened = (nodes) =>
      nodes.flatMap((node) =>
        typeof node === 'string' ? [] : [node, ...flattened(node.children)],
      );
    assert.ok(
      !flattened(rendered).some(
        (node) =>
          node.tag === 'rich-text' ||
          node.attrs.class === 'match' ||
          node.attrs.bindtap === 'onNext' ||
          node.attrs.bindtap === 'onPrevious',
      ),
    );
    assert.ok(
      flattened(rendered).some(
        (node) =>
          node.attrs['data-mode'] === 'keyword' &&
          node.attrs.bindtap === 'onMode',
      ),
    );
    const semanticCount = requests.length;
    page.onNext();
    page.onPrevious();
    await flush();
    assert.equal(requests.length, semanticCount);
    page.onHide();
    assert.deepEqual(page.data.hits, []);
    page.onShow();
    await flush();
    assert.equal(page.data.mode, 'semantic');
    assert.equal(page.data.hits.length, 1);
    page.onCancel();
    assert.deepEqual(page.data.hits, []);
    page.onMode({ currentTarget: { dataset: { mode: 'keyword' } } });
    await flush();
    assert.equal(new URL(requests.at(-1).url).pathname, '/v1/community/search');
    assert.equal(page.data.mode, 'keyword');
    const wxml = readFileSync(
      path.join(dist, 'pages/community-search/community-search.wxml'),
      'utf8',
    );
    assert.match(wxml, /data-mode="semantic" bindtap="onMode"/);
    assert.match(wxml, /loaded &amp;&amp; mode === 'keyword'/);
    assert.match(wxml, /服务默认未开启/);
    assert.doesNotMatch(wxml, /rich-text|尚不支持语义/);
  } finally {
    page?.onUnload();
    globalThis.wx.navigateTo = original.navigateTo;
    app.community.search = original.search;
    app.community.gateway = original.gateway;
    if (original.credentials)
      app.identity.sessions.completeLogin(
        app.identity.sessions.beginLogin(),
        original.credentials,
      );
  }
  console.log(
    'Search compiled native smoke passed: semantic mode/disabled/unknown/retry/manual keyword fallback, strict unhighlighted DTO, no semantic paging and emitted WXML, lightweight mixed hits, structured reply navigation, type/date/within-post filters, plain server segments, explicit and all/regional/global scopes, no-campus entry, stale optional browse, urgent/resolved and source-space decoding, visible category transitions, frozen query, sparse continuation, fresh previous, membership restart, hide/reopen and account clearing. No physical-device claim.',
  );
}
