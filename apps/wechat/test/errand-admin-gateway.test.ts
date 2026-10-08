import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import { SessionStore } from '../src/auth/session';
import { HttpErrandAdminGateway } from '../src/errands/admin-gateway';
import { Cancellation } from '../src/platform/contracts';
import { ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  adminCursor,
  adminPage,
  adminQuery,
  adminRegion,
  authorization,
  otherAdminRegion,
} from './errand-admin-helpers';
function setup() {
  const sessions = new SessionStore(),
    transport = new ScriptedTransport();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const gateway = new HttpErrandAdminGateway(
    new ApiClient('https://api.example', transport, sessions, {
      refresh: async () =>
        sessions.rotate(sessions.snapshot(), wireCredentials('b')),
    }),
  );
  return { sessions, transport, gateway };
}
test('administration sends only bounded authenticated GET requests and public query selectors', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply(authorization());
  await s.gateway.authorization(cancel);
  const query = adminQuery({ keyword: '公开 %_ #' });
  s.transport.reply(
    adminPage({ context: { ...adminPage().context, ...query } }),
  );
  await s.gateway.list(query, adminCursor, cancel, 50);
  assert.deepEqual(
    s.transport.requests.map((r) => [r.method, new URL(r.url).pathname]),
    [
      ['GET', '/v1/me/authorization'],
      ['GET', '/v1/admin/errands'],
    ],
  );
  assert.deepEqual(
    Object.fromEntries(new URL(s.transport.requests[1]!.url).searchParams),
    {
      regionId: adminRegion,
      status: 'all',
      keyword: '公开 %_ #',
      limit: '50',
      cursor: adminCursor,
    },
  );
  for (const r of s.transport.requests) {
    assert.equal(r.body, undefined);
    assert.equal(
      r.headers.Authorization,
      `Bearer ${wireCredentials().accessToken}`,
    );
  }
});
test('invalid queries never send; wrong target/status/keyword and repeated cursor responses reject', async () => {
  const s = setup(),
    cancel = new Cancellation();
  for (const limit of [0, 51, 1.5])
    await assert.rejects(
      s.gateway.list(adminQuery(), null, cancel, limit),
      ClientError,
    );
  await assert.rejects(
    s.gateway.list(adminQuery(), 'bad', cancel),
    ClientError,
  );
  assert.equal(s.transport.requests.length, 0);
  for (const page of [
    adminPage({
      context: { ...adminPage().context, regionId: otherAdminRegion },
      items: [],
    }),
    adminPage({
      context: { ...adminPage().context, status: 'pending' },
      items: [],
    }),
    adminPage({ context: { ...adminPage().context, keyword: 'wrong' } }),
    adminPage({ continuation: 'more', nextCursor: adminCursor }),
  ]) {
    s.transport.reply(page);
    await assert.rejects(
      s.gateway.list(adminQuery(), adminCursor, cancel),
      (error: unknown) =>
        error instanceof ClientError && error.kind === 'protocol',
    );
  }
});
test('expired session replay preserves exact management selector and remains read-only', async () => {
  const s = setup();
  s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  s.transport.reply(adminPage());
  await s.gateway.list(adminQuery(), null, new Cancellation());
  assert.equal(s.transport.requests.length, 2);
  assert.equal(s.transport.requests[0]!.url, s.transport.requests[1]!.url);
  assert.equal(
    s.transport.requests[1]!.headers.Authorization,
    `Bearer ${wireCredentials('b').accessToken}`,
  );
});
