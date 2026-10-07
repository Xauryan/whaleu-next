import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { loadConfig } from '../src/config/config.js';
import { DatabaseService } from '../src/database/database.js';
import { ApplicationError } from '../src/http/application-error.js';
import { configureHttp } from '../src/http/http.js';
import {
  IDENTITY_PROVIDER,
  loginRequestSchema,
  refreshRequestSchema,
} from '../src/identity/contracts.js';
import type {
  ProviderIdentity,
  SessionView,
} from '../src/identity/contracts.js';
import { IdentityRepository } from '../src/identity/identity.repository.js';
import { IdentityRateLimiter } from '../src/identity/rate-limit.js';
import { IdentityService } from '../src/identity/identity.service.js';
import {
  bearerToken,
  hashToken,
  mintToken,
  requireToken,
} from '../src/identity/tokens.js';
import { WechatIdentityProvider } from '../src/identity/wechat-provider.js';

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@127.0.0.1/whaleu_test',
  PG_SSL_MODE: 'disable',
  LOG_LEVEL: 'silent',
  WECHAT_APP_ID: 'wx0000000000000000',
  WECHAT_APP_SECRET: 'synthetic-provider-secret-for-unit-tests-only',
  AUTH_RATE_LIMIT_KEY: '01'.repeat(32),
});
const identity: ProviderIdentity = {
  provider: 'wechat',
  appId: config.WECHAT_APP_ID!,
  subject: 'synthetic-subject',
};
const session: SessionView = {
  accountId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  expiresAt: 1_800_000_000_000,
  refreshExpiresAt: 1_800_600_000_000,
};
const validProviderBody = {
  openid: identity.subject,
  unionid: 'synthetic-union',
  session_key: Buffer.alloc(16, 1).toString('base64'),
};

function transport(body: unknown, status = 200): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status });
}
function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ApplicationError && error.code === code;
}

test('opaque tokens have bounded distinct purposes, unique entropy and non-reversible database fingerprints', () => {
  const access = mintToken('access');
  const refresh = mintToken('refresh');
  assert.match(access, /^wu_a_[A-Za-z0-9_-]{43}$/);
  assert.match(refresh, /^wu_r_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(access, mintToken('access'));
  assert.match(hashToken(access), /^[a-f0-9]{64}$/);
  assert.equal(requireToken(access, 'access'), access);
  assert.equal(bearerToken(`Bearer ${access}`), access);
  for (const value of [
    refresh,
    '',
    null,
    ` ${access}`,
    `${access} `,
    access.repeat(100),
  ])
    assert.throws(
      () => requireToken(value, 'access'),
      hasCode('AUTHENTICATION_REQUIRED'),
    );
  for (const value of [
    access,
    `Basic ${access}`,
    `Bearer ${access}, Bearer ${access}`,
    [`Bearer ${access}`],
  ])
    assert.throws(() => bearerToken(value), hasCode('AUTHENTICATION_REQUIRED'));
  assert.throws(
    () => requireToken(access, 'refresh'),
    hasCode('AUTHENTICATION_REQUIRED'),
  );
});

test('auth schemas reject user-supplied identity, coercions, blanks and oversized payloads', () => {
  assert.equal(
    loginRequestSchema.safeParse({ code: 'synthetic-code' }).success,
    true,
  );
  for (const input of [
    { code: 123 },
    { code: ' ' },
    { code: 'x'.repeat(257) },
    { code: 'ok', accountId: 'victim' },
    { code: 'ok', openid: 'victim' },
  ])
    assert.equal(loginRequestSchema.safeParse(input).success, false);
  assert.equal(
    refreshRequestSchema.safeParse({ refreshToken: mintToken('refresh') })
      .success,
    true,
  );
  assert.equal(
    refreshRequestSchema.safeParse({ refreshToken: mintToken('access') })
      .success,
    false,
  );
});

test('auth configuration is all-or-none, has no key or provider default, rejects weak shapes without values', () => {
  const base = {
    DATABASE_URL: 'postgresql://test:test@127.0.0.1/whaleu_test',
    PG_SSL_MODE: 'disable',
  };
  assert.equal(loadConfig(base).AUTH_RATE_LIMIT_KEY, undefined);
  assert.throws(
    () => loadConfig({ ...base, WECHAT_APP_ID: config.WECHAT_APP_ID }),
    /configured together/,
  );
  assert.throws(
    () => loadConfig({ ...base, AUTH_RATE_LIMIT_KEY: 'short-private-key' }),
    (error: Error) =>
      !error.message.includes('short-private-key') &&
      error.message.includes('AUTH_RATE_LIMIT_KEY'),
  );
});

test('WeChat server exchange uses fixed HTTPS URL, strict bounds, timeout and no redirects; exposes no provider session key', async () => {
  let calls = 0;
  const provider = new WechatIdentityProvider(config, async (input, init) => {
    calls += 1;
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.weixin.qq.com');
    assert.equal(url.pathname, '/sns/jscode2session');
    assert.equal(url.searchParams.get('js_code'), 'synthetic-code');
    assert.equal(url.searchParams.get('grant_type'), 'authorization_code');
    assert.equal(url.searchParams.get('appid'), config.WECHAT_APP_ID);
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal instanceof AbortSignal);
    return new Response(JSON.stringify(validProviderBody));
  });
  assert.deepEqual(await provider.exchange('synthetic-code'), {
    ...identity,
    unionSubject: 'synthetic-union',
  });
  assert.equal(calls, 1);
  await assert.rejects(provider.exchange(' '), hasCode('LOGIN_REJECTED'));
  assert.equal(calls, 1);
});

