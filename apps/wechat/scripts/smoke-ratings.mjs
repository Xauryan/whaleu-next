import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
// Bounded repository-owned WXML condition/loop/template model, not native rendering.
function parse(source) {
  const root = { tag: 'root', attrs: {}, children: [] },
    stack = [root];
  for (const match of source.matchAll(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g)) {
    const token = match[0];
    if (token.startsWith('<!--')) continue;
    if (token.startsWith('</'))
      assert.equal(stack.pop().tag, token.slice(2, -1).trim());
    else if (token.startsWith('<')) {
      const tag = /^<([\w-]+)/.exec(token)?.[1];
      assert.ok(tag);
      const attrs = Object.fromEntries(
        [...token.matchAll(/([\w:-]+)="([^"]*)"/g)].map((item) => [
          item[1],
          item[2]
            .replaceAll('&amp;', '&')
            .replaceAll('&lt;', '<')
            .replaceAll('&gt;', '>'),
        ]),
      );
      if (/\bwx:else(?:\s|>|\/)/.test(token)) attrs['wx:else'] = '';
      const node = { tag, attrs, children: [] };
      stack.at(-1).children.push(node);
      if (!token.endsWith('/>')) stack.push(node);
    } else if (token.trim()) stack.at(-1).children.push(token);
  }
  assert.equal(stack.length, 1);
  return root;
}
const expression = (source, scope) =>
  Function(
    ...Object.keys(scope),
    `return (${source});`,
  )(...Object.values(scope));
const interpolate = (text, scope) =>
  text.replace(/{{([\s\S]*?)}}/g, (_, source) => expression(source, scope));
