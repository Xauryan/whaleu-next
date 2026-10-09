import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import { Cancellation } from '../src/platform/contracts';
import { HttpRatingManagementGateway } from '../src/ratings/management-gateway';
import { ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import { requestId, otherId } from './ratings-helpers';
import {
  creationIntent,
  creationReceipt,
  preparation,
} from './ratings-management-helpers';
function setup() {
  const sessions = new SessionStore(),
    transport = new ScriptedTransport();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  return {
    transport,
    gateway: new HttpRatingManagementGateway(
      new ApiClient('https://ratings.example', transport, sessions, {
        refresh: async () =>
          sessions.rotate(sessions.snapshot(), wireCredentials('b')),
      }),
    ),
  };
}
test('creation uses authenticated prepare/commit and independent minimal request recovery', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply(preparation());
  s.transport.reply(creationReceipt());
  assert.deepEqual(
    await s.gateway.command(creationIntent(), cancel),
    creationReceipt(),
  );
  s.transport.reply(creationReceipt());
  await s.gateway.receipt(requestId, cancel);
  assert.deepEqual(
    s.transport.requests.map((r) => [r.method, new URL(r.url).pathname]),
    [
      ['POST', '/v1/ratings/management/prepare'],
      ['POST', '/v1/ratings/management/targets'],
      ['GET', `/v1/ratings/management/requests/${requestId}`],
    ],
  );
  assert.deepEqual(s.transport.requests[0]!.body, creationIntent().payload);
  assert.deepEqual(s.transport.requests[1]!.body, {
    ...creationIntent().payload,
    expectedContextRevision: preparation().contextRevision,
  });
  for (const r of s.transport.requests)
    assert.equal(
      r.headers.Authorization,
      `Bearer ${wireCredentials().accessToken}`,
    );
});
test('mismatched preparation blocks commit, mismatched creation target/request fails closed', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply({ ...preparation(), requestId: otherId });
  await assert.rejects(() => s.gateway.command(creationIntent(), cancel), {
    kind: 'protocol',
  });
  assert.equal(s.transport.requests.length, 1);
  s.transport.reply(preparation());
  s.transport.reply({ ...creationReceipt(), targetId: otherId });
  await assert.rejects(() => s.gateway.command(creationIntent(), cancel), {
    kind: 'protocol',
  });
  s.transport.reply({ ...creationReceipt(), requestId: otherId });
  await assert.rejects(() => s.gateway.receipt(requestId, cancel), {
    kind: 'protocol',
  });
  await assert.rejects(() => s.gateway.receipt('invalid', cancel));
  assert.equal(s.transport.requests.length, 4);
});
test('lost prepare and commit responses replay the exact original key, content and stable context', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.steps.push(async () => {
    throw new Error('lost prepare');
  });
  await assert.rejects(() => s.gateway.command(creationIntent(), cancel));
  assert.equal(s.transport.requests.length, 1);
  s.transport.reply(preparation());
  s.transport.steps.push(async () => {
    throw new Error('lost commit');
  });
  await assert.rejects(() => s.gateway.command(creationIntent(), cancel));
  s.transport.reply(preparation());
  s.transport.reply(creationReceipt());
  await s.gateway.command(creationIntent(), cancel);
  assert.deepEqual(
    s.transport.requests[0]!.body,
    s.transport.requests[1]!.body,
  );
  assert.deepEqual(
    s.transport.requests[1]!.body,
    s.transport.requests[3]!.body,
  );
  assert.deepEqual(
    s.transport.requests[2]!.body,
    s.transport.requests[4]!.body,
  );
});
test('closed prepare fetches durable receipt; 409 alone or GET404 is never a synthetic rejection', async () => {
  const s = setup(),
    cancel = new Cancellation();
  const closed = {
    error: { code: 'RATING_CREATION_CONTEXT_CHANGED', message: 'closed' },
  };
  const rejection = {
    requestId,
    operation: 'create_target',
    outcome: 'rejected',
    code: 'RATING_CREATION_CONTEXT_CHANGED',
  };
  s.transport.reply(closed, 409);
  s.transport.reply(rejection);
  assert.deepEqual(
    await s.gateway.command(creationIntent(), cancel),
    rejection,
  );
  assert.deepEqual(
    s.transport.requests.map((r) => r.method),
    ['POST', 'GET'],
  );
  s.transport.reply(closed, 409);
  s.transport.reply(
    { error: { code: 'REQUEST_NOT_FOUND', message: 'missing' } },
    404,
  );
  await assert.rejects(() => s.gateway.command(creationIntent(), cancel));
});
test('cancel sends exact frozen original input and accepts prior applied or durable cancelled receipt', async () => {
  const s = setup(),
    cancel = new Cancellation();
  for (const result of [
    creationReceipt(),
    {
      requestId,
      operation: 'create_target',
      outcome: 'rejected',
      code: 'RATING_CREATION_CANCELLED',
    },
  ]) {
    s.transport.reply(result);
    assert.deepEqual(await s.gateway.cancel(creationIntent(), cancel), result);
  }
  for (const request of s.transport.requests) {
    assert.equal(
      new URL(request.url).pathname,
      '/v1/ratings/management/cancel',
    );
    assert.equal(request.method, 'POST');
    assert.deepEqual(request.body, creationIntent().payload);
  }
});
