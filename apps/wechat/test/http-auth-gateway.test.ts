import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { AuthService } from '../src/auth/auth-service';
import { HttpAuthGateway } from '../src/auth/http-auth-gateway';
import { SessionStore } from '../src/auth/session';
import {
  decodeCredentials,
  decodeSessionInfo,
} from '../src/auth/session-contract';
import { Cancellation } from '../src/platform/contracts';
import {
  FakeClock,
  ScriptedTransport,
  deferred,
  flush,
  response,
} from './helpers';
import { wireCredentials, wireSession } from './identity-helpers';
function setup(timeout = 100) {
  const transport = new ScriptedTransport();
  const clock = new FakeClock();
  const gateway = new HttpAuthGateway(
    'https://api.example.invalid/',
    transport,
    clock,
    timeout,
  );
  return { gateway, transport, clock };
}

test('concrete login exchanges only the provider code and validates credentials', async () => {
  const s = setup();
  s.transport.reply({
    ...wireCredentials(),
    providerId: 'synthetic-private',
    profile: { name: 'fake' },
  });
  assert.deepEqual(await s.gateway.login('synthetic-code'), wireCredentials());
  const request = s.transport.requests[0];
  assert.equal(
    request?.url,
    'https://api.example.invalid/v1/auth/wechat/login',
  );
  assert.equal(request.method, 'POST');
  assert.deepEqual(request.body, { code: 'synthetic-code' });
  assert.deepEqual(request.headers, { 'content-type': 'application/json' });
  assert.equal(s.clock.timers, 0);
});
test('refresh sends only a refresh token and logout sends only bearer access', async () => {
  const s = setup();
  s.transport.reply(wireCredentials('b'));
  await s.gateway.refresh(wireCredentials());
  s.transport.reply('', 204);
  await s.gateway.logout(wireCredentials('b'));
  assert.equal(
    s.transport.requests[0]?.url,
    'https://api.example.invalid/v1/auth/refresh',
  );
  assert.deepEqual(s.transport.requests[0]?.body, {
    refreshToken: wireCredentials().refreshToken,
  });
  assert.equal(s.transport.requests[0]?.headers.Authorization, undefined);
  assert.equal(
    s.transport.requests[1]?.url,
    'https://api.example.invalid/v1/auth/logout',
  );
  assert.equal(
    s.transport.requests[1]?.headers.Authorization,
    `Bearer ${wireCredentials('b').accessToken}`,
  );
  assert.equal(s.transport.requests[1]?.body, undefined);
});
test('strict identity DTO validation rejects malformed IDs tokens timestamps and wrong purpose', () => {
  const good = wireCredentials();
  for (const patch of [
    { accountId: '12' },
    { sessionId: 'not-a-uuid' },
    { accessToken: good.refreshToken },
    { refreshToken: good.accessToken },
    { accessToken: 'wu_a_short' },
    { expiresAt: undefined },
    { expiresAt: -1 },
    { expiresAt: 1.1 },
    { expiresAt: Infinity },
    { refreshExpiresAt: good.expiresAt - 1 },
    { refreshExpiresAt: Number.MAX_SAFE_INTEGER },
    { refreshToken: `${good.refreshToken}\n` },
  ])
    assert.throws(() => decodeCredentials({ ...good, ...patch }), {
      kind: 'protocol',
    });
  for (const value of [undefined, null, [], {}]) {
    assert.throws(() => decodeCredentials(value), { kind: 'protocol' });
  }
  assert.deepEqual(
    decodeSessionInfo({ ...good, untrustedProfile: {} }),
    wireSession(),
  );
});
test('wrong success status, success error envelope and malformed logout are rejected', async () => {
  const s = setup();
  for (const status of [201, 202, 204]) {
    s.transport.reply(wireCredentials(), status);
    await assert.rejects(s.gateway.login('synthetic'), { kind: 'protocol' });
  }
  s.transport.reply({
    ...wireCredentials(),
    error: { code: 'LOGIN_REJECTED' },
  });
  await assert.rejects(s.gateway.login('synthetic'), { kind: 'protocol' });
  s.transport.reply({ message: 'unexpected' }, 204);
  await assert.rejects(s.gateway.logout(wireCredentials()), {
    kind: 'protocol',
  });
});
test('provider unavailable and unconfigured errors preserve only safe diagnostics', async () => {
  const s = setup();
  for (const code of ['AUTH_NOT_CONFIGURED', 'IDENTITY_PROVIDER_UNAVAILABLE']) {
    s.transport.reply(
      {
        error: {
          code,
          message: 'synthetic-secret-token',
          requestId: '12345678-1234-4123-8123-123456789abc',
        },
      },
      503,
    );
    await assert.rejects(s.gateway.login('synthetic'), (error) => {
      assert.equal((error as ClientError).details.serverCode, code);
      assert.equal(
        JSON.stringify(error).includes('synthetic-secret-token'),
        false,
      );
      return true;
    });
  }
});
test('gateway never retries a lost refresh response', async () => {
  const s = setup();
  s.transport.steps.push(async () => {
    throw new Error('synthetic-secret-token');
  });
  await assert.rejects(s.gateway.refresh(wireCredentials()), (error) => {
    assert.equal((error as ClientError).kind, 'network');
    assert.equal(String(error).includes('synthetic-secret-token'), false);
    return true;
  });
  assert.equal(s.transport.requests.length, 1);
});
test('gateway deadline aborts the transport and ignores late completion', async () => {
  const s = setup();
  const late = deferred<ReturnType<typeof response>>();
  s.transport.steps.push(() => late.promise);
  const pending = s.gateway.login('synthetic');
  const rejected = assert.rejects(pending, { kind: 'timeout' });
  await flush();
  s.clock.advance(100);
  await rejected;
  assert.equal(s.transport.requests[0]?.cancellation?.isCancelled, true);
  late.resolve(response(wireCredentials()));
  await flush();
  assert.equal(s.clock.timers, 0);
  assert.equal(s.transport.requests.length, 1);
});
test('gateway cancellation settles promptly and pre-cancelled calls never dispatch', async () => {
  const s = setup();
  const cancellation = new Cancellation();
  cancellation.cancel();
  await assert.rejects(s.gateway.login('synthetic', { cancellation }), {
    kind: 'cancelled',
  });
  assert.equal(s.transport.requests.length, 0);
  const active = new Cancellation();
  const late = deferred<ReturnType<typeof response>>();
  s.transport.steps.push(() => late.promise);
  const pending = s.gateway.refresh(wireCredentials(), {
    cancellation: active,
  });
  await flush();
  active.cancel();
  await assert.rejects(pending, { kind: 'cancelled' });
  late.resolve(response(wireCredentials()));
  await flush();
  assert.equal(s.clock.timers, 0);
});
test('gateway repeats ownership check immediately before concrete dispatch', async () => {
  const s = setup();
  let current = true;
  const pending = s.gateway.login('synthetic', {
    beforeDispatch: () => {
      if (!current) throw new ClientError('stale-session', 'Superseded');
    },
  });
  current = false;
  await assert.rejects(pending, { kind: 'stale-session' });
  assert.equal(s.transport.requests.length, 0);
});
test('same-tick logout blocks concrete refresh and does not clear a newer login', async () => {
  const s = setup();
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const auth = new AuthService(
    sessions,
    s.gateway,
    { login: async () => 'synthetic' },
    s.clock,
  );
  const pending = auth.refresh(sessions.snapshot());
  sessions.logout();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials('b'));
  await assert.rejects(pending, { kind: 'stale-session' });
  assert.equal(s.transport.requests.length, 0);
  assert.equal(
    sessions.snapshot().credentials?.accessToken,
    wireCredentials('b').accessToken,
  );
});
test('origin validation rejects credential destinations with unsafe or malformed authority', () => {
  const s = setup();
  for (const origin of [
    'http://api.invalid',
    'https://u:p@api.invalid',
    'https://api.invalid/a',
    'https://api.invalid?q=1',
    'https://api.invalid#x',
    'https://api..invalid',
    'https://-api.invalid',
    'https://api.invalid:65536',
    'https://api.invalid:0',
    'https://api.invalid\n',
  ])
    assert.throws(() => new HttpAuthGateway(origin, s.transport, s.clock), {
      kind: 'configuration',
    });
});
test('invalid provider code fails before any network call', async () => {
  const s = setup();
  for (const code of [
    '',
    ' ',
    'x'.repeat(257),
    'x\ny',
    'code.with.dot',
    'code/with/slash',
    'code+plus',
  ])
    await assert.rejects(s.gateway.login(code), { kind: 'configuration' });
  assert.equal(s.transport.requests.length, 0);
});

test('same-tick deadline expiry prevents a deferred gateway request from dispatching', async () => {
  const s = setup();
  const pending = s.gateway.login('synthetic');
  const rejection = assert.rejects(pending, { kind: 'timeout' });
  s.clock.advance(100);
  await rejection;
  await flush();
  assert.equal(s.transport.requests.length, 0);
});
