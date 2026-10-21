/** Actual emitted registration/WXML/API client; synthetic transport is not HTTP/PG acceptance. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, render } from './smoke-ratings.mjs';
import { createNativePressBridge } from '../test/native-press-emitted-harness.mjs';
const require = createRequire(import.meta.url);
const dist = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../dist',
);
const emitted = (name) => require(path.join(dist, `${name}.js`));
const { SessionStore } = emitted('auth/session');
const { ApiClient } = emitted('api/client');
const { PrivateViewLifecycle } = emitted('identity-privacy/overlay');
const { createVerificationRuntime } = emitted('verification/runtime');
const { createInstitutionalRuntime } = emitted(
  'verification/institutional-runtime',
);
const { HttpSchoolUidGateway } = emitted('school-uid/gateway');
const { institutionalCommandHash, institutionalConsent, institutionalPurpose } =
  emitted('verification/institutional-contract');
const config = emitted('config'),
  savedConfig = config.clientConfiguration;
const id = '12345678-1234-4123-8123-123456789aaa',
  campusId = '12345678-1234-4123-8123-123456789bbb',
  accountId = '12345678-1234-4123-8123-123456789ccc';
const origin = 'https://synthetic-institution.invalid',
  version = 'a'.repeat(64);
const registered = JSON.parse(
  readFileSync(path.join(dist, 'app.json'), 'utf8'),
).pages;
const name = 'institutional-verification';
assert.ok(registered.includes(`pages/${name}/${name}`));
assert.match(
  readFileSync(
    path.join(dist, 'verification/institutional-contract.js'),
    'utf8',
  ),
  /require\("\.\.\/vendor\/sha256"\)/,
);
assert.match(
  readFileSync(path.join(dist, 'pages/verification/verification.wxml'), 'utf8'),
  /pages\/institutional-verification\/institutional-verification/,
);
const tick = async () => {
  for (let i = 0; i < 200; i++) await Promise.resolve();
};
const flat = (nodes) =>
  nodes.flatMap((node) =>
    typeof node === 'string' ? [node] : [node, ...flat(node.children)],
  );
const tree = parse(
  readFileSync(path.join(dist, `pages/${name}/${name}.wxml`), 'utf8'),
);
const savedGlobals = {
  Page: globalThis.Page,
  getApp: globalThis.getApp,
  wx: globalThis.wx,
};
const storage = new Map(),
  calls = [],
  navigations = [],
  views = [];
const sessions = new SessionStore();
sessions.completeLogin(sessions.beginLogin(), {
  accountId,
  sessionId: '22345678-1234-4123-8123-123456789ccc',
  accessToken: `wu_a_${'a'.repeat(43)}`,
  refreshToken: `wu_r_${'a'.repeat(43)}`,
  expiresAt: 4_000_000_000_000,
  refreshExpiresAt: 4_001_000_000_000,
});
let receipt = null,
  verificationReads = 0,
  uidReads = 0,
  handoffs = 0,
  uidUnavailable = false;
const api = new ApiClient(
  origin,
  {
    async send(request) {
      const url = new URL(request.url),
        route = url.pathname;
      calls.push({ route, body: request.body });
      let body;
      if (route === '/v1/me/verification') {
        verificationReads++;
        body = {
          affiliation: {
            status: receipt?.state === 'completed' ? 'verified' : 'unverified',
          },
          studentNumber: {
            status: receipt?.state === 'completed' ? 'verified' : 'unverified',
          },
          phone: { status: 'unverified' },
          application: { status: 'none' },
        };
      } else if (route === '/v1/me/school-uid') {
        uidReads++;
        if (uidUnavailable)
          return {
            status: 503,
            headers: {},
            body: { error: { code: 'SCHOOL_UID_UNAVAILABLE' } },
          };
        body =
          receipt?.state === 'completed'
            ? {
                status: 'assigned',
                school: { code: '12345', name: '合成学校' },
                uid: '42',
                formattedUid: '000042',
              }
            : { status: 'unassigned' };
      } else if (route.endsWith('/capability')) {
        assert.equal(url.searchParams.get('campusId'), campusId);
        body = {
          campusId,
          state: 'eligible',
          schoolName: '合成学校',
          capabilityVersion: version,
          consent: institutionalConsent,
          purpose: institutionalPurpose,
          supportedFacts: ['affiliation', 'student_number'],
        };
      } else if (route === '/v1/me/institutional-sso/requests') {
        assert.deepEqual(request.body, {
          requestId: id,
          campusId,
          capabilityVersion: version,
          consent: institutionalConsent,
        });
        const saved = [...storage.values()][0];
        assert.equal(saved.phase, 'prepare_unstarted');
        receipt = {
          requestId: id,
          requestHash: institutionalCommandHash(accountId, request.body),
          state: 'prepared',
          context: {
            campusId,
            capabilityVersion: version,
            consent: institutionalConsent,
          },
          expiresAt: '2030-10-14 02:00:00.000001+00',
        };
        body = receipt;
      } else if (route.endsWith('/complete')) {
        if (request.body.mode === 'authorize') {
          assert.equal([...storage.values()][0].phase, 'submit_pending');
          assert.deepEqual(Object.keys(request.body).sort(), [
            'authorizationResponse',
            'mode',
            'requestHash',
          ]);
          assert.equal(
            request.body.authorizationResponse,
            'one-use-synthetic-secret',
          );
          receipt = {
            requestId: id,
            requestHash: receipt.requestHash,
            state: 'completed',
            changedFacts: ['affiliation', 'student_number'],
            uidOutcome: 'issued',
            uidReason: null,
          };
        } else assert.equal(request.body.mode, 'recover');
        body = receipt;
      } else if (route.endsWith('/close')) {
        assert.equal([...storage.values()][0].phase, 'cancel');
        receipt = {
          requestId: id,
          requestHash: request.body.requestHash,
          state: 'cancelled',
        };
        body = receipt;
      } else if (route.endsWith(`/requests/${id}`))
        body = receipt ?? {
          requestId: id,
          requestHash: null,
          state: 'not_recorded',
        };
      else assert.fail(`Unexpected synthetic route ${route}`);
      return { status: 200, headers: {}, body };
    },
  },
  sessions,
  {
    async refresh() {
      assert.fail('No synthetic auth refresh expected');
    },
  },
);
const identity = { sessions, api },
  verification = createVerificationRuntime(identity);
const community = {
  sessions,
  gateway: {},
  newRequestId: async () => id,
  schoolUid: new HttpSchoolUidGateway(api),
  privateViews: new PrivateViewLifecycle(),
};
const app = { identity, verification, community };
app.institutionalSso = createInstitutionalRuntime(
  identity,
  community,
  verification,
  {
    get: (key) => storage.get(key),
    set: (key, value) => storage.set(key, structuredClone(value)),
    remove: (key) => storage.delete(key),
  },
  origin,
);
const wx = {
  navigateBack: (options) => options.fail({}),
  reLaunch: (options) => {
    navigations.push(options.url);
    options.success();
  },
};
function mount() {
  let page;
  globalThis.Page = (definition) => {
    page = definition;
  };
  globalThis.getApp = () => app;
  globalThis.wx = wx;
  const entry = path.join(dist, `pages/${name}/${name}.js`);
  delete require.cache[require.resolve(entry)];
  require(entry);
  assert.ok(page);
  page.setData = (patch) => {
    views.push(structuredClone(patch));
    page.data = { ...page.data, ...patch };
  };
  const controls = createNativePressBridge({
    page,
    pageFile: entry.slice(0, -3),
    dist,
  });
  const nodes = () => flat(render(tree.children, page.data, {}));
  const event = (binding, handler, detail = {}) => {
    if (binding === 'bindtap' && controls.find(handler)) {
      const hit = controls.capture(handler);
      try {
        assert.equal(hit.press(), true);
      } finally {
        hit.detach();
      }
      return;
    }
    const node = nodes().find(
      (node) => typeof node !== 'string' && node.attrs[binding] === handler,
    );
    assert.ok(node, `WXML renders ${handler}`);
    assert.notEqual(node.attrs.disabled, 'true');
    page[handler]({ detail, currentTarget: { dataset: {} } });
  };
  page.onLoad({ campusId });
  page.onShow();
  return { page, nodes, event, tap: (handler) => event('bindtap', handler) };
}
try {
  config.clientConfiguration = {
    apiOrigin: origin,
    providerLoginEnabled: true,
  };
  const unavailable = mount();
  await tick();
  assert.equal(unavailable.page.data.capability.state, 'eligible');
  assert.equal(unavailable.page.data.nativeAvailable, false);
  assert.ok(
    !unavailable
      .nodes()
      .some(
        (node) =>
          typeof node !== 'string' &&
          (node.attrs.bindtap === 'onPrepare' ||
            node.attrs['bind:press'] === 'onPrepare'),
      ),
  );
  unavailable.page.onPrepare();
  unavailable.page.onAuthorize();
  await tick();
  assert.equal(
    calls.filter((call) => call.route === '/v1/me/institutional-sso/requests')
      .length,
    0,
  );
  unavailable.page.onUnload();
  app.institutionalSso = {
    ...app.institutionalSso,
    port: {
      available: true,
      async authorize(context) {
        handoffs++;
        assert.equal([...storage.values()][0].phase, 'authorize_pending');
        assert.equal(context.requestId, id);
        assert.equal(context.requestHash, receipt.requestHash);
        return {
          state: 'authorized',
          authorizationResponse: 'one-use-synthetic-secret',
        };
      },
    },
  };
  const h = mount();
  await tick();
  h.event('bindchange', 'onConsent', { value: ['consent'] });
  h.tap('onPrepare');
  h.page.onPrepare();
  await tick();
  assert.equal(h.page.data.state, 'prepared');
  assert.equal(h.page.data.canAuthorize, true);
  h.tap('onAuthorize');
  h.page.onAuthorize();
  await tick();
  assert.equal(handoffs, 1);
  assert.equal(h.page.data.state, 'completed');
  assert.equal(h.page.data.frozen, false);
  assert.equal(
    h.page.data.verificationView.rows.find((row) => row.key === 'affiliation')
      .value,
    '已验证',
  );
  assert.equal(
    h.page.data.verificationView.rows.find((row) => row.key === 'phone').value,
    '未验证',
  );
  assert.equal(h.page.data.schoolUidView.schoolUid.formattedUid, '000042');
  assert.ok(verificationReads >= 3);
  assert.ok(uidReads >= 3);
  assert.equal(storage.size, 0);
  assert.ok(!JSON.stringify(views).includes('one-use-synthetic-secret'));
  const text = h
    .nodes()
    .filter((node) => typeof node === 'string')
    .join('');
  assert.ok(text.includes('000042'));
  assert.ok(
    h
      .nodes()
      .some(
        (node) =>
          typeof node !== 'string' &&
          node.tag === 'wu-f7-list-item' &&
          node.attrs.title === '学号验证',
      ),
  );
  assert.match(
    readFileSync(
      path.join(dist, 'components/f7-list-item/f7-list-item.wxml'),
      'utf8',
    ),
    /\{\{title\}\}/,
  );
  assert.ok(!text.includes('one-use-synthetic-secret'));
  uidUnavailable = true;
  h.tap('onReload');
  await tick();
  assert.equal(h.page.data.verificationView.loaded, true);
  assert.equal(h.page.data.schoolUidView.loaded, false);
  assert.ok(h.page.data.schoolUidView.error);
  h.tap('onBack');
  assert.deepEqual(navigations, ['/pages/verification/verification']);
  h.page.onUnload();
  // Cold prepared is insufficient when local journal says handoff-started.
  const pending = app.institutionalSso.journal.freeze(accountId, {
    requestId: id,
    campusId,
    capabilityVersion: version,
    consent: institutionalConsent,
  });
  app.institutionalSso.journal.advance(pending, 'authorize_pending');
  receipt = {
    requestId: id,
    requestHash: pending.requestHash,
    state: 'prepared',
    context: {
      campusId,
      capabilityVersion: version,
      consent: institutionalConsent,
    },
    expiresAt: '2030-10-14T02:00:00.000Z',
  };
  const cold = mount();
  await tick();
  assert.equal(cold.page.data.canAuthorize, false);
  cold.page.onAuthorize();
  await tick();
  assert.equal(handoffs, 1);
  assert.ok(
    !cold
      .nodes()
      .some(
        (node) =>
          typeof node !== 'string' &&
          (node.attrs.bindtap === 'onAuthorize' ||
            node.attrs['bind:press'] === 'onAuthorize'),
      ),
  );
  cold.tap('onClose');
  await tick();
  assert.equal(cold.page.data.state, 'cancelled');
  cold.page.onUnload();
  console.log(
    'Institutional SSO emitted Page/WXML smoke passed (synthetic transport only).',
  );
} finally {
  config.clientConfiguration = savedConfig;
  Object.assign(globalThis, savedGlobals);
}
