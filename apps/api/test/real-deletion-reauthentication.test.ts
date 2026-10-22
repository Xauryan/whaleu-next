import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config/config.js';
import { WechatIdentityProvider } from '../src/identity/wechat-provider.js';
import { ProviderIdentityDigests } from '../src/identity/registration/digests.js';
import {
  RequestProviderReauthentication,
  type VerifiedRequestProvider,
} from '../src/account-deletion/real/reauthentication.js';
import { ApplicationError } from '../src/http/application-error.js';
const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://127.0.0.1/whaleu_test',
  PG_SSL_MODE: 'disable',
  AUTH_RATE_LIMIT_KEY: '03'.repeat(32),
  WECHAT_APP_ID: 'wx0123456789abcdef',
  WECHAT_APP_SECRET: 'synthetic-local-adapter-test-only',
});
const scope = {
  purpose: 'acceptance' as const,
  attemptId: '10000000-0000-4000-8000-000000000001',
  requestId: '10000000-0000-4000-8000-000000000002',
  accountId: '10000000-0000-4000-8000-000000000003',
  generation: '1',
  appId: config.WECHAT_APP_ID!,
  subject: 'synthetic-local-native-subject',
};
const keys = new ProviderIdentityDigests({
  version: 1,
  activeEpoch: 'test-two',
  keys: [
    { epoch: 'test-one', keyHex: '01'.repeat(32) },
    { epoch: 'test-two', keyHex: '02'.repeat(32) },
  ],
});
const rejected = (e: unknown) =>
  e instanceof ApplicationError && e.code === 'REAL_DELETION_SCOPE_UNAVAILABLE';

test('existing WeChat adapter produces one request-bound proof, captures all retained HMAC epochs and never exposes provider session_key', async () => {
  let calls = 0;
  const provider = new WechatIdentityProvider(config, async (url, options) => {
    calls++;
    assert.equal(new URL(String(url)).origin, 'https://api.weixin.qq.com');
    assert.equal(options?.redirect, 'error');
    return new Response(
      JSON.stringify({
        openid: scope.subject,
        unionid: 'synthetic-local-union',
        session_key: Buffer.alloc(16).toString('base64'),
      }),
      { status: 200 },
    );
  });
  const exchange = new RequestProviderReauthentication(provider, keys);
  const proof = await exchange.exchange('local-provider-code', scope);
  assert.deepEqual(proof, {});
  const result = exchange.consume(proof, scope);
  assert.equal(result.identity.unionSubject, 'synthetic-local-union');
  assert(!('session_key' in result.identity));
  assert.equal(result.digests.length, 2);
  assert.notEqual(result.digests[0]!.digest, result.digests[1]!.digest);
  assert(!JSON.stringify(result.digests).includes(scope.subject));
  assert.throws(() => exchange.consume(proof, scope), rejected);
  assert.throws(
    () => exchange.consume({} as VerifiedRequestProvider, scope),
    rejected,
  );
  assert.equal(calls, 1);
});

test('fresh provider identity cannot transfer an attempt to another account, generation, request or app', async () => {
  const provider = new WechatIdentityProvider(
    config,
    async () =>
      new Response(
        JSON.stringify({
          openid: scope.subject,
          session_key: Buffer.alloc(16).toString('base64'),
        }),
        { status: 200 },
      ),
  );
  const exchange = new RequestProviderReauthentication(provider, keys);
  for (const field of [
    'attemptId',
    'requestId',
    'accountId',
    'generation',
    'appId',
    'subject',
  ] as const) {
    const proof = await exchange.exchange('local-code', scope);
    assert.throws(
      () =>
        exchange.consume(proof, {
          ...scope,
          [field]: scope[field] + 'changed',
        }),
      rejected,
    );
  }
  await assert.rejects(
    exchange.exchange('local-code', {
      ...scope,
      subject: 'not-the-verified-mapping',
    }),
    rejected,
  );
});
