import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import { Cancellation } from '../src/platform/contracts';
import { HttpFloorRatingsGateway } from '../src/canteen-floor-scores/gateway';
import { ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  catalog,
  detail,
  command,
  receipt,
  cancelled,
  floorId,
  requestId,
} from './canteen-floor-scores-helpers';
function setup() {
  const sessions = new SessionStore(),
    transport = new ScriptedTransport();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const gateway = new HttpFloorRatingsGateway(
    new ApiClient('https://floors.example', transport, sessions, {
      refresh: async () =>
        sessions.rotate(sessions.snapshot(), wireCredentials('b')),
    }),
  );
  return { sessions, transport, gateway };
}
test('floor gateway authenticates exact independent scalar route and receipt-first cancellation payload', async () => {
  const s = setup(),
    c = new Cancellation();
  s.transport.reply(catalog());
  await s.gateway.catalog(c);
  s.transport.reply(detail());
  await s.gateway.detail(floorId, c);
  s.transport.reply(receipt());
  await s.gateway.submit(floorId, command(), c);
  s.transport.reply(receipt());
  await s.gateway.receipt(requestId, c);
  s.transport.reply(cancelled());
  await s.gateway.cancel(floorId, command(), c);
  assert.equal(
    new URL(s.transport.requests[2]!.url).pathname,
    `/v1/ratings/canteen-floors/${floorId}/first-score`,
  );
  assert.deepEqual(s.transport.requests[2]!.body, command());
  assert.deepEqual(s.transport.requests[4]!.body, {
    floorId,
    command: command(),
  });
  for (const r of s.transport.requests)
    assert.equal(
      r.headers.Authorization,
      'Bearer ' + wireCredentials().accessToken,
    );
});
test('mismatched target/decimal/status is protocol failure; typed unknown history remains 503 uncertainty', async () => {
  const s = setup(),
    c = new Cancellation();
  s.transport.reply({
    ...detail(),
    floor: { ...detail().floor, id: requestId },
  });
  await assert.rejects(s.gateway.detail(floorId, c));
  s.transport.reply(receipt(command({ score: 1.25 })));
  await assert.rejects(s.gateway.submit(floorId, command(), c));
  s.transport.reply(
    { error: { code: 'FLOOR_HISTORY_UNAVAILABLE', message: 'Unknown' } },
    503,
  );
  await assert.rejects(
    s.gateway.detail(floorId, c),
    (e: unknown) => (e as { kind: string }).kind !== 'protocol',
  );
  s.transport.reply(
    { error: { code: 'FLOOR_HISTORY_UNAVAILABLE', message: 'Wrong status' } },
    404,
  );
  await assert.rejects(
    s.gateway.detail(floorId, c),
    (e: unknown) => (e as { kind: string }).kind === 'protocol',
  );
});
test('access refresh retries exact decimal intent and original request key only once', async () => {
  const s = setup(),
    c = new Cancellation();
  s.transport.reply(
    { error: { code: 'ACCESS_TOKEN_EXPIRED', message: 'Expired' } },
    401,
  );
  s.transport.reply(receipt(command({ score: Math.PI })));
  await s.gateway.submit(floorId, command({ score: Math.PI }), c);
  assert.deepEqual(
    s.transport.requests[0]!.body,
    s.transport.requests[1]!.body,
  );
  assert.notEqual(
    s.transport.requests[0]!.headers.Authorization,
    s.transport.requests[1]!.headers.Authorization,
  );
});
