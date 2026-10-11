import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config/config.js';
import { WechatPhoneProvider } from '../src/verification/wechat-phone-provider.js';
const base = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@localhost:55432/whaleu_test',
  PG_SSL_MODE: 'disable',
};
const configured = {
  ...base,
  WECHAT_PHONE_BINDING: 'enabled',
  WECHAT_PHONE_PROOF_TTL_SECONDS: '3600',
  WECHAT_APP_ID: 'wx0000000000000000',
  WECHAT_APP_SECRET: 'synthetic-phone-provider-only-value',
  AUTH_RATE_LIMIT_KEY: '0'.repeat(64),
};
const now = 1_800_000_000_000;
const payload = () => ({
  errcode: 0,
  errmsg: 'ok',
  phone_info: {
    phoneNumber: '13123456789',
    purePhoneNumber: '13123456789',
    countryCode: 86,
    watermark: { timestamp: now / 1000, appid: configured.WECHAT_APP_ID },
  },
});
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200 });
test('phone and enrollment opt-ins default disabled and reject production; proof lifetime is explicit', () => {
  const defaults = loadConfig(base);
  assert.equal(defaults.WECHAT_PHONE_BINDING, 'disabled');
  assert.equal(defaults.NATIVE_VERIFICATION_ENROLLMENT, 'disabled');
  assert.throws(
    () => loadConfig({ ...configured, NODE_ENV: 'production' }),
    /non-production/,
  );
  assert.throws(
    () =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        NATIVE_VERIFICATION_ENROLLMENT: 'enabled',
      }),
    /non-production/,
  );
  assert.throws(
    () =>
      loadConfig({ ...configured, WECHAT_PHONE_PROOF_TTL_SECONDS: undefined }),
    /proof lifetime/,
  );
});
test('real adapter protocol uses fixed official destination, POST code, cached token, no value returned', async () => {
  const calls: { url: URL; options: RequestInit }[] = [];
  const provider = new WechatPhoneProvider(
    loadConfig(configured),
    (async (url, options) => {
      calls.push({ url: new URL(String(url)), options: options! });
      return json(
        calls.length === 1
          ? { access_token: 'synthetic-token', expires_in: 7200 }
          : payload(),
      );
    }) as typeof fetch,
    () => now,
  );
  assert.deepEqual(await provider.exchange('one-time-code'), {
    appId: configured.WECHAT_APP_ID,
    authorizedAt: now,
  });
  await provider.exchange('different-code');
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.url.origin, 'https://api.weixin.qq.com');
    assert.equal(call.options.redirect, 'error');
  }
  assert.equal(calls[0]!.url.pathname, '/cgi-bin/token');
  assert.equal(
    calls[0]!.url.searchParams.get('grant_type'),
    'client_credential',
  );
  assert.equal(calls[1]!.url.pathname, '/wxa/business/getuserphonenumber');
  assert.equal(calls[1]!.options.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[1]!.options.body)), {
    code: 'one-time-code',
  });
  assert.equal(
    calls[1]!.url.searchParams.get('access_token'),
    'synthetic-token',
  );
});
test('disabled adapter never contacts provider; malformed, wrong app, stale and error responses never verify or retry', async () => {
  let disabledCalls = 0;
  const disabled = new WechatPhoneProvider(loadConfig(base), (async () => {
    disabledCalls++;
    return json({});
  }) as typeof fetch);
  await assert.rejects(disabled.exchange('code'));
  assert.equal(disabledCalls, 0);
  for (const bad of [
    { errcode: 40029, errmsg: 'private-provider-detail' },
    {},
    {
      ...payload(),
      phone_info: {
        ...payload().phone_info,
        watermark: { timestamp: now / 1000, appid: 'another-app' },
      },
    },
    {
      ...payload(),
      phone_info: {
        ...payload().phone_info,
        watermark: {
          timestamp: now / 1000 - 301,
          appid: configured.WECHAT_APP_ID,
        },
      },
    },
    { ...payload(), phone_info: { ...payload().phone_info, phoneNumber: '' } },
  ]) {
    let calls = 0;
    const provider = new WechatPhoneProvider(
      loadConfig(configured),
      (async () => {
        calls++;
        return json(
          calls === 1
            ? { access_token: 'synthetic-token', expires_in: 7200 }
            : bad,
        );
      }) as typeof fetch,
      () => now,
    );
    await assert.rejects(
      provider.exchange('code'),
      (error: unknown) => !String(error).includes('private-provider-detail'),
    );
    assert.equal(calls, 2);
  }
});
