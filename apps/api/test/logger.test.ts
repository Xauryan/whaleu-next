import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogger } from '../src/observability/logger.js';

test('structured logging redacts credential fields and token headers', () => {
  let output = '';
  const logger = createLogger('info', {
    write: (line: string) => {
      output += line;
    },
  });
  logger.info({
    event: 'test',
    password: 'secret-password',
    DATABASE_URL: 'secret-db-url',
    WECHAT_APP_SECRET: 'secret-provider',
    AUTH_RATE_LIMIT_KEY: 'secret-risk-key',
    code: 'secret-code',
    session_key: 'secret-provider-session',
    openid: 'secret-provider-subject',
    unionid: 'secret-provider-union',
    credentials: {
      accessToken: 'secret-native-access',
      refreshToken: 'secret-native-refresh',
      access_token: 'secret-access',
      refresh_token: 'secret-refresh',
    },
    req: {
      headers: {
        authorization: 'secret-auth',
        cookie: 'secret-cookie',
        token: 'secret-token',
      },
    },
  });
  assert.ok(!output.includes('secret-'));
  assert.ok(output.includes('[REDACTED]'));
  assert.equal((JSON.parse(output) as { event: string }).event, 'test');
});
