import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import { HttpSystemNoticesGateway } from '../src/community/system-notices-gateway';
import { Cancellation } from '../src/platform/contracts';
import { createdAt, otherId, requestId } from './community-helpers';
import { deferred, flush, response, ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import { systemNotice, systemNotices } from './system-notices-helpers';

function harness(loggedIn = true) {
  const sessions = new SessionStore(),
    transport = new ScriptedTransport();
  if (loggedIn)
    sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  let refreshes = 0;
  const gateway = new HttpSystemNoticesGateway(
    new ApiClient('https://api.example', transport, sessions, {
      refresh: async () => {
        refreshes++;
        return sessions.rotate(sessions.snapshot(), wireCredentials('b'));
      },
    }),
  );
  return { sessions, transport, gateway, refreshes: () => refreshes };
}

test('system notice endpoints use owner authentication, bounded paging and exact empty read PUT', async () => {
  const s = harness(),
    cancel = new Cancellation();
  s.transport.reply(systemNotices());
  await s.gateway.list('opaque_cursor', cancel, 50);
  s.transport.reply({ unreadCount: 9 });
  await s.gateway.unread(cancel);
  s.transport.reply({ noticeId: requestId, readAt: createdAt, unreadCount: 8 });
  await s.gateway.read(requestId, cancel);
  s.transport.reply(systemNotices());
  await s.gateway.list(null, cancel);
  assert.deepEqual(
    s.transport.requests.map((request) => [
      request.method,
      new URL(request.url).pathname,
      request.body,
    ]),
    [
      ['GET', '/v1/me/system-notices', undefined],
      ['GET', '/v1/me/system-notices/unread-count', undefined],
      ['PUT', `/v1/me/system-notices/${requestId}/read`, {}],
      ['GET', '/v1/me/system-notices', undefined],
    ],
  );
  assert.deepEqual(
    Object.fromEntries(new URL(s.transport.requests[0]!.url).searchParams),
    { limit: '50', cursor: 'opaque_cursor' },
  );
  assert.deepEqual(
    Object.fromEntries(new URL(s.transport.requests[3]!.url).searchParams),
    { limit: '20' },
  );
  assert.ok(
    s.transport.requests.every((request) => request.headers.Authorization),
  );
});

test('guest and malformed system-notice inputs never reach transport', async () => {
  const s = harness(false),
    cancel = new Cancellation();
  for (const run of [
    () => s.gateway.list(null, cancel),
    () => s.gateway.unread(cancel),
    () => s.gateway.read(requestId, cancel),
  ])
    await assert.rejects(run, { kind: 'auth-required' });
  assert.equal(s.transport.requests.length, 0);
  const auth = harness();
  for (const run of [
    () => auth.gateway.list('bad&cursor', cancel),
    ...[0, 51, 1.5, NaN].map(
      (limit) => () => auth.gateway.list(null, cancel, limit),
    ),
    () => auth.gateway.read('../other', cancel),
  ])
    await assert.rejects(run, { kind: 'protocol' });
  assert.equal(auth.transport.requests.length, 0);
});

test('system notice gateway rejects identity mismatches, source leaks, over-limit and non-200 successes', async () => {
  const s = harness(),
    cancel = new Cancellation();
  s.transport.reply({ noticeId: otherId, readAt: createdAt, unreadCount: 0 });
  await assert.rejects(() => s.gateway.read(requestId, cancel), {
    kind: 'protocol',
  });
  s.transport.reply(
    systemNotices([systemNotice(), systemNotice({ noticeId: otherId })]),
  );
  await assert.rejects(() => s.gateway.list(null, cancel, 1), {
    kind: 'protocol',
  });
  s.transport.reply({
    ...systemNotices(),
    items: [{ ...systemNotice(), postId: otherId }],
  });
  await assert.rejects(() => s.gateway.list(null, cancel), {
    kind: 'protocol',
  });
  s.transport.reply({ unreadCount: 1, accountId: otherId });
  await assert.rejects(() => s.gateway.unread(cancel), { kind: 'protocol' });
  s.transport.reply(
    { noticeId: requestId, readAt: createdAt, unreadCount: 0 },
    201,
  );
  await assert.rejects(() => s.gateway.read(requestId, cancel), {
    kind: 'protocol',
  });
});

test('system notice read expiry replay preserves owner and exact idempotent empty-body request', async () => {
  const s = harness(),
    cancel = new Cancellation();
  s.transport.reply(
    { error: { code: 'ACCESS_TOKEN_EXPIRED', message: 'expired' } },
    401,
  );
  s.transport.reply({ noticeId: requestId, readAt: createdAt, unreadCount: 0 });
  await s.gateway.read(requestId, cancel);
  assert.equal(s.refreshes(), 1);
  assert.deepEqual(
    s.transport.requests.map((request) => request.body),
    [{}, {}],
  );
  assert.equal(s.transport.requests[0]!.url, s.transport.requests[1]!.url);
});

test('old-account system notice callbacks and cancelled transport cannot hydrate new sessions', async () => {
  for (const change of ['cancel', 'account', 'same-account'] as const) {
    const s = harness(),
      cancel = new Cancellation(),
      pending = deferred<ReturnType<typeof response>>();
    s.transport.steps.push(() => pending.promise);
    const running = s.gateway.list(null, cancel);
    await flush();
    if (change === 'cancel') cancel.cancel();
    else
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('b'),
        accountId: change === 'account' ? otherId : wireCredentials().accountId,
      });
    pending.resolve(response(systemNotices()));
    await assert.rejects(running, {
      kind: change === 'cancel' ? 'cancelled' : 'stale-session',
    });
  }
});
