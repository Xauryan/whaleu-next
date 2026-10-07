import assert from 'node:assert/strict';
import test from 'node:test';
import { healthLive, healthReady } from '../src/api/health';
import { ApiClient, type Endpoint } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import { AuthService } from '../src/auth/auth-service';
import { SessionStore } from '../src/auth/session';
import { Cancellation } from '../src/platform/contracts';
import {
  FakeClock,
  ScriptedTransport,
  credentials,
  deferred,
  flush,
  response,
  signedIn,
} from './helpers';

const endpoint: Endpoint<unknown> = {
  path: '/synthetic/resource',
  method: 'GET',
  authentication: 'required',
  authReplay: 'once',
  decode: (value) => value,
};
function setup(sessions = signedIn()) {
  const transport = new ScriptedTransport();
  let refreshes = 0;
  const auth = new AuthService(
    sessions,
    {
      logout: async () => undefined,
      login: async () => credentials(),
      refresh: async () => {
        refreshes += 1;
        return credentials('12', 'b');
      },
    },
    { login: async () => 'synthetic-code' },
    new FakeClock(),
  );
  const client = new ApiClient(
    'https://example.invalid',
    transport,
    sessions,
    auth,
  );
  return { client, sessions, transport, refreshes: () => refreshes };
}

test('expired token is refreshed once and replay uses the new access token', async () => {
  const s = setup();
  s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  s.transport.reply({ value: 42 });
  assert.deepEqual(await s.client.request(endpoint), { value: 42 });
  assert.equal(s.refreshes(), 1);
  assert.equal(s.transport.requests.length, 2);
  assert.equal(
    s.transport.requests[1]?.headers.Authorization,
    'Bearer synthetic-access-b',
  );
  assert.equal(s.transport.requests[0]?.headers.refresh_token, undefined);
});
test('second unauthorized result stops replay rather than creating a loop', async () => {
  const s = setup();
  s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  await assert.rejects(s.client.request(endpoint), { kind: 'auth-expired' });
  assert.equal(s.refreshes(), 1);
  assert.equal(s.transport.requests.length, 2);
});
test('explicitly non-replayable operations never retry after auth rejection', async () => {
  const s = setup();
  s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  await assert.rejects(
    s.client.request({ ...endpoint, method: 'POST', authReplay: 'never' }),
    { kind: 'auth-expired' },
  );
  assert.equal(s.refreshes(), 0);
  assert.equal(s.transport.requests.length, 1);
});
test('network failures never trigger refresh or mutation replay', async () => {
  const s = setup();
  s.transport.steps.push(async () => {
    throw new ClientError('network', 'Synthetic');
  });
  await assert.rejects(s.client.request(endpoint), { kind: 'network' });
  assert.equal(s.refreshes(), 0);
});
test('stale success after account switch is rejected before decoding', async () => {
  const s = setup();
  const late = deferred<ReturnType<typeof response>>();
  s.transport.steps.push(() => late.promise);
  let decodes = 0;
  const pending = s.client.request({
    ...endpoint,
    decode: (value) => {
      decodes += 1;
      return value;
    },
  });
  await flush();
  s.sessions.completeLogin(s.sessions.beginLogin(), credentials('99'));
  late.resolve(response({ value: 'old-account' }));
  await assert.rejects(pending, { kind: 'stale-session' });
  assert.equal(decodes, 0);
});
test('stale failure after account switch cannot appear as a current-account failure', async () => {
  const s = setup();
  const late = deferred<ReturnType<typeof response>>();
  s.transport.steps.push(() => late.promise);
  const pending = s.client.request(endpoint);
  await flush();
  s.sessions.logout();
  late.reject(new ClientError('network', 'Synthetic'));
  await assert.rejects(pending, { kind: 'stale-session' });
});
test('guest response becomes stale after login', async () => {
  const s = setup(new SessionStore());
  const late = deferred<ReturnType<typeof response>>();
  s.transport.steps.push(() => late.promise);
  const pending = s.client.request({ ...endpoint, authentication: 'none' });
  await flush();
  s.sessions.completeLogin(s.sessions.beginLogin(), credentials());
  late.resolve(response({ value: 1 }));
  await assert.rejects(pending, { kind: 'stale-session' });
});
test('the new client does not reinterpret numeric legacy business codes', async () => {
  const s = setup();
  s.transport.reply({ code: 4001 });
  s.transport.reply({ error_code: 4001 });
  assert.deepEqual(await s.client.request(endpoint), { code: 4001 });
  assert.deepEqual(await s.client.request(endpoint), { error_code: 4001 });
  assert.equal(s.refreshes(), 0);
});
test('caller object is snapshotted and no user identity is injected into new API payloads', async () => {
  const s = setup();
  const body = { user_id: 999, nested: { text: 'first' } };
  s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  s.transport.reply({ value: 1 });
  const pending = s.client.request({ ...endpoint, method: 'POST' }, { body });
  body.nested.text = 'mutated';
  await pending;
  assert.deepEqual(s.transport.requests[1]?.body, {
    user_id: 999,
    nested: { text: 'first' },
  });
  assert.equal(
    s.transport.requests[1]?.headers.Authorization,
    'Bearer synthetic-access-b',
  );
  assert.equal(s.transport.requests[1]?.headers.token, undefined);
});
test('required auth fails before network; explicit anonymous endpoint never sends access token', async () => {
  const s = setup(new SessionStore());
  await assert.rejects(s.client.request(endpoint), { kind: 'auth-required' });
  assert.equal(s.transport.requests.length, 0);
  s.sessions.completeLogin(s.sessions.beginLogin(), credentials());
  s.transport.reply({ value: 1 });
  await s.client.request({ ...endpoint, authentication: 'none' });
  assert.equal(s.transport.requests[0]?.headers.Authorization, undefined);
});
test('cancelled request is never started, cancellation before refresh prevents replay', async () => {
  const s = setup();
  const cancellation = new Cancellation();
  cancellation.cancel();
  await assert.rejects(s.client.request(endpoint, { cancellation }), {
    kind: 'cancelled',
  });
  assert.equal(s.transport.requests.length, 0);
  const second = new Cancellation();
  s.transport.steps.push(async () => {
    second.cancel();
    return response({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  });
  await assert.rejects(s.client.request(endpoint, { cancellation: second }), {
    kind: 'cancelled',
  });
  assert.equal(s.refreshes(), 0);
});
test('arbitrary response headers cannot rotate credentials', async () => {
  const s = setup();
  s.transport.reply({}, 200, {
    'new-access-token': 'synthetic-access-b',
    'new-refresh-token': 'synthetic-refresh-b',
  });
  await s.client.request(endpoint);
  assert.equal(s.sessions.snapshot().revision, 0);
});
test('origin and endpoint validation prevents credentials reaching a caller-provided host', async () => {
  const s = setup();
  for (const origin of [
    'http://example.invalid',
    'https://user@example.invalid',
    'https://example.invalid/path',
    'https://example.invalid?token=x',
  ]) {
    assert.throws(
      () =>
        new ApiClient(origin, s.transport, s.sessions, {
          refresh: async () => s.sessions.snapshot(),
        }),
      { kind: 'configuration' },
    );
  }
  for (const path of [
    '//evil.invalid/a',
    'https://evil.invalid',
    '/a/../secret',
    '/a?token=x',
    '/a#b',
  ]) {
    await assert.rejects(s.client.request({ ...endpoint, path }), {
      kind: 'configuration',
    });
  }
  assert.equal(s.transport.requests.length, 0);
});
test('two concurrent 401 responses generate one refresh', async () => {
  const s = setup();
  s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  s.transport.reply({ value: 1 });
  s.transport.reply({ value: 2 });
  const result = await Promise.all([
    s.client.request(endpoint),
    s.client.request(endpoint),
  ]);
  assert.equal(result.length, 2);
  assert.equal(s.refreshes(), 1);
  await flush();
});

test('cancellation during shared refresh settles promptly without cancelling peers', async () => {
  const sessions = signedIn();
  const transport = new ScriptedTransport();
  const clock = new FakeClock();
  const next = deferred<ReturnType<typeof credentials>>();
  let refreshes = 0;
  const auth = new AuthService(
    sessions,
    {
      logout: async () => undefined,
      login: async () => credentials(),
      refresh: async () => {
        refreshes += 1;
        return next.promise;
      },
    },
    { login: async () => 'synthetic' },
    clock,
  );
  const client = new ApiClient(
    'https://example.invalid',
    transport,
    sessions,
    auth,
  );
  transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  transport.reply({ value: 'peer' });
  const cancellation = new Cancellation();
  const cancelled = client.request(endpoint, { cancellation });
  const peer = client.request(endpoint);
  await flush();
  assert.equal(refreshes, 1);
  cancellation.cancel();
  await assert.rejects(cancelled, { kind: 'cancelled' });
  assert.equal(clock.now(), 1_000); // No timer advance was needed to cancel this wait.
  next.resolve(credentials('12', 'b'));
  assert.deepEqual(await peer, { value: 'peer' });
  assert.equal(transport.requests.length, 3);
});
test('same-tick logout prevents a scheduled native request from being dispatched', async () => {
  const s = setup();
  const pending = s.client.request(endpoint);
  s.sessions.logout();
  await assert.rejects(pending, { kind: 'stale-session' });
  assert.equal(s.transport.requests.length, 0);
});
test('generic unauthorized and revoked sessions never trigger a token refresh', async () => {
  const s = setup();
  for (const code of [
    'UNAUTHORIZED',
    'AUTHENTICATION_REQUIRED',
    'SESSION_REVOKED',
  ]) {
    s.transport.reply({ error: { code } }, 401);
    await assert.rejects(s.client.request(endpoint), { kind: 'auth-required' });
  }
  assert.equal(s.refreshes(), 0);
});

test('implemented health routes use an explicit DTO decoder without credentials', async () => {
  const s = setup();
  s.transport.reply({ status: 'ok' });
  assert.deepEqual(await s.client.request(healthLive), { status: 'ok' });
  assert.equal(
    s.transport.requests[0]?.url,
    'https://example.invalid/health/live',
  );
  assert.equal(s.transport.requests[0]?.headers.Authorization, undefined);
  s.transport.reply({ status: 'unexpected' });
  await assert.rejects(s.client.request(healthReady), { kind: 'protocol' });
});
