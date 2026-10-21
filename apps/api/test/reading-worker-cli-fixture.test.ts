/** Pure test-helper contracts only. This file does not claim real CLI/PG success. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import {
  readingWorkerLoginUrl,
  createReadingWorkerLogin,
  readingLoginAuthMode,
  readingWorkerScramVerifier,
} from './support/reading-worker-login.js';
import {
  decodeReadingCliHealth,
  readingCliCommand,
  readingCliEnvironment,
} from './support/reading-worker-cli.js';

const name = 'reading_test_' + 'a'.repeat(32);
for (const host of ['127.0.0.1', 'localhost', '[::1]'])
  test(`direct LOGIN target is explicit disposable ${host} without inherited credential`, () => {
    const url = new URL(
      readingWorkerLoginUrl(
        `postgresql://original:synthetic-placeholder@${host}:5434/whaleu_test`,
        name,
      ),
    );
    assert.equal(url.username, name);
    assert.equal(url.password, '');
    assert.equal(url.pathname, '/whaleu_test');
    assert.equal(url.port, '5434');
  });
for (const url of [
  'postgresql://127.0.0.2/whaleu_test',
  'postgresql://192.0.2.1/whaleu_test',
  'postgresql://127.0.0.1/whaleu_prod',
  'postgresql://127.0.0.1/whaleu_test?sslmode=disable',
  'postgresql://127.0.0.1/whaleu_test#other',
  'https://127.0.0.1/whaleu_test',
])
  test(`disposable LOGIN URL refuses ${url}`, () => {
    assert.throws(() => readingWorkerLoginUrl(url, name));
  });
test('generated role name cannot inject identifiers', () => {
  for (const role of [
    'postgres',
    'reading_test_short',
    name + '; SELECT 1',
    name + '"',
  ])
    assert.throws(() =>
      readingWorkerLoginUrl('postgresql://127.0.0.1/whaleu_test', role),
    );
});
function fixture(ssl: boolean) {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql === 'SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')
        return { rows: [{ ssl }] };
      if (
        sql ===
        'SELECT current_database() database,host(inet_server_addr()) host'
      )
        return { rows: [{ database: 'whaleu_test', host: '127.0.0.1' }] };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  return { pool, queries };
}
test('LOGIN fixture reuses exact NOLOGIN grant construction, then enables only that generated role', async () => {
  const f = fixture(true),
    role = await createReadingWorkerLogin(
      f.pool,
      'postgresql://127.0.0.1/whaleu_test',
    );
  assert.equal(
    f.queries[2],
    `CREATE ROLE "${role.name}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`,
  );
  assert.ok(f.queries.slice(3, -1).every((q) => q.startsWith('GRANT ')));
  const password = new URL(role.database).password;
  assert.ok(
    /^[a-f0-9]{64}$/.test(password),
    'LOGIN receives only a fresh synthetic credential',
  );
  assert.ok(
    f.queries
      .at(-1)
      ?.startsWith(
        `ALTER ROLE "${role.name}" LOGIN PASSWORD 'SCRAM-SHA-256$4096:`,
      ),
  );
  assert.ok(
    f.queries.every((q) => !q.includes(password) && !q.includes('SET ROLE')),
    'No cleartext password or impersonated role query',
  );
  await role.close();
  assert.deepEqual(f.queries.slice(-2), [
    `DROP OWNED BY "${role.name}"`,
    `DROP ROLE "${role.name}"`,
  ]);
});
test('TLS refusal occurs before original role fixture or any mutation', async () => {
  const f = fixture(false);
  await assert.rejects(
    createReadingWorkerLogin(f.pool, 'postgresql://127.0.0.1/whaleu_test'),
  );
  assert.deepEqual(f.queries, [
    'SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()',
  ]);
});
test('CLI commands invoke real source and ordinary dist Node entries without shell/env-file', () => {
  const root = '/fixture/apps/api';
  assert.deepEqual(readingCliCommand(root, 'source', 'once'), {
    cwd: root,
    args: [
      '--import',
      'tsx',
      root + '/src/community/reading-formatting/process-reading.ts',
      'once',
    ],
  });
  assert.deepEqual(readingCliCommand(root, 'compiled', 'serve'), {
    cwd: root,
    args: [
      root + '/dist/community/reading-formatting/process-reading.js',
      'serve',
    ],
  });
  assert.throws(() => readingCliCommand('relative', 'source', 'once'));
});
test('CLI environment does not inherit providers, arbitrary loaders, credentials or disabled TLS', () => {
  for (const mode of ['once', 'serve'] as const) {
    const env = readingCliEnvironment(
      '/fixture/api',
      'postgresql://fixture@127.0.0.1/whaleu_test',
      mode,
      {
        NODE_OPTIONS: 'untrusted-loader',
        WECHAT_APP_SECRET: 'synthetic-not-a-key',
        DATABASE_URL: 'unrelated',
        PG_SSL_MODE: 'disable',
        NODE_EXTRA_CA_CERTS: '/fixture/ca.pem',
        PATH: '/fixture/bin',
      },
    );
    assert.equal(env['NODE_ENV'], 'production');
    assert.equal(env['PG_SSL_MODE'], 'verify-full');
    assert.equal(env['NODE_OPTIONS'], undefined);
    assert.equal(env['WECHAT_APP_SECRET'], undefined);
    assert.equal(env['NODE_EXTRA_CA_CERTS'], '/fixture/ca.pem');
    assert.equal(
      env['COMMUNITY_READING_FORMATTING_PROCESSING'],
      mode === 'serve' ? 'automatic' : 'manual_only',
    );
    assert.equal(env['VIEW_REPORTING_RETENTION_PROCESSING'], 'disabled');
  }
});
test('only bounded aggregate health is admitted; source, query, identity and credential fields reject', () => {
  const health = {
    worker: 'reading-formatting',
    state: 'sleeping',
    cycles: 1,
    ticks: 1,
  };
  assert.equal(Object.isFrozen(decodeReadingCliHealth(health)), true);
  for (const raw of [
    null,
    [],
    { ...health, text: 'source' },
    { ...health, database: 'url' },
    { ...health, token: 'secret' },
    { ...health, state: 'working' },
    { ...health, ticks: NaN },
    { ...health, ticks: -1 },
    { ...health, cycles: 1.5 },
    { ...health, worker: 'other' },
  ])
    assert.throws(() => decodeReadingCliHealth(raw));
});

test('auth lane must be explicit, with no unknown/missing downgrade', () => {
  assert.equal(readingLoginAuthMode('trust'), 'trust');
  assert.equal(readingLoginAuthMode('password'), 'password');
  for (const raw of [undefined, null, '', 'auto', 'scram', 'PASSWORD', true])
    assert.throws(() => readingLoginAuthMode(raw), /must explicitly/);
});
test('synthetic SCRAM verifier matches a fixed independently derived ASCII vector', () => {
  // Fixed non-secret test vector, independently calculated with Python hashlib/hmac.
  assert.equal(
    readingWorkerScramVerifier(
      'a'.repeat(64),
      Buffer.from(Array.from({ length: 16 }, (_, n) => n)),
    ),
    'SCRAM-SHA-256$4096:AAECAwQFBgcICQoLDA0ODw==$HdrLQKlGCF6BYVPVDo1W42SrzG2w7U3LkMEWU/Rhlxs=:hKfY4QZft7Vi1wQiz9MvToq8CBi2+Wb1+1VTNTnG3w8=',
  );
  for (const value of [
    '',
    'short',
    'a'.repeat(63),
    'z'.repeat(64),
    "'".repeat(64),
  ])
    assert.throws(() => readingWorkerScramVerifier(value, Buffer.alloc(16)));
  assert.throws(() =>
    readingWorkerScramVerifier('a'.repeat(64), Buffer.alloc(15)),
  );
});
test('LOGIN URL replaces rather than inherits the original admin credential', () => {
  const url = new URL(
    readingWorkerLoginUrl(
      'postgresql://admin:old@127.0.0.1/whaleu_test',
      name,
      'b'.repeat(64),
    ),
  );
  assert.ok(url.password === 'b'.repeat(64));
  assert.equal(url.username, name);
  assert.throws(() =>
    readingWorkerLoginUrl(
      'postgresql://127.0.0.1/whaleu_test',
      name,
      "bad'password",
    ),
  );
});
