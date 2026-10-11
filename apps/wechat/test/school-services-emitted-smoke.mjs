/** Actual emitted Page/WXML event wiring; synthetic platform data only. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, render } from '../scripts/smoke-ratings.mjs';
const require = createRequire(import.meta.url),
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  dist = path.join(root, 'dist');
const emitted = (name) => require(path.join(dist, name + '.js'));
const { SessionStore } = emitted('auth/session'),
  { ClientError } = emitted('api/errors'),
  { schoolEntryKeys, publicSchoolEntryKeys, schoolCommandHash } = emitted(
    'school-configuration/contract',
  );
const campus = '33333333-3333-4333-8333-333333333333',
  region = '55555555-5555-4555-8555-555555555555',
  account = '11111111-1111-4111-8111-111111111111',
  requestId = '77777777-7777-4777-8777-777777777777';
const sessions = new SessionStore();
sessions.completeLogin(sessions.beginLogin(), {
  accountId: account,
  sessionId: '22222222-2222-4222-8222-222222222222',
  accessToken: 'wu_a_' + 'a'.repeat(43),
  refreshToken: 'wu_r_' + 'b'.repeat(43),
  expiresAt: 1900000000000,
  refreshExpiresAt: 1900600000000,
});
const entries = schoolEntryKeys.map((entryKey) => ({
  entryKey,
  revision: entryKey === 'admin' ? 1 : 0,
  state: entryKey === 'admin' ? 'configured' : 'unconfigured',
  data:
    entryKey === 'admin'
      ? { kind: 'admin', enabled: true, wechatId: 'synthetic_admin' }
      : null,
  qrcode: { status: entryKey === 'admin' ? 'configured' : 'none' },
}));
const receipts = new Map(),
  storage = new Map(),
  copied = [];
let lose = true;
const api = {
  async request(endpoint, options = {}) {
    const pathname = endpoint.path;
    let result;
    if (pathname === '/v1/school-services')
      result = {
        context: {
          campusId: options.query.campusId,
          campusName: '合成大学',
          region: { id: region, name: '合成管理地区' },
        },
        entries: entries
          .filter((entry) => publicSchoolEntryKeys.includes(entry.entryKey))
          .map((entry) =>
            entry.state === 'disabled'
              ? { ...entry, data: null, qrcode: { status: 'none' } }
              : entry,
          ),
      };
    else if (pathname.endsWith('/capabilities'))
      result = {
        management: 'fixed',
        region: { id: region, name: '合成管理地区' },
      };
    else if (pathname === '/v1/me/school-configuration')
      result = {
        context: {
          regionId: region,
          regionName: '合成管理地区',
          management: 'fixed',
        },
        entries,
      };
    else if (
      pathname === `/v1/me/school-configuration/${region}/entries/admin`
    ) {
      const command = options.body,
        index = entries.findIndex((entry) => entry.entryKey === 'admin');
      entries[index] = {
        entryKey: 'admin',
        revision: command.expectedRevision + 1,
        state: command.entry.enabled ? 'configured' : 'disabled',
        data: command.entry,
        qrcode: { status: 'configured' },
      };
      result = {
        requestId: command.clientRequestId,
        requestHash: schoolCommandHash(account, region, 'admin', command),
        regionId: region,
        entryKey: 'admin',
        revision: command.expectedRevision + 1,
        outcome: 'saved',
      };
      receipts.set(command.clientRequestId, result);
      if (lose) {
        lose = false;
        throw new ClientError('network', 'Synthetic lost response');
      }
    } else if (pathname.includes('/requests/')) {
      const id = pathname.split('/').at(-1),
        receipt = receipts.get(id);
      result = receipt
        ? { state: 'recorded', requestId: id, receipt }
        : { state: 'not_recorded', requestId: id };
    } else throw new Error('Unexpected endpoint ' + pathname);
    return endpoint.decode(structuredClone(result));
  },
};
const wx = {
  getStorageSync: (key) => storage.get(key),
  setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
  removeStorageSync: (key) => storage.delete(key),
  setClipboardData: (options) => {
    copied.push(options.data);
    options.success();
  },
};
const app = {
  identity: { sessions, api },
  community: { newRequestId: async () => requestId },
  schoolQr: {
    createReader: (callback) => ({
      load: async () =>
        callback({
          status: 'ready',
          message: 'Synthetic QR',
          src: 'wxfile://tmp/school-qr.png',
        }),
      clear: () => callback({ status: 'idle', message: '', src: '' }),
      dispose: () => callback({ status: 'idle', message: '', src: '' }),
    }),
    createUploader: (callback) => ({
      clear: () => callback({ status: 'idle', message: '', progress: 0 }),
      dispose: () => callback({ status: 'idle', message: '', progress: 0 }),
    }),
  },
};
const before = {
  Page: globalThis.Page,
  getApp: globalThis.getApp,
  wx: globalThis.wx,
};
const drain = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};
const flatten = (nodes) =>
  nodes.flatMap((node) =>
    typeof node === 'string' ? [node] : [node, ...flatten(node.children)],
  );
function mount(name) {
  let page;
  globalThis.Page = (value) => {
    page = value;
  };
  globalThis.getApp = () => app;
  globalThis.wx = wx;
  const target = path.join(dist, 'pages', name, name + '.js');
  delete require.cache[require.resolve(target)];
  require(target);
  assert.ok(page);
  page.setData = (patch) => {
    page.data = { ...page.data, ...patch };
  };
  const tree = parse(
    readFileSync(path.join(dist, 'pages', name, name + '.wxml'), 'utf8'),
  );
  const nodes = () => flatten(render(tree.children, page.data));
  const tap = (handler, match = () => true) => {
    const node = nodes().find(
      (node) =>
        typeof node !== 'string' &&
        node.tag === 'button' &&
        node.attrs.bindtap === handler &&
        match(node),
    );
    assert.ok(node, 'Actual WXML renders ' + handler);
    assert.notEqual(node.attrs.disabled, 'true');
    const dataset = Object.fromEntries(
      Object.entries(node.attrs)
        .filter(([key]) => key.startsWith('data-'))
        .map(([key, value]) => [key.slice(5), value]),
    );
    return page[handler]({ currentTarget: { dataset } });
  };
  return { page, nodes, tap };
}
try {
  const manifest = JSON.parse(
    readFileSync(path.join(dist, 'app.json'), 'utf8'),
  );
  assert.ok(manifest.pages.includes('pages/school-services/school-services'));
  assert.ok(
    manifest.pages.includes('pages/school-configuration/school-configuration'),
  );
  const publicPage = mount('school-services');
  publicPage.page.onLoad({ campusId: campus });
  publicPage.page.onShow();
  await drain();
  assert.equal(publicPage.page.data.entries.length, 5);
  publicPage.tap('onCopy', (node) => node.attrs['data-field'] === 'wechatId');
  await drain();
  assert.deepEqual(copied, ['synthetic_admin']);
  publicPage.tap('onPreview');
  await drain();
  assert.equal(publicPage.page.data.qr.src, 'wxfile://tmp/school-qr.png');
  publicPage.tap('onCloseQr');
  assert.equal(publicPage.page.data.qr.src, '');
  publicPage.page.onHide();
  assert.deepEqual(publicPage.page.data.entries, []);
  const adminPage = mount('school-configuration');
  adminPage.page.onShow();
  await drain();
  adminPage.tap('onChooseEntry', (node) => node.attrs['data-key'] === 'admin');
  assert.equal(adminPage.page.data.form.wechatId, 'synthetic_admin');
  adminPage.page.onField({
    currentTarget: { dataset: { field: 'wechatId' } },
    detail: { value: 'changed_admin' },
  });
  adminPage.tap('onSave');
  await drain();
  assert.equal(adminPage.page.data.pending, true);
  adminPage.page.onHide();
  const resumed = mount('school-configuration');
  resumed.page.onShow();
  await drain();
  assert.equal(resumed.page.data.pending, true);
  resumed.tap('onRecover');
  await drain();
  assert.equal(resumed.page.data.pending, false);
  resumed.tap('onRefresh');
  await drain();
  resumed.tap('onChooseEntry', (node) => node.attrs['data-key'] === 'admin');
  assert.equal(resumed.page.data.form.wechatId, 'changed_admin');
  sessions.logout();
  assert.equal(resumed.page.data.form, null);
  assert.deepEqual(resumed.page.data.entries, []);
  resumed.page.onUnload();
  publicPage.page.onUnload();
  console.log(
    'School service emitted Page/WXML smoke passed (synthetic platform; not physical-device acceptance).',
  );
} finally {
  Object.assign(globalThis, before);
}
