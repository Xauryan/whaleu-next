import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthService, type AuthGateway } from '../src/auth/auth-service';
import { ClientError } from '../src/api/errors';
import { SessionStore } from '../src/auth/session';
import {
  FakeClock,
  MemoryStorage,
  credentials,
  deferred,
  flush,
  signedIn,
} from './helpers';

function gateway(
  refresh: AuthGateway['refresh'],
  login: AuthGateway['login'] = async () => credentials(),
): AuthGateway {
  return { refresh, login };
}

test('parallel expired requests share one refresh and late 401 reuses new revision', async () => {
  const sessions = signedIn();
  const clock = new FakeClock();
  const next = deferred<ReturnType<typeof credentials>>();
  let calls = 0;
  const service = new AuthService(
    sessions,
    gateway(async () => {
      calls += 1;
      return next.promise;
    }),
    { login: async () => 'synthetic-code' },
    clock,
  );
  const ticket = sessions.snapshot();
  const a = service.refresh(ticket);
  const b = service.refresh(ticket);
  assert.equal(a, b);
  await flush();
  assert.equal(calls, 1);
  next.resolve(credentials('12', 'b'));
  await Promise.all([a, b]);
  await service.refresh(ticket);
  assert.equal(calls, 1);
  assert.equal(
    sessions.snapshot().credentials?.accessToken,
    'synthetic-access-b',
  );
  assert.equal(clock.timers, 0);
});
test('bounded refresh releases flight after timeout and ignores a late success', async () => {
  const sessions = signedIn();
  const clock = new FakeClock();
  const late = deferred<ReturnType<typeof credentials>>();
  let calls = 0;
  const service = new AuthService(
    sessions,
    gateway(async () =>
      ++calls === 1 ? late.promise : credentials('12', 'b'),
    ),
    { login: async () => 'synthetic-code' },
    clock,
    100,
  );
  const pending = service.refresh(sessions.snapshot());
  const rejection = assert.rejects(pending, { kind: 'timeout' });
  await flush();
  clock.advance(100);
  await rejection;
  await service.refresh(sessions.snapshot());
  late.resolve(credentials('12', 'late'));
  await flush();
  assert.equal(
    sessions.snapshot().credentials?.accessToken,
    'synthetic-access-b',
  );
  assert.equal(calls, 2);
});
test('synchronous refresh throw cleans up singleflight without losing login', async () => {
  const sessions = signedIn();
  const clock = new FakeClock();
  let calls = 0;
  const service = new AuthService(
    sessions,
    gateway(() => {
      if (++calls === 1) throw new Error('synthetic');
      return Promise.resolve(credentials('12', 'b'));
    }),
    { login: async () => 'synthetic-code' },
    clock,
  );
  await assert.rejects(service.refresh(sessions.snapshot()), {
    kind: 'network',
  });
  await service.refresh(sessions.snapshot());
  assert.equal(calls, 2);
});
test('refresh success after account switch cannot overwrite the new account', async () => {
  const sessions = signedIn();
  const late = deferred<ReturnType<typeof credentials>>();
  const service = new AuthService(
    sessions,
    gateway(async () => late.promise),
    { login: async () => 'synthetic-code' },
    new FakeClock(),
  );
  const pending = service.refresh(sessions.snapshot());
  sessions.completeLogin(sessions.beginLogin(), credentials('99'));
  late.resolve(credentials('12', 'late'));
  await assert.rejects(pending, { kind: 'stale-session' });
  assert.equal(sessions.snapshot().credentials?.accountId, '99');
});
test('old failed refresh cannot clear a newer same-account login', async () => {
  const sessions = signedIn();
  const late = deferred<ReturnType<typeof credentials>>();
  const service = new AuthService(
    sessions,
    gateway(async () => late.promise),
    { login: async () => 'synthetic-code' },
    new FakeClock(),
  );
  const pending = service.refresh(sessions.snapshot());
  sessions.completeLogin(sessions.beginLogin(), credentials('12', 'new-login'));
  late.reject(new ClientError('auth-required', 'Invalid refresh'));
  await assert.rejects(pending, { kind: 'stale-session' });
  assert.equal(
    sessions.snapshot().credentials?.accessToken,
    'synthetic-access-new-login',
  );
});
test('definitively rejected refresh invalidates only the current login', async () => {
  const sessions = signedIn();
  const service = new AuthService(
    sessions,
    gateway(async () => {
      throw new ClientError('auth-required', 'Rejected');
    }),
    { login: async () => 'synthetic-code' },
    new FakeClock(),
  );
  await assert.rejects(service.refresh(sessions.snapshot()), {
    kind: 'auth-required',
  });
  assert.equal(sessions.snapshot().credentials, null);
});
test('later login attempt wins over an earlier provider exchange', async () => {
  const sessions = new SessionStore();
  const first = deferred<ReturnType<typeof credentials>>();
  let calls = 0;
  const service = new AuthService(
    sessions,
    gateway(
      async (current) => current,
      async () => (++calls === 1 ? first.promise : credentials('99')),
    ),
    { login: async () => 'synthetic-code' },
    new FakeClock(),
  );
  const a = service.login();
  await flush();
  const b = service.login();
  await b;
  first.resolve(credentials('12'));
  await assert.rejects(a, { kind: 'stale-session' });
  assert.equal(sessions.snapshot().credentials?.accountId, '99');
});
test('logout during platform login prevents exchange and late login commit', async () => {
  const sessions = new SessionStore();
  const code = deferred<string>();
  let exchanges = 0;
  const service = new AuthService(
    sessions,
    gateway(
      async (current) => current,
      async () => {
        exchanges += 1;
        return credentials();
      },
    ),
    { login: () => code.promise },
    new FakeClock(),
  );
  const pending = service.login();
  await flush();
  sessions.logout();
  code.resolve('synthetic-code');
  await assert.rejects(pending, { kind: 'stale-session' });
  assert.equal(exchanges, 0);
});

