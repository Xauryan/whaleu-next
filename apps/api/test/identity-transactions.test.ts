import { sessionEpochFixture } from './support/session-epoch-fixture.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { loadConfig } from '../src/config/config.js';
import type { DatabaseService } from '../src/database/database.js';
import { ApplicationError } from '../src/http/application-error.js';
import { IdentityRepository } from '../src/identity/identity.repository.js';
import { IdentityRateLimiter } from '../src/identity/rate-limit.js';

// Rejected refresh paths may read, lock, restore bounded timeouts and force
// deferred checks, but may not write replacement tokens. These are the exact
// ten short statements observed through the real0180 refresh/final-proof path.
// This is deliberately not a general SELECT, SQL-prefix or DML-regex classifier.
const reviewedRejectedRefreshSql = new Set([
  'SELECT clock_timestamp() AS now',
  "SELECT current_setting('transaction_isolation') isolation,current_setting('statement_timeout') statement_timeout,current_setting('lock_timeout') lock_timeout",
  'SELECT id FROM whaleu_identity.accounts WHERE id=$1 FOR SHARE',
  'SELECT id FROM whaleu_identity.sessions WHERE id=$1 AND account_id=$2 FOR UPDATE',
  'SELECT pg_try_advisory_xact_lock_shared($1, $2) AS locked',
  'SELECT s.*, a.status, a.lifecycle, a.session_revocation_epoch, r.consumed_at\n        FROM whaleu_identity.refresh_tokens r JOIN whaleu_identity.sessions s ON s.id=r.session_id\n        JOIN whaleu_identity.accounts a ON a.id=s.account_id WHERE r.token_hash=$1 AND s.id=$2 AND a.id=$3',
  'SELECT s.account_id,r.session_id FROM whaleu_identity.refresh_tokens r JOIN whaleu_identity.sessions s ON s.id=r.session_id WHERE r.token_hash=$1',
  "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
  'SELECT token_hash FROM whaleu_identity.refresh_tokens WHERE token_hash=$1 AND session_id=$2 FOR UPDATE',
  'SET CONSTRAINTS ALL IMMEDIATE',
]);
// Pin the complete read-only catalog CTE, not its comment or WITH prefix.
// Any source/whitespace change requires reviewing and repinning that exact SQL.
const reviewedEpochSchemaSqlSha256 =
  '10ca0e24a1ff4d49cc3bcc7b54eebb292ccda3b95aac500034b0da452a3854f0';
function assertRejectedRefreshReadOnly(statements: readonly string[]): void {
  for (const sql of statements)
    assert.ok(
      reviewedRejectedRefreshSql.has(sql) ||
        createHash('sha256').update(sql).digest('hex') ===
          reviewedEpochSchemaSqlSha256,
      'Unexpected SQL outside the rejected-refresh read/control allowlist',
    );
}

function fixture(
  query: (sql: string, values: unknown[]) => unknown[],
  afterLock?: (sql: string) => void,
) {
  const statements: string[] = [];
  let commits = 0;
  let rollbacks = 0;
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      statements.push(sql);
      const epoch = sessionEpochFixture(sql);
      if (epoch) return epoch;
      if (sql.startsWith('SELECT s.account_id,r.session_id'))
        return {
          rows: [{ account_id: row.account_id, session_id: row.id }],
          rowCount: 1,
        };
      if (
        sql ===
          'SELECT id FROM whaleu_identity.accounts WHERE id=$1 FOR SHARE' ||
        sql ===
          'SELECT id FROM whaleu_identity.sessions WHERE id=$1 AND account_id=$2 FOR UPDATE' ||
        sql ===
          'SELECT token_hash FROM whaleu_identity.refresh_tokens WHERE token_hash=$1 AND session_id=$2 FOR UPDATE'
      ) {
        afterLock?.(sql);
        return { rows: [], rowCount: 0 };
      }
      return { rows: query(sql, values), rowCount: 1 };
    },
  } as unknown as PoolClient;
  const database = {
    transaction: async <T>(operation: (client: PoolClient) => Promise<T>) => {
      try {
        startTransactionDeadlines(client);
        const result = await operation(client);
        await checkTransactionDeadlines(client);
        commits += 1;
        return result;
      } catch (error) {
        rollbacks += 1;
        throw error;
      } finally {
        clearTransactionDeadlines(client);
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
  lifecycle: 'active',
  access_expires_at: new Date(now.getTime() + 1000),
  refresh_expires_at: new Date(now.getTime() + 2000),
  absolute_expires_at: new Date(now.getTime() + 3000),
  revoked_at: null,
  issued_revocation_epoch: '0',
  session_revocation_epoch: '0',
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
    assertRejectedRefreshReadOnly(database.statements);
    assert.equal(database.commits(), 1);
  }
});

