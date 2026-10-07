import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);

/** Emitted Mini Program page + actual API client/gateway/decoders, using synthetic transport only. */
export async function smokeIdentityCampus({ app, dist, mountPage, flush }) {
  const { ApiClient } = require(path.join(dist, 'api/client.js'));
  const { HttpIdentityCampusGateway } = require(
    path.join(dist, 'identity-campus/gateway.js'),
  );
  const { PendingIdentityCampusStore } = require(
    path.join(dist, 'identity-campus/pending.js'),
  );
  const { PrivateViewLifecycle } = require(
    path.join(dist, 'identity-privacy/overlay.js'),
  );
  const { ClientError } = require(path.join(dist, 'api/errors.js'));
  const original = app.identityCampus;
  const accountId = app.identity.sessions.snapshot().credentials.accountId;
  const credentials = app.identity.sessions.snapshot().credentials;
  const campusId = '33333333-3333-4333-8333-333333333333';
  const nextId = '44444444-4444-4444-8444-444444444444';
  const requestId = 'abababab-abab-4bab-8bab-abababababab';
  const campus = (id) => ({
    id,
    name: '合成校区',
    operatingRegion: {
      id: '55555555-5555-4555-8555-555555555555',
      name: '合成地区',
    },
  });
  let selected = null,
    loseResponse = true,
    malformed = false;
  const records = new Map(),
    requests = [];
  const pending = new PendingIdentityCampusStore(
    {
      get: (key) => records.get(key),
      set: (key, value) => records.set(key, value),
      remove: (key) => records.delete(key),
    },
    'https://identity-smoke.invalid',
  );
  const receipt = {
    requestId,
    campusId,
    outcome: 'applied',
    selectionRevision: 1,
  };
  const api = new ApiClient(
    'https://identity-smoke.invalid',
    {
      async send(request) {
        requests.push(request);
        assert.equal(
          request.headers.Authorization,
          `Bearer ${app.identity.sessions.snapshot().credentials.accessToken}`,
        );
        if (request.method === 'PUT') {
          assert.deepEqual(request.body, {
            requestId,
            campusId,
            expectedStateRevision: `ic1:${'a'.repeat(64)}`,
          });
          assert.ok(pending.load(accountId));
          selected = campusId;
          if (loseResponse) throw new ClientError('timeout', 'safe');
          return { status: 200, headers: {}, body: receipt };
        }
        if (request.url.endsWith(`/requests/${requestId}`))
          return { status: 200, headers: {}, body: receipt };
        assert.ok(request.url.endsWith('/v1/me/identity-campus'));
        const body = {
          affiliation: 'verified',
          selection: selected ? 'valid' : 'unavailable',
          reason: selected ? 'current' : 'history_unknown',
          selectedCampus: selected ? campus(selected) : null,
          options: {
            status: 'known',
            items: [campus(campusId), campus(nextId)],
          },
          writeEligibility: { phone: 'verified', safety: 'allowed' },
          canSelect: true,
          expectedStateRevision: `ic1:${'a'.repeat(64)}`,
          guidance: selected ? 'reselect' : 'choose',
        };
        return {
          status: 200,
          headers: {},
          body: malformed ? { ...body, assertionId: requestId } : body,
        };
      },
    },
    app.identity.sessions,
    { refresh: async () => app.identity.sessions.snapshot() },
  );
  app.identityCampus = {
    sessions: app.identity.sessions,
    gateway: new HttpIdentityCampusGateway(api),
    pending,
    privateViews: new PrivateViewLifecycle(),
    newRequestId: async () => requestId,
  };
  const page = mountPage(
    path.join(dist, 'pages/identity-campus/identity-campus.js'),
  );
  await flush();
  assert.equal(page.data.loaded, true);
  assert.equal(page.data.state.reason, 'history_unknown');
  assert.equal(page.data.selectedId, '');
  assert.equal(requests.length, 1);
  assert.equal(records.size, 0);
  page.onChoose({ currentTarget: { dataset: { id: campusId } } });
  page.onRequestConfirmation();
  assert.equal(page.data.confirmation.operatingRegion.name, '合成地区');
  page.onDismissConfirmation();
  page.onConfirm();
  await flush();
  assert.equal(requests.length, 1);
  page.onRequestConfirmation();
  page.onConfirm();
  page.onConfirm();
  await flush();
  assert.equal(requests.filter((r) => r.method === 'PUT').length, 1);
  assert.equal(page.data.frozen, true);
  assert.ok(pending.load(accountId));
  app.onHide();
  assert.equal(page.data.state, null);
  assert.equal(page.data.loaded, false);
  assert.equal(page.data.confirmation, null);
  assert.ok(pending.load(accountId));
  page.onHide();
  // Same-account reauthentication can recover the durable receipt, then fetch current state separately.
  app.identity.sessions.completeLogin(
    app.identity.sessions.beginLogin(),
    credentials,
  );
  selected = nextId;
  page.onShow();
  await flush();
  assert.equal(page.data.frozen, true);
  page.onReceipt();
  await flush();
  assert.equal(pending.load(accountId), null);
  assert.equal(page.data.state.selectedCampus.id, nextId);
  assert.match(page.data.receiptStatus, /之后的选择替代/);
  assert.deepEqual(
    requests.slice(-2).map((r) => r.method),
    ['GET', 'GET'],
  );
  assert.equal(requests.filter((r) => r.method === 'PUT').length, 1);
  malformed = true;
  page.onReload();
  await flush();
  assert.equal(page.data.loaded, false);
  assert.equal(page.data.state, null);
  assert.ok(page.data.error);
  assert.equal(JSON.stringify(page.data).includes('assertionId'), false);
  page.onUnload();
  assert.equal(page.data.state, null);
  assert.equal(page.controller, undefined);
  loseResponse = false;
  const template = readFileSync(
    path.join(dist, 'pages/identity-campus/identity-campus.wxml'),
    'utf8',
  );
  assert.match(template, /确认保存此身份校区/);
  assert.match(template, /不撤销/);
  assert.match(template, /再次点击发送/);
  assert.doesNotMatch(
    template,
    /rich-text|web-view|accessToken|studentNumber|phoneNumber/,
  );
  app.identityCampus = original;
}