test('platform login code arriving after deadline never starts backend exchange', async () => {
  const sessions = new SessionStore();
  const clock = new FakeClock();
  const code = deferred<string>();
  let exchanges = 0;
  const service = new AuthService(
    sessions,
    gateway(
      async (current) => current,
      async () => {
        exchanges += 1;
        return credentials();
      },
    ),
    { login: () => code.promise },
    clock,
    100,
  );
  const pending = service.login();
  const rejection = assert.rejects(pending, { kind: 'timeout' });
  await flush();
  clock.advance(100);
  await rejection;
  code.resolve('late-synthetic-code');
  await flush();
  assert.equal(exchanges, 0);
  assert.equal(sessions.snapshot().credentials, null);
});

test('raw synchronous provider and gateway errors are sanitized at the login boundary', async () => {
  for (const stage of ['provider', 'gateway']) {
    const service = new AuthService(
      new SessionStore(),
      gateway(
        async (current) => current,
        () => {
          throw new Error('synthetic-private-sentinel');
        },
      ),
      {
        login: () => {
          if (stage === 'provider')
            throw new Error('synthetic-private-sentinel');
          return Promise.resolve('synthetic');
        },
      },
      new FakeClock(),
    );
    await assert.rejects(service.login(), (error) => {
      assert.equal((error as { kind: string }).kind, 'network');
      assert.equal(String(error).includes('private-sentinel'), false);
      return true;
    });
  }
});

test('login storage failure retains its storage category while clearing memory', async () => {
  const storage = new MemoryStorage();
  storage.failWrite = true;
  const sessions = new SessionStore(storage);
  const service = new AuthService(
    sessions,
    gateway(async (current) => current),
    { login: async () => 'synthetic' },
    new FakeClock(),
  );
  await assert.rejects(service.login(), { kind: 'storage' });
  assert.equal(sessions.snapshot().credentials, null);
});
test('refresh storage failure retains its storage category while clearing memory', async () => {
  const storage = new MemoryStorage();
  const sessions = new SessionStore(storage);
  sessions.completeLogin(sessions.beginLogin(), credentials());
  storage.failWrite = true;
  const service = new AuthService(
    sessions,
    gateway(async () => credentials('12', 'b')),
    { login: async () => 'synthetic' },
    new FakeClock(),
  );
  await assert.rejects(service.refresh(sessions.snapshot()), {
    kind: 'storage',
  });
  assert.equal(sessions.snapshot().credentials, null);
});
