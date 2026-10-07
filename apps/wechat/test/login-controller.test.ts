import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import { AuthService } from '../src/auth/auth-service';
import { HttpAuthGateway } from '../src/auth/http-auth-gateway';
import { createIdentityRuntime } from '../src/auth/runtime';
import { SessionStore } from '../src/auth/session';
import {
  LoginController,
  friendlyError,
  type LoginView,
} from '../src/pages/login/controller';
import type { WxApi } from '../src/platform/wechat';
import {
  FakeClock,
  MemoryStorage,
  ScriptedTransport,
  deferred,
  flush,
  response,
} from './helpers';
import { wireCredentials, wireSession } from './identity-helpers';
function setup(restored = false, storage?: MemoryStorage) {
  const sessions = new SessionStore(storage);
  if (restored)
    sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const transport = new ScriptedTransport();
  const clock = new FakeClock();
  let providerCalls = 0;
  const provider = {
    login: async () => {
      providerCalls += 1;
      return 'synthetic-code';
    },
  };
  const gateway = new HttpAuthGateway(
    'https://api.example.invalid',
    transport,
    clock,
  );
  const auth = new AuthService(sessions, gateway, provider, clock);
  const api = new ApiClient(
    'https://api.example.invalid',
    transport,
    sessions,
    auth,
  );
  const views: LoginView[] = [];
  const controller = new LoginController({ sessions, auth, api }, (view) =>
    views.push(view),
  );
  return {
    controller,
    api,
    auth,
    sessions,
    transport,
    clock,
    views,
    provider,
    providerCalls: () => providerCalls,
    view: () => views[views.length - 1]!,
  };
}

