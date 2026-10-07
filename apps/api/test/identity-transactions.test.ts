import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { loadConfig } from '../src/config/config.js';
import type { DatabaseService } from '../src/database/database.js';
import { ApplicationError } from '../src/http/application-error.js';
import { IdentityRepository } from '../src/identity/identity.repository.js';
import { IdentityRateLimiter } from '../src/identity/rate-limit.js';

function fixture(query: (sql: string, values: unknown[]) => unknown[]) {
  const statements: string[] = [];
  let commits = 0;
  let rollbacks = 0;
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      statements.push(sql);
      return { rows: query(sql, values), rowCount: 1 };
    },
  } as unknown as PoolClient;
  const database = {
    transaction: async <T>(operation: (client: PoolClient) => Promise<T>) => {
      try {
        const result = await operation(client);
        commits += 1;
        return result;
      } catch (error) {
        rollbacks += 1;
        throw error;
      }
    },
  } as unknown as DatabaseService;
  return {
    database,
    statements,
    commits: () => commits,
    rollbacks: () => rollbacks,
  };
}

const now = new Date('2026-01-01T00:00:00Z');
const row = {
  id: '22222222-2222-4222-8222-222222222222',
  account_id: '11111111-1111-4111-8111-111111111111',
  status: 'active',
  access_expires_at: new Date(now.getTime() + 1000),
  refresh_expires_at: new Date(now.getTime() + 2000),
  absolute_expires_at: new Date(now.getTime() + 3000),
  revoked_at: null,
  consumed_at: null,
};
const hashes = { access: 'a'.repeat(64), refresh: 'b'.repeat(64) };

test('replay revocation is committed before the public error is thrown', async () => {
  const database = fixture((sql, values) => {
    if (sql.startsWith('SELECT s.*')) return [row];
    if (sql === 'SELECT clock_timestamp() AS now') return [{ now }];
    if (sql.startsWith('SELECT consumed_at')) return [{ consumed_at: now }];
    if (sql.startsWith('UPDATE whaleu_identity.sessions')) {
      assert.match(sql, /refresh_replay/);
      assert.equal(values[0], row.id);
      return [];
    }
    assert.fail('Unexpected SQL');
  });
  await assert.rejects(
    new IdentityRepository(database.database).rotate('c'.repeat(64), hashes),
    (error) =>
      error instanceof ApplicationError &&
      error.code === 'REFRESH_TOKEN_REUSED',
  );
  assert.equal(database.commits(), 1);
  assert.equal(database.rollbacks(), 0);
  assert.equal(
    database.statements.some((sql) => sql.startsWith('INSERT')),
    false,
  );
});

test('failed replacement token insertion rolls back consumption and session updates', async () => {
  const database = fixture((sql) => {
    if (sql.startsWith('SELECT s.*')) return [row];
    if (sql === 'SELECT clock_timestamp() AS now') return [{ now }];
    if (sql.startsWith('SELECT consumed_at')) return [{ consumed_at: null }];
    if (sql.startsWith('INSERT')) throw new Error('synthetic storage failure');
    return [];
  });
  await assert.rejects(
    new IdentityRepository(database.database).rotate('c'.repeat(64), hashes),
    /synthetic storage failure/,
  );
  assert.equal(database.commits(), 0);
  assert.equal(database.rollbacks(), 1);
});

test('revoked, blocked, expired and unknown refresh states never write replacement tokens', async () => {
  for (const [input, code] of [
    [undefined, 'AUTHENTICATION_REQUIRED'],
    [{ ...row, revoked_at: now }, 'SESSION_REVOKED'],
    [{ ...row, status: 'blocked' }, 'ACCOUNT_BLOCKED'],
    [{ ...row, refresh_expires_at: now }, 'REFRESH_TOKEN_EXPIRED'],
  ] as const) {
    const database = fixture((sql) =>
      sql.startsWith('SELECT s.*') ? (input ? [input] : []) : [{ now }],
    );
    await assert.rejects(
      new IdentityRepository(database.database).rotate('c'.repeat(64), hashes),
      (error) => error instanceof ApplicationError && error.code === code,
    );
    assert.ok(database.statements.every((sql) => sql.startsWith('SELECT')));
    assert.equal(database.commits(), 1);
  }
});

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@127.0.0.1/whaleu_test',
  PG_SSL_MODE: 'disable',
  WECHAT_APP_ID: 'wx0000000000000000',
  WECHAT_APP_SECRET: 'synthetic-provider-secret-for-unit-tests-only',
  AUTH_RATE_LIMIT_KEY: '03'.repeat(32),
});

test('global risk denial commits its counter and never creates a per-address bucket', async () => {
  const database = fixture((sql, values) => {
    if (sql.startsWith('DELETE')) return [];
    assert.match(String(values[0]), /^[a-f0-9]{64}$/);
    assert.ok(!String(values[0]).includes('192.0.2.1'));
    return [{ hits: 301 }];
  });
  await assert.rejects(
    new IdentityRateLimiter(config, database.database).consume(
      'login',
      '192.0.2.1',
    ),
    (error) =>
      error instanceof ApplicationError && error.code === 'RATE_LIMITED',
  );
  assert.equal(database.commits(), 1);
  assert.equal(database.rollbacks(), 0);
  assert.equal(
    database.statements.filter((sql) => sql.startsWith('INSERT')).length,
    1,
  );
});

test('unconfigured risk control fails before touching PostgreSQL', async () => {
  const disabled = loadConfig({
    DATABASE_URL: config.DATABASE_URL,
    PG_SSL_MODE: 'disable',
  });
  const database = fixture(() => assert.fail('must not query'));
  await assert.rejects(
    new IdentityRateLimiter(disabled, database.database).consume(
      'login',
      '192.0.2.1',
    ),
    (error) =>
      error instanceof ApplicationError && error.code === 'AUTH_NOT_CONFIGURED',
  );
  assert.equal(database.commits(), 0);
});
