/** Emitted Page/WXML + strict HTTP gateway smoke. Synthetic protocol only, never API/PG policy evidence. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, render } from './smoke-ratings.mjs';
import { createNativePressBridge } from '../test/native-press-emitted-harness.mjs';
const require = createRequire(import.meta.url);
export async function smokeAccountModeration({ dist }) {
  const emitted = (name) => require(path.join(dist, `${name}.js`));
  const { ApiClient } = emitted('api/client'),
    { SessionStore } = emitted('auth/session'),
    { createCommunityRuntime } = emitted('community/runtime');
  const id = (n) => `${String(n).padStart(8, '0')}-cafe-4ca7-8ca7-ca71ca71ca71`,
    at = '2026-10-13T00:00:00.000Z';
  const p = {
    punishmentId: id(3),
    kind: 'access_suspension',
    revision: '1',
    reason: '合成封号原因',
    startsAt: at,
    endsAt: null,
    recordedAt: at,
    state: 'active',
    terminal: null,
    canAppeal: true,
    openAppealId: null,
  };
  const a = {
    appealId: id(4),
    punishment: p,
    text: '合成私人申诉',
    submittedAt: at,
    state: 'pending',
    decision: null,
  };
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), {
    accountId: id(1),
    sessionId: id(2),
    accessToken: `wu_a_${'a'.repeat(43)}`,
    refreshToken: `wu_r_${'b'.repeat(43)}`,
    expiresAt: 1900000000000,
    refreshExpiresAt: 1900600000000,
  });
  const commands = [],
    storage = new Map();
  let runtime,
    lose = true,
    recorded = null;
  const api = new ApiClient(
    'https://native-moderation.example',
    {
      async send(request) {
        const route = new URL(request.url).pathname;
        assert.ok(request.headers.Authorization);
        let body;
        if (request.method === 'POST') {
          const journal = runtime.pendingAccountModeration.load(id(1));
          assert.deepEqual(journal.command, request.body);
          commands.push(structuredClone(request.body));
          body = {
            requestId: request.body.clientRequestId,
            action: request.body.action,
            punishment: request.body.punishment,
            outcome: 'applied',
            recordedAt: at,
            appealId: id(4),
            reusedOpenCase: false,
          };
          recorded = body;
          if (lose) {
            lose = false;
            throw Error('synthetic lost response');
          }
        } else if (route.includes('/appeal-requests/'))
          body = { state: 'recorded', receipt: recorded };
        else if (route === '/v1/me/safety/status')
          body = {
            coverage: 'complete',
            effective: 'access_suspension',
            checkedAt: at,
            current: [
              p,
              { ...p, punishmentId: id(5), kind: 'interaction_mute' },
            ],
          };
        else if (route.startsWith('/v1/me/safety/punishments/')) body = p;
        else if (route.includes('/appeal-management/appeals/'))
          body = { ...a, stateVersion: 'a'.repeat(64), canDecide: true };
        else if (route.endsWith('/appeal-management/appeals'))
          body = {
            items: [{ ...a, stateVersion: 'a'.repeat(64), canDecide: true }],
            nextCursor: null,
          };
        else if (route.includes('/punishment-management/punishments/'))
          body = { ...p, stateVersion: 'b'.repeat(64), canRelease: true };
        else if (route.endsWith('/punishment-management/punishments'))
          body = {
            items: [{ ...p, stateVersion: 'b'.repeat(64), canRelease: true }],
            nextCursor: null,
          };
        else if (route.endsWith('/appeals'))
          body = { items: [a], nextCursor: null };
        else if (route.endsWith('/appeals/' + id(4))) body = a;
        else throw Error(`Unexpected route ${route}`);
        return { status: 200, headers: {}, body };
      },
    },
    sessions,
    {
      refresh: async () => {
        throw Error('No automatic auth replay');
      },
    },
  );
  const wx = {
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, v) => storage.set(key, v),
    removeStorageSync: (key) => storage.delete(key),
  };
  runtime = createCommunityRuntime(
    { sessions, api },
    wx,
    'https://native-moderation.example',
  );
  runtime.newRequestId = async () => id(99);
  const app = { identity: { sessions, api }, community: runtime };
  const previous = {
    Page: globalThis.Page,
    getApp: globalThis.getApp,
    wx: globalThis.wx,
  };
  const pages = [];
  const flat = (nodes) =>
    nodes.flatMap((n) =>
      typeof n === 'string' ? [n] : [n, ...flat(n.children)],
    );
  const flush = async () => {
    for (let i = 0; i < 200; i++) await Promise.resolve();
  };
  function templatesFor(file, templates = {}) {
    const tree = parse(readFileSync(file, 'utf8'));
    for (const node of tree.children) {
      if (typeof node === 'string') continue;
      if (node.tag === 'import')
        templatesFor(
          path.resolve(path.dirname(file), node.attrs.src),
          templates,
        );
      if (node.tag === 'template' && node.attrs.name)
        templates[node.attrs.name] = node;
    }
    return templates;
  }
  function mount(name, query = {}) {
    let page;
    globalThis.Page = (value) => {
      page = value;
    };
    globalThis.getApp = () => app;
    globalThis.wx = wx;
    const entry = path.join(dist, `pages/${name}/${name}.js`);
    delete require.cache[require.resolve(entry)];
    require(entry);
    assert.ok(page);
    page.setData = (patch) => {
      page.data = { ...page.data, ...patch };
    };
    pages.push(page);
    page.onLoad(query);
    page.onShow();
    const tree = parse(
      readFileSync(path.join(dist, `pages/${name}/${name}.wxml`), 'utf8'),
    );
    const nodes = () =>
      flat(
        render(
          tree.children,
          page.data,
          templatesFor(path.join(dist, `pages/${name}/${name}.wxml`)),
        ),
      );
    const nativeOwner = [
      'account-status',
      'safety-appeal',
      'safety-appeal-management',
      'safety-punishment-management',
    ].includes(name);
    const nativePress = nativeOwner
      ? createNativePressBridge({
          page,
          pageFile: path.join(dist, `pages/${name}/${name}`),
          dist,
        })
      : null;
    const event = (handler, detail = {}, dataset = {}) => {
      // Consumer and management presses use the actual registered Component.
      // Native textarea events retain the original raw control boundary.
      if (nativePress?.find(handler, dataset)) {
        const capture = nativePress.capture(handler, dataset);
        assert.equal(capture.press(), true, `Native consumer press ${handler}`);
        capture.detach();
        return;
      }
      const n = nodes().find(
        (n) =>
          typeof n !== 'string' &&
          (n.attrs.bindtap === handler || n.attrs.bindinput === handler) &&
          Object.entries(dataset).every(
            ([key, value]) => n.attrs['data-' + key] === value,
          ),
      );
      assert.ok(n, `Rendered ${handler}`);
      assert.notEqual(n.attrs.disabled, 'true');
      page[handler]({ detail, currentTarget: { dataset } });
    };
    return { page, nodes, event };
  }
  try {
    let h = mount('account-status');
    await flush();
    assert.equal(h.page.data.accountStatus.effective, 'access_suspension');
    assert.equal(h.page.data.accountStatus.current.length, 2);
    assert.ok(
      h
        .nodes()
        .some((n) => typeof n === 'string' && n.includes('封号不会退出登录')),
    );
    h.page.onHide();
    h = mount('safety-appeal', { punishmentId: id(3) });
    await flush();
    h.event('onText', { value: '合成私人申诉' });
    h.event('onRequestAppeal');
    assert.equal(h.page.data.confirming, 'submit_appeal');
    h.event('onSubmit');
    await flush();
    assert.equal(h.page.data.frozen, true);
    h.page.onHide();
    h = mount('safety-appeal');
    await flush();
    h.event('onRecover');
    await flush();
    assert.equal(h.page.data.frozen, false);
    assert.match(h.page.data.receiptStatus, /完成/);
    assert.equal(commands.length, 1);
    h.page.onHide();
    h = mount('safety-appeal-management', { appealId: id(4) });
    await flush();
    h.event('onReason', { value: '合成决定' });
    h.event('onRequestDecision', {}, { decision: 'released' });
    assert.equal(h.page.data.confirming, 'decide_appeal');
    h.event('onClose');
    assert.equal(h.page.data.confirming, null);
    h.page.onHide();
    h = mount('safety-punishment-management', { punishmentId: id(3) });
    await flush();
    h.event('onReason', { value: '合成解除' });
    h.event('onRequestRelease');
    assert.equal(h.page.data.confirming, 'release');
    h.event('onClose');
    assert.equal(h.page.data.confirming, null);
    sessions.logout();
    assert.equal(h.page.data.selectedPunishment, null);
  } finally {
    for (const p of pages) p.onUnload?.();
    Object.assign(globalThis, previous);
  }
  console.log(
    'Account moderation emitted Page/WXML/strict HTTP smoke passed: independent mute/suspension display, private immutable appeal loss/recovery, current admin decision/release confirmation and session cleanup. Synthetic protocol only; not AppModule/PG or physical-device acceptance.',
  );
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  await smokeAccountModeration({
    dist: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist'),
  });
