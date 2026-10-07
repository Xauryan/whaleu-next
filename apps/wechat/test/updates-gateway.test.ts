import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import { HttpCommunityGateway } from '../src/community/gateway';
import { Cancellation } from '../src/platform/contracts';
import { createdAt, otherId, requestId } from './community-helpers';
import { deferred, flush, response, ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import { update, updates } from './updates-helpers';
function harness(loggedIn = true) {
  const sessions = new SessionStore(),
    transport = new ScriptedTransport();
  if (loggedIn)
    sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  let refreshes = 0;
  const gateway = new HttpCommunityGateway(
    new ApiClient('https://api.example', transport, sessions, {
      refresh: async () => {
        refreshes++;
        return sessions.rotate(sessions.snapshot(), wireCredentials('b'));
      },
    }),
  );
  return { gateway, sessions, transport, refreshes: () => refreshes };
}
test('Updates endpoints are self-authenticated, bounded and exact; read PUT has empty body and target GET never marks read', async () => {
  const s = harness(),
    cancel = new Cancellation();
  s.transport.reply(updates());
  await s.gateway.updates('opaque_cursor', cancel, 50);
  s.transport.reply({ unreadCount: 7 });
  await s.gateway.updatesUnread(cancel);
  s.transport.reply({
    noticeId: requestId,
    status: 'available',
    target: update().target,
  });
  await s.gateway.updateTarget(requestId, cancel);
  s.transport.reply({ noticeId: requestId, readAt: createdAt, unreadCount: 6 });
  await s.gateway.readUpdate(requestId, cancel);
  assert.deepEqual(
    s.transport.requests.map((r) => [
      r.method,
      new URL(r.url).pathname,
      r.body,
    ]),
    [
      ['GET', '/v1/me/community/updates', undefined],
      ['GET', '/v1/me/community/updates/unread-count', undefined],
      ['GET', `/v1/me/community/updates/${requestId}/target`, undefined],
      ['PUT', `/v1/me/community/updates/${requestId}/read`, {}],
    ],
  );
  assert.deepEqual(
    Object.fromEntries(new URL(s.transport.requests[0]!.url).searchParams),
    { limit: '50', cursor: 'opaque_cursor' },
  );
  assert.ok(
    s.transport.requests.every((request) => request.headers.Authorization),
  );
});
test('Updates guest and malformed inputs never reach transport', async () => {
  const s = harness(false),
    cancel = new Cancellation();
  for (const run of [
    () => s.gateway.updates(null, cancel),
    () => s.gateway.updatesUnread(cancel),
    () => s.gateway.readUpdate(requestId, cancel),
    () => s.gateway.updateTarget(requestId, cancel),
  ])
    await assert.rejects(run, { kind: 'auth-required' });
  assert.equal(s.transport.requests.length, 0);
  const auth = harness();
  for (const run of [
    () => auth.gateway.updates('bad&cursor', cancel),
    ...[0, 51, 1.5, NaN].map(
      (limit) => () => auth.gateway.updates(null, cancel, limit),
    ),
    () => auth.gateway.readUpdate('bad', cancel),
    () => auth.gateway.updateTarget('bad', cancel),
  ])
    await assert.rejects(run, { kind: 'protocol' });
  assert.equal(auth.transport.requests.length, 0);
});
test('Updates rejects mismatched exact notice identities, over-limit pages, private fields and wrong HTTP success status', async () => {
  const s = harness(),
    cancel = new Cancellation();
  s.transport.reply({ noticeId: otherId, readAt: createdAt, unreadCount: 0 });
  await assert.rejects(() => s.gateway.readUpdate(requestId, cancel), {
    kind: 'protocol',
  });
  s.transport.reply({ noticeId: otherId, status: 'unavailable' });
  await assert.rejects(() => s.gateway.updateTarget(requestId, cancel), {
    kind: 'protocol',
  });
  s.transport.reply(updates([update(), update('reply', otherId)]));
  await assert.rejects(() => s.gateway.updates(null, cancel, 1), {
    kind: 'protocol',
  });
  s.transport.reply({ unreadCount: 2, accountId: otherId });
  await assert.rejects(() => s.gateway.updatesUnread(cancel), {
    kind: 'protocol',
  });
  s.transport.reply(
    { noticeId: requestId, readAt: createdAt, unreadCount: 0 },
    201,
  );
  await assert.rejects(() => s.gateway.readUpdate(requestId, cancel), {
    kind: 'protocol',
  });
});
test('read retry after expired access uses same owner and exact notice; stale session responses cannot hydrate', async () => {
  const s = harness(),
    cancel = new Cancellation();
  s.transport.reply(
    { error: { code: 'ACCESS_TOKEN_EXPIRED', message: 'expired' } },
    401,
  );
  s.transport.reply({ noticeId: requestId, readAt: createdAt, unreadCount: 0 });
  await s.gateway.readUpdate(requestId, cancel);
  assert.equal(s.refreshes(), 1);
  assert.deepEqual(
    s.transport.requests.map((r) => r.body),
    [{}, {}],
  );
  assert.equal(s.transport.requests[0]!.url, s.transport.requests[1]!.url);
  const pending = deferred<ReturnType<typeof response>>();
  s.transport.steps.push(() => pending.promise);
  const running = s.gateway.updates(null, new Cancellation());
  await flush();
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('c'),
    accountId: otherId,
  });
  pending.resolve(response(updates()));
  await assert.rejects(running, { kind: 'stale-session' });
});