test('rejected-refresh no-write proof rejects disguised writes and unreviewed controls', async () => {
  const database = fixture((sql) =>
    sql.startsWith('SELECT s.*') ? [] : [{ now }],
  );
  await assert.rejects(
    new IdentityRepository(database.database).rotate('c'.repeat(64), hashes),
    { code: 'AUTHENTICATION_REQUIRED' },
  );
  assertRejectedRefreshReadOnly(database.statements);
  assert.equal(database.commits(), 1);
  const writes = [
    "INSERT INTO whaleu_identity.refresh_tokens(token_hash) VALUES ('unexpected')",
    'update whaleu_identity.refresh_tokens set consumed_at=clock_timestamp()',
    'delete from whaleu_identity.refresh_tokens',
    'truncate whaleu_identity.refresh_tokens',
    '/* read fence */ DELETE FROM whaleu_identity.refresh_tokens',
    "-- read fence\ninsert into whaleu_identity.refresh_tokens(token_hash) values ('unexpected')",
    'WITH changed AS (DELETE FROM whaleu_identity.refresh_tokens RETURNING token_hash) SELECT token_hash FROM changed',
    'with input as (select clock_timestamp() as now) update whaleu_identity.refresh_tokens set consumed_at=input.now from input',
    '/* identity-session-epoch-schema-v1 */ WITH changed AS (DELETE FROM whaleu_identity.refresh_tokens RETURNING token_hash) SELECT token_hash FROM changed',
    'EXPLAIN ANALYZE DELETE FROM whaleu_identity.refresh_tokens',
    'SELECT whaleu_identity.mutate_refresh_tokens()',
    "SELECT set_config('role',$1,true)",
    'SET CONSTRAINTS ALL DEFERRED',
    'WITH unreviewed AS (SELECT 1) SELECT * FROM unreviewed',
    // Every captured read/control, including the pinned catalog CTE, must reject
    // an appended write. Observed SQL is mutation input, never allowlist input.
    ...[...new Set(database.statements)].map(
      (sql) => `${sql};\ndelete from whaleu_identity.refresh_tokens`,
    ),
  ];
  for (const sql of writes)
    assert.throws(
      () => assertRejectedRefreshReadOnly([...database.statements, sql]),
      /outside the rejected-refresh read\/control allowlist/,
    );
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

test('refresh locks account then session then token and rechecks lifecycle after waits', async () => {
  const database = fixture((sql) => {
    if (sql.startsWith('SELECT s.*')) return [{ ...row, lifecycle: 'cooling' }];
    if (sql === 'SELECT clock_timestamp() AS now') return [{ now }];
    assert.fail('No credential writes are permitted after lifecycle fence');
  });
  await assert.rejects(
    new IdentityRepository(database.database).rotate('c'.repeat(64), hashes),
    (error) =>
      error instanceof ApplicationError && error.code === 'SESSION_REVOKED',
  );
  const account = database.statements.findIndex(
    (s) =>
      s === 'SELECT id FROM whaleu_identity.accounts WHERE id=$1 FOR SHARE',
  );
  const session = database.statements.findIndex((s) =>
    s.includes('sessions WHERE id=$1 AND account_id=$2 FOR UPDATE'),
  );
  const token = database.statements.findIndex((s) =>
    s.includes('token_hash=$1 AND session_id=$2 FOR UPDATE'),
  );
  const fresh = database.statements.findIndex((s) =>
    s.startsWith('SELECT s.*'),
  );
  assert.ok(
    account >= 0 && account < session && session < token && token < fresh,
  );
  assert.equal(
    database.statements.some(
      (s) => s.startsWith('INSERT') || s.startsWith('UPDATE'),
    ),
    false,
  );
});

test('refresh uses fresh lifecycle, revocation and actual time after simulated lock waits', async () => {
  for (const scenario of [
    {
      phase: 'accounts',
      patch: { lifecycle: 'cooling' },
      at: now,
      code: 'SESSION_REVOKED',
    },
    {
      phase: 'sessions',
      patch: { revoked_at: now },
      at: now,
      code: 'SESSION_REVOKED',
    },
    {
      phase: 'refresh_tokens',
      patch: {},
      at: row.absolute_expires_at,
      code: 'REFRESH_TOKEN_EXPIRED',
    },
  ]) {
    let fresh: Omit<typeof row, 'revoked_at'> & { revoked_at: Date | null } = {
        ...row,
      },
      clock = now,
      waited = false;
    const f = fixture(
      (sql) => {
        if (sql.startsWith('SELECT s.*')) {
          assert.ok(waited);
          return [fresh];
        }
        if (sql === 'SELECT clock_timestamp() AS now') return [{ now: clock }];
        assert.fail('Fresh negative authority must prevent every token write');
      },
      (sql) => {
        if (sql.includes(`whaleu_identity.${scenario.phase} WHERE`)) {
          waited = true;
          fresh = { ...fresh, ...scenario.patch };
          clock = scenario.at;
        }
      },
    );
    await assert.rejects(
      new IdentityRepository(f.database).rotate('c'.repeat(64), hashes),
      { code: scenario.code },
    );
    assert.equal(f.commits(), 1);
    assert.equal(f.rollbacks(), 0);
    assert.equal(
      f.statements.some((sql) => /^(INSERT|UPDATE)/.test(sql)),
      false,
    );
  }
});

test('refresh replay consumed while waiting is freshly reread and committed, never minted', async () => {
  let consumed: Date | null = null;
  const f = fixture(
    (sql) => {
      if (sql.startsWith('SELECT s.*'))
        return [{ ...row, consumed_at: consumed }];
      if (sql === 'SELECT clock_timestamp() AS now') return [{ now }];
      if (sql.startsWith('SELECT consumed_at')) {
        assert.equal(consumed, now);
        return [{ consumed_at: consumed }];
      }
      if (sql.startsWith('UPDATE whaleu_identity.sessions')) {
        assert.match(sql, /refresh_replay/);
        return [];
      }
      assert.fail('Replay must not write replacements');
    },
    (sql) => {
      if (sql.includes('refresh_tokens WHERE')) consumed = now;
    },
  );
  await assert.rejects(
    new IdentityRepository(f.database).rotate('c'.repeat(64), hashes),
    { code: 'REFRESH_TOKEN_REUSED' },
  );
  assert.equal(f.commits(), 1);
  assert.equal(f.rollbacks(), 0);
  assert.equal(
    f.statements.filter((sql) => sql.startsWith('UPDATE')).length,
    1,
  );
  assert.equal(
    f.statements.some((sql) => sql.startsWith('INSERT')),
    false,
  );
});
