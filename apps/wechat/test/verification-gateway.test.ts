import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import { Cancellation } from '../src/platform/contracts';
import { WechatTransport, type WxApi } from '../src/platform/wechat';
import { HttpVerificationGateway } from '../src/verification/gateway';
import {
  FakeClock,
  ScriptedTransport,
  deferred,
  flush,
  response,
} from './helpers';
import { wireCredentials } from './identity-helpers';
import { summary } from './verification-helpers';

function setup() {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const transport = new ScriptedTransport();
  let refreshes = 0;
  const gateway = new HttpVerificationGateway(
    new ApiClient('https://api.example.invalid', transport, sessions, {
      refresh: async () => {
        refreshes += 1;
        return sessions.rotate(sessions.snapshot(), wireCredentials('b'));
      },
    }),
  );
  return { sessions, transport, gateway, refreshes: () => refreshes };
}
test('own verification gateway uses only authenticated GET with no account selector or request body', async () => {
  const s = setup();
  s.transport.reply(summary());
  const cancel = new Cancellation();
  assert.deepEqual(await s.gateway.summary(cancel), summary());
  assert.equal(s.transport.requests.length, 1);
  const request = s.transport.requests[0]!;
  assert.equal(request.url, 'https://api.example.invalid/v1/me/verification');
  assert.equal(request.method, 'GET');
  assert.equal(request.body, undefined);
  assert.equal(
    request.headers.Authorization,
    `Bearer ${wireCredentials().accessToken}`,
  );
  assert.equal(request.cancellation, cancel);
  s.sessions.logout();
  await assert.rejects(s.gateway.summary(new Cancellation()), {
    kind: 'auth-required',
  });
  assert.equal(s.transport.requests.length, 1);
});
test('summary read refreshes expired access once, using the current credential, but never retries a second expiry', async () => {
  const s = setup();
  s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  s.transport.reply(summary());
  await s.gateway.summary(new Cancellation());
  assert.equal(s.refreshes(), 1);
  assert.equal(
    s.transport.requests[1]?.headers.Authorization,
    `Bearer ${wireCredentials('b').accessToken}`,
  );
  s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  await assert.rejects(s.gateway.summary(new Cancellation()), {
    kind: 'auth-expired',
  });
  assert.equal(s.refreshes(), 2);
  assert.equal(s.transport.requests.length, 4);
});
test('summary rejects malformed success/status and does not turn denial or unavailable service into unverified', async () => {
  const s = setup();
  for (const [body, status, kind] of [
    [summary(), 201, 'protocol'],
    [
      { ...summary(), studentNumber: { status: 'verified', value: '00123' } },
      200,
      'protocol',
    ],
    [{}, 200, 'protocol'],
    [{ error: { code: 'SESSION_REVOKED' } }, 401, 'auth-required'],
    [{ error: { code: 'FORBIDDEN' } }, 403, 'forbidden'],
    [{ error: { code: 'INTERNAL_ERROR' } }, 503, 'http'],
  ] as const) {
    s.transport.reply(body, status);
    await assert.rejects(s.gateway.summary(new Cancellation()), { kind });
  }
  assert.equal(s.refreshes(), 0);
  assert.equal(s.transport.requests.length, 6);
});
test('same-tick cancellation prevents transport and late account or same-account login results are rejected', async () => {
  const s = setup();
  const cancel = new Cancellation();
  const cancelled = s.gateway.summary(cancel);
  cancel.cancel();
  await assert.rejects(cancelled, { kind: 'cancelled' });
  assert.equal(s.transport.requests.length, 0);
  for (const accountId of [
    wireCredentials().accountId,
    '99999999-9999-4999-8999-999999999999',
  ]) {
    const late = deferred<ReturnType<typeof response>>();
    s.transport.steps.push(() => late.promise);
    const pending = s.gateway.summary(new Cancellation());
    await flush();
    s.sessions.completeLogin(s.sessions.beginLogin(), {
      ...wireCredentials('c'),
      accountId,
    });
    late.resolve(response(summary({ phone: { status: 'verified' } })));
    await assert.rejects(pending, { kind: 'stale-session' });
  }
});
test('native summary cancellation and timeout abort transport and discard late callbacks', async () => {
  for (const mode of ['cancel', 'timeout'] as const) {
    const clock = new FakeClock(),
      sessions = new SessionStore();
    sessions.completeLogin(sessions.beginLogin(), wireCredentials());
    let aborted = 0;
    let callback: Parameters<WxApi['request']>[0] | undefined;
    const gateway = new HttpVerificationGateway(
      new ApiClient(
        'https://api.example.invalid',
        new WechatTransport(
          {
            request(options) {
              callback = options;
              return {
                abort() {
                  aborted += 1;
                },
              };
            },
          },
          clock,
        ),
        sessions,
        { refresh: async () => sessions.snapshot() },
      ),
    );
    const cancel = new Cancellation(),
      pending = gateway.summary(cancel);
    await flush();
    if (mode === 'cancel') cancel.cancel();
    else clock.advance(15_000);
    await assert.rejects(pending, {
      kind: mode === 'cancel' ? 'cancelled' : 'timeout',
    });
    assert.equal(aborted, 1);
    assert.equal(clock.timers, 0);
    callback?.success({ statusCode: 200, data: summary() });
  }
});