function render(nodes, scope, templates) {
  const result = [];
  let matched = false;
  for (const node of nodes) {
    if (typeof node === 'string') {
      result.push(interpolate(node, scope));
      continue;
    }
    if (node.tag === 'import') continue;
    if ('wx:for' in node.attrs) {
      const { ['wx:for']: loop, ...attrs } = node.attrs;
      for (const [index, item] of expression(
        loop.slice(2, -2),
        scope,
      ).entries())
        result.push(
          ...render(
            [{ ...node, attrs }],
            { ...scope, [attrs['wx:for-item'] ?? 'item']: item, index },
            templates,
          ),
        );
      continue;
    }
    if ('wx:if' in node.attrs) matched = false;
    const condition = node.attrs['wx:if'] ?? node.attrs['wx:elif'];
    if ('wx:elif' in node.attrs && matched) continue;
    if (condition !== undefined) {
      if (!expression(condition.slice(2, -2), scope)) continue;
      matched = true;
    } else if ('wx:else' in node.attrs) {
      if (matched) continue;
      matched = true;
    } else matched = false;
    if (node.tag === 'template' && node.attrs.is) {
      const nested = expression(`({${node.attrs.data.slice(2, -2)}})`, scope);
      result.push(
        ...render(templates[node.attrs.is].children, nested, templates),
      );
      continue;
    }
    result.push({
      tag: node.tag,
      attrs: Object.fromEntries(
        Object.entries(node.attrs)
          .filter(([key]) => !key.startsWith('wx:'))
          .map(([key, value]) => [key, interpolate(value, scope)]),
      ),
      children: render(node.children, scope, templates),
    });
  }
  return result;
}
/** Synthetic emitted-page / real ApiClient decoder roundtrip. Not native-device rendering or PostgreSQL proof. */
export async function smokeRatings({ app, dist, flush }) {
  const { ApiClient } = require(path.join(dist, 'api/client.js'));
  const { ClientError } = require(path.join(dist, 'api/errors.js'));
  const { HttpRatingsGateway } = require(path.join(dist, 'ratings/gateway.js'));
  const { PendingRatingStore } = require(path.join(dist, 'ratings/pending.js'));
  const original = {
    ratings: app.community.ratings,
    pending: app.community.pendingRatings,
    newRequestId: app.community.newRequestId,
    credentials: app.identity.sessions.snapshot().credentials,
    navigateTo: globalThis.wx.navigateTo,
  };
  const targetId = '11111111-1111-4111-8111-111111111111',
    categoryId = '22222222-2222-4222-8222-222222222222',
    regionId = '33333333-3333-4333-8333-333333333333',
    revision = '44444444-4444-4444-8444-444444444444',
    nextRevision = '55555555-5555-4555-8555-555555555555',
    commentId = '66666666-6666-4666-8666-666666666666',
    otherTargetId = '77777777-7777-4777-8777-777777777777',
    personaId = '88888888-8888-4888-8888-888888888888',
    otherPersonaId = '99999999-9999-4999-8999-999999999999',
    otherAccount = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cursor = 'a'.repeat(43),
    now = '2026-10-08T12:00:00.123456Z';
  const publicName = '合成评分目标',
    rootBody = '合成独立文字评价',
    requests = [],
    commands = [],
    navigation = [],
    stored = new Map(),
    receipts = new Map(),
    pages = [];
  let requestNumber = 1,
    minted = 0;
  const nextId = () =>
    `${String(requestNumber++).padStart(8, '0')}-cccc-4ccc-8ccc-cccccccccccc`;
  const state = {
    score: null,
    scoreRevision: revision,
    roots: [],
    unavailable: false,
    active: true,
    holdDetail: null,
    holdCommand: null,
    holdId: null,
    failStorage: false,
    failRemove: false,
    loseReply: false,
    terminal: null,
    missingReceipt: false,
    hiddenScan: false,
  };
  const category = (parentId = null) => ({
    id: parentId === null ? categoryId : otherTargetId,
    parentId,
    level: parentId === null ? 1 : 2,
    kind: 'general',
    systemKey: null,
    name: parentId === null ? '合成根分类' : '合成子分类',
    description: '',
    revision,
  });
  const target = (id = targetId) => ({
    id,
    categoryId,
    name: id === targetId ? publicName : '另一个合成目标',
    description: '合成目标描述',
    revision,
    allowedActions: {
      setScore: !state.unavailable,
      createComment: true,
      authorModes: ['named', 'anonymous'],
    },
  });
  const root = (id = targetId, authorMode = 'anonymous', body = rootBody) => ({
    id: commentId,
    targetId: id,
    body,
    revision,
    createdAt: now,
    author:
      authorMode === 'anonymous'
        ? {
            mode: 'anonymous',
            targetId: id,
            personaId: id === targetId ? personaId : otherPersonaId,
            displayName:
              id === targetId ? '本目标合成分身' : '另一目标合成分身',
          }
        : { mode: 'named', profileId: personaId, displayName: '合成公开姓名' },
    isMine: true,
    allowedActions: { delete: true },
  });
  const summary = () =>
    state.unavailable
      ? { status: 'unavailable' }
      : {
          status: 'known',
          count: state.score === null ? 0 : 1,
          sum: state.score ?? 0,
          average: state.score,
          distribution: Object.fromEntries(
            [1, 2, 3, 4, 5].map((score) => [
              String(score),
              state.score === score ? 1 : 0,
            ]),
          ),
          revision: state.scoreRevision,
        };
  const ok = (body) => ({ status: 200, headers: {}, body });
  const error = (status, code) => ({
    status,
    headers: {},
    body: { error: { code } },
  });
  const api = new ApiClient(
    'https://ratings-smoke.example',
    {
      send: async (request) => {
        requests.push(request);
        assert.ok(request.headers.Authorization);
        const url = new URL(request.url),
          pathname = url.pathname,
          scope = url.searchParams.get('regionId');
        if (request.method === 'GET') assert.equal(request.body, undefined);
        if (pathname.startsWith('/v1/ratings/requests/')) {
          const id = pathname.split('/').at(-1);
          return !state.missingReceipt && receipts.has(id)
            ? ok(receipts.get(id))
            : error(404, 'REQUEST_NOT_FOUND');
        }
        if (pathname === '/v1/ratings/context')
          return ok({
            homeRegion: { id: regionId, label: '合成身份地区' },
            regions: [
              { id: regionId, label: '合成身份地区', relation: 'home' },
            ],
          });
        if (pathname === '/v1/ratings/categories') {
          const parentId = url.searchParams.get('parentId');
          return ok({
            context: { regionId: scope, catalogRevision: revision, parentId },
            items: [category(parentId)],
            nextCursor: null,
            continuation: 'end',
          });
        }
        if (pathname === '/v1/ratings/targets')
          return ok({
            context: {
              regionId: scope,
              catalogRevision: revision,
              categoryId: url.searchParams.get('categoryId'),
            },
            items: [target()],
            nextCursor: null,
            continuation: 'end',
          });
        if (request.method !== 'GET') {
          commands.push(request);
          assert.equal(
            request.body.regionId === null ||
              request.body.regionId === regionId,
            true,
          );
          assert.equal(request.body.expectedTargetRevision, revision);
          assert.ok(stored.size > 0, 'immutable journal precedes dispatch');
          if (state.holdCommand) await state.holdCommand.promise;
          const operation =
            request.method === 'PUT'
              ? 'set_score'
              : request.method === 'POST'
                ? 'create_comment'
                : 'delete_comment';
          let result = receipts.get(request.body.clientRequestId);
          if (!result) {
            let outcome = 'applied',
              rejection = state.terminal;
            if (!state.active) rejection = 'RATING_NOT_FOUND';
            if (
              operation === 'set_score' &&
              request.body.expectedRevision !==
                (state.score === null ? null : state.scoreRevision)
            )
              rejection = 'RATING_REVISION_CONFLICT';
            if (rejection)
              result = {
                requestId: request.body.clientRequestId,
                operation,
                outcome: 'rejected',
                code: rejection,
              };
            else {
              if (operation === 'set_score') {
                assert.deepEqual(Object.keys(request.body).sort(), [
                  'clientRequestId',
                  'expectedRevision',
                  'expectedTargetRevision',
                  'regionId',
                  'score',
                ]);
                if (state.score === request.body.score) outcome = 'noop';
                else {
                  state.score = request.body.score;
                  state.scoreRevision = nextRevision;
                }
              } else if (operation === 'create_comment') {
                assert.deepEqual(request.body.assetIds, []);
                assert.equal('score' in request.body, false);
                state.roots = [
                  root(targetId, request.body.authorMode, request.body.body),
                ];
              } else {
                assert.equal(request.body.targetId, targetId);
                state.roots = [];
              }
              result = {
                requestId: request.body.clientRequestId,
                operation,
                outcome,
                targetId,
                subjectId: operation === 'set_score' ? targetId : commentId,
                revision:
                  operation === 'set_score'
                    ? state.scoreRevision
                    : nextRevision,
                occurredAt: now,
              };
            }
            receipts.set(request.body.clientRequestId, result);
          }
          if (state.loseReply)
            throw new ClientError(
              'timeout',
              'Synthetic committed response loss',
            );
          return ok(result);
        }
        if (!state.active) return error(404, 'RATING_NOT_FOUND');
        const id = pathname.split('/')[4];
        if (pathname.endsWith('/my-score'))
          return state.unavailable
            ? error(503, 'RATING_SCORE_UNAVAILABLE')
            : ok({
                myScore:
                  state.score === null
                    ? null
                    : { score: state.score, revision: state.scoreRevision },
              });
        if (pathname.endsWith('/score-summary')) return ok(summary());
        if (pathname.endsWith('/comments')) {
          const scan = state.hiddenScan && !url.searchParams.has('cursor');
          return ok({
            context: {
              regionId: scope,
              catalogRevision: revision,
              targetId: id,
            },
            items: scan
              ? []
              : id === targetId
                ? state.roots
                : [root(otherTargetId)],
            nextCursor: scan ? cursor : null,
            continuation: scan ? 'scan' : 'end',
          });
        }
        if (pathname.startsWith('/v1/ratings/targets/')) {
          const snapshot = target(id);
          if (state.holdDetail) await state.holdDetail.promise;
          return ok(snapshot);
        }
        if (pathname === `/v1/ratings/comments/${commentId}`)
          return state.roots.length
            ? ok(state.roots[0])
            : error(404, 'RATING_NOT_FOUND');
        throw new Error(`Unexpected ratings smoke route ${pathname}`);
      },
    },
    app.identity.sessions,
    {
      refresh: async () => {
        throw new Error('Unexpected synthetic refresh');
      },
    },
  );
  app.community.ratings = new HttpRatingsGateway(api);
  app.community.pendingRatings = new PendingRatingStore(
    {
      get: (key) => stored.get(key),
      set: (key, value) => {
        if (state.failStorage) throw new Error('Synthetic storage failure');
        stored.set(key, value);
      },
      remove: (key) => {
        if (state.failRemove) throw new Error('Synthetic remove failure');
        stored.delete(key);
      },
    },
    'synthetic-ratings-smoke',
  );
  app.community.newRequestId = async () => {
    minted++;
    return state.holdId ? state.holdId.promise : nextId();
  };
  globalThis.wx.navigateTo = (options) => navigation.push(options);
  const templates = Object.fromEntries(
    parse(readFileSync(path.join(dist, 'ratings/common.wxml'), 'utf8'))
      .children.filter((n) => typeof n !== 'string')
      .map((n) => [n.attrs.name, n]),
  );
  const source = (mode) =>
    readFileSync(
      path.join(dist, `pages/rating-${mode}/rating-${mode}.wxml`),
      'utf8',
    );
  const presented = (mode, page) =>
    render(parse(source(mode)).children, page.data, templates);
  const visible = (mode, page) => JSON.stringify(presented(mode, page));
  const nodes = (entries) =>
    entries.flatMap((n) =>
      typeof n === 'string' ? [] : [n, ...nodes(n.children)],
    );
  const buttons = (mode, page, handler) =>
    nodes(presented(mode, page)).filter((n) => n.attrs.bindtap === handler);
  const mount = (mode, route = {}) => {
    let page;
    const oldPage = globalThis.Page;
    globalThis.Page = (definition) => {
      page = definition;
    };
    const module = path.join(dist, `pages/rating-${mode}/rating-${mode}.js`);
    try {
      delete require.cache[require.resolve(module)];
      require(module);
    } finally {
      globalThis.Page = oldPage;
    }
    page.setData = (data) => {
      page.data = { ...page.data, ...data };
    };
    for (const handler of [
      ...(
        source(mode) +
        readFileSync(path.join(dist, 'ratings/common.wxml'), 'utf8')
      ).matchAll(/bind(?:tap|input)="([^"]+)"/g),
    ])
      assert.equal(
        typeof page[handler[1]],
        'function',
        `emitted ${handler[1]} handler`,
      );
    pages.push(page);
    page.onLoad(route);
    page.onShow();
    return page;
  };
  const tap = (page, handler, dataset = {}) =>
    page[handler]({ currentTarget: { dataset } });
  const clear = (page) => {
    assert.equal(page.data.detail, null);
    assert.deepEqual(page.data.comments, []);
    assert.equal(page.data.myScore, null);
    assert.equal(page.data.summary, null);
    assert.equal(page.data.text, '');
    assert.equal(page.data.textLength, 0);
    assert.equal(page.data.authorMode, null);
    assert.equal(page.data.composerOpen, false);
    assert.equal(page.data.selectedScore, null);
    assert.equal(page.data.deleteId, null);
    assert.equal(page.data.canMoreComments, false);
  };
  try {
    const config = JSON.parse(
      readFileSync(path.join(dist, 'app.json'), 'utf8'),
    );
    for (const mode of ['catalog', 'detail', 'recovery']) {
      assert.ok(config.pages.includes(`pages/rating-${mode}/rating-${mode}`));
      assert.doesNotMatch(
        source(mode),
        /<image|rich-text|chooseImage|subscribeMessage|requestPayment|bindtap="[^"]*(?:Like|Reply|Subscribe|Upload|Image)/i,
      );
    }
    assert.match(
      readFileSync(
        path.join(dist, 'pages/community-feed/community-feed.wxml'),
        'utf8',
      ),
      /\/pages\/rating-catalog\/rating-catalog/,
    );
    let page = mount('catalog');
    await flush();
    assert.equal(page.data.loaded, true);
    assert.equal(page.data.regionId, null);
    assert.ok(visible('catalog', page).includes('合成根分类'));
    tap(page, 'onCategory', { id: categoryId });
    tap(page, 'onCategory', { id: categoryId });
    assert.equal(navigation.length, 1);
    assert.equal(
      navigation[0].url,
      `/pages/rating-catalog/rating-catalog?parentId=${categoryId}`,
    );
    page.onHide();
    navigation[0].fail();
    assert.equal(page.data.error, '');
    page.onUnload();
    page = mount('catalog', { parentId: categoryId });
    await flush();
    assert.ok(visible('catalog', page).includes(publicName));
    tap(page, 'onTarget', { id: targetId });
    assert.equal(
      navigation.at(-1).url,
      `/pages/rating-detail/rating-detail?targetId=${targetId}`,
    );
    page.onUnload();
    page = mount('catalog');
    await flush();
    page.onRegions();
    await flush();
    assert.ok(visible('catalog', page).includes('合成身份地区'));
    tap(page, 'onRegion', { id: regionId });
    await flush();
    assert.equal(page.data.regionId, regionId);
    page.onHide();
    page.onShow();
    await flush();
    assert.equal(page.data.regionId, regionId);
    tap(page, 'onRegion', { id: '' });
    await flush();
    assert.equal(page.data.regionId, null);
    page.onUnload();

    page = mount('detail', { targetId });
    await flush();
    let text = visible('detail', page);
    assert.ok(text.includes('你尚未评分'));
    assert.ok(text.includes('暂无评分'));
    assert.ok(!text.includes('统计暂时未知'));
    assert.equal(buttons('detail', page, 'onScore').length, 5);
    tap(page, 'onScore', { score: '0' });
    assert.equal(page.data.selectedScore, null);
    tap(page, 'onScore', { score: '1e0' });
    assert.equal(page.data.selectedScore, null);
    tap(page, 'onScore', { score: '5' });
    assert.ok(visible('detail', page).includes('确认提交 5 分'));
    assert.equal(
      buttons('detail', page, 'onConfirmScore')[0].attrs.disabled,
      'false',
    );
    state.holdId = deferred();
    const beforeId = minted;
    page.onConfirmScore();
    page.onConfirmScore();
    await flush();
    assert.equal(minted, beforeId + 1);
    page.onDismissScore();
    clear(page);
    state.holdId.resolve(nextId());
    await flush();
    state.holdId = null;
    assert.equal(commands.length, 0);
    assert.equal(stored.size, 0);
    page.onRefresh();
    await flush();
    tap(page, 'onScore', { score: 5 });
    state.holdCommand = deferred();
    state.loseReply = true;
    page.onConfirmScore();
    page.onConfirmScore();
    await flush();
    assert.equal(commands.length, 1);
    clear(page);
    assert.equal(page.data.frozen, true);
    assert.equal(buttons('detail', page, 'onRetry')[0].attrs.disabled, 'true');
    const first = structuredClone(commands[0].body);
    state.holdCommand.resolve();
    await flush();
    state.holdCommand = null;
    assert.equal(page.data.frozen, true);
    assert.ok(visible('detail', page).includes('重试原请求'));
    state.loseReply = false;
    state.missingReceipt = true;
    page.onRecover();
    await flush();
    assert.equal(page.data.frozen, true);
    assert.equal(stored.size, 1);
    assert.equal(commands.length, 1);
    page.onRetry();
    await flush();
    state.missingReceipt = false;
    assert.equal(commands.length, 2);
    assert.deepEqual(commands[1].body, first);
    assert.equal(state.score, 5);
    assert.equal(page.data.myScore.score, 5);
    assert.equal(page.data.summary.count, 1);
    assert.equal(stored.size, 0);
    text = visible('detail', page);
    assert.ok(text.includes('当前 5 分'));
    assert.ok(text.includes('5 分 · 1 人评分'));
    const unchanged = JSON.stringify(summary());
    tap(page, 'onScore', { score: 5 });
    page.onConfirmScore();
    await flush();
    assert.equal(JSON.stringify(summary()), unchanged);
    assert.ok(visible('detail', page).includes('未发生变更'));

    page.onCompose();
    page.onText({ detail: { value: '😀'.repeat(501) } });
    tap(page, 'onAuthorMode', { mode: 'anonymous' });
    assert.equal(
      buttons('detail', page, 'onPublish')[0].attrs.disabled,
      'true',
    );
    const beforeText = commands.length;
    page.onPublish();
    await flush();
    assert.equal(commands.length, beforeText);
    page.onText({ detail: { value: ` \r\n${rootBody}\r\n ` } });
    assert.equal(page.data.textLength, [...rootBody].length);
    assert.equal(
      buttons('detail', page, 'onPublish')[0].attrs.disabled,
      'false',
    );
    page.onPublish();
    page.onPublish();
    await flush();
    assert.equal(commands.length, beforeText + 1);
    assert.equal(commands.at(-1).body.body, rootBody);
    assert.equal(state.score, 5);
    assert.ok(visible('detail', page).includes(rootBody));
    assert.ok(visible('detail', page).includes('本目标合成分身'));
    tap(page, 'onDelete', { id: commentId });
    assert.ok(visible('detail', page).includes('独立评分仍保留'));
    page.onDismissDelete();
    assert.equal(page.data.deleteId, null);
    tap(page, 'onDelete', { id: commentId });
    page.onConfirmDelete();
    page.onConfirmDelete();
    await flush();
    assert.equal(state.roots.length, 0);
    assert.equal(state.score, 5);
    assert.ok(!visible('detail', page).includes(rootBody));
    assert.equal(page.data.myScore.score, 5);
    for (const result of receipts.values())
      assert.equal(JSON.stringify(result).includes(rootBody), false);

    // Cross-device conflict is terminal for this attempt and requires explicit refresh.
    tap(page, 'onScore', { score: 4 });
    state.score = 1;
    state.scoreRevision = otherPersonaId;
    page.onConfirmScore();
    await flush();
    assert.equal(page.data.needsRefresh, true);
    assert.equal(page.data.frozen, false);
    clear(page);
    assert.ok(visible('detail', page).includes('刷新后重新确认'));
    const conflictCommands = commands.length;
    page.onConfirmScore();
    await flush();
    assert.equal(commands.length, conflictCommands);
    page.onRefresh();
    await flush();
    assert.equal(page.data.myScore.score, 1);
    assert.equal(page.data.selectedScore, null);
    state.unavailable = true;
    page.onRefresh();
    await flush();
    text = visible('detail', page);
    assert.ok(text.includes('自己的评分暂时未知'));
    assert.ok(text.includes('统计暂时未知'));
    assert.ok(!text.includes('暂无评分'));
    assert.equal(buttons('detail', page, 'onScore').length, 0);
    state.unavailable = false;
    state.roots = [root()];
    state.hiddenScan = true;
    page.onRefresh();
    await flush();
    assert.equal(page.data.comments.length, 0);
    assert.equal(buttons('detail', page, 'onMoreComments').length, 1);
    page.onMoreComments();
    await flush();
    assert.equal(page.data.comments.length, 1);
    assert.ok(visible('detail', page).includes(rootBody));
    assert.equal(buttons('detail', page, 'onMoreComments').length, 0);
    state.hiddenScan = false;
    page.onUnload();

    // A late old-target detail never reintroduces its persona on another target.
    state.holdDetail = deferred();
    page = mount('detail', { targetId });
    await flush();
    page.onHide();
    const held = state.holdDetail;
    state.holdDetail = null;
    const otherPage = mount('detail', { targetId: otherTargetId });
    await flush();
    held.resolve();
    await flush();
    clear(page);
    assert.ok(visible('detail', otherPage).includes('另一目标合成分身'));
    assert.ok(!visible('detail', otherPage).includes('本目标合成分身'));
    page.onUnload();
    otherPage.onUnload();

    // Every lifecycle boundary clears native page data and actual WXML output.
    const boundaries = [
      ['hide', (p) => p.onHide()],
      ['cancel', (p) => p.onCancel()],
      [
        'Safety',
        () =>
          app.community.safetyChanges.invalidate(
            original.credentials.accountId,
          ),
      ],
      [
        'identity campus',
        () =>
          app.community.directoryScopeChanges.clear(
            original.credentials.accountId,
          ),
      ],
      [
        'browse campus',
        () =>
          app.community.browsingScopeChanges.clear(
            original.credentials.accountId,
          ),
      ],
      [
        'same-account epoch',
        () =>
          app.identity.sessions.completeLogin(
            app.identity.sessions.beginLogin(),
            original.credentials,
          ),
      ],
      [
        'account replacement',
        () =>
          app.identity.sessions.completeLogin(
            app.identity.sessions.beginLogin(),
            { ...original.credentials, accountId: otherAccount },
          ),
      ],
      ['root app hide', () => app.community.privateViews.clear()],
    ];
    for (const [label, interrupt] of boundaries) {
      page = mount('detail', { targetId });
      await flush();
      page.onCompose();
      tap(page, 'onAuthorMode', { mode: 'anonymous' });
      page.onText({ detail: { value: '不应保留的合成输入' } });
      interrupt(page);
      clear(page);
      assert.ok(!visible('detail', page).includes(rootBody), label);
      assert.ok(!visible('detail', page).includes('不应保留的合成输入'), label);
      page.onUnload();
      if (
        app.identity.sessions.snapshot().credentials?.accountId !==
        original.credentials.accountId
      )
        app.identity.sessions.completeLogin(
          app.identity.sessions.beginLogin(),
          original.credentials,
        );
    }

    // Storage failure never dispatches; recovery checks the same immutable journal.
    page = mount('detail', { targetId });
    await flush();
    tap(page, 'onScore', { score: 4 });
    state.failStorage = true;
    const beforeStorage = commands.length;
    page.onConfirmScore();
    await flush();
    assert.equal(commands.length, beforeStorage);
    assert.equal(page.data.frozen, true);
    assert.ok(visible('detail', page).includes('保存失败'));
    state.failStorage = false;
    page.onRefresh();
    await flush();
    state.failRemove = true;
    tap(page, 'onScore', { score: 4 });
    page.onConfirmScore();
    await flush();
    assert.equal(page.data.frozen, true);
    assert.equal(stored.size, 1);
    state.failRemove = false;
    page.onRecover();
    await flush();
    assert.equal(stored.size, 0);
    assert.equal(page.data.myScore.score, 4);

    // An account-owned receipt recovers after parent disablement without historical content.
    page.onCompose();
    tap(page, 'onAuthorMode', { mode: 'named' });
    page.onText({ detail: { value: rootBody } });
    state.loseReply = true;
    page.onPublish();
    await flush();
    assert.equal(page.data.frozen, true);
    state.loseReply = false;
    page.onUnload();
    state.active = false;
    const beforeRecovery = requests.length;
    page = mount('recovery');
    await flush();
    assert.equal(stored.size, 0);
    assert.equal(page.data.loaded, true);
    clear(page);
    assert.ok(visible('recovery', page).includes('历史操作结果已确认'));
    assert.ok(!visible('recovery', page).includes(rootBody));
    assert.equal(
      requests
        .slice(beforeRecovery)
        .filter(
          (r) => !new URL(r.url).pathname.startsWith('/v1/ratings/requests/'),
        ).length,
      0,
    );
    page.onUnload();
    page = mount('detail', { targetId });
    await flush();
    clear(page);
    assert.ok(visible('detail', page).includes('当前不可查看'));
    assert.equal(page.data.loaded, false);
    page.onUnload();
  } finally {
    for (const page of pages) page.onUnload?.();
    app.community.ratings = original.ratings;
    app.community.pendingRatings = original.pending;
    app.community.newRequestId = original.newRequestId;
    globalThis.wx.navigateTo = original.navigateTo;
    app.identity.sessions.completeLogin(
      app.identity.sessions.beginLogin(),
      original.credentials,
    );
  }
  console.log(
    'Ratings emitted handlers, real ApiClient/strict gateway, and bounded WXML condition/loop/template model passed (synthetic; not native rendering).',
  );
}
