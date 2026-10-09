import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import { Cancellation } from '../src/platform/contracts';
import { HttpRatingTargetOwnerDeletionGateway } from '../src/ratings/target-owner-deletion-gateway';
import { ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import { requestId, otherId, targetId } from './ratings-helpers';
import {
  ownerContext,
  ownerIntent,
  ownerReceipt,
  cancelledReceipt,
} from './rating-owner-management-helpers';
const prefix = '/v1/ratings/management/owner-deletion';
function setup() {
  const sessions = new SessionStore(),
    transport = new ScriptedTransport();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  return {
    transport,
    gateway: new HttpRatingTargetOwnerDeletionGateway(
      new ApiClient('https://ratings.example', transport, sessions, {
        refresh: async () =>
          sessions.rotate(sessions.snapshot(), wireCredentials('b')),
      }),
    ),
  };
}
test('native deletion sends only exact metadata through authenticated owner endpoints', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply(ownerContext());
  assert.deepEqual(await s.gateway.context(targetId, cancel), ownerContext());
  s.transport.reply(ownerReceipt());
  assert.deepEqual(
    await s.gateway.command(ownerIntent(), cancel),
    ownerReceipt(),
  );
  s.transport.reply(ownerReceipt());
  await s.gateway.receipt(requestId, cancel);
  s.transport.reply(cancelledReceipt());
  assert.deepEqual(
    await s.gateway.cancel(ownerIntent(), cancel),
    cancelledReceipt(),
  );
  assert.deepEqual(
    s.transport.requests.map((r) => [r.method, new URL(r.url).pathname]),
    [
      ['GET', `${prefix}/targets/${targetId}/context`],
      ['POST', `${prefix}/targets/${targetId}`],
      ['GET', `${prefix}/requests/${requestId}`],
      ['POST', `${prefix}/cancel`],
    ],
  );
  assert.deepEqual(s.transport.requests[1]!.body, {
    clientRequestId: requestId,
    expectedTargetRevision: ownerIntent().payload.expectedTargetRevision,
  });
  assert.deepEqual(s.transport.requests[3]!.body, ownerIntent().payload);
  for (const r of s.transport.requests)
    assert.equal(
      r.headers.Authorization,
      `Bearer ${wireCredentials().accessToken}`,
    );
});
test('context and receipts reject cross-target/key, private additions and invalid locators', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply({ ...ownerContext(), targetId: otherId });
  await assert.rejects(() => s.gateway.context(targetId, cancel), {
    kind: 'protocol',
  });
  s.transport.reply({ ...ownerReceipt(), targetId: otherId });
  await assert.rejects(() => s.gateway.command(ownerIntent(), cancel), {
    kind: 'protocol',
  });
  s.transport.reply({ ...ownerReceipt(), requestId: otherId });
  await assert.rejects(() => s.gateway.receipt(requestId, cancel), {
    kind: 'protocol',
  });
  s.transport.reply({ ...cancelledReceipt(), name: 'private' });
  await assert.rejects(() => s.gateway.cancel(ownerIntent(), cancel), {
    kind: 'protocol',
  });
  await assert.rejects(() => s.gateway.context('invalid', cancel));
  await assert.rejects(() => s.gateway.receipt('invalid', cancel));
  assert.equal(s.transport.requests.length, 4);
});
test('unknown HTTP outcomes, receipt absence and unavailable sources never become rejected receipts', async () => {
  const s = setup(),
    cancel = new Cancellation();
  for (const [status, code] of [
    [404, 'RATING_NOT_FOUND'],
    [409, 'RATING_REVISION_CONFLICT'],
    [403, 'SAFETY_ACTION_RESTRICTED'],
    [503, 'CONTENT_REVIEW_UNAVAILABLE'],
    [503, 'RATING_UNAVAILABLE'],
  ] as const) {
    s.transport.reply({ error: { code, message: 'synthetic' } }, status);
    await assert.rejects(() => s.gateway.command(ownerIntent(), cancel));
  }
  s.transport.reply(
    { error: { code: 'REQUEST_NOT_FOUND', message: 'missing' } },
    404,
  );
  await assert.rejects(() => s.gateway.receipt(requestId, cancel));
  assert.equal(s.transport.requests.length, 6);
});
test('lost submit/cancel responses replay frozen payload and accept prior applied receipt precedence', async () => {
  const s = setup(),
    cancel = new Cancellation();
  for (const method of ['command', 'cancel'] as const) {
    s.transport.steps.push(async () => {
      throw new Error('lost response');
    });
    await assert.rejects(() => s.gateway[method](ownerIntent(), cancel));
    s.transport.reply(ownerReceipt());
    assert.deepEqual(
      await s.gateway[method](ownerIntent(), cancel),
      ownerReceipt(),
    );
  }
  assert.deepEqual(
    s.transport.requests[0]!.body,
    s.transport.requests[1]!.body,
  );
  assert.deepEqual(
    s.transport.requests[2]!.body,
    s.transport.requests[3]!.body,
  );
});
