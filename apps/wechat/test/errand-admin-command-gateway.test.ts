import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import { HttpErrandAdminCommandsGateway } from '../src/errands/admin-command-gateway';
import { decodeErrandAdminIntent } from '../src/errands/admin-command-contract';
import { Cancellation } from '../src/platform/contracts';
import { ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  applied,
  deleteIntent,
  eventId,
  restrictionHistory,
  restrictionId,
  restrictionPage,
} from './errand-admin-command-helpers';
import {
  adminCursor,
  adminOrderId,
  publicProfileId,
} from './errand-admin-helpers';
import { requestId } from './community-helpers';
function fixture() {
  const sessions = new SessionStore(),
    transport = new ScriptedTransport();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const gateway = new HttpErrandAdminCommandsGateway(
    new ApiClient('https://api.example', transport, sessions, {
      refresh: async () =>
        sessions.rotate(sessions.snapshot(), wireCredentials('b')),
    }),
  );
  return { gateway, transport, sessions, cancel: new Cancellation() };
}
test('all four authenticated commands and own receipts use precise separate routes and no client authority fields', async () => {
  const h = fixture();
  const intents = [
    deleteIntent(),
    decodeErrandAdminIntent({
      operation: 'restrict_accepter',
      orderId: adminOrderId,
      payload: {
        clientRequestId: requestId,
        expectedRevision: publicProfileId,
        reason: '合成理由',
        duration: { kind: 'finite', unit: 'days', value: 7 },
      },
    }),
    decodeErrandAdminIntent({
      operation: 'issue',
      payload: {
        clientRequestId: requestId,
        targetProfileId: publicProfileId,
        action: 'accept',
        reason: '合成理由',
        duration: { kind: 'permanent' },
      },
    }),
    decodeErrandAdminIntent({
      operation: 'release',
      restrictionId,
      payload: { clientRequestId: requestId, reason: '合成解除' },
    }),
  ];
  for (const intent of intents) {
    h.transport.reply(applied(intent));
    await h.gateway.command(intent, h.cancel);
    h.transport.reply(applied(intent));
    await h.gateway.receipt(intent, h.cancel);
  }
  assert.deepEqual(
    h.transport.requests.map((r) => [r.method, new URL(r.url).pathname]),
    [
      ['POST', `/v1/admin/errands/${adminOrderId}/delete`],
      ['GET', `/v1/admin/errand-requests/${requestId}`],
      ['POST', `/v1/admin/errands/${adminOrderId}/restrict-accepter`],
      ['GET', `/v1/admin/errand-requests/${requestId}`],
      ['POST', '/v1/admin/errand-restrictions'],
      ['GET', `/v1/admin/errand-restriction-requests/${requestId}`],
      ['POST', `/v1/admin/errand-restrictions/${restrictionId}/release`],
      ['GET', `/v1/admin/errand-restriction-requests/${requestId}`],
    ],
  );
  for (let i = 0; i < intents.length; i++) {
    assert.deepEqual(h.transport.requests[i * 2]!.body, intents[i]!.payload);
    assert.equal(h.transport.requests[i * 2 + 1]!.body, undefined);
  }
});
test('auth refresh replays exactly the same frozen body/key and rejects mismatched receipt', async () => {
  const h = fixture();
  h.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  h.transport.reply(applied());
  await h.gateway.command(deleteIntent(), h.cancel);
  assert.deepEqual(
    h.transport.requests[0]!.body,
    h.transport.requests[1]!.body,
  );
  assert.equal(h.transport.requests[0]!.url, h.transport.requests[1]!.url);
  assert.equal(
    h.transport.requests[1]!.headers.Authorization,
    `Bearer ${wireCredentials('b').accessToken}`,
  );
  h.transport.reply({ ...applied(), requestId: eventId });
  await assert.rejects(h.gateway.receipt(deleteIntent(), h.cancel));
});
test('record list/history paginate bounded strict DTOs; wrong filters/identity and repeated cursors reject', async () => {
  const h = fixture();
  h.transport.reply(restrictionPage());
  await h.gateway.restrictions(
    { state: 'all', action: 'all', targetProfileId: publicProfileId },
    adminCursor,
    h.cancel,
    50,
  );
  assert.deepEqual(
    Object.fromEntries(new URL(h.transport.requests[0]!.url).searchParams),
    {
      state: 'all',
      action: 'all',
      targetProfileId: publicProfileId,
      limit: '50',
      cursor: adminCursor,
    },
  );
  h.transport.reply(restrictionHistory());
  await h.gateway.history(restrictionId, null, h.cancel);
  h.transport.reply(restrictionPage());
  await assert.rejects(
    h.gateway.restrictions({ state: 'released' }, null, h.cancel),
  );
  h.transport.reply(restrictionHistory());
  await assert.rejects(h.gateway.history(publicProfileId, null, h.cancel));
  h.transport.reply(
    restrictionPage({ nextCursor: adminCursor, continuation: 'more' }),
  );
  await assert.rejects(
    h.gateway.restrictions({ state: 'all' }, adminCursor, h.cancel),
  );
  const count = h.transport.requests.length;
  await assert.rejects(h.gateway.history(restrictionId, 'invalid', h.cancel));
  assert.equal(h.transport.requests.length, count);
});

test('administrative error/status combinations remain strict transport failures', async () => {
  const h = fixture();
  h.transport.reply(
    { error: { code: 'ERRAND_RESTRICTION_TARGET_PROTECTED' } },
    409,
  );
  await assert.rejects(
    h.gateway.command(deleteIntent(), h.cancel),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'kind' in error &&
      error.kind === 'protocol',
  );
});
