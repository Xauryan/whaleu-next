/** Emitted native controller/gateway/Page/WXML; bounded synthetic HTTP/platform. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, render } from './smoke-ratings.mjs';
const require = createRequire(import.meta.url);
export async function smokeSchoolAdminManagement({ dist }) {
  const emitted = (name) => require(path.join(dist, `${name}.js`));
  const { ApiClient } = emitted('api/client'),
    { ClientError } = emitted('api/errors'),
    { SessionStore } = emitted('auth/session'),
    { createCommunityRuntime } = emitted('community/runtime');
  const id = (n) => `${String(n).padStart(8, '0')}-cafe-4ca7-8ca7-ca71ca71ca71`,
    accountId = id(1),
    profileId = id(10),
    region = id(20),
    related = id(21),
    origin = 'https://school-admin-native.example';
  const sessions = new SessionStore();
  const login = (actor = accountId) =>
    sessions.completeLogin(sessions.beginLogin(), {
      accountId: actor,
      sessionId: id(2),
      accessToken: `wu_a_${'a'.repeat(43)}`,
      refreshToken: `wu_r_${'b'.repeat(43)}`,
      expiresAt: 1900000000000,
      refreshExpiresAt: 1900600000000,
    });
  login();
  const storage = new Map(),
    receipts = new Map(),
    commands = [],
    calls = [];
  let runtime,
    assignment = null,
    sequence = 100,
    version = 'a'.repeat(64),
    allowed = true,
    lose = false,
    drop = false;
  const transport = {
    async send(request) {
      const url = new URL(request.url);
      calls.push(url.pathname);
      assert.equal(url.origin, origin);
      assert.ok(request.headers.Authorization);
      let body;
      if (url.pathname === '/v1/me/authorization')
        body = {
          role: 'developer',
          schoolAdminManagement: allowed,
          management: { global: true, operatingRegionIds: [] },
          identityView: { allowed: true, maxBatchSize: 20 },
        };
      else if (url.pathname.endsWith('/management')) {
        if (url.searchParams.get('targetProfileId') !== profileId)
          throw new ClientError('http', 'Missing public reference', {
            httpStatus: 404,
            serverCode: 'SCHOOL_ADMIN_MANAGEMENT_TARGET_NOT_ALLOWED',
          });
        assert.deepEqual([...url.searchParams.keys()], ['targetProfileId']);
        body = {
          target: { profileId, displayName: '合成公开昵称' },
          stateVersion: version,
          currentAssignment: assignment,
          eligibility: {
            status: 'known',
            reason: null,
            regions: [
              { id: region, name: '原地区' },
              { id: related, name: '新地区' },
            ],
            defaultRegionId: assignment?.regionId ?? region,
          },
          actions: {
            appoint: assignment === null,
            reassign: assignment !== null,
            revoke: assignment !== null,
          },
        };
      } else if (url.pathname.includes('/requests/')) {
        const saved = receipts.get(url.pathname.split('/').at(-1));
        body = saved
          ? { state: 'recorded', receipt: saved }
          : { state: 'not_recorded' };
      } else if (
        url.pathname.endsWith('/commands') ||
        url.pathname.endsWith('/commands/cancel')
      ) {
        const c = request.body,
          pending = runtime.pendingSchoolAdminManagement.load(accountId);
        assert.deepEqual(pending.command, c);
        assert.equal(
          pending.phase,
          url.pathname.endsWith('/cancel') ? 'cancel' : 'submit',
        );
        commands.push(c);
        if (drop) {
          drop = false;
          throw new ClientError('network', 'Dropped before server');
        }
        body = receipts.get(c.clientRequestId);
        if (!body) {
          const { clientRequestId, ...intent } = c;
          const base = { ...intent, requestId: clientRequestId };
          if (url.pathname.endsWith('/cancel'))
            body = {
              ...base,
              outcome: 'rejected',
              code: 'SCHOOL_ADMIN_MANAGEMENT_CANCELLED',
            };
          else if (c.expectedStateVersion !== version)
            body = {
              ...base,
              outcome: 'rejected',
              code: 'SCHOOL_ADMIN_MANAGEMENT_STALE',
            };
          else {
            const unchanged =
              c.action === 'reassign' && c.regionId === assignment?.regionId;
            assignment =
              c.action === 'revoke'
                ? null
                : {
                    regionId: c.regionId,
                    name: c.regionId === region ? '原地区' : '新地区',
                    status: 'active',
                  };
            version = String(sequence++).padStart(64, '0');
            body = {
              ...base,
              outcome: unchanged ? 'unchanged' : 'applied',
              eventId: id(sequence++),
              recordedAt: '2026-10-13T00:00:00.000Z',
              titleGranted: c.action === 'appoint',
            };
          }
          receipts.set(c.clientRequestId, body);
        }
        if (lose) {
          lose = false;
          throw new ClientError('network', 'Committed reply lost');
        }
      } else throw Error(`Unexpected route ${url.pathname}`);
      return { status: 200, headers: {}, body };
    },
  };
  const native = {
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    removeStorageSync: (key) => storage.delete(key),
  };
  const api = new ApiClient(origin, transport, sessions, {
    refresh: async () => {
      throw Error('No implicit auth replay');
    },
  });
  const boot = () => {
    runtime = createCommunityRuntime({ api, sessions }, native, origin);
    runtime.newRequestId = async () => id(sequence++);
  };
  boot();
  const app = { community: runtime },
    previous = { Page: globalThis.Page, getApp: globalThis.getApp },
    pages = [];
  const flush = async () => {
    for (let n = 0; n < 200; n++) await Promise.resolve();
  };
  const tree = parse(
    readFileSync(
      path.join(
        dist,
        'pages/school-admin-management/school-admin-management.wxml',
      ),
      'utf8',
    ),
  );
  const flatten = (nodes) =>
    nodes.flatMap((n) =>
      typeof n === 'string' ? [n] : [n, ...flatten(n.children)],
    );
  const mount = (query = {}) => {
    let definition;
    globalThis.Page = (v) => {
      definition = v;
    };
    const file = path.join(
      dist,
      'pages/school-admin-management/school-admin-management.js',
    );
    delete require.cache[require.resolve(file)];
    require(file);
    const page = {
      ...definition,
      data: structuredClone(definition.data),
      setData(patch) {
        Object.assign(this.data, patch);
      },
    };
    pages.push(page);
    page.onLoad(query);
    page.onShow();
    return page;
  };
  const nodes = (page) => flatten(render(tree.children, page.data, {}));
  const tap = (page, handler, dataset = {}) => {
    const node = nodes(page).find(
      (n) =>
        typeof n !== 'string' &&
        n.attrs.bindtap === handler &&
        Object.entries(dataset).every(([k, v]) => n.attrs[`data-${k}`] === v),
    );
    assert.ok(node, handler);
    assert.notEqual(node.attrs.disabled, 'true');
    page[handler]({ currentTarget: { dataset } });
  };
  const input = (page, value) => {
    assert.ok(
      nodes(page).find(
        (n) => typeof n !== 'string' && n.attrs.bindinput === 'onTargetInput',
      ),
    );
    page.onTargetInput({ detail: { value } });
  };
  const confirm = (page, action, selected = region) => {
    if (action !== 'revoke') tap(page, 'onSelectRegion', { id: selected });
    tap(page, 'onRequest', { action });
    assert.equal(page.data.confirming, action);
    const text = nodes(page)
      .filter((n) => typeof n === 'string')
      .join('');
    assert.match(text, /头衔不代表当前权限/);
    assert.match(text, /不会自动佩戴/);
    assert.match(text, /不发送通知/);
  };
  try {
    globalThis.getApp = () => app;
    assert.ok(
      JSON.parse(
        readFileSync(path.join(dist, 'app.json'), 'utf8'),
      ).pages.includes('pages/school-admin-management/school-admin-management'),
    );
    let page = mount();
    await flush();
    assert.equal(page.data.canManage, true);
    input(page, 'bad');
    tap(page, 'onReload');
    await flush();
    assert.match(page.data.error, /公开主页 ID/);
    input(page, id(999));
    tap(page, 'onReload');
    await flush();
    assert.ok(page.data.error);
    input(page, profileId);
    tap(page, 'onReload');
    await flush();
    assert.equal(page.data.loaded, true);
    assert.equal(page.data.selectedRegionId, '');
    confirm(page, 'appoint');
    tap(page, 'onClose');
    page.onSubmit();
    await flush();
    assert.equal(commands.length, 0);
    confirm(page, 'appoint');
    lose = true;
    tap(page, 'onSubmit');
    page.onSubmit();
    await flush();
    assert.equal(commands.length, 1);
    assert.equal(page.data.frozen, true);
    const first = commands[0];
    page.onUnload();
    boot();
    app.community = runtime;
    allowed = false;
    const before = calls.length;
    page = mount();
    await flush();
    assert.equal(calls.length, before, 'Recovery bypasses capability read');
    tap(page, 'onRecover');
    await flush();
    assert.equal(page.data.frozen, false);
    assert.equal(page.data.canManage, false);
    assert.match(page.data.receiptStatus, /历史结果/);
    assert.equal(commands.length, 1);
    allowed = true;
    tap(page, 'onReload');
    await flush();
    confirm(page, 'reassign', related);
    tap(page, 'onSubmit');
    await flush();
    assert.equal(page.data.management.currentAssignment.regionId, related);
    confirm(page, 'revoke');
    tap(page, 'onSubmit');
    await flush();
    assert.equal(page.data.management.currentAssignment, null);
    confirm(page, 'appoint');
    drop = true;
    tap(page, 'onSubmit');
    await flush();
    const original = runtime.pendingSchoolAdminManagement.load(accountId);
    tap(page, 'onRecover');
    await flush();
    assert.equal(page.data.pendingRequestId, original.command.clientRequestId);
    tap(page, 'onCancelRequest');
    tap(page, 'onConfirmCancel');
    await flush();
    assert.match(page.data.receiptStatus, /原请求已取消/);
    assert.equal(receipts.get(first.clientRequestId).outcome, 'applied');
    assert.equal(assignment, null);
    page.onHide();
    assert.equal(page.data.management, null);
    assert.equal(page.data.receiptStatus, '');
  } finally {
    for (const page of pages) page.onUnload();
    globalThis.Page = previous.Page;
    globalThis.getApp = previous.getApp;
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await smokeSchoolAdminManagement({
    dist: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist'),
  });
  console.log(
    'Emitted school-admin management smoke passed (synthetic platform/HTTP/WXML model, not device or PG acceptance)',
  );
}