for (const [label, body, expected] of [
  [
    'code rejected',
    { errcode: 40029, errmsg: 'private-details' },
    'LOGIN_REJECTED',
  ],
  ['code reused', { errcode: 40163 }, 'LOGIN_REJECTED'],
  ['provider throttled', { errcode: 45011 }, 'IDENTITY_PROVIDER_UNAVAILABLE'],
  [
    'missing subject',
    { session_key: validProviderBody.session_key },
    'IDENTITY_PROVIDER_UNAVAILABLE',
  ],
  [
    'missing session key',
    { openid: 'subject' },
    'IDENTITY_PROVIDER_UNAVAILABLE',
  ],
  [
    'wrong error type',
    { ...validProviderBody, errcode: '0' },
    'IDENTITY_PROVIDER_UNAVAILABLE',
  ],
  [
    'invalid subject',
    { ...validProviderBody, openid: ' ' },
    'IDENTITY_PROVIDER_UNAVAILABLE',
  ],
  [
    'invalid union',
    { ...validProviderBody, unionid: 1 },
    'IDENTITY_PROVIDER_UNAVAILABLE',
  ],
  [
    'invalid session key',
    { ...validProviderBody, session_key: 'short' },
    'IDENTITY_PROVIDER_UNAVAILABLE',
  ],
  [
    'oversized response',
    { openid: 'x'.repeat(9000) },
    'IDENTITY_PROVIDER_UNAVAILABLE',
  ],
] as const) {
  test(`WeChat fails closed: ${label}`, async () => {
    await assert.rejects(
      new WechatIdentityProvider(config, transport(body)).exchange('code'),
      hasCode(expected),
    );
  });
}

test('provider HTTP, network and malformed JSON failures are sanitized and never retried', async () => {
  for (const fetcher of [
    transport({}, 500),
    (async () => {
      throw new Error('private-url-with-secret');
    }) as typeof fetch,
    (async () => new Response('{bad-json-private-secret')) as typeof fetch,
  ]) {
    const provider = new WechatIdentityProvider(config, fetcher);
    await assert.rejects(
      provider.exchange('code'),
      (error: Error) =>
        hasCode('IDENTITY_PROVIDER_UNAVAILABLE')(error) &&
        !error.message.includes('private'),
    );
  }
});

test('unconfigured provider never makes a network request', async () => {
  const disabled = loadConfig({
    DATABASE_URL: config.DATABASE_URL,
    PG_SSL_MODE: 'disable',
  });
  await assert.rejects(
    new WechatIdentityProvider(disabled, async () => {
      assert.fail('must not call provider');
    }).exchange('code'),
    hasCode('AUTH_NOT_CONFIGURED'),
  );
});

