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
          item[2].replaceAll('&amp;', '&'),
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
export async function smokeActivities({ app, dist, flush }) {
  const { ApiClient } = require(path.join(dist, 'api/client.js'));
  const { HttpActivitiesGateway } = require(
    path.join(dist, 'activities/gateway.js'),
  );
  const { HttpProfileGateway } = require(path.join(dist, 'profile/gateway.js'));
  const { PendingActivityVisitStore } = require(
    path.join(dist, 'activities/pending.js'),
  );
  const original = {
    activities: app.community.activities,
    profiles: app.community.profiles,
    pending: app.community.pendingActivityVisits,
    credentials: app.identity.sessions.snapshot().credentials,
    navigateTo: globalThis.wx.navigateTo,
    newRequestId: app.community.newRequestId,
  };
  const regionId = '11111111-1111-4111-8111-111111111111',
    activityId = '22222222-2222-4222-8222-222222222222',
    revision = '33333333-3333-4333-8333-333333333333',
    requestId = '77777777-7777-4777-8777-777777777777',
    otherRegion = '44444444-4444-4444-8444-444444444444';
  const cursor = Buffer.alloc(32, 1).toString('base64url'),
    nextCursor = Buffer.alloc(32, 2).toString('base64url');
  let profile = {
    accountId: original.credentials.accountId,
    nickname: null,
    bio: '',
    selectedCampus: null,
    revision: 0,
    preferences: {
      showOfficialAccountTip: true,
      showHotTopic: true,
      showGroupNotice: true,
      showTradingGroupNotice: true,
      showErrandGroupNotice: true,
      defaultAnonymousEnabled: false,
      defaultCommentAnonymousEnabled: false,
      defaultCommentNonAnonymousEnabled: false,
      defaultAllowAnonymousDm: false,
      hideProfilePosts: false,
      activitySubscribed: true,
    },
  };
  const state = {
    regionId,
    holdRead: null,
    holdVisit: null,
    error: null,
    empty: false,
    knownEmpty: false,
    paging: false,
    historical: false,
    visitLoss: false,
    preferenceConflict: false,
    preferenceLoss: false,
  };
  const requests = [],
    visits = [],
    navigation = [],
    stored = new Map();
  const summary = (id = activityId) => ({
    id,
    revision,
    title: '  合成活动原文\r\n标题  ',
    organizerLabel: '合成主办方快照',
    reward: { status: 'unavailable', value: null },
    online: { status: 'known', value: 'offline' },
    createdAt: { status: 'unavailable', value: null },
    cover: { status: 'unavailable' },
    organizerAvatar: { status: 'absent' },
  });
  const detail = () => ({
    ...summary(),
    regionId,
    bodyText: '  完整介绍\r\n<b>保留原文</b>  ',
    activityTime: '周末 下午\n时间待定',
    activityLocation: '  活动中心  ',
    gallery: state.knownEmpty
      ? { status: 'known_empty', items: [] }
      : { status: 'unavailable', items: null },
    organizerQr: { status: 'unavailable' },
  });
  const api = new ApiClient(
    'https://api.example',
    {
      send: async (request) => {
        requests.push(request);
        assert.ok(request.headers.Authorization);
        const url = new URL(request.url),
          ok = (body) => ({ status: 200, headers: {}, body });
        if (request.method === 'GET') assert.equal(request.body, undefined);
        if (url.pathname === '/v1/me/profile') return ok(profile);
        if (url.pathname === '/v1/me/preferences') {
          assert.equal(request.method, 'PATCH');
          if (state.preferenceConflict) {
            state.preferenceConflict = false;
            profile = { ...profile, revision: profile.revision + 1 };
            return {
              status: 409,
              headers: {},
              body: { error: { code: 'PROFILE_REVISION_CONFLICT' } },
            };
          }
          if (state.preferenceLoss) throw new Error('synthetic network');
          assert.equal(request.body.expectedRevision, profile.revision);
          profile = {
            ...profile,
            revision: profile.revision + 1,
            preferences: {
              ...profile.preferences,
              ...request.body.preferences,
            },
          };
          return ok(profile);
        }
        if (url.pathname.startsWith('/v1/me/activity-visits/')) {
          assert.equal(request.method, 'PUT');
          visits.push(request);
          if (state.holdVisit) await state.holdVisit.promise;
          if (state.visitLoss) throw new Error('synthetic response loss');
          return ok({
            requestId: url.pathname.split('/').at(-1),
            regionId: request.body.regionId,
            catalogRevision: request.body.expectedCatalogRevision,
            visitedAt: '2026-10-08T12:00:00.123456Z',
          });
        }
        if (url.pathname === '/v1/activities/context') {
          if (state.holdRead) await state.holdRead.promise;
          return ok({
            regionId: state.regionId,
            visitHistory: 'never_visited',
          });
        }
        if (state.error)
          return {
            status: 503,
            headers: {},
            body: { error: { code: state.error } },
          };
        if (url.pathname.endsWith(`/${activityId}`)) return ok(detail());
        assert.equal(url.pathname, `/v1/regions/${regionId}/activities`);
        const current = url.searchParams.get('cursor'),
          more = state.paging && current !== nextCursor;
        const items = state.empty
          ? []
          : more
            ? Array.from({ length: 20 }, (_, i) =>
                summary(
                  i === 0
                    ? activityId
                    : `${String(i).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
                ),
              )
            : [summary()];
        return ok({
          context: { regionId, catalogRevision: revision },
          selection:
            url.searchParams.get('window') === 'all'
              ? { kind: 'all' }
              : state.historical
                ? { kind: 'historical', maximum: 10 }
                : { kind: 'recent', since: '2026-10-05T12:00:00Z' },
          items,
          continuation: more ? 'more' : 'end',
          nextCursor: more ? nextCursor : null,
          pageCursor: current ?? cursor,
        });
      },
    },
    app.identity.sessions,
    {
      refresh: async () => {
        throw new Error('Unexpected refresh');
      },
    },
  );
  app.community.activities = new HttpActivitiesGateway(api);
  app.community.profiles = new HttpProfileGateway(api);
  app.community.pendingActivityVisits = new PendingActivityVisitStore(
    {
      get: (key) => stored.get(key),
      set: (key, value) => stored.set(key, value),
      remove: (key) => stored.delete(key),
    },
    'activity-smoke',
  );
  app.community.newRequestId = async () => requestId;
  globalThis.wx.navigateTo = (options) => navigation.push(options);
  const templates = Object.fromEntries(
    parse(readFileSync(path.join(dist, 'activities/facts.wxml'), 'utf8'))
      .children.filter((node) => typeof node !== 'string')
      .map((node) => [node.attrs.name, node]),
  );
  const source = (mode) =>
    readFileSync(
      path.join(dist, `pages/activity-${mode}/activity-${mode}.wxml`),
      'utf8',
    );
  const presented = (mode, page) =>
    JSON.stringify(render(parse(source(mode)).children, page.data, templates));
  const mount = (mode, query = {}, holdRender = false) => {
    let page;
    const old = globalThis.Page;
    globalThis.Page = (definition) => {
      page = definition;
    };
    const module = path.join(
      dist,
      `pages/activity-${mode}/activity-${mode}.js`,
    );
    delete require.cache[require.resolve(module)];
    require(module);
    globalThis.Page = old;
    page.renderCallbacks = [];
    page.setData = (data, callback) => {
      page.data = { ...page.data, ...data };
      if (callback) {
        if (holdRender) page.renderCallbacks.push(callback);
        else callback();
      }
    };
    page.onLoad(query);
    page.onShow();
    return page;
  };
  for (const mode of ['list', 'detail'])
    assert.doesNotMatch(
      source(mode),
      /<image|rich-text|previewImage|subscribeMessage|data-url|eventChannel/i,
    );
  const feed = readFileSync(
    path.join(dist, 'pages/community-feed/community-feed.wxml'),
    'utf8',
  );
  assert.match(feed, /\/pages\/activity-list\/activity-list/);
  let page = mount('list');
  await flush();
  assert.equal(page.data.loaded, true);
  assert.equal(visits.length, 1);
  assert.equal(page.data.visit.confirmed, true);
  let text = presented('list', page);
  for (const expected of [
    '合成主办方快照',
    '奖励信息未确认',
    '线下活动',
    '发布时间暂不可用',
    '封面暂不可用',
    '最近 72 小时',
    '消息投递尚未接入',
  ])
    assert.ok(text.includes(expected), expected);
  state.historical = true;
  page.onRefresh();
  await flush();
  assert.ok(presented('list', page).includes('最近 10 条历史活动'));
  state.historical = false;
  page.onActivity({ currentTarget: { dataset: { id: activityId } } });
  page.onActivity({ currentTarget: { dataset: { id: activityId } } });
  assert.equal(navigation.length, 1);
  assert.equal(
    navigation[0].url,
    `/pages/activity-detail/activity-detail?regionId=${regionId}&activityId=${activityId}`,
  );
  page.onHide();
  assert.equal(page.data.items.length, 0);
  navigation[0].fail();
  assert.equal(page.data.error, '');
  const visitCount = visits.length;
  let child = mount('detail', { regionId, activityId });
  await flush();
  assert.equal(child.data.loaded, true);
  assert.equal(visits.length, visitCount);
  text = presented('detail', child);
  for (const expected of [
    '完整介绍',
    '保留原文',
    '周末 下午',
    '活动中心',
    '尚不能确认是否有图片',
    '主办方二维码暂不可用',
  ])
    assert.ok(text.includes(expected), expected);
  child.onHide();
  assert.equal(child.data.detail, null);
  state.knownEmpty = true;
  child.onShow();
  await flush();
  assert.ok(presented('detail', child).includes('无介绍图片'));
  child.onUnload();
  state.paging = true;
  page.onShow();
  await flush();
  page.onNext();
  await flush();
  assert.equal(page.data.pageNumber, 2);
  page.onPrevious();
  await flush();
  assert.equal(page.data.pageNumber, 1);
  assert.equal(
    new URL(
      requests
        .filter((r) => new URL(r.url).pathname.endsWith('/activities'))
        .at(-1).url,
    ).searchParams.get('cursor'),
    cursor,
  );
  page.onUnload();
  state.paging = false;
  state.error = 'ACTIVITY_ENTRY_SELECTION_UNAVAILABLE';
  page = mount('list');
  await flush();
  assert.equal(page.data.loaded, false);
  assert.equal(page.data.entryUnavailable, true);
  const beforeAll = visits.length;
  state.error = null;
  state.empty = true;
  page.onAll();
  await flush();
  assert.equal(page.data.loaded, true);
  assert.equal(visits.length, beforeAll + 1);
  assert.ok(presented('list', page).includes('没有活动'));
  page.onUnload();
  state.empty = false;
  for (const invalidation of ['hide', 'scope', 'root', 'relogin']) {
    const before = visits.length;
    page = mount('list', {}, true);
    await flush();
    assert.equal(page.data.loaded, true);
    assert.equal(visits.length, before);
    if (invalidation === 'hide') page.onHide();
    if (invalidation === 'scope')
      app.community.directoryScopeChanges.clear(original.credentials.accountId);
    if (invalidation === 'root') app.community.privateViews.clear();
    if (invalidation === 'relogin')
      app.identity.sessions.completeLogin(
        app.identity.sessions.beginLogin(),
        original.credentials,
      );
    for (const callback of page.renderCallbacks) callback();
    await flush();
    assert.equal(visits.length, before, invalidation);
    assert.equal(page.data.loaded, false);
    page.onUnload();
  }
  state.holdRead = deferred();
  page = mount('list');
  await flush();
  page.onHide();
  state.holdRead.resolve();
  await flush();
  assert.equal(page.data.loaded, false);
  page.onUnload();
  state.holdRead = null;
  state.regionId = otherRegion;
  child = mount('detail', { regionId, activityId });
  await flush();
  assert.equal(child.data.detail, null);
  assert.match(child.data.error, /身份校区/);
  child.onUnload();
  state.regionId = regionId;
  state.visitLoss = true;
  page = mount('list');
  await flush();
  assert.equal(page.data.visit.pending, true);
  const lost = visits.at(-1);
  page.onHide();
  app.identity.sessions.completeLogin(
    app.identity.sessions.beginLogin(),
    original.credentials,
  );
  state.visitLoss = false;
  page.onShow();
  await flush();
  assert.equal(page.data.visit.pending, true);
  const beforeRetry = visits.length;
  page.onVisitRetry();
  page.onVisitRetry();
  await flush();
  assert.equal(visits.length, beforeRetry + 1);
  assert.equal(visits.at(-1).url, lost.url);
  assert.deepEqual(visits.at(-1).body, lost.body);
  assert.equal(page.data.visit.confirmed, true);
  assert.equal(stored.size, 0);
  page.onPreference({ detail: { value: false } });
  page.onPreferenceSave();
  await flush();
  assert.equal(page.data.preference.checked, false);
  assert.equal(page.data.preference.dirty, false);
  state.preferenceConflict = true;
  page.onPreference({ detail: { value: true } });
  page.onPreferenceSave();
  await flush();
  assert.equal(page.data.preference.checked, false);
  assert.match(page.data.preference.status, /核对/);
  assert.equal(page.data.preference.dirty, false);
  state.preferenceLoss = true;
  page.onPreference({ detail: { value: true } });
  page.onPreferenceSave();
  await flush();
  assert.equal(page.data.preference.needsReload, true);
  assert.notEqual(page.data.preference.status, '已保存');
  page.onUnload();
  state.preferenceLoss = false;
  for (const query of [{ regionId, activityId, snapshot: detail() }, {}]) {
    child = mount('detail', query);
    await flush();
    assert.equal(child.data.loaded, false);
    child.onUnload();
  }
  app.community.activities = original.activities;
  app.community.profiles = original.profiles;
  app.community.pendingActivityVisits = original.pending;
  app.community.newRequestId = original.newRequestId;
  globalThis.wx.navigateTo = original.navigateTo;
  console.log(
    'Activity emitted smoke passed: real gateway/strict decoders, template projection, recent/all/known-empty/unavailable, deep-link/fresh Back, opaque Previous, repeated navigation, successful render-only visit, hide/scope/root/login/late callbacks, exact response-loss retry, Profile preference success/conflict/uncertainty; synthetic native model, not device acceptance',
  );
}
