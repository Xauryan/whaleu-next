import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import { Cancellation } from '../src/platform/contracts';
import { HttpDishRecommendationsGateway } from '../src/dish-recommendations/gateway';
import { ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  cancelled,
  command,
  id,
  otherId,
  own,
  page,
  receipt,
  recommend,
  requestId,
  retract,
} from './dish-recommendations-helpers';
function setup() {
  const sessions = new SessionStore(),
    transport = new ScriptedTransport();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const gateway = new HttpDishRecommendationsGateway(
    new ApiClient('https://dishes.example', transport, sessions, {
      refresh: async () =>
        sessions.rotate(sessions.snapshot(), wireCredentials('b')),
    }),
  );
  return { sessions, transport, gateway };
}
test('distinct W2 namespaces, exact Unicode query, operations and cancellation intent', async () => {
  const s = setup(),
    cancel = new Cancellation(),
    input = command({ dishName: ' A😀 ' });
  s.transport.reply(page());
  await s.gateway.list(id, null, cancel);
  s.transport.reply(own());
  await s.gateway.own(id, input.dishName, cancel);
  assert.equal(
    new URL(s.transport.requests[1]!.url).searchParams.get('dishName'),
    input.dishName,
  );
  s.transport.reply(receipt(input));
  await s.gateway.submit(id, recommend, input, cancel);
  s.transport.reply(receipt(input, retract));
  await s.gateway.submit(id, retract, input, cancel);
  s.transport.reply(cancelled(input, retract));
  await s.gateway.cancel(id, retract, input, cancel);
  s.transport.reply(receipt(input));
  await s.gateway.receipt(requestId, cancel);
  assert.deepEqual(s.transport.requests[4]!.body, {
    windowId: id,
    operation: retract,
    command: input,
  });
  assert.equal(
    new URL(s.transport.requests[2]!.url).pathname,
    `/v1/ratings/windows/${id}/dishes/recommend`,
  );
  assert.equal(
    new URL(s.transport.requests[3]!.url).pathname,
    `/v1/ratings/windows/${id}/dishes/retract`,
  );
  assert.equal(
    new URL(s.transport.requests[4]!.url).pathname,
    `/v1/ratings/windows/dish-requests/${requestId}/cancel`,
  );
  for (const r of s.transport.requests)
    assert.equal(
      r.headers.Authorization,
      `Bearer ${wireCredentials().accessToken}`,
    );
});
test('wrong target and receipt direction, privacy leakage and wrong-status errors fail closed', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply(page({ windowId: otherId }));
  await assert.rejects(s.gateway.list(id, null, cancel));
  s.transport.reply(receipt(command(), retract));
  await assert.rejects(s.gateway.submit(id, recommend, command(), cancel));
  s.transport.reply({ ...own(), actorId: id });
  await assert.rejects(s.gateway.own(id, '菜', cancel));
  s.transport.reply(
    { error: { code: 'DISH_HISTORY_UNAVAILABLE', message: 'wrong' } },
    404,
  );
  await assert.rejects(
    s.gateway.list(id, null, cancel),
    (e: unknown) => (e as { kind: string }).kind === 'protocol',
  );
});
test('refresh replays immutable original command only once', async () => {
  const s = setup();
  s.transport.reply(
    { error: { code: 'ACCESS_TOKEN_EXPIRED', message: 'expired' } },
    401,
  );
  s.transport.reply(receipt());
  await s.gateway.submit(id, recommend, command(), new Cancellation());
  assert.deepEqual(
    s.transport.requests[0]!.body,
    s.transport.requests[1]!.body,
  );
  assert.notEqual(
    s.transport.requests[0]!.headers.Authorization,
    s.transport.requests[1]!.headers.Authorization,
  );
});
