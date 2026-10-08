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
export async function smokeErrands({ app, dist, flush }) {
  const { ApiClient } = require(path.join(dist, 'api/client.js'));
  const { HttpErrandsGateway } = require(path.join(dist, 'errands/gateway.js'));
  const { PendingErrandStore } = require(path.join(dist, 'errands/pending.js'));
  const { HttpProfileGateway } = require(path.join(dist, 'profile/gateway.js'));
  const { HttpErrandNoticesGateway } = require(
    path.join(dist, 'errands/notices.js'),
  );
  const original = {
    notices: app.community.errandNotices,
    errands: app.community.errands,
    pending: app.community.pendingErrands,
    profiles: app.community.profiles,
    newRequestId: app.community.newRequestId,
    credentials: app.identity.sessions.snapshot().credentials,
    navigateTo: globalThis.wx.navigateTo,
  };
  const orderId = '11111111-1111-4111-8111-111111111111',
    regionId = '22222222-2222-4222-8222-222222222222',
    sourceId = '33333333-3333-4333-8333-333333333333',
    revision = '44444444-4444-4444-8444-444444444444',
    campusId = '55555555-5555-4555-8555-555555555555';
  const requests = [],
    commands = [],
    receipts = new Map(),
    stored = new Map(),
    navigation = [];
  const state = {
    role: 'none',
    lifecycle: 'pending',
    deleted: false,
    holdDetail: null,
    holdHistory: null,
    holdCommand: null,
    loseReply: false,
    failStorage: false,
    terminal: null,
    discoveryMode: 'home',
    noticeKind: 'accepted',
    noticeRead: false,
    holdNotice: null,
    missingNotice: false,
  };
  let requestNumber = 1;
  const requestId = () =>
    `${String(requestNumber++).padStart(8, '0')}-7777-4777-8777-777777777777`;
  const publicText = '合成公开任务描述',
    privateText = '合成双方私密说明',
    privateWechat = 'synthetic-opposite-contact';
  const now = '2026-10-08T12:00:00.000Z';
  const summary = () => ({
    id: orderId,
    revision,
    title: '合成文字跑腿',
    publicText,
    expectedTimeText: '今晚 八点前',
    reward: '12.34567890123456789',
    state: state.lifecycle,
    createdAt: now,
    acceptedAt: state.lifecycle === 'pending' ? null : now,
    completedAt: state.lifecycle === 'completed' ? now : null,
    cancelledAt: state.lifecycle === 'cancelled' ? now : null,
    targetRegion: { id: regionId, label: '合成目标地区' },
    sourceRegion: { id: sourceId, label: '合成来源地区' },
    scope: 'foreign',
  });
  const detail = () => ({
    ...summary(),
    relation: state.role,
    ...(state.role !== 'none' ? { privateText } : {}),
    ...(state.role !== 'none' && state.lifecycle === 'accepted'
      ? {
          oppositeContact: {
            display: { status: 'available', displayName: '合成对方' },
            contacts: { wechat: privateWechat, phone: '12345678901' },
          },
        }
      : {}),
    capabilities: {
      accept: state.role === 'none' && state.lifecycle === 'pending',
      cancel:
        state.role === 'publisher' &&
        ['pending', 'accepted'].includes(state.lifecycle),
      complete: state.role === 'publisher' && state.lifecycle === 'accepted',
      delete: state.role === 'publisher',
    },
  });
  const profile = {
    accountId: original.credentials.accountId,
    nickname: null,
    bio: '',
    selectedCampus: {
      id: campusId,
      institutionId: null,
      institutionName: '合成机构',
      fullName: '合成校园',
      shortName: null,
      district: '测试地区',
      isActive: true,
    },
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
  const api = new ApiClient(
    'https://errands.example',
    {
      send: async (request) => {
        requests.push(request);
        assert.ok(request.headers.Authorization);
        const url = new URL(request.url),
          path = url.pathname,
          ok = (body) => ({ status: 200, headers: {}, body });
        if (request.method === 'GET') assert.equal(request.body, undefined);
        if (path === '/v1/me/errand-notices')
          return ok({
            items: [
              {
                noticeId: revision,
                kind: state.noticeKind,
                orderId,
                createdAt: now,
                readAt: state.noticeRead ? now : null,
              },
            ],
            nextCursor: null,
            unreadCount: state.noticeRead ? 0 : 1,
          });
        if (path === `/v1/me/errand-notices/${revision}/read`) {
          assert.equal(request.method, 'PUT');
          assert.deepEqual(request.body, {});
          if (state.missingNotice)
            return {
              status: 404,
              headers: {},
              body: { error: { code: 'ERRAND_NOT_FOUND' } },
            };
          if (state.holdNotice) await state.holdNotice.promise;
          state.noticeRead = true;
          return ok({ noticeId: revision, readAt: now, unreadCount: 0 });
        }
        if (path === '/v1/me/profile') return ok(profile);
        if (path === '/v1/campuses')
          return ok({
            items: [profile.selectedCampus],
            page: 1,
            pageSize: 20,
            total: 1,
          });
        if (path === '/v1/operating-regions') {
          assert.equal(url.searchParams.get('campusId'), campusId);
          return ok({
            items: [{ id: regionId, name: '合成目标地区', isActive: true }],
          });
        }
        if (path === '/v1/me/errands/contact-history') {
          if (state.holdHistory) await state.holdHistory.promise;
          return ok({
            status: 'available',
            contacts: { wechat: 'synthetic-remembered', phone: '' },
          });
        }
        if (path.startsWith('/v1/me/errand-requests/'))
          return receipts.has(path.split('/').at(-1))
            ? ok(receipts.get(path.split('/').at(-1)))
            : {
                status: 404,
                headers: {},
                body: { error: { code: 'REQUEST_NOT_FOUND' } },
              };
        if (request.method === 'POST') {
          const operation =
            path === '/v1/errands' ? 'publish' : path.split('/').at(-1);
          commands.push(request);
          if (state.holdCommand) await state.holdCommand.promise;
          let receipt = receipts.get(request.body.clientRequestId);
          if (!receipt) {
            if (state.terminal)
              receipt = {
                requestId: request.body.clientRequestId,
                operation,
                outcome: 'rejected',
                code: state.terminal,
              };
            else {
              receipt = {
                requestId: request.body.clientRequestId,
                operation,
                outcome: 'applied',
                orderId,
                revision,
                occurredAt: now,
              };
              if (operation === 'accept') {
                state.lifecycle = 'accepted';
                state.role = 'accepter';
              }
              if (operation === 'complete') state.lifecycle = 'completed';
              if (operation === 'cancel') state.lifecycle = 'cancelled';
              if (operation === 'delete') state.deleted = true;
            }
            receipts.set(receipt.requestId, receipt);
          }
          if (state.loseReply) throw new Error('synthetic response loss');
          return ok(receipt);
        }
        if (path === `/v1/errands/${orderId}`) {
          const snapshot = detail();
          if (state.holdDetail) await state.holdDetail.promise;
          return state.deleted
            ? {
                status: 404,
                headers: {},
                body: { error: { code: 'ERRAND_NOT_FOUND' } },
              }
            : ok(snapshot);
        }
        if (path === '/v1/errands')
          return ok({
            context: {
              kind: 'discovery',
              regionId,
              discoveryMode: state.discoveryMode,
            },
            items:
              !state.deleted &&
              ['pending', 'accepted'].includes(state.lifecycle)
                ? [summary()]
                : [],
            continuation: 'end',
            nextCursor: null,
          });
        if (path === '/v1/me/errands')
          return ok({
            context: {
              kind: 'own',
              relation: url.searchParams.get('relation'),
            },
            items: state.deleted ? [] : [summary()],
            continuation: 'end',
            nextCursor: null,
          });
        throw new Error(`Unexpected synthetic errand route ${path}`);
      },
    },
    app.identity.sessions,
    {
      refresh: async () => {
        throw new Error('Unexpected refresh');
      },
    },
  );
  app.community.errands = new HttpErrandsGateway(api);
  app.community.errandNotices = new HttpErrandNoticesGateway(api);
  app.community.profiles = new HttpProfileGateway(api);
  app.community.pendingErrands = new PendingErrandStore(
    {
      get: (key) => stored.get(key),
      set: (key, value) => {
        if (state.failStorage) throw new Error('Synthetic storage');
        stored.set(key, value);
      },
      remove: (key) => stored.delete(key),
    },
    'synthetic-errand-smoke',
  );
  app.community.newRequestId = async () => requestId();
  globalThis.wx.navigateTo = (options) => navigation.push(options);
  const templates = Object.fromEntries(
    parse(readFileSync(path.join(dist, 'errands/common.wxml'), 'utf8'))
      .children.filter((n) => typeof n !== 'string')
      .map((n) => [n.attrs.name, n]),
  );
  const source = (mode) =>
    readFileSync(
      path.join(dist, `pages/errand-${mode}/errand-${mode}.wxml`),
      'utf8',
    );
  const presented = (mode, page) =>
    JSON.stringify(render(parse(source(mode)).children, page.data, templates));
  const mount = (mode, route = {}) => {
    let page;
    const old = globalThis.Page;
    globalThis.Page = (definition) => {
      page = definition;
    };
    const module = path.join(dist, `pages/errand-${mode}/errand-${mode}.js`);
    delete require.cache[require.resolve(module)];
    require(module);
    globalThis.Page = old;
    page.setData = (data) => {
      page.data = { ...page.data, ...data };
    };
    page.onLoad?.(route);
    page.onShow();
    return page;
  };
  const input = (page, field, value) =>
    page.onForm({ currentTarget: { dataset: { field } }, detail: { value } });
  for (const mode of ['list', 'mine', 'detail', 'compose', 'notices'])
    assert.doesNotMatch(
      source(mode),
      /<image|rich-text|chooseImage|requestPayment|subscribeMessage|eventChannel/i,
    );
  const feed = readFileSync(
    path.join(dist, 'pages/community-feed/community-feed.wxml'),
    'utf8',
  );
  assert.match(feed, /\/pages\/errand-list\/errand-list/);
  let page = mount('list');
  await flush();
  assert.equal(page.data.loaded, true);
  assert.equal(page.data.regionId, regionId);
  assert.ok(presented('list', page).includes(publicText));
  assert.ok(!presented('list', page).includes(privateText));
  assert.equal(page.data.canMore, false);
  const endReads = requests.length;
  page.onMore();
  await flush();
  assert.equal(requests.length, endReads);
  page.onOrder({ currentTarget: { dataset: { id: orderId } } });
  page.onOrder({ currentTarget: { dataset: { id: orderId } } });
  assert.equal(navigation.length, 1);
  assert.equal(
    navigation[0].url,
    `/pages/errand-detail/errand-detail?orderId=${orderId}`,
  );
  page.onHide();
  navigation[0].fail();
  assert.equal(page.data.error, '');
  assert.deepEqual(page.data.items, []);
  page.onUnload();
  state.discoveryMode = 'own_only';
  page = mount('list', { regionId });
  await flush();
  assert.ok(presented('list', page).includes('仅显示自己最近三天'));
  page.onUnload();
  // Closing a still-loading modal must not resurrect stored private contact fields.
  page = mount('detail', { orderId });
  await flush();
  assert.ok(!presented('detail', page).includes(privateText));
  state.holdHistory = deferred();
  page.onAccept();
  await flush();
  assert.equal(page.data.acceptModal, true);
  page.onCloseAccept();
  state.holdHistory.resolve();
  await flush();
  state.holdHistory = null;
  assert.equal(page.data.acceptModal, false);
  assert.deepEqual(page.data.contacts, { wechat: '', phone: '' });
  page.onAccept();
  await flush();
  assert.equal(page.data.contacts.wechat, 'synthetic-remembered');
  page.onToggleLast();
  assert.equal(page.data.contacts.wechat, '');
  page.onContact({
    currentTarget: { dataset: { field: 'wechat' } },
    detail: { value: 'synthetic-new-runner' },
  });
  state.holdCommand = deferred();
  state.loseReply = true;
  page.onConfirmAccept();
  page.onConfirmAccept();
  await flush();
  assert.equal(commands.length, 1);
  const originalCommand = {
    url: commands[0].url,
    body: structuredClone(commands[0].body),
  };
  assert.equal(page.data.detail, null);
  state.holdCommand.resolve();
  await flush();
  state.holdCommand = null;
  assert.equal(page.data.frozen, true);
  assert.ok(presented('detail', page).includes('重试完全相同的请求'));
  assert.ok(!presented('detail', page).includes(privateWechat));
  state.loseReply = false;
  page.onRetry();
  await flush();
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[1].body, originalCommand.body);
  assert.equal(commands[1].url, originalCommand.url);
  assert.equal(page.data.frozen, false);
  assert.equal(page.data.detail.relation, 'accepter');
  let text = presented('detail', page);
  assert.ok(text.includes(privateWechat));
  assert.ok(text.includes(privateText));
  assert.ok(!text.includes('data-action":"complete'));
  assert.ok(text.includes('只有发布者可以取消'));
  state.lifecycle = 'completed';
  page.onRefresh();
  await flush();
  text = presented('detail', page);
  assert.ok(text.includes(privateText));
  assert.ok(!text.includes(privateWechat));
  page.onUnload();
  // Fresh publisher cleanup is allowed; the terminal projection cannot reuse accepted contacts.
  state.role = 'publisher';
  state.lifecycle = 'accepted';
  page = mount('detail', { orderId });
  await flush();
  assert.ok(presented('detail', page).includes(privateWechat));
  page.onConfirm({ currentTarget: { dataset: { action: 'complete' } } });
  assert.equal(page.data.confirmAction, 'complete');
  page.onConfirmCommand();
  page.onConfirmCommand();
  await flush();
  assert.equal(commands.length, 3);
  assert.equal(page.data.detail.state, 'completed');
  text = presented('detail', page);
  assert.ok(text.includes(privateText));
  assert.ok(!text.includes(privateWechat));
  assert.ok(text.includes('删除订单'));
  page.onUnload();
  // Publish snapshots exact canonical text/decimal/contact intent and persists before sending.
  page = mount('compose', { regionId });
  await flush();
  for (const [field, value] of Object.entries({
    title: ' 合成新订单 ',
    publicText: ' 合成公开\r\n说明 ',
    privateText: ' 合成私密 ',
    expectedTimeText: ' 今晚 八点前 ',
    reward: '12.345678901234567890',
    wechat: 'synthetic-publisher',
    phone: '12345678901',
  }))
    input(page, field, value);
  state.failStorage = true;
  const beforePublish = commands.length;
  page.onPublish();
  await flush();
  assert.equal(commands.length, beforePublish);
  assert.ok(page.data.error);
  state.failStorage = false;
  state.holdCommand = deferred();
  state.loseReply = true;
  page.onPublish();
  page.onPublish();
  await flush();
  assert.equal(commands.length, beforePublish + 1);
  const publish = commands.at(-1).body;
  assert.equal(publish.reward, '12.34567890123456789');
  assert.equal(publish.publicText, '合成公开\n说明');
  assert.deepEqual(publish.publicAssetIds, []);
  assert.deepEqual(publish.privateAssetIds, []);
  assert.equal(page.data.form.privateText, '');
  state.holdCommand.resolve();
  await flush();
  state.holdCommand = null;
  page.onHide();
  state.loseReply = false;
  const recoveryStart = requests.length;
  page.onShow();
  await flush();
  assert.match(
    new URL(requests[recoveryStart].url).pathname,
    /^\/v1\/me\/errand-requests\//,
  );
  assert.equal(commands.length, beforePublish + 1);
  assert.equal(page.data.frozen, false);
  page.onPublisherContacts();
  assert.equal(page.data.form.wechat, 'synthetic-publisher');
  page.onUnload();
  // Late private detail after root hide and same-account relogin is discarded.
  state.lifecycle = 'accepted';
  state.role = 'publisher';
  state.holdDetail = deferred();
  page = mount('detail', { orderId });
  await flush();
  app.community.privateViews.clear();
  state.holdDetail.resolve();
  await flush();
  state.holdDetail = null;
  assert.equal(page.data.detail, null);
  page.onUnload();
  page = mount('detail', { orderId });
  await flush();
  assert.ok(page.data.detail.oppositeContact);
  app.identity.sessions.completeLogin(
    app.identity.sessions.beginLogin(),
    original.credentials,
  );
  assert.equal(page.data.detail, null);
  assert.equal(page.data.form.wechat, '');
  page.onUnload();
  // Own histories work without profile/current identity reads and finish at the actual end.
  const ownStart = requests.length;
  page = mount('mine', { relation: 'accepted' });
  await flush();
  assert.equal(page.data.loaded, true);
  assert.equal(page.data.canMore, false);
  assert.ok(
    !requests
      .slice(ownStart)
      .some((r) =>
        ['/v1/me/profile', '/v1/operating-regions'].includes(
          new URL(r.url).pathname,
        ),
      ),
  );
  assert.ok(!presented('mine', page).includes(privateWechat));
  page.onUnload();
  page = mount('notices');
  await flush();
  assert.equal(page.data.unreadCount, 1);
  assert.ok(presented('notices', page).includes('你发布的跑腿已有人接单'));
  assert.ok(!presented('notices', page).includes(privateWechat));
  page.onOrder({ currentTarget: { dataset: { id: revision } } });
  page.onOrder({ currentTarget: { dataset: { id: revision } } });
  assert.equal(navigation.length, 2);
  assert.equal(
    navigation[1].url,
    `/pages/errand-detail/errand-detail?orderId=${orderId}`,
  );
  state.holdNotice = deferred();
  const noticeReads = requests.filter((r) => r.method === 'PUT').length;
  page.onRead({ currentTarget: { dataset: { id: revision } } });
  page.onRead({ currentTarget: { dataset: { id: revision } } });
  await flush();
  assert.equal(
    requests.filter((r) => r.method === 'PUT').length,
    noticeReads + 1,
  );
  page.onHide();
  state.holdNotice.resolve();
  await flush();
  state.holdNotice = null;
  assert.equal(page.data.unreadCount, 0);
  assert.deepEqual(page.data.items, []);
  page.onUnload();
  state.noticeKind = 'completed';
  page = mount('notices');
  await flush();
  assert.ok(
    presented('notices', page).includes('你接取的跑腿已由发布者确认完成'),
  );
  assert.equal(page.data.items[0].readAt, now);
  assert.equal(page.data.unreadCount, 0);
  page.onUnload();
  state.noticeRead = false;
  state.missingNotice = true;
  page = mount('notices');
  await flush();
  assert.equal(page.data.items.length, 1);
  page.onRead({ currentTarget: { dataset: { id: revision } } });
  await flush();
  assert.equal(page.data.loaded, false);
  assert.deepEqual(page.data.items, []);
  assert.equal(page.data.unreadCount, 0);
  assert.ok(
    !presented('notices', page).includes('你接取的跑腿已由发布者确认完成'),
  );
  page.onUnload();
  app.community.errandNotices = original.notices;
  app.community.errands = original.errands;
  app.community.pendingErrands = original.pending;
  app.community.profiles = original.profiles;
  app.community.newRequestId = original.newRequestId;
  globalThis.wx.navigateTo = original.navigateTo;
  console.log(
    'Errand emitted smoke passed: native text publish, exact decimal/contact snapshots, campus operating-region resolution, home/foreign-own discovery, current participant/private/contact branches, modal dismissal, repeated commands, frozen identical recovery, storage failure, publisher completion, own histories, local accepted/completed notice navigation/read/unread, session/root-hide clearing; synthetic WXML model, not device acceptance',
  );
}

// Shared only by repository-owned emitted errand-page smoke checks.
export { parse as parseErrandWxml, render as renderErrandWxml };
