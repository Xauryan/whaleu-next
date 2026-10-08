import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { HttpExperienceGateway } from '../src/experience/gateway';
import { Cancellation } from '../src/platform/contracts';
import { ScriptedTransport, deferred, flush, response } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  appearance,
  catalog,
  noticeId,
  otherAccount,
  receipt,
  requestId,
  setup,
  summary,
} from './experience-helpers';
function build() {
  const s = setup(),
    transport = new ScriptedTransport();
  let refreshes = 0;
  const gateway = new HttpExperienceGateway(
    new ApiClient('https://api.example.invalid', transport, s.sessions, {
      refresh: async () => {
        refreshes += 1;
        return s.sessions.rotate(s.sessions.snapshot(), wireCredentials('b'));
      },
    }),
  );
  return { ...s, transport, gateway, refreshes: () => refreshes };
}
test('gateway routes are owner-authenticated exact DTOs and read-only GETs, no client day/owner/source authority', async () => {
  const s = build(),
    c = new Cancellation();
  s.transport.reply(summary());
  await s.gateway.summary(c);
  s.transport.reply(catalog());
  await s.gateway.catalog(c);
  s.transport.reply(appearance());
  await s.gateway.appearance(c);
  s.transport.reply({ items: [], nextCursor: null, coverage: 'partial' });
  await s.gateway.records(null, c);
  s.transport.reply({ items: [], nextCursor: null, coverage: 'partial' });
  await s.gateway.records('opaque_cursor', c);
  s.transport.reply({ items: [] });
  await s.gateway.unlocks(c);
  s.transport.reply(receipt());
  await s.gateway.signIn({ requestId }, c);
  s.transport.reply(receipt());
  await s.gateway.receipt(requestId, c);
  const selection = {
    requestId,
    expectedRevision: '0',
    titleKey: 'level_1',
    colorId: null,
  };
  s.transport.reply({
    requestId,
    operation: 'appearance',
    outcome: 'applied',
    titleKey: 'level_1',
    colorId: null,
    revision: '1',
  });
  await s.gateway.selectAppearance(selection, c);
  s.transport.reply({ noticeId, acknowledged: true });
  await s.gateway.acknowledge(noticeId, c);
  assert.deepEqual(
    s.transport.requests.map((r) => [
      r.method,
      r.url.replace('https://api.example.invalid', ''),
      r.body,
    ]),
    [
      ['GET', '/v1/me/experience', undefined],
      ['GET', '/v1/experience/catalog', undefined],
      ['GET', '/v1/me/experience/appearance', undefined],
      ['GET', '/v1/me/experience/records?limit=20', undefined],
      [
        'GET',
        '/v1/me/experience/records?limit=20&cursor=opaque_cursor',
        undefined,
      ],
      ['GET', '/v1/me/experience/unlocks', undefined],
      ['POST', '/v1/me/experience/sign-in', { requestId }],
      ['GET', `/v1/me/experience/requests/${requestId}`, undefined],
      ['PUT', '/v1/me/experience/appearance', selection],
      ['PUT', `/v1/me/experience/unlocks/${noticeId}/ack`, {}],
    ],
  );
  for (const r of s.transport.requests)
    assert.equal(
      r.headers.Authorization,
      `Bearer ${wireCredentials().accessToken}`,
    );
  s.runtime.dispose();
});
test('reads refresh once, sign-in/appearance/ack mutations never automatically replay expired authentication', async () => {
  const s = build(),
    c = new Cancellation();
  s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  s.transport.reply(summary());
  await s.gateway.summary(c);
  assert.equal(s.refreshes(), 1);
  for (const run of [
    () => s.gateway.signIn({ requestId }, c),
    () =>
      s.gateway.selectAppearance(
        { requestId, expectedRevision: '0', titleKey: null, colorId: null },
        c,
      ),
    () => s.gateway.acknowledge(noticeId, c),
  ]) {
    s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
    await assert.rejects(run(), { kind: 'auth-expired' });
  }
  assert.equal(s.refreshes(), 1);
  assert.equal(s.transport.requests.length, 5);
  s.runtime.dispose();
});
test('wrong status, nested extra data, receipt operation/request/selection mismatch fail closed', async () => {
  const s = build(),
    c = new Cancellation();
  for (const [value, status] of [
    [summary(), 201],
    [{ ...summary(), actor: { name: 'private' } }, 200],
  ] as const) {
    s.transport.reply(value, status);
    await assert.rejects(s.gateway.summary(c), { kind: 'protocol' });
  }
  s.transport.reply({ ...receipt(), requestId: otherAccount });
  await assert.rejects(s.gateway.signIn({ requestId }, c), {
    kind: 'protocol',
  });
  s.transport.reply({
    requestId,
    operation: 'appearance',
    outcome: 'applied',
    titleKey: null,
    colorId: null,
    revision: '1',
  });
  await assert.rejects(s.gateway.signIn({ requestId }, c), {
    kind: 'protocol',
  });
  s.transport.reply({ ...receipt(), requestId: otherAccount });
  await assert.rejects(s.gateway.receipt(requestId, c), { kind: 'protocol' });
  s.transport.reply({ noticeId: otherAccount, acknowledged: true });
  await assert.rejects(s.gateway.acknowledge(noticeId, c), {
    kind: 'protocol',
  });
  assert.throws(() => s.gateway.receipt('../foreign', c), { kind: 'protocol' });
  assert.throws(() => s.gateway.records('../source?private', c), {
    kind: 'protocol',
  });
  s.runtime.dispose();
});
test('appearance rejection HTTP200 is terminal receipt; baseline/pending409 have no success receipt and conflicting error statuses fail', async () => {
  const s = build(),
    c = new Cancellation();
  const reject = {
    requestId,
    operation: 'appearance',
    outcome: 'rejected',
    code: 'EXPERIENCE_COLOR_INELIGIBLE',
  };
  s.transport.reply(reject);
  assert.deepEqual(
    await s.gateway.selectAppearance(
      { requestId, expectedRevision: '0', titleKey: null, colorId: 25 },
      c,
    ),
    reject,
  );
  for (const code of [
    'EXPERIENCE_BASELINE_UNAVAILABLE',
    'EXPERIENCE_PENDING',
    'EXPERIENCE_REQUEST_CONFLICT',
  ]) {
    s.transport.reply({ error: { code } }, 409);
    await assert.rejects(s.gateway.signIn({ requestId }, c), {
      kind: 'business',
      details: { httpStatus: 409, serverCode: code },
    });
    s.transport.reply({ error: { code } }, 503);
    await assert.rejects(s.gateway.signIn({ requestId }, c), {
      kind: 'protocol',
    });
  }
  s.transport.reply({ error: { code: 'EXPERIENCE_REQUEST_NOT_FOUND' } }, 404);
  await assert.rejects(s.gateway.receipt(requestId, c), { kind: 'http' });
  s.runtime.dispose();
});
test('same-tick cancel and replaced session prevent dispatch or reject late result without a newer token replay', async () => {
  const s = build(),
    c = new Cancellation();
  const p = s.gateway.signIn({ requestId }, c);
  c.cancel();
  await assert.rejects(p, { kind: 'cancelled' });
  assert.equal(s.transport.requests.length, 0);
  const late = deferred<ReturnType<typeof response>>();
  s.transport.steps.push(() => late.promise);
  const q = s.gateway.summary(new Cancellation());
  await flush();
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('c'),
    accountId: otherAccount,
  });
  late.resolve(response(summary()));
  await assert.rejects(q, { kind: 'stale-session' });
  assert.equal(s.refreshes(), 0);
  s.runtime.dispose();
});
