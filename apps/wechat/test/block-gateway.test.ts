import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import { HttpBlockGateway } from '../src/community/block-gateway';
import { Cancellation } from '../src/platform/contracts';
import { ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  blockEntry,
  blockIntent,
  blockResult,
  unblockIntent,
} from './block-helpers';
import { otherId, postId, requestId } from './community-helpers';
function setup() {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const transport = new ScriptedTransport();
  return {
    sessions,
    transport,
    gateway: new HttpBlockGateway(
      new ApiClient('https://api.example', transport, sessions, {
        refresh: async () => sessions.snapshot(),
      }),
    ),
  };
}
test('block gateway authenticates typed content-only writes, independent own cleanup/list/state/recovery', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply(blockResult());
  await s.gateway.apply(blockIntent(), cancel);
  s.transport.reply(blockResult(unblockIntent()));
  await s.gateway.apply(unblockIntent(), cancel);
  s.transport.reply({ items: [blockEntry()], nextCursor: null });
  await s.gateway.list('opaque_cursor', cancel, 50);
  s.transport.reply({ relationshipId: otherId, blocked: false, revision: '2' });
  await s.gateway.state(otherId, cancel);
  s.transport.reply(blockResult(blockIntent(), false, '2'));
  await s.gateway.receipt(requestId, cancel);
  assert.equal(s.transport.requests.length, 5);
  assert.deepEqual(s.transport.requests[0]!.body, {
    clientRequestId: requestId,
    source: { kind: 'post', id: postId },
    blocked: true,
  });
  assert.deepEqual(s.transport.requests[1]!.body, {
    clientRequestId: requestId,
    blocked: false,
    expectedRevision: '1',
  });
  assert.match(
    s.transport.requests[2]!.url,
    /\/v1\/me\/safety\/blocks\?limit=50&cursor=opaque_cursor$/,
  );
  for (const request of s.transport.requests)
    assert.equal(
      request.headers.Authorization,
      `Bearer ${wireCredentials().accessToken}`,
    );
  assert.match(s.transport.requests[4]!.url, /\/block-requests\//);
});
test('block gateway fails closed on mismatched resource/request/operation, unknown fields and oversized pages', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply(blockResult(unblockIntent()));
  await assert.rejects(s.gateway.apply(blockIntent(), cancel));
  s.transport.reply({
    ...blockResult(),
    receipt: { ...blockResult().receipt, requestId: otherId },
  });
  await assert.rejects(s.gateway.receipt(requestId, cancel));
  s.transport.reply({
    relationshipId: requestId,
    blocked: true,
    revision: '1',
  });
  await assert.rejects(s.gateway.state(otherId, cancel));
  s.transport.reply({
    items: [blockEntry(), { ...blockEntry(), relationshipId: requestId }],
    nextCursor: null,
  });
  await assert.rejects(s.gateway.list(null, cancel, 1));
  const count = s.transport.requests.length;
  await assert.rejects(s.gateway.list(null, cancel, 51));
  assert.equal(s.transport.requests.length, count);
});

test('expired-access read and durable write retries are bounded and keep exact block intent', async () => {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const transport = new ScriptedTransport();
  let refreshes = 0;
  const gateway = new HttpBlockGateway(
    new ApiClient('https://api.example', transport, sessions, {
      refresh: async () => {
        refreshes++;
        return sessions.rotate(sessions.snapshot(), wireCredentials('b'));
      },
    }),
  );
  const expired = {
    error: { code: 'ACCESS_TOKEN_EXPIRED', message: 'ignored', requestId },
  };
  transport.reply(expired, 401);
  transport.reply(blockResult());
  await gateway.apply(blockIntent(), new Cancellation());
  assert.equal(refreshes, 1);
  assert.deepEqual(transport.requests[0]!.body, transport.requests[1]!.body);
  assert.notEqual(
    transport.requests[0]!.headers.Authorization,
    transport.requests[1]!.headers.Authorization,
  );
  transport.reply(expired, 401);
  transport.reply(expired, 401);
  await assert.rejects(gateway.list(null, new Cancellation()));
  assert.equal(refreshes, 2);
  assert.equal(transport.requests.length, 4);
});
