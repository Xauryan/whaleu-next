import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  parseErrandWxml as parse,
  renderErrandWxml as render,
} from './smoke-errands.mjs';
const require = createRequire(import.meta.url);
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
/** Emitted native handlers + real transport/decoders + WXML branches, never a device/provider claim. */
export async function smokeErrandAdmin({ app, dist, flush }) {
  const { ApiClient } = require(path.join(dist, 'api/client.js'));
  const { HttpErrandAdminGateway } = require(
    path.join(dist, 'errands/admin-gateway.js'),
  );
  const original = {
    admin: app.community.errandAdmin,
    credentials: app.identity.sessions.snapshot().credentials,
  };
  const regionId = '11111111-1111-4111-8111-111111111111',
    otherRegion = '22222222-2222-4222-8222-222222222222',
    orderId = '33333333-3333-4333-8333-333333333333',
    profileId = '44444444-4444-4444-8444-444444444444';
  const timestamp = '2020-01-01T12:00:00.000001Z',
    cursorA = 'a'.repeat(43),
    cursorB = 'b'.repeat(43);
  const state = {
    role: 'school_admin',
    regions: [regionId],
    title: '合成历史已删除订单',
    countKnown: true,
    empty: false,
    paging: false,
    privateLeak: false,
    wrongContext: false,
    hold: null,
    error: null,
  };
  const requests = [];
  const auth = () => ({
    role: state.role,
    management: {
      global: ['developer', 'super_admin'].includes(state.role),
      operatingRegionIds: state.role === 'member' ? [] : state.regions,
    },
    identityView: { allowed: state.role === 'developer', maxBatchSize: 20 },
  });
  const row = (query) => {
    const displayState = query.status === 'all' ? 'deleted' : query.status;
    const lifecycle = displayState === 'deleted' ? 'completed' : displayState;
    const accepted = lifecycle === 'accepted' || lifecycle === 'completed';
    return {
      id: orderId,
      revision: profileId,
      title: state.title,
      publicText: '合成公开说明',
      expectedTimeText: '某天下午',
      reward: '12.345678901234567890123456789',
      state: lifecycle,
      displayState,
      createdAt: timestamp,
      acceptedAt: accepted ? timestamp : null,
      completedAt: lifecycle === 'completed' ? timestamp : null,
      cancelledAt: lifecycle === 'cancelled' ? timestamp : null,
      deletedAt: displayState === 'deleted' ? timestamp : null,
      deletionReason:
        displayState === 'deleted' ? { status: 'unavailable' } : null,
      publisher: { status: 'available', profileId, displayName: '合成发布者' },
      accepter: accepted ? { status: 'unavailable' } : null,
      relation: 'none',
      sourceRegion: { id: otherRegion, status: 'unavailable' },
      targetRegion: {
        id: query.regionId,
        status: 'available',
        label: '合成目标地区',
        active: state.role === 'school_admin',
      },
    };
  };
  const api = new ApiClient(
    'https://api.example',
    {
      send: async (request) => {
        requests.push(request);
        assert.equal(request.method, 'GET');
        assert.equal(request.body, undefined);
        assert.ok(request.headers.Authorization);
        const url = new URL(request.url),
          query = Object.fromEntries(url.searchParams);
        if (url.pathname === '/v1/me/authorization')
          return { status: 200, headers: {}, body: auth() };
        assert.equal(url.pathname, '/v1/admin/errands');
        const sparse = state.paging && query.cursor === cursorA,
          end = state.paging && query.cursor === cursorB;
        const body = {
          context: {
            regionId: query.regionId,
            management: auth().management.global ? 'global' : 'fixed',
            status: query.status,
            keyword: query.keyword,
            search: {
              matcher: 'public-text-name-uuid-v1',
              legacyNumericReferences: 'unavailable',
            },
          },
          items: sparse || end || state.empty ? [] : [row(query)],
          continuation: state.paging && !end ? 'more' : 'end',
          nextCursor: state.paging
            ? end
              ? null
              : sparse
                ? cursorB
                : cursorA
            : null,
          total:
            state.countKnown && !/^[0-9]+$/.test(query.keyword)
              ? {
                  status: 'known',
                  value: state.empty ? '0' : '9007199254740993',
                }
              : { status: 'unavailable' },
          ...(state.privateLeak
            ? { privateText: 'never show this private sentinel' }
            : {}),
        };
        if (state.wrongContext) body.context.regionId = otherRegion;
        const error = state.error;
        if (state.hold) await state.hold.promise;
        return error
          ? { status: 503, headers: {}, body: { error: { code: error } } }
          : { status: 200, headers: {}, body };
      },
    },
    app.identity.sessions,
    {
      refresh: async () => {
        throw new Error('Unexpected synthetic refresh');
      },
    },
  );
  app.community.errandAdmin = new HttpErrandAdminGateway(api);
  const source = readFileSync(
    path.join(dist, 'pages/errand-admin/errand-admin.wxml'),
    'utf8',
  );
  const tree = parse(source);
  const common = parse(
    readFileSync(path.join(dist, 'errands/admin-command.wxml'), 'utf8'),
  );
  const templates = Object.fromEntries(
    common.children
      .filter((node) => typeof node !== 'string' && node.attrs?.name)
      .map((node) => [node.attrs.name, node]),
  );
  const text = (page) =>
    JSON.stringify(render(tree.children, page.data, templates));
  const mount = (route = {}) => {
    let page;
    const old = globalThis.Page;
    globalThis.Page = (definition) => {
      page = definition;
    };
    const module = path.join(dist, 'pages/errand-admin/errand-admin.js');
    delete require.cache[require.resolve(module)];
    require(module);
    globalThis.Page = old;
    page.setData = (data) => {
      page.data = { ...page.data, ...data };
    };
    page.onLoad(route);
    page.onShow();
    return page;
  };
  const cleared = (page) => {
    assert.deepEqual(page.data.items, []);
    assert.equal(page.data.total, null);
    assert.equal(page.data.loaded, false);
    assert.ok(!text(page).includes(state.title));
  };
  const adminReads = () =>
    requests.filter((r) => new URL(r.url).pathname === '/v1/admin/errands');
  const input = (page, handler, value) => page[handler]({ detail: { value } });
  const status = (page, value) =>
    page.onStatus({ currentTarget: { dataset: { value } } });
  for (const pattern of [
    /requestPayment|subscribeMessage|chooseImage|eventChannel|<image|rich-text/,
    /contacts|privateText|studentNumber|grantId/,
  ])
    assert.doesNotMatch(source, pattern);
  assert.match(
    readFileSync(path.join(dist, 'pages/errand-list/errand-list.wxml'), 'utf8'),
    /wx:if="{{adminAvailable}}"[^>]*errand-admin/,
  );
  let page = mount({ campusId: regionId });
  await flush();
  cleared(page);
  assert.equal(requests.length, 0);
  page.onUnload();
  state.role = 'member';
  page = mount({ regionId });
  await flush();
  assert.equal(page.data.access, 'denied');
  assert.equal(adminReads().length, 0);
  assert.ok(text(page).includes('当前账号没有跑腿管理权限'));
  page.onUnload();
  state.role = 'school_admin';
  page = mount({ regionId: otherRegion });
  await flush();
  cleared(page);
  assert.equal(adminReads().length, 0);
  page.onUnload();
  state.regions = [regionId, otherRegion];
  page = mount();
  await flush();
  cleared(page);
  assert.equal(adminReads().length, 0);
  page.onUnload();
  state.regions = [regionId];
  page = mount();
  await flush();
  assert.equal(page.data.access, 'fixed');
  assert.equal(page.data.regionId, regionId);
  let shown = text(page);
  assert.ok(shown.includes('固定管理地区'));
  assert.ok(shown.includes('删除前生命周期：已完成'));
  assert.ok(shown.includes('2020-01-01'));
  assert.ok(shown.includes('12.345678901234567890123456789'));
  assert.ok(shown.includes('精确总数：9007199254740993'));
  assert.ok(shown.includes('删除原因资料暂不可用'));
  assert.ok(shown.includes('公开资料暂不可用'));
  assert.ok(shown.includes(profileId));
  assert.ok(!shown.includes('选择管理目标地区'));
  assert.ok(
    !requests.some((r) =>
      ['/v1/me/profile', '/v1/operating-regions'].includes(
        new URL(r.url).pathname,
      ),
    ),
  );
  for (const value of [
    'pending',
    'accepted',
    'completed',
    'cancelled',
    'deleted',
    'all',
  ]) {
    status(page, value);
    cleared(page);
    await flush();
    assert.equal(page.data.filter, value);
    assert.equal(page.data.loaded, true);
    assert.equal(
      new URL(adminReads().at(-1).url).searchParams.get('status'),
      value,
    );
  }
  state.empty = true;
  page.onRefresh();
  await flush();
  assert.ok(text(page).includes('精确总数：0'));
  assert.ok(text(page).includes('本页没有匹配项，已到本次查询末尾'));
  state.empty = false;
  state.countKnown = false;
  page.onRefresh();
  await flush();
  shown = text(page);
  assert.ok(shown.includes('精确总数暂不可用'));
  assert.ok(!shown.includes('精确总数：0'));
  input(page, 'onKeyword', '  12345  ');
  cleared(page);
  page.onSearch();
  await flush();
  shown = text(page);
  assert.ok(shown.includes('当前为数字文字查询'));
  assert.ok(shown.includes('旧数字 UID 对照资料暂不可用'));
  assert.equal(
    new URL(adminReads().at(-1).url).searchParams.get('keyword'),
    '12345',
  );
  input(page, 'onKeyword', '');
  page.onSearch();
  await flush();
  state.paging = true;
  page.onRefresh();
  await flush();
  assert.equal(page.data.canNext, true);
  page.onNext();
  cleared(page);
  await flush();
  assert.equal(page.data.items.length, 0);
  assert.equal(page.data.canNext, true);
  assert.ok(text(page).includes('本批没有匹配项，扫描尚未结束'));
  state.title = '重新读取的第一页';
  page.onPrevious();
  await flush();
  assert.equal(page.data.pageNumber, 1);
  assert.ok(text(page).includes(state.title));
  assert.equal(
    new URL(adminReads().at(-1).url).searchParams.has('cursor'),
    false,
  );
  page.onNext();
  await flush();
  page.onNext();
  await flush();
  assert.equal(page.data.canNext, false);
  const finalReads = requests.length;
  page.onNext();
  await flush();
  assert.equal(requests.length, finalReads);
  page.onPrevious();
  await flush();
  state.role = 'member';
  page.onPrevious();
  await flush();
  cleared(page);
  assert.equal(page.data.access, 'unknown');
  assert.ok(page.data.error);
  page.onRefresh();
  await flush();
  assert.equal(page.data.access, 'denied');
  page.onUnload();
  state.role = 'school_admin';
  state.paging = false;
  state.privateLeak = true;
  page = mount();
  await flush();
  cleared(page);
  assert.ok(!text(page).includes('never show'));
  state.privateLeak = false;
  page.onRefresh();
  await flush();
  assert.equal(page.data.loaded, true);
  state.wrongContext = true;
  page.onRefresh();
  await flush();
  cleared(page);
  state.wrongContext = false;
  page.onUnload();
  for (const boundary of [
    'hide',
    'epoch',
    'scope',
    'browse',
    'safety',
    'stop',
    'expired',
  ]) {
    page = mount();
    await flush();
    assert.equal(page.data.loaded, true);
    state.hold = deferred();
    if (boundary === 'expired') state.error = 'AUTHORIZATION_UNAVAILABLE';
    page.onRefresh();
    await flush();
    cleared(page);
    if (boundary === 'hide') app.community.privateViews.clear();
    if (boundary === 'epoch')
      app.identity.sessions.completeLogin(
        app.identity.sessions.beginLogin(),
        original.credentials,
      );
    if (boundary === 'scope')
      app.community.directoryScopeChanges.clear(original.credentials.accountId);
    if (boundary === 'browse')
      app.community.browsingScopeChanges.clear(original.credentials.accountId);
    if (boundary === 'safety')
      app.community.safetyChanges.invalidate(original.credentials.accountId);
    if (boundary === 'stop') page.onCancel();
    state.hold.resolve();
    state.hold = null;
    state.error = null;
    await flush();
    cleared(page);
    if (boundary === 'expired') assert.ok(page.data.error);
    page.onUnload();
  }
  for (const role of ['super_admin', 'developer']) {
    state.role = role;
    page = mount();
    const before = adminReads().length;
    await flush();
    assert.equal(page.data.access, 'global');
    assert.equal(adminReads().length, before);
    assert.ok(text(page).includes('选择管理目标地区'));
    input(page, 'onRegion', otherRegion);
    page.onSelectRegion();
    await flush();
    assert.equal(page.data.loaded, true);
    assert.equal(page.data.regionId, otherRegion);
    assert.ok(text(page).includes('（已停用）'));
    input(page, 'onKeyword', 'previous');
    page.onSearch();
    await flush();
    status(page, 'deleted');
    await flush();
    input(page, 'onRegion', regionId);
    cleared(page);
    page.onSelectRegion();
    await flush();
    assert.equal(page.data.keyword, '');
    assert.equal(page.data.filter, 'all');
    page.onHide();
    cleared(page);
    page.onShow();
    await flush();
    assert.equal(page.data.regionId, '');
    assert.equal(page.data.loaded, false);
    page.onUnload();
  }
  app.community.errandAdmin = original.admin;
  console.log(
    'Errand administration emitted smoke passed: fresh school/global grants, deep-link denial, six historical states, public-only participant references, exact decimal/count knownness, numeric UID limitation, sparse fresh Previous/Next, scope/query/status/session/Safety/hide/expiry clearing with separate command confirmation; synthetic WXML model, not device acceptance',
  );
}
