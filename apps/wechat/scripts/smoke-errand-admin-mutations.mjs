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
/** Native page handlers, emitted WXML branches and real ApiClient/gateways against disposable synthetic HTTP responses. */
export async function smokeErrandAdminMutations({ app, dist, flush }) {
  const { ApiClient } = require(path.join(dist, 'api/client.js'));
  const { ClientError } = require(path.join(dist, 'api/errors.js'));
  const { HttpErrandAdminGateway } = require(
    path.join(dist, 'errands/admin-gateway.js'),
  );
  const { HttpErrandAdminCommandsGateway } = require(
    path.join(dist, 'errands/admin-command-gateway.js'),
  );
  const { PendingErrandAdminStore } = require(
    path.join(dist, 'errands/admin-pending.js'),
  );
  const original = {
    admin: app.community.errandAdmin,
    commands: app.community.errandAdminCommands,
    pending: app.community.pendingErrandAdmin,
    newRequestId: app.community.newRequestId,
    credentials: app.identity.sessions.snapshot().credentials,
    navigateTo: globalThis.wx.navigateTo,
  };
  const ids = Array.from(
    { length: 12 },
    (_, i) =>
      `${String(i + 1)
        .repeat(8)
        .slice(0, 8)}-1111-4111-8111-${String(i + 1)
        .repeat(12)
        .slice(0, 12)}`,
  );
  const [
    regionId,
    otherRegion,
    orderId,
    profileId,
    revision,
    restrictionId,
    separateRestrictionId,
    eventId,
  ] = ids;
  const time = '2026-10-08T12:00:00.000001Z',
    cursor = 'a'.repeat(43);
  const state = {
    role: 'school_admin',
    region: regionId,
    deleted: false,
    deleteReason: '',
    relation: 'none',
    hold: null,
    drop: false,
    receipt503: false,
    receiptMissing: false,
    historyMore: true,
    sequence: 8,
  };
  const requests = [],
    sent = [],
    receipts = new Map(),
    stored = new Map(),
    navigation = [];
  const auth = () => ({
    role: state.role,
    management: {
      global: ['developer', 'super_admin'].includes(state.role),
      operatingRegionIds: state.role === 'member' ? [] : [state.region],
    },
    identityView: { allowed: state.role === 'developer', maxBatchSize: 20 },
  });
  const participant = {
    status: 'available',
    profileId,
    displayName: '合成公开参与者',
  };
  const record = (id, action) => ({
    restrictionId: id,
    subject: participant,
    action,
    reason: '合成限制原因',
    startsAt: time,
    endsAt: null,
    state: 'active',
    origin: 'local',
    recordedAt: time,
    operator: participant,
    source: { kind: 'global' },
    terminal: null,
  });
  let records = [
    record(restrictionId, 'all'),
    record(separateRestrictionId, 'publish'),
  ];
  const order = () => ({
    id: orderId,
    revision,
    title: '合成管理订单',
    publicText: '仅公开订单文字',
    expectedTimeText: '某个下午',
    reward: '12.34567890123456789',
    state: 'completed',
    displayState: state.deleted ? 'deleted' : 'completed',
    createdAt: time,
    acceptedAt: time,
    completedAt: time,
    cancelledAt: null,
    deletedAt: state.deleted ? time : null,
    deletionReason: state.deleted
      ? state.deleteReason
        ? { status: 'provided', value: state.deleteReason }
        : { status: 'not_provided' }
      : null,
    publisher: participant,
    accepter: participant,
    relation: state.relation,
    sourceRegion: { id: otherRegion, status: 'unavailable' },
    targetRegion: {
      id: regionId,
      status: 'available',
      label: '合成订单目标地区',
      active: true,
    },
  });
  const ok = (data) => ({ status: 200, headers: {}, body: data });
  const fail = (code, status = 403) => ({
    status,
    headers: {},
    body: { error: { code } },
  });
  const api = new ApiClient(
    'https://api.example',
    {
      async send(request) {
        requests.push(request);
        const url = new URL(request.url),
          route = url.pathname;
        if (route === '/v1/me/authorization') return ok(auth());
        if (route === '/v1/admin/errands' && request.method === 'GET')
          return ok({
            context: {
              regionId: url.searchParams.get('regionId'),
              management: auth().management.global ? 'global' : 'fixed',
              status: url.searchParams.get('status'),
              keyword: url.searchParams.get('keyword'),
              search: {
                matcher: 'public-text-name-uuid-v1',
                legacyNumericReferences: 'unavailable',
              },
            },
            items: [order()],
            continuation: 'end',
            nextCursor: null,
            total: { status: 'known', value: '1' },
          });
        if (/\/v1\/admin\/errand-(?:restriction-)?requests\//.test(route)) {
          if (state.receipt503) return fail('AUTHORIZATION_UNAVAILABLE', 503);
          if (state.receiptMissing) return fail('REQUEST_NOT_FOUND', 404);
          const result = receipts.get(route.split('/').at(-1));
          return result ? ok(result) : fail('REQUEST_NOT_FOUND', 404);
        }
        if (
          route === '/v1/admin/errand-restrictions' &&
          request.method === 'GET'
        ) {
          if (!auth().management.global) return fail('FORBIDDEN');
          const items = records.filter(
            (item) =>
              (!url.searchParams.get('action') ||
                item.action === url.searchParams.get('action')) &&
              (url.searchParams.get('state') === 'all' ||
                item.state === url.searchParams.get('state')),
          );
          return ok({
            items,
            continuation: 'end',
            nextCursor: null,
            recordedTotal: { status: 'known', value: String(items.length) },
            historyCoverage: 'unknown_before_boundary',
          });
        }
        if (route.endsWith('/history')) {
          const record = records.find((item) =>
            route.includes(item.restrictionId),
          );
          return ok({
            restriction: record,
            events: url.searchParams.has('cursor')
              ? []
              : [
                  {
                    eventId,
                    kind: 'issued',
                    effectiveAt: time,
                    recordedAt: time,
                    reason: '合成签发理由',
                    operator: participant,
                    replacementRestrictionId: null,
                  },
                ],
            continuation:
              state.historyMore && !url.searchParams.has('cursor')
                ? 'more'
                : 'end',
            nextCursor:
              state.historyMore && !url.searchParams.has('cursor')
                ? cursor
                : null,
            historyCoverage: 'unknown_before_boundary',
          });
        }
        if (request.method === 'POST') {
          sent.push(request);
          if (state.hold) await state.hold.promise;
          const body = request.body,
            cached = receipts.get(body.clientRequestId);
          if (cached) return ok(cached);
          let result;
          if (
            route.endsWith('/delete') ||
            route.endsWith('/restrict-accepter')
          ) {
            const operation = route.endsWith('/delete')
              ? 'admin_delete'
              : 'restrict_accepter';
            result = {
              requestId: body.clientRequestId,
              operation,
              outcome: 'applied',
              orderId,
              revision: operation === 'admin_delete' ? eventId : revision,
              occurredAt: time,
            };
            if (operation === 'admin_delete') {
              state.deleted = true;
              state.deleteReason = body.deleteReason;
            }
          } else {
            const release = route.endsWith('/release'),
              id = release ? route.split('/').at(-2) : restrictionId;
            result = {
              requestId: body.clientRequestId,
              operation: release ? 'release' : 'issue',
              outcome: 'applied',
              restrictionId: id,
              eventId,
              occurredAt: time,
            };
            if (release)
              records = records.map((item) =>
                item.restrictionId === id
                  ? {
                      ...item,
                      state: 'released',
                      terminal: {
                        kind: 'manually_released',
                        eventId,
                        effectiveAt: time,
                        reason: body.reason,
                        replacementRestrictionId: null,
                      },
                    }
                  : item,
              );
          }
          receipts.set(body.clientRequestId, result);
          if (state.drop) {
            state.drop = false;
            throw new ClientError('timeout', 'Synthetic dropped result');
          }
          return ok(result);
        }
        throw new Error(`Unexpected synthetic route ${route}`);
      },
    },
    app.identity.sessions,
    {
      refresh: async () => {
        throw new Error('No provider refresh');
      },
    },
  );
  app.community.errandAdmin = new HttpErrandAdminGateway(api);
  app.community.errandAdminCommands = new HttpErrandAdminCommandsGateway(api);
  app.community.pendingErrandAdmin = new PendingErrandAdminStore(
    {
      get: (key) => stored.get(key),
      set: (key, value) => stored.set(key, value),
      remove: (key) => stored.delete(key),
    },
    'synthetic-admin-smoke',
  );
  app.community.newRequestId = async () =>
    `aaaaaaaa-aaaa-4aaa-8aaa-${String(++state.sequence).padStart(12, '0')}`;
  globalThis.wx.navigateTo = ({ url, success }) => {
    navigation.push(url);
    success?.({});
    return {};
  };
  const common = parse(
    readFileSync(path.join(dist, 'errands/admin-command.wxml'), 'utf8'),
  );
  const templates = Object.fromEntries(
    common.children
      .filter((node) => typeof node !== 'string' && node.attrs?.name)
      .map((node) => [node.attrs.name, node]),
  );
  const mount = (name, query = {}) => {
    let page;
    const previous = globalThis.Page;
    globalThis.Page = (value) => {
      page = value;
    };
    const filename = path.join(dist, `pages/${name}/${name}.js`);
    delete require.cache[require.resolve(filename)];
    require(filename);
    globalThis.Page = previous;
    page.setData = (data) => {
      page.data = { ...page.data, ...data };
    };
    page.onLoad(query);
    page.onShow();
    return page;
  };
  const shown = (page, name) =>
    JSON.stringify(
      render(
        parse(
          readFileSync(path.join(dist, `pages/${name}/${name}.wxml`), 'utf8'),
        ).children,
        page.data,
        templates,
      ),
    );
  const tap = (page, name, id) =>
    page[name]({ currentTarget: { dataset: { id } } });
  const input = (page, name, value) => page[name]({ detail: { value } });
  const cleared = (page) => {
    assert.equal(page.data.loaded, false);
    assert.deepEqual(page.data.items, []);
    assert.equal(
      'total' in page.data ? page.data.total : page.data.recordedTotal,
      null,
    );
  };
  let page = mount('errand-admin');
  await flush();
  assert.equal(
    page.data.loaded,
    true,
    JSON.stringify({
      data: page.data,
      requests: requests.map((r) => new URL(r.url).pathname),
    }),
  );
  assert.ok(shown(page, 'errand-admin').includes('管理删除订单'));
  tap(page, 'onAdminDelete', orderId);
  assert.equal(page.data.adminCommand.publisherRestriction, false);
  let text = shown(page, 'errand-admin');
  assert.ok(text.includes('可选，默认不选'));
  assert.ok(text.includes(regionId));
  page.onAdminPublisherRestriction({ detail: { value: true } });
  input(page, 'onAdminReason', '合成处理原因');
  input(page, 'onAdminDuration', '10');
  text = shown(page, 'errand-admin');
  assert.ok(text.includes('对所有地区生效'));
  assert.ok(text.includes('永久限制'));
  page.onAdminDismiss();
  page.onAdminConfirm();
  await flush();
  assert.equal(sent.length, 0);
  tap(page, 'onAdminDelete', orderId);
  input(page, 'onAdminReason', '可独立读取的删除原因');
  state.drop = true;
  page.onAdminConfirm();
  page.onAdminConfirm();
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(page.data.adminCommand.frozen, true);
  assert.equal(stored.size, 1);
  state.receipt503 = true;
  page.onAdminRecover();
  await flush();
  cleared(page);
  assert.equal(stored.size, 1);
  assert.ok(page.data.adminCommand.frozen);
  state.receipt503 = false;
  state.role = 'developer';
  page.onAdminRecover();
  await flush();
  assert.equal(stored.size, 0);
  await flush();
  assert.ok(shown(page, 'errand-admin').includes('可独立读取的删除原因'));
  assert.equal(sent.length, 1);
  page.onUnload();
  state.role = 'school_admin';
  state.deleted = false;
  state.relation = 'publisher';
  page = mount('errand-admin');
  await flush();
  text = shown(page, 'errand-admin');
  assert.ok(text.includes('按发布者流程管理自己的订单'));
  assert.ok(!text.includes('管理删除订单'));
  assert.ok(text.includes('限制此订单接单者'));
  tap(page, 'onAdminRestrictAccepter', orderId);
  assert.equal(page.data.adminCommand.modal.operation, 'restrict_accepter');
  page.onAdminDismiss();
  tap(page, 'onOwnerOrder', orderId);
  assert.equal(
    navigation.at(-1),
    `/pages/errand-detail/errand-detail?orderId=${orderId}`,
  );
  page.onUnload();
  state.relation = 'none';
  page = mount('errand-restrictions');
  await flush();
  assert.equal(page.data.access, 'denied');
  assert.ok(!shown(page, 'errand-restrictions').includes('签发新跑腿限制'));
  page.onUnload();
  state.role = 'developer';
  page = mount('errand-restrictions');
  await flush();
  text = shown(page, 'errand-restrictions');
  assert.ok(text.includes('完整历史未知'));
  assert.ok(text.includes('已记录结果精确总数：2'));
  tap(page, 'onHistory', restrictionId);
  await flush();
  assert.equal(page.data.mode, 'history');
  assert.equal(page.data.canNext, true);
  page.onNext();
  await flush();
  assert.ok(
    shown(page, 'errand-restrictions').includes('原签发或更早历史仍未知'),
  );
  page.onPrevious();
  await flush();
  assert.equal(page.data.events.length, 1);
  tap(page, 'onRelease', restrictionId);
  text = shown(page, 'errand-restrictions');
  assert.ok(text.includes('该账号可能仍有其他'));
  input(page, 'onAdminReason', '合成单项解除');
  page.onAdminConfirm();
  await flush();
  assert.equal(
    records.find((item) => item.restrictionId === restrictionId).state,
    'released',
  );
  assert.equal(
    records.find((item) => item.restrictionId === separateRestrictionId).state,
    'active',
  );
  page.onBackToList();
  await flush();
  page.onIssue();
  input(page, 'onAdminTarget', profileId);
  input(page, 'onAdminReason', '新合成限制');
  input(page, 'onAdminDuration', '5');
  state.hold = deferred();
  page.onAdminConfirm();
  await flush();
  const pendingCount = stored.size;
  assert.equal(pendingCount, 1);
  page.onHide();
  state.hold.resolve();
  state.hold = null;
  await flush();
  assert.equal(stored.size, 1);
  cleared(page);
  page.onShow();
  await flush();
  state.receiptMissing = true;
  page.onAdminRecover();
  await flush();
  assert.equal(stored.size, 1);
  const beforeReplay = sent.length;
  state.receiptMissing = false;
  page.onAdminRetry();
  await flush();
  assert.equal(stored.size, 0);
  assert.equal(sent.length, beforeReplay + 1);
  assert.deepEqual(sent.at(-1).body, sent.at(-2).body);
  page.onUnload();
  records = [
    {
      ...record(restrictionId, 'all'),
      origin: 'baseline',
      state: 'released',
      operator: { status: 'unknown' },
      source: { kind: 'unknown' },
      terminal: { kind: 'baseline_released', effectiveAt: time },
    },
  ];
  page = mount('errand-restrictions');
  await flush();
  text = shown(page, 'errand-restrictions');
  assert.ok(text.includes('基线已知解除时间'));
  assert.ok(text.includes('原操作人与解除原因未知'));
  assert.ok(!text.includes('已手动解除'));
  assert.ok(!text.includes('onRelease'));
  page.onUnload();
  for (const boundary of ['scope', 'browse', 'safety', 'epoch']) {
    page = mount('errand-restrictions');
    await flush();
    page.onIssue();
    assert.ok(page.data.adminCommand.modal);
    if (boundary === 'scope')
      app.community.directoryScopeChanges.clear(original.credentials.accountId);
    if (boundary === 'browse')
      app.community.browsingScopeChanges.clear(original.credentials.accountId);
    if (boundary === 'safety')
      app.community.safetyChanges.invalidate(original.credentials.accountId);
    if (boundary === 'epoch')
      app.identity.sessions.completeLogin(
        app.identity.sessions.beginLogin(),
        original.credentials,
      );
    cleared(page);
    assert.equal(page.data.adminCommand.modal, null);
    const before = sent.length;
    page.onAdminConfirm();
    await flush();
    assert.equal(sent.length, before);
    page.onUnload();
  }
  assert.ok(requests.every((request) => request.headers.Authorization));
  app.community.errandAdmin = original.admin;
  app.community.errandAdminCommands = original.commands;
  app.community.pendingErrandAdmin = original.pending;
  app.community.newRequestId = original.newRequestId;
  globalThis.wx.navigateTo = original.navigateTo;
  console.log(
    'Errand admin mutation emitted smoke passed: native scoped/global confirmation, exact cross-region effects, optional publisher restriction off, owner E1 routing, unknown/503/current-authority recovery, immutable replay, one-of-many release, honest history paging and lifecycle invalidation; synthetic transport/WXML only, not device or backend acceptance',
  );
}
