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

/** Emitted native handlers and real gateway, with synthetic local HTTP and WXML evaluation. */
export async function smokeErrandAdminNotices({ app, dist, flush }) {
  const { ApiClient } = require(path.join(dist, 'api/client.js'));
  const { HttpErrandNoticesGateway } = require(
    path.join(dist, 'errands/notices.js'),
  );
  const { HttpErrandsGateway } = require(path.join(dist, 'errands/gateway.js'));
  const { Cancellation } = require(path.join(dist, 'platform/contracts.js'));
  const sessions = app.identity.sessions;
  const original = {
    gateway: app.community.errandNotices,
    credentials: sessions.snapshot().credentials,
    navigateTo: globalThis.wx.navigateTo,
  };
  assert.ok(original.credentials);
  const uuid = (n) =>
    `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
  const orderId = uuid(91),
    restrictionId = uuid(92),
    eventId = uuid(93),
    now = '2026-10-08T12:00:00.123456Z',
    end = '2026-10-15T12:00:00.123456Z',
    reason = '合成原因 <view>只是文字</view>\n第二行';
  let number = 1;
  const common = () => ({
    noticeId: uuid(number++),
    createdAt: now,
    readAt: null,
  });
  const items = [
    { ...common(), kind: 'accepted', orderId },
    { ...common(), kind: 'completed', orderId },
    {
      ...common(),
      kind: 'admin_deleted',
      orderId,
      deletionReason: { status: 'provided', value: reason },
    },
    {
      ...common(),
      kind: 'admin_deleted',
      orderId,
      deletionReason: { status: 'not_provided' },
    },
  ];
  for (const action of ['publish', 'accept', 'all']) {
    for (const endsAt of [null, end])
      items.push({
        ...common(),
        kind: 'feature_restricted',
        restrictionId,
        eventId,
        action,
        reason,
        startsAt: now,
        endsAt,
      });
    items.push({
      ...common(),
      kind: 'feature_released',
      restrictionId,
      eventId,
      action,
      reason,
      releasedAt: now,
    });
  }
  const state = {
    items,
    read: new Set(),
    listHold: null,
    readHold: null,
    missing: false,
  };
  const requests = [],
    navigation = [];
  const unread = () =>
    state.items.filter((item) => !state.read.has(item.noticeId)).length;
  const api = new ApiClient(
    'https://errand-notices.example',
    {
      send: async (request) => {
        requests.push(request);
        assert.ok(request.headers.Authorization);
        const url = new URL(request.url),
          route = url.pathname;
        const ok = (body) => ({ status: 200, headers: {}, body });
        const absent = () => ({
          status: 404,
          headers: {},
          body: { error: { code: 'ERRAND_NOT_FOUND' } },
        });
        if (request.method === 'GET') assert.equal(request.body, undefined);
        if (route === '/v1/me/errand-notices') {
          assert.equal(url.searchParams.get('limit'), '20');
          const snapshot = {
            items: state.items.map((item) => ({
              ...item,
              readAt: state.read.has(item.noticeId) ? now : null,
            })),
            nextCursor: null,
            unreadCount: unread(),
          };
          if (state.listHold) await state.listHold.promise;
          return ok(snapshot);
        }
        if (route === `/v1/errands/${orderId}`) return absent();
        const read = /^\/v1\/me\/errand-notices\/([^/]+)\/read$/.exec(route);
        if (read) {
          assert.equal(request.method, 'PUT');
          assert.deepEqual(request.body, {});
          if (state.missing) return absent();
          if (state.readHold) await state.readHold.promise;
          assert.ok(items.some((item) => item.noticeId === read[1]));
          state.read.add(read[1]);
          return ok({ noticeId: read[1], readAt: now, unreadCount: unread() });
        }
        throw new Error(`Unexpected synthetic notice route: ${route}`);
      },
    },
    sessions,
    {
      refresh: async () => {
        throw new Error('Unexpected refresh');
      },
    },
  );
  app.community.errandNotices = new HttpErrandNoticesGateway(api);
  globalThis.wx.navigateTo = (options) => navigation.push(options);
  const tree = parse(
    readFileSync(
      path.join(dist, 'pages/errand-notices/errand-notices.wxml'),
      'utf8',
    ),
  );
  const presented = (page) => render(tree.children, page.data, {});
  const nodes = (tree) =>
    tree.flatMap((node) =>
      typeof node === 'string' ? [] : [node, ...nodes(node.children)],
    );
  const content = (node) =>
    typeof node === 'string' ? node : node.children.map(content).join('');
  const tap = (id) => ({ currentTarget: { dataset: { id } } });
  const mount = () => {
    let page;
    const previous = globalThis.Page;
    globalThis.Page = (definition) => {
      page = definition;
    };
    const file = path.join(dist, 'pages/errand-notices/errand-notices.js');
    try {
      delete require.cache[require.resolve(file)];
      require(file);
    } finally {
      globalThis.Page = previous;
    }
    page.setData = (patch) => {
      page.data = { ...page.data, ...patch };
    };
    page.onShow();
    return page;
  };
  let page;
  try {
    page = mount();
    await flush();
    assert.equal(page.data.loaded, true);
    assert.equal(page.data.items.length, items.length);
    assert.equal(page.data.unreadCount, items.length);
    assert.equal(
      requests.length,
      1,
      'notice rendering must not fetch order/profile/contact detail',
    );
    assert.equal(requests.filter((r) => r.method === 'PUT').length, 0);
    const visible = nodes(presented(page));
    const cards = visible.filter((node) => node.attrs.class === 'card');
    assert.equal(cards.length, items.length);
    assert.equal(
      visible.filter((node) => node.attrs.bindtap === 'onOrder').length,
      2,
    );
    assert.ok(
      visible.every(
        (node) => !['rich-text', 'web-view', 'image'].includes(node.tag),
      ),
    );
    for (const [index, item] of items.entries()) {
      const text = content(cards[index]);
      if (item.kind === 'admin_deleted') {
        assert.ok(text.includes('你发布的跑腿已被管理员删除'));
        assert.ok(
          text.includes(
            item.deletionReason.status === 'provided'
              ? reason
              : '管理员未填写删除原因',
          ),
        );
      }
      if (
        item.kind === 'feature_restricted' ||
        item.kind === 'feature_released'
      ) {
        assert.ok(text.includes(restrictionId));
        assert.ok(text.includes(reason));
        assert.ok(
          text.includes(
            { publish: '发布跑腿', accept: '接取跑腿', all: '发布与接取跑腿' }[
              item.action
            ],
          ),
        );
      }
      if (item.kind === 'feature_restricted') {
        assert.ok(
          text.includes(
            item.endsAt === null ? '期限：永久' : `结束时间：${end}`,
          ),
        );
        assert.ok(text.includes('适用范围：所有地区'));
      }
      if (item.kind === 'feature_released') {
        assert.ok(text.includes(`解除时间：${now}`));
        assert.ok(
          text.includes('仅解除上述编号对应的一条限制。其他限制仍可能生效'),
        );
        assert.ok(!text.includes('全部恢复'));
      }
      if (!['accepted', 'completed'].includes(item.kind))
        page.onOrder(tap(item.noticeId));
    }
    page.onOrder(tap(orderId));
    assert.equal(
      navigation.length,
      0,
      'forged/stale datasets cannot open administrative notices',
    );
    page.onOrder(tap(items[0].noticeId));
    page.onOrder(tap(items[0].noticeId));
    assert.equal(navigation.length, 1);
    assert.equal(
      navigation[0].url,
      `/pages/errand-detail/errand-detail?orderId=${orderId}`,
    );
    navigation[0].success();
    page.onOrder(tap(items[1].noticeId));
    assert.equal(navigation.length, 2);
    navigation[1].success();
    await assert.rejects(
      new HttpErrandsGateway(api).detail(orderId, new Cancellation()),
    );
    assert.ok(content(cards[2]).includes(reason));
    assert.deepEqual(
      page.data.items,
      items,
      'detail 404 must not erase a separate local deletion record',
    );
    const deletionId = items[2].noticeId;
    state.readHold = deferred();
    page.onRead(tap(deletionId));
    page.onRead(tap(deletionId));
    await flush();
    assert.equal(requests.filter((r) => r.method === 'PUT').length, 1);
    state.readHold.resolve();
    await flush();
    state.readHold = null;
    assert.equal(page.data.items[2].readAt, now);
    assert.equal(page.data.unreadCount, items.length - 1);
    assert.ok(
      content(
        nodes(presented(page)).filter((node) => node.attrs.class === 'card')[2],
      ).includes(reason),
    );
    const listCount = requests.length;
    page.onMore();
    page.onMore();
    await flush();
    assert.equal(requests.length, listCount);
    page.onHide();
    assert.deepEqual(page.data.items, []);
    page.onShow();
    await flush();
    assert.equal(
      requests.length,
      listCount + 1,
      'return/back starts a new authenticated feed read',
    );
    assert.equal(page.data.items[2].readAt, now);
    page.onUnload();

    for (const boundary of [
      'hide',
      'root-hide',
      'relogin',
      'account',
      'safety',
      'cancel',
    ]) {
      state.listHold = deferred();
      page = mount();
      await flush();
      if (boundary === 'hide') page.onHide();
      else if (boundary === 'root-hide') app.community.privateViews.clear();
      else if (boundary === 'relogin')
        sessions.completeLogin(sessions.beginLogin(), original.credentials);
      else if (boundary === 'account')
        sessions.completeLogin(sessions.beginLogin(), {
          ...original.credentials,
          accountId: uuid(99),
        });
      else if (boundary === 'safety')
        app.community.safetyChanges.invalidate(
          sessions.snapshot().credentials.accountId,
        );
      else page.onCancel();
      state.listHold.resolve();
      await flush();
      state.listHold = null;
      assert.deepEqual(page.data.items, [], `late list after ${boundary}`);
      assert.equal(page.data.unreadCount, 0);
      page.onUnload();
      sessions.completeLogin(sessions.beginLogin(), original.credentials);
    }
    page = mount();
    await flush();
    state.readHold = deferred();
    page.onRead(tap(items[4].noticeId));
    await flush();
    page.onHide();
    state.readHold.resolve();
    await flush();
    state.readHold = null;
    assert.deepEqual(page.data.items, []);
    assert.equal(page.data.unreadCount, 0);
    page.onUnload();

    page = mount();
    await flush();
    state.missing = true;
    page.onRead(tap(items.at(-1).noticeId));
    await flush();
    assert.deepEqual(page.data.items, []);
    assert.equal(page.data.loaded, false);
    assert.equal(page.data.unreadCount, 0);
    page.onUnload();
  } finally {
    page?.onUnload();
    app.community.errandNotices = original.gateway;
    globalThis.wx.navigateTo = original.navigateTo;
    sessions.completeLogin(sessions.beginLogin(), original.credentials);
  }
  console.log(
    'Errand admin notices smoke passed: five closed variants, local deletion reason after detail 404, action/permanent/finite release wording, exact read routes, fresh navigation and interrupted lifecycle; synthetic emitted WXML model, not device acceptance',
  );
}
