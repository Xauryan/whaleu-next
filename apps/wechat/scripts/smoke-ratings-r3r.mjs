import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parse, render } from './smoke-ratings.mjs';
const require = createRequire(import.meta.url);
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};

/** Synthetic native handlers + real gateway/ApiClient + actual bounded WXML
 * branches. The build uses emitted JS; focused tests reuse this model with TS.
 * Neither is WeChat device rendering or actual backend/PostgreSQL acceptance. */
export async function smokeRatingsR3R({ app, dist, flush, extension = 'js' }) {
  const module = (name) => require(path.join(dist, `${name}.${extension}`));
  const { ApiClient } = module('api/client');
  const { HttpRatingRandomGateway } = module('ratings/random-gateway');
  const { HttpProfileGateway } = module('profile/gateway');
  const original = {
    ratingRandom: app.community.ratingRandom,
    profiles: app.community.profiles,
    navigateTo: globalThis.wx.navigateTo,
    credentials: app.identity.sessions.snapshot().credentials,
  };
  const id = (n) => `${String(n).padStart(8, '0')}-dddd-4ddd-8ddd-dddddddddddd`;
  const categoryId = id(1),
    campusId = id(2),
    regionId = id(3),
    targetId = id(4),
    revision = id(5);
  const requests = [],
    pages = [],
    navigations = [];
  const state = { mode: 'known', hold: null, minimumMismatch: false };
  const summary = () =>
    state.mode === 'unknown'
      ? { status: 'unavailable' }
      : {
          status: 'known',
          count: state.mode === 'zero' ? 0 : 1,
          sum: state.mode === 'zero' ? 0 : 5,
          average: state.mode === 'zero' ? null : 5,
          distribution: {
            1: 0,
            2: 0,
            3: 0,
            4: 0,
            5: state.mode === 'zero' ? 0 : 1,
          },
          revision,
        };
  const campus = {
    id: campusId,
    institutionId: '10001',
    institutionName: '合成随机大学',
    fullName: '合成随机大学物理校区',
    shortName: null,
    district: '合成区',
    isActive: true,
  };
  const transport = {
    send: async (request) => {
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname === '/v1/campuses')
        return {
          status: 200,
          headers: {},
          body: {
            items: [campus],
            page: Number(url.searchParams.get('page')),
            pageSize: 20,
            total: 1,
          },
        };
      assert.equal(url.pathname, '/v1/ratings/random-target');
      assert.equal(request.method, 'GET');
      assert.ok(request.headers.Authorization);
      assert.equal(request.body, undefined);
      assert.equal(url.searchParams.has('regionId'), false);
      assert.equal(url.searchParams.has('cursor'), false);
      const hold = state.hold;
      const failure = state.mode === 'unavailable';
      const body = {
        context: {
          categoryId: url.searchParams.get('categoryId'),
          campusId: url.searchParams.get('campusId'),
          minimumAverage: state.minimumMismatch
            ? 1
            : url.searchParams.has('minimumAverage')
              ? Number(url.searchParams.get('minimumAverage'))
              : null,
        },
        candidateCount: state.mode === 'empty' ? 0 : 2048,
        item:
          state.mode === 'empty'
            ? null
            : {
                regionId: url.searchParams.has('campusId') ? regionId : null,
                target: {
                  id: targetId,
                  categoryId,
                  name: '合成完整池目标',
                  description: '来自超过一页的服务端完整候选池',
                  revision,
                  allowedActions: {
                    setScore: state.mode !== 'unknown',
                    createComment: true,
                    authorModes: ['named'],
                  },
                },
                summary: summary(),
              },
      };
      if (hold) await hold.promise;
      return failure
        ? {
            status: 503,
            headers: {},
            body: {
              error: {
                code: 'RATING_SCORE_UNAVAILABLE',
                message: 'Synthetic',
                requestId: id(9),
              },
            },
          }
        : { status: 200, headers: {}, body };
    },
  };
  const api = new ApiClient(
    'https://ratings.example',
    transport,
    app.identity.sessions,
    {
      refresh: async () => app.identity.sessions.snapshot(),
    },
  );
  app.community.ratingRandom = new HttpRatingRandomGateway(api);
  app.community.profiles = new HttpProfileGateway(api);
  globalThis.wx.navigateTo = (options) => {
    navigations.push(options.url);
    options.success?.();
  };
  const source = readFileSync(
    path.join(dist, 'pages/rating-random/rating-random.wxml'),
    'utf8',
  );
  const tree = parse(source);
  const shown = (page) => render(tree.children, page.data, {});
  const visible = (page) => JSON.stringify(shown(page));
  const nodes = (items) =>
    items.flatMap((n) =>
      typeof n === 'string' ? [] : [n, ...nodes(n.children)],
    );
  const buttons = (page, handler) =>
    nodes(shown(page)).filter((node) => node.attrs.bindtap === handler);
  const mount = (route = { categoryId }) => {
    const oldPage = globalThis.Page;
    let page;
    globalThis.Page = (definition) => {
      page = definition;
    };
    const file = path.join(
      dist,
      `pages/rating-random/rating-random.${extension}`,
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
    for (const [, handler] of source.matchAll(/bind(?:tap|input)="([^"]+)"/g))
      assert.equal(
        typeof page[handler],
        'function',
        `random handler ${handler}`,
      );
    pages.push(page);
    page.onLoad(route);
    page.onShow();
    return page;
  };
  const input = (page, handler, value) => page[handler]({ detail: { value } });
  const tap = (page, handler, id) =>
    page[handler]({ currentTarget: { dataset: { id } } });
  const login = (credentials = original.credentials) =>
    app.identity.sessions.completeLogin(
      app.identity.sessions.beginLogin(),
      credentials,
    );
  try {
    const page = mount();
    assert.equal(requests.length, 0);
    assert.match(visible(page), /当前范围：仅全局/);
    assert.equal(buttons(page, 'onDraw').length, 1);
    page.onDraw();
    await flush();
    assert.deepEqual(
      Object.fromEntries(new URL(requests[0].url).searchParams),
      { categoryId },
    );
    assert.match(visible(page), /2048 个目标/);
    assert.match(visible(page), /合成完整池目标/);
    assert.match(visible(page), /将在全局目录中打开/);
    assert.doesNotMatch(visible(page), /全局目标|学校校区地区目标/);
    page.onTarget();
    assert.equal(
      navigations.at(-1),
      `/pages/rating-detail/rating-detail?targetId=${targetId}`,
    );
    state.mode = 'zero';
    page.onDraw();
    await flush();
    assert.match(visible(page), /尚无评分/);
    state.mode = 'unknown';
    page.onDraw();
    await flush();
    assert.match(visible(page), /评分统计未知/);
    assert.equal(visible(page).includes('均分 0'), false);
    state.mode = 'known';
    page.onCampusPicker();
    await flush();
    assert.equal(buttons(page, 'onChooseCampus').length, 1);
    tap(page, 'onChooseCampus', campusId);
    input(page, 'onMinimumAverage', '4.1');
    assert.match(visible(page), /当前范围：所选学校全部校区地区 \+ 全局/);
    page.onDraw();
    await flush();
    assert.deepEqual(
      Object.fromEntries(new URL(requests.at(-1).url).searchParams),
      { categoryId, campusId, minimumAverage: '4.1' },
    );
    assert.match(visible(page), /将在学校校区地区目录中打开/);
    assert.doesNotMatch(visible(page), /学校校区地区目标/);
    page.onTarget();
    assert.equal(
      navigations.at(-1),
      `/pages/rating-detail/rating-detail?targetId=${targetId}&regionId=${regionId}`,
    );
    assert.equal(
      requests.some((request) =>
        new URL(request.url).pathname.startsWith('/v1/me/'),
      ),
      false,
    );
    state.mode = 'empty';
    page.onDraw();
    await flush();
    assert.match(visible(page), /完整候选池：0 个目标/);
    assert.equal(buttons(page, 'onTarget').length, 0);
    state.mode = 'unavailable';
    page.onDraw();
    await flush();
    assert.equal(page.data.result, null);
    assert.match(visible(page), /统计未知.*无法抽取/);
    assert.equal(visible(page).includes('完整候选池：0'), false);
    state.mode = 'known';
    state.minimumMismatch = true;
    page.onDraw();
    await flush();
    assert.equal(page.data.result, null);
    assert.match(visible(page), /格式异常/);
    state.minimumMismatch = false;
    page.onGlobal();
    input(page, 'onMinimumAverage', '');
    const hold = deferred();
    state.hold = hold;
    const before = requests.length;
    page.onDraw();
    page.onDraw();
    page.onDraw();
    await flush();
    assert.equal(requests.length, before + 1);
    page.onCancel();
    assert.equal(page.data.result, null);
    state.hold = null;
    hold.resolve();
    await flush();
    assert.equal(page.data.result, null);
    for (const boundary of ['hide', 'session', 'root', 'safety']) {
      page.onShow();
      const pending = deferred();
      state.hold = pending;
      page.onDraw();
      await flush();
      if (boundary === 'hide') page.onHide();
      if (boundary === 'session')
        login({ ...original.credentials, accountId: id(10) });
      if (boundary === 'root') app.community.privateViews.clear();
      if (boundary === 'safety')
        app.community.safetyChanges.invalidate(
          app.identity.sessions.snapshot().credentials.accountId,
        );
      pending.resolve();
      state.hold = null;
      await flush();
      assert.equal(page.data.result, null);
      assert.equal(page.data.campus, null);
      page.onTarget();
      assert.equal(navigations.length, 2);
      login();
    }
    page.onShow();
    assert.match(visible(page), /当前范围：仅全局/);
    const invalid = mount({ categoryId, regionId });
    assert.equal(buttons(invalid, 'onDraw').length, 0);
    assert.match(visible(invalid), /分类入口无效/);
    const catalogSource = readFileSync(
      path.join(dist, 'pages/rating-catalog/rating-catalog.wxml'),
      'utf8',
    );
    assert.match(catalogSource, /bindtap="onRandom"/);
  } finally {
    for (const page of pages) page.onUnload();
    app.community.ratingRandom = original.ratingRandom;
    app.community.profiles = original.profiles;
    globalThis.wx.navigateTo = original.navigateTo;
    login();
  }
  console.log(
    'Ratings R3R synthetic native/WXML smoke passed: explicit global/campus selection, real strict GET, 2048 pool count, unknown/zero/empty/unavailable, returned-region detail, repeated/cancelled/hidden/session/Safety reads.',
  );
}
