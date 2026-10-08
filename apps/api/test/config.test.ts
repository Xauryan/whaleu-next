import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config/config.js';

const local = {
  DATABASE_URL: 'postgresql://dev:test@127.0.0.1:55432/whaleu_dev',
  PG_SSL_MODE: 'disable',
};

test('valid local configuration has bounded defaults and is immutable', () => {
  const config = loadConfig(local);
  assert.equal(config.PORT, 3000);
  assert.equal(config.PG_POOL_MAX, 10);
  assert.equal(config.HTTP_HOST, '127.0.0.1');
  assert.equal(config.EXPERIENCE_PROCESSING, 'manual_only');
  assert.equal(config.SUBSCRIPTION_COMPONENT_PROCESSING, 'manual_only');
  assert.equal(config.LIKE_COMPONENT_PROCESSING, 'manual_only');
  assert.equal(config.COMMENT_COMPONENT_PROCESSING, 'manual_only');
  assert.equal(config.VIEW_REPORTING_RETENTION_PROCESSING, 'automatic');
  assert.equal(config.EXPERIENCE_INTERVAL_MS, 5000);
  assert.equal(config.EXPERIENCE_BATCH_SIZE, 20);
  assert.equal(Object.isFrozen(config), true);
});

test('remote connections use verified TLS by default', () => {
  assert.equal(
    loadConfig({ DATABASE_URL: 'postgresql://db.example.test/whaleu' })
      .PG_SSL_MODE,
    'verify-full',
  );
});

for (const input of [
  { PORT: '0' },
  { PORT: '65536' },
  { PG_POOL_MAX: '101' },
  { PG_CONNECTION_TIMEOUT_MS: 'NaN' },
  { PG_STATEMENT_TIMEOUT_MS: '0' },
  { LOG_LEVEL: 'trace' },
  { NODE_ENV: 'prod' },
  { EXPERIENCE_PROCESSING: 'always' },
  { SUBSCRIPTION_COMPONENT_PROCESSING: 'always' },
  { LIKE_COMPONENT_PROCESSING: 'always' },
  { COMMENT_COMPONENT_PROCESSING: 'always' },
  { VIEW_REPORTING_RETENTION_PROCESSING: 'always' },
  { EXPERIENCE_INTERVAL_MS: '0' },
  { EXPERIENCE_INTERVAL_MS: '60001' },
  { EXPERIENCE_BATCH_SIZE: '0' },
  { EXPERIENCE_BATCH_SIZE: '51' },
]) {
  test(`rejects invalid configuration ${Object.keys(input)[0]}`, () => {
    assert.throws(
      () => loadConfig({ ...local, ...input }),
      /Invalid configuration fields/,
    );
  });
}

test('configuration diagnostics never include secrets', () => {
  assert.throws(
    () => loadConfig({ ...local, PORT: 'secret-port-value' }),
    (error: Error) => {
      assert.ok(!error.message.includes('secret-port-value'));
      assert.ok(!error.message.includes(local.DATABASE_URL));
      return true;
    },
  );
});

test('rejects connection-string TLS overrides, missing databases, and non-Postgres URLs', () => {
  for (const DATABASE_URL of [
    `${local.DATABASE_URL}?sslmode=no-verify`,
    `${local.DATABASE_URL}#secret`,
    'postgresql://localhost/',
    'https://db.example.test/whaleu',
    'secret-invalid-url',
  ])
    assert.throws(() => loadConfig({ ...local, DATABASE_URL }), /DATABASE_URL/);
});

test('rejects unencrypted remote and production databases', () => {
  assert.throws(
    () =>
      loadConfig({
        ...local,
        DATABASE_URL: 'postgresql://remote.example.test/db',
      }),
    /Unencrypted/,
  );
  assert.throws(
    () => loadConfig({ ...local, NODE_ENV: 'production' }),
    /Production/,
  );
});