test('native login establishes a real session view without copying credentials or fake profile data', async () => {
  const s = setup();
  s.transport.reply(wireCredentials());
  s.transport.reply(wireSession());
  await s.controller.login();
  assert.equal(s.providerCalls(), 1);
  assert.equal(s.view().verified, true);
  assert.equal(s.view().accountId, wireCredentials().accountId);
  assert.equal(s.view().busy, false);
  assert.equal(
    s.transport.requests[1]?.url,
    'https://api.example.invalid/v1/auth/session',
  );
  assert.equal(
    s.transport.requests[1]?.headers.Authorization,
    `Bearer ${wireCredentials().accessToken}`,
  );
  const rendered = JSON.stringify(s.views);
  for (const secret of [
    wireCredentials().accessToken,
    wireCredentials().refreshToken,
    'synthetic-code',
  ])
    assert.equal(rendered.includes(secret), false);
  assert.equal(rendered.includes('nickname'), false);
});
test('rapid double tap creates one provider login and one backend exchange', async () => {
  const s = setup();
  const code = deferred<string>();
  s.provider.login = () => code.promise;
  s.transport.reply(wireCredentials());
  s.transport.reply(wireSession());
  const first = s.controller.login();
  await s.controller.login();
  code.resolve('synthetic');
  await first;
  assert.equal(s.transport.requests.length, 2);
});
test('cancel login before the provider responds prevents exchange and late UI changes', async () => {
  const s = setup();
  const code = deferred<string>();
  s.provider.login = () => code.promise;
  const pending = s.controller.login();
  await flush();
  await s.controller.logout();
  code.resolve('late-synthetic');
  await pending;
  assert.equal(s.transport.requests.length, 0);
  assert.equal(s.view().status, '已退出登录');
  assert.equal(s.view().hasLocalSession, false);
  assert.equal(s.clock.timers, 0);
});
test('page unload cancels its login work and never renders a late result', async () => {
  const s = setup();
  const late = deferred<ReturnType<typeof response>>();
  s.transport.steps.push(() => late.promise);
  const pending = s.controller.login();
  await flush();
  s.controller.dispose();
  const renderedCount = s.views.length;
  late.resolve(response(wireCredentials()));
  await pending;
  assert.equal(s.views.length, renderedCount);
  assert.equal(s.sessions.snapshot().credentials, null);
  assert.equal(s.transport.requests.length, 1);
});
test('restored login remains unverified until an explicit session check succeeds', async () => {
  const s = setup(true);
  assert.equal(s.transport.requests.length, 0);
  assert.equal(s.view().verified, false);
  assert.equal(s.view().accountId, '');
  assert.equal(s.view().hasLocalSession, true);
  s.transport.reply(wireSession());
  await s.controller.checkSession();
  assert.equal(s.view().verified, true);
});
test('restored expired access refreshes once and rechecks session using rotated credentials', async () => {
  const s = setup(true);
  s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  s.transport.reply(wireCredentials('b'));
  s.transport.reply(wireSession(wireCredentials('b')));
  await s.controller.checkSession();
  assert.equal(s.view().verified, true);
  assert.equal(s.transport.requests.length, 3);
  assert.deepEqual(s.transport.requests[1]?.body, {
    refreshToken: wireCredentials().refreshToken,
  });
  assert.equal(
    s.transport.requests[2]?.headers.Authorization,
    `Bearer ${wireCredentials('b').accessToken}`,
  );
});
test('lost refresh response returns to signed-out UI and cannot be retried', async () => {
  const s = setup(true);
  s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  s.transport.steps.push(async () => {
    throw new ClientError('network', 'Synthetic');
  });
  await s.controller.checkSession();
  assert.equal(s.view().hasLocalSession, false);
  assert.equal(s.view().verified, false);
  assert.match(s.view().error, /重新登录/);
  await s.controller.checkSession();
  assert.equal(s.transport.requests.length, 2);
});
test('server revoked session and account blocked clear local login without refresh', async () => {
  for (const [code, status] of [
    ['SESSION_REVOKED', 401],
    ['ACCOUNT_BLOCKED', 403],
  ] as const) {
    const s = setup(true);
    s.transport.reply({ error: { code } }, status);
    await s.controller.checkSession();
    assert.equal(s.view().hasLocalSession, false);
    assert.equal(s.view().verified, false);
    assert.equal(s.transport.requests.length, 1);
  }
});
test('unconfigured client never calls wx login, request, or storage', async () => {
  let calls = 0;
  const unused = () => {
    calls += 1;
    throw new Error('Must remain local');
  };
  const wx: WxApi = {
    request: unused,
    login: unused,
    getStorageSync: unused,
    setStorageSync: unused,
    removeStorageSync: unused,
  };
  const runtime = createIdentityRuntime(
    { apiOrigin: '', providerLoginEnabled: false },
    wx,
    new FakeClock(),
  );
  const views: LoginView[] = [];
  const controller = new LoginController(runtime, (view) => views.push(view));
  await controller.login();
  assert.equal(calls, 0);
  assert.equal(views[views.length - 1]?.configured, false);
  assert.match(views[views.length - 1]?.error ?? '', /尚未配置/);
});
test('server unconfigured and provider unavailable are honestly explained', async () => {
  for (const code of ['AUTH_NOT_CONFIGURED', 'IDENTITY_PROVIDER_UNAVAILABLE']) {
    const s = setup();
    s.transport.reply({ error: { code, message: 'synthetic-secret' } }, 503);
    await s.controller.login();
    assert.equal(s.view().hasLocalSession, false);
    assert.equal(s.view().verified, false);
    assert.equal(s.view().busy, false);
    assert.equal(
      s.view().error,
      friendlyError(new ClientError('http', '', { serverCode: code })),
    );
    assert.equal(JSON.stringify(s.views).includes('synthetic-secret'), false);
  }
});
test('session identity mismatch clears credentials without displaying another account', async () => {
  const s = setup(true);
  s.transport.reply({
    ...wireSession(),
    accountId: '92345678-1234-4123-8123-123456789abc',
  });
  await s.controller.checkSession();
  assert.equal(s.view().verified, false);
  assert.equal(s.view().accountId, '');
  assert.equal(s.view().hasLocalSession, false);
});
test('logout suppresses late session results and duplicate taps revoke only once', async () => {
  const s = setup(true);
  const check = deferred<ReturnType<typeof response>>();
  const revoke = deferred<ReturnType<typeof response>>();
  s.transport.steps.push(
    () => check.promise,
    () => revoke.promise,
  );
  const checking = s.controller.checkSession();
  await flush();
  const loggingOut = s.controller.logout();
  await s.controller.logout();
  assert.equal(s.sessions.snapshot().credentials, null);
  await flush();
  check.resolve(response(wireSession()));
  revoke.resolve(response('', 204));
  await Promise.all([checking, loggingOut]);
  assert.equal(s.transport.requests.length, 2);
  assert.equal(s.view().status, '已退出登录');
  assert.equal(s.view().verified, false);
  assert.equal(s.view().accountId, '');
});
test('uncertain server logout is not presented as confirmed session revocation', async () => {
  const s = setup(true);
  s.transport.steps.push(async () => {
    throw new Error('synthetic');
  });
  await s.controller.logout();
  assert.equal(s.sessions.snapshot().credentials, null);
  assert.equal(s.view().hasLocalSession, false);
  assert.match(s.view().error, /未确认/);
});
test('configured startup restores only its own origin without automatic provider or API calls', () => {
  const storage = new MemoryStorage();
  let calls = 0;
  const wx: WxApi = {
    request: () => {
      calls += 1;
      throw new Error('No startup request');
    },
    login: () => {
      calls += 1;
    },
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.remove(key),
  };
  const config = {
    apiOrigin: 'https://one.example.invalid',
    providerLoginEnabled: true,
  };
  const first = createIdentityRuntime(config, wx, new FakeClock());
  first.sessions.completeLogin(first.sessions.beginLogin(), wireCredentials());
  const same = createIdentityRuntime(config, wx, new FakeClock());
  const other = createIdentityRuntime(
    { ...config, apiOrigin: 'https://two.example.invalid' },
    wx,
    new FakeClock(),
  );
  assert.deepEqual(same.sessions.snapshot().credentials, wireCredentials());
  assert.equal(other.sessions.snapshot().credentials, null);
  assert.equal(calls, 0);
});