let app: INestApplication;
let riskDenied = false;
let calls = 0;
let repositoryAction: { action: string; values: unknown[] } | undefined;
let applicationError: string | undefined;
before(async () => {
  const record = (action: string, ...values: unknown[]) => {
    repositoryAction = { action, values };
  };
  const module = await Test.createTestingModule({
    imports: [AppModule.register(config)],
  })
    .overrideProvider(DatabaseService)
    .useValue({ ready: async () => true })
    .overrideProvider(IDENTITY_PROVIDER)
    .useValue({
      exchange: async () => {
        calls += 1;
        if (applicationError) throw new ApplicationError('LOGIN_REJECTED');
        return identity;
      },
    })
    .overrideProvider(IdentityRateLimiter)
    .useValue({
      consume: async () => {
        if (riskDenied) throw new ApplicationError('RATE_LIMITED');
      },
    })
    .overrideProvider(IdentityRepository)
    .useValue({
      createSession: async (...values: unknown[]) => {
        record('login', ...values);
        return session;
      },
      rotate: async (...values: unknown[]) => {
        record('refresh', ...values);
        return session;
      },
      authenticate: async (...values: unknown[]) => {
        record('session', ...values);
        return session;
      },
      revoke: async (...values: unknown[]) => {
        record('logout', ...values);
      },
    })
    .compile();
  app = module.createNestApplication({ logger: false });
  configureHttp(app);
  await app.init();
});
after(async () => {
  await app?.close();
});

test('native login HTTP contract issues private credentials while persistence receives only hashes', async () => {
  const response = await request(app.getHttpServer())
    .post('/v1/auth/wechat/login')
    .send({ code: 'synthetic-code' })
    .expect(200);
  const body = response.body as { accessToken: string; refreshToken: string };
  assert.deepEqual(response.body, {
    ...session,
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
  });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(repositoryAction?.action, 'login');
  assert.deepEqual(repositoryAction?.values, [
    identity,
    {
      access: hashToken(body.accessToken),
      refresh: hashToken(body.refreshToken),
    },
  ]);
  assert.ok(!JSON.stringify(response.body).includes('subject'));
});

test('HTTP schema rejects claimed account identity and enforces token purposes before database access', async () => {
  const old = repositoryAction;
  await request(app.getHttpServer())
    .post('/v1/auth/wechat/login')
    .send({ code: 'code', accountId: 'victim' })
    .expect(400);
  await request(app.getHttpServer())
    .post('/v1/auth/refresh')
    .send({ refreshToken: mintToken('access') })
    .expect(400);
  await request(app.getHttpServer())
    .get('/v1/auth/session')
    .set('Authorization', `Bearer ${mintToken('refresh')}`)
    .expect(401);
  await request(app.getHttpServer()).get('/v1/auth/session').expect(401);
  await request(app.getHttpServer())
    .get(`/v1/auth/session?accessToken=${mintToken('access')}`)
    .expect(401);
  assert.equal(repositoryAction, old);
});

test('refresh/session/logout direct success shapes and bearer handling are stable', async () => {
  const token = mintToken('refresh');
  const response = await request(app.getHttpServer())
    .post('/v1/auth/refresh')
    .send({ refreshToken: token })
    .expect(200);
  assert.equal(repositoryAction?.action, 'refresh');
  assert.equal(repositoryAction?.values[0], hashToken(token));
  const access = (response.body as { accessToken: string }).accessToken;
  const current = await request(app.getHttpServer())
    .get('/v1/auth/session')
    .set('Authorization', `Bearer ${access}`)
    .expect(200);
  assert.deepEqual(current.body, session);
  assert.equal(repositoryAction?.values[0], hashToken(access));
  await request(app.getHttpServer())
    .post('/v1/auth/logout')
    .set('Authorization', `Bearer ${access}`)
    .expect(204);
  assert.equal(repositoryAction?.action, 'logout');
});

test('rate rejection happens before provider calls and errors share sanitized envelope', async () => {
  riskDenied = true;
  const before = calls;
  try {
    const response = await request(app.getHttpServer())
      .post('/v1/auth/wechat/login')
      .send({ code: 'synthetic-private-code' })
      .expect(429);
    assert.equal(
      (response.body as { error: { code: string } }).error.code,
      'RATE_LIMITED',
    );
    assert.equal(calls, before);
    assert.ok(
      !JSON.stringify(response.body).includes('synthetic-private-code'),
    );
  } finally {
    riskDenied = false;
  }
  applicationError = 'reject';
  try {
    await request(app.getHttpServer())
      .post('/v1/auth/wechat/login')
      .send({ code: 'code' })
      .expect(401);
  } finally {
    applicationError = undefined;
  }
});

test('service rejects cross-purpose tokens even outside HTTP', async () => {
  const service = app.get(IdentityService);
  await assert.rejects(
    service.refresh(mintToken('access')),
    hasCode('AUTHENTICATION_REQUIRED'),
  );
  assert.throws(
    () => service.session(mintToken('refresh')),
    hasCode('AUTHENTICATION_REQUIRED'),
  );
  assert.throws(
    () => service.logout(mintToken('refresh')),
    hasCode('AUTHENTICATION_REQUIRED'),
  );
});
