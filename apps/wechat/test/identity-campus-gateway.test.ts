import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { HttpIdentityCampusGateway } from '../src/identity-campus/gateway';
import { Cancellation } from '../src/platform/contracts';
import { ScriptedTransport, deferred, flush, response } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  intent,
  otherCampusId,
  receipt,
  requestId,
  setup,
  state,
} from './identity-campus-helpers';
function build() {
  const s = setup(),
    transport = new ScriptedTransport();
  let refreshes = 0;
  const gateway = new HttpIdentityCampusGateway(
    new ApiClient('https://api.example.invalid', transport, s.sessions, {
      refresh: async () => {
        refreshes += 1;
        return s.sessions.rotate(s.sessions.snapshot(), wireCredentials('b'));
      },
    }),
  );
  return { ...s, transport, gateway, refreshes: () => refreshes };
}
test('gateway uses authenticated own routes, strict request and matching receipts, no hidden account selector', async () => {
  const s = build(),
    cancel = new Cancellation();
  s.transport.reply(state());
  await s.gateway.state(cancel);
  s.transport.reply(receipt());
  await s.gateway.select(intent(), cancel);
  s.transport.reply(receipt());
  await s.gateway.receipt(requestId, cancel);
  assert.deepEqual(
    s.transport.requests.map((r) => [r.method, r.url, r.body]),
    [
      ['GET', 'https://api.example.invalid/v1/me/identity-campus', undefined],
      ['PUT', 'https://api.example.invalid/v1/me/identity-campus', intent()],
      [
        'GET',
        `https://api.example.invalid/v1/me/identity-campus/requests/${requestId}`,
        undefined,
      ],
    ],
  );
  for (const r of s.transport.requests)
    assert.equal(
      r.headers.Authorization,
      `Bearer ${wireCredentials().accessToken}`,
    );
  s.transport.reply(receipt({ campusId: otherCampusId }));
  await assert.rejects(s.gateway.select(intent(), cancel), {
    kind: 'protocol',
  });
  s.transport.reply(receipt({ requestId: otherCampusId }));
  await assert.rejects(s.gateway.receipt(requestId, cancel), {
    kind: 'protocol',
  });
  assert.throws(() => s.gateway.receipt('../another-account', cancel), {
    kind: 'protocol',
  });
});
test('read and receipt may refresh once; PUT never silently refreshes/replays or replaces its intent', async () => {
  const s = build(),
    cancel = new Cancellation();
  s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  s.transport.reply(state());
  await s.gateway.state(cancel);
  s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  s.transport.reply(receipt());
  await s.gateway.receipt(requestId, cancel);
  assert.equal(s.refreshes(), 2);
  s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  await assert.rejects(s.gateway.select(intent(), cancel), {
    kind: 'auth-expired',
  });
  assert.equal(s.refreshes(), 2);
  assert.equal(s.transport.requests.length, 5);
});
test('gateway errors retain absent-receipt and unavailable meaning; contradictory HTTP codes and success statuses fail closed', async () => {
  const s = build();
  for (const [code, status, kind] of [
    ['IDENTITY_CAMPUS_REQUEST_NOT_FOUND', 404, 'http'],
    ['IDENTITY_CAMPUS_REVISION_CONFLICT', 409, 'business'],
    ['IDENTITY_CAMPUS_UNAVAILABLE', 503, 'http'],
    ['IDENTITY_CAMPUS_REVISION_CONFLICT', 503, 'protocol'],
    ['IDENTITY_CAMPUS_REQUEST_NOT_FOUND', 409, 'protocol'],
  ] as const) {
    s.transport.reply({ error: { code } }, status);
    await assert.rejects(s.gateway.receipt(requestId, new Cancellation()), {
      kind,
    });
  }
  s.transport.reply(state(), 201);
  await assert.rejects(s.gateway.state(new Cancellation()), {
    kind: 'protocol',
  });
  s.transport.reply({ ...state(), selectedCampus: { private: true } });
  await assert.rejects(s.gateway.state(new Cancellation()), {
    kind: 'protocol',
  });
});
test('same-tick cancellation and old login epochs prevent or reject gateway dispatch', async () => {
  const s = build(),
    cancel = new Cancellation();
  const p = s.gateway.select(intent(), cancel);
  cancel.cancel();
  await assert.rejects(p, { kind: 'cancelled' });
  assert.equal(s.transport.requests.length, 0);
  const late = deferred<ReturnType<typeof response>>();
  s.transport.steps.push(() => late.promise);
  const request = s.gateway.state(new Cancellation());
  await flush();
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('c'));
  late.resolve(response(state()));
  await assert.rejects(request, { kind: 'stale-session' });
});