test('runtime rejects saved credentials with wrong token purpose UUID or expiry ordering', () => {
  for (const patch of [
    {
      accessToken: wireCredentials().refreshToken,
      refreshToken: wireCredentials().accessToken,
    },
    { accountId: 'not-a-uuid' },
    { sessionId: 'not-a-uuid' },
    { refreshExpiresAt: wireCredentials().expiresAt - 1 },
  ]) {
    const storage = new MemoryStorage();
    const key = 'whaleu.identity.v1:https://one.example.invalid';
    storage.set(key, {
      version: 1,
      credentials: { ...wireCredentials(), ...patch },
    });
    let calls = 0;
    const wx: WxApi = {
      request: () => {
        calls += 1;
        throw new Error('No request');
      },
      login: () => {
        calls += 1;
      },
      getStorageSync: (name) => storage.get(name),
      setStorageSync: (name, value) => storage.set(name, value),
      removeStorageSync: (name) => storage.remove(name),
    };
    const runtime = createIdentityRuntime(
      { apiOrigin: 'https://one.example.invalid', providerLoginEnabled: true },
      wx,
      new FakeClock(),
    );
    assert.equal(runtime.sessions.snapshot().credentials, null);
    assert.equal(runtime.startupError?.kind, 'storage');
    assert.equal(storage.get(key), undefined);
    assert.equal(calls, 0);
  }
});

test('completed old session response cannot clear or display a newer account at the UI await boundary', async () => {
  for (const [code, status] of [
    ['success', 200],
    ['AUTHENTICATION_REQUIRED', 401],
    ['ACCOUNT_BLOCKED', 403],
  ] as const) {
    const s = setup(true);
    const newer = {
      ...wireCredentials('b'),
      accountId: '92345678-1234-4123-8123-123456789abc',
      sessionId: '82345678-1234-4123-8123-123456789abc',
    };
    s.transport.reply(
      status === 200 ? wireSession() : { error: { code } },
      status,
    );
    const request = s.api.request.bind(s.api);
    // Model an account switch after ApiClient settled but before its UI continuation runs.
    s.api.request = async (endpoint, options) => {
      try {
        return await request(endpoint, options);
      } finally {
        s.sessions.completeLogin(s.sessions.beginLogin(), newer);
      }
    };
    await s.controller.checkSession();
    assert.deepEqual(s.sessions.snapshot().credentials, newer);
    assert.equal(s.view().verified, false);
    assert.equal(s.view().accountId, '');
    assert.equal(s.view().hasLocalSession, true);
    assert.match(s.view().status, /登录状态已改变/);
  }
});
test('completed old login cannot start a session check for a newer account at the UI await boundary', async () => {
  const s = setup();
  const newer = {
    ...wireCredentials('b'),
    accountId: '92345678-1234-4123-8123-123456789abc',
  };
  s.transport.reply(wireCredentials());
  const login = s.auth.login.bind(s.auth);
  s.auth.login = async (cancellation) => {
    const ticket = await login(cancellation);
    s.sessions.completeLogin(s.sessions.beginLogin(), newer);
    return ticket;
  };
  await s.controller.login();
  assert.deepEqual(s.sessions.snapshot().credentials, newer);
  assert.equal(s.transport.requests.length, 1);
  assert.equal(s.view().verified, false);
});
test('completed old logout does not label a newer login as logged out', async () => {
  const s = setup(true);
  const newer = {
    ...wireCredentials('b'),
    accountId: '92345678-1234-4123-8123-123456789abc',
  };
  s.transport.reply('', 204);
  const logout = s.auth.logout.bind(s.auth);
  s.auth.logout = async () => {
    await logout();
    s.sessions.completeLogin(s.sessions.beginLogin(), newer);
  };
  await s.controller.logout();
  assert.deepEqual(s.sessions.snapshot().credentials, newer);
  assert.equal(s.view().hasLocalSession, true);
  assert.match(s.view().status, /登录状态已改变/);
});

