import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import { Cancellation } from '../src/platform/contracts';
import { HttpWindowRatingsGateway } from '../src/window-ratings/gateway';
import { ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  cancelled,
  canteenId,
  catalog,
  command,
  detail,
  floorId,
  id,
  otherId,
  page,
  receipt,
  requestId,
  window,
} from './window-ratings-helpers';
function setup() {
  const sessions = new SessionStore(),
    transport = new ScriptedTransport();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const gateway = new HttpWindowRatingsGateway(
    new ApiClient('https://windows.example', transport, sessions, {
      refresh: async () =>
        sessions.rotate(sessions.snapshot(), wireCredentials('b')),
    }),
  );
  return { sessions, transport, gateway };
}
test('specialist authenticated routes serialize exact source ids, signed scores, CAS and cancellation', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply(catalog());
  await s.gateway.catalog(cancel);
  s.transport.reply(page());
  await s.gateway.list({ canteenIds: [canteenId], floorId }, null, cancel);
  const query = new URL(s.transport.requests[1]!.url);
  assert.equal(query.pathname, '/v1/ratings/windows');
  assert.equal(query.searchParams.get('canteenIds'), canteenId);
  assert.equal(query.searchParams.get('floorId'), floorId);
  assert.equal(query.searchParams.has('campusId'), false);
  s.transport.reply(detail());
  await s.gateway.detail(id, cancel);
  s.transport.reply(receipt(command({ score: 0 })));
  await s.gateway.submit(id, command({ score: 0 }), cancel);
  s.transport.reply(receipt());
  await s.gateway.receipt(requestId, cancel);
  s.transport.reply(cancelled());
  await s.gateway.cancel(id, command(), cancel);
  assert.deepEqual(s.transport.requests[3]!.body, command({ score: 0 }));
  assert.deepEqual(s.transport.requests[5]!.body, {
    windowId: id,
    command: command(),
  });
  assert.equal(
    new URL(s.transport.requests[5]!.url).pathname,
    `/v1/ratings/windows/requests/${requestId}/cancel`,
  );
  for (const request of s.transport.requests)
    assert.equal(
      request.headers.Authorization,
      `Bearer ${wireCredentials().accessToken}`,
    );
});
test('wrong target, filtered leakage, malformed receipt and status mismatches fail closed', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply(detail({ window: window({ id: otherId }) }));
  await assert.rejects(s.gateway.detail(id, cancel));
  s.transport.reply(page());
  await assert.rejects(s.gateway.list({ canteenIds: [otherId] }, null, cancel));
  s.transport.reply(receipt(command({ score: 1 })));
  await assert.rejects(s.gateway.submit(id, command(), cancel));
  s.transport.reply(
    { error: { code: 'WINDOW_CATALOG_UNAVAILABLE', message: 'Bad status' } },
    404,
  );
  await assert.rejects(
    s.gateway.catalog(cancel),
    (error: unknown) => (error as { kind: string }).kind === 'protocol',
  );
  s.sessions.logout();
  await assert.rejects(s.gateway.receipt(requestId, cancel));
  assert.equal(s.transport.requests.length, 4);
});
test('access refresh replays the same score/CAS/request tuple once', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply(
    { error: { code: 'ACCESS_TOKEN_EXPIRED', message: 'Expired' } },
    401,
  );
  s.transport.reply(receipt());
  await s.gateway.submit(id, command(), cancel);
  assert.deepEqual(
    s.transport.requests[0]!.body,
    s.transport.requests[1]!.body,
  );
  assert.notEqual(
    s.transport.requests[0]!.headers.Authorization,
    s.transport.requests[1]!.headers.Authorization,
  );
});
test('zero and negative minimum keep negative candidates; positive minimum excludes them', async () => {
  const s = setup(),
    cancel = new Cancellation();
  const negative = page({
    items: [window({ summary: { kind: 'known', ratingCount: 1, mean: -4 } })],
  });
  for (const minRating of [0, -10]) {
    s.transport.reply(negative);
    assert.equal(
      (await s.gateway.list({ minRating }, null, cancel)).items.length,
      1,
    );
  }
  s.transport.reply(negative);
  await assert.rejects(s.gateway.list({ minRating: 1 }, null, cancel));
});