test('partial storage write plus failed cleanup keeps the cache-clearing warning after login and refresh', async () => {
  class PartialWriteStorage extends MemoryStorage {
    failAfterWrite = false;
    override set(key: string, value: unknown): void {
      super.set(key, value);
      if (this.failAfterWrite) {
        this.failRemove = true;
        throw new Error('Synthetic partial storage failure');
      }
    }
  }
  for (const refreshing of [false, true]) {
    const storage = new PartialWriteStorage();
    const s = setup(refreshing, storage);
    storage.failAfterWrite = true;
    if (refreshing)
      s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
    s.transport.reply(wireCredentials('b'));
    if (refreshing) await s.controller.checkSession();
    else await s.controller.login();
    assert.equal(s.sessions.snapshot().credentials, null);
    assert.equal(storage.data.size, 1);
    assert.equal(s.view().hasLocalSession, false);
    assert.equal(s.view().verified, false);
    assert.match(s.view().error, /凭证可能未能删除/);
    assert.match(s.view().error, /清理小程序缓存/);
    assert.equal(s.view().busy, false);
  }
});
test('failed removal before starting a new login keeps the storage warning without provider calls', async () => {
  const storage = new MemoryStorage();
  const s = setup(true, storage);
  storage.failRemove = true;
  await s.controller.login();
  assert.equal(s.providerCalls(), 0);
  assert.equal(s.sessions.snapshot().credentials, null);
  assert.match(s.view().error, /清理小程序缓存/);
});

test('revoked-session cleanup failure stops loading and warns that stored credentials may remain', async () => {
  const storage = new MemoryStorage();
  const s = setup(true, storage);
  storage.failRemove = true;
  s.transport.reply({ error: { code: 'SESSION_REVOKED' } }, 401);
  await s.controller.checkSession();
  assert.equal(s.sessions.snapshot().credentials, null);
  assert.equal(storage.data.size, 1);
  assert.equal(s.view().hasLocalSession, false);
  assert.equal(s.view().busy, false);
  assert.match(s.view().status, /设备存储需要处理/);
  assert.match(s.view().error, /清理小程序缓存/);
});
test('returning from a business page clears stale verified login UI after terminal auth cleanup', async () => {
  const s = setup(true);
  s.transport.reply(wireSession());
  await s.controller.checkSession();
  assert.equal(s.view().verified, true);
  s.sessions.logout();
  s.controller.syncSession();
  assert.equal(s.view().verified, false);
  assert.equal(s.view().hasLocalSession, false);
  assert.equal(s.view().accountId, '');
});
test('returning after a same-session refresh updates expiry, but a newer login epoch must be reverified', async () => {
  const s = setup(true);
  s.transport.reply(wireSession());
  await s.controller.checkSession();
  const refreshed = {
    ...wireCredentials('b'),
    expiresAt: wireCredentials().expiresAt + 60000,
  };
  s.sessions.rotate(s.sessions.snapshot(), refreshed);
  s.controller.syncSession();
  assert.equal(s.view().verified, true);
  assert.equal(s.view().expiresAt, new Date(refreshed.expiresAt).toISOString());
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('c'));
  s.controller.syncSession();
  assert.equal(s.view().verified, false);
  assert.equal(s.view().expiresAt, '');
});
