/** Historical compatibility, not current epoch acceptance. The unit double
 * exercises genuine predecessor SQL through the REAL managed TX runner. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Test } from '@nestjs/testing';
import type { PoolClient } from 'pg';
import { loadConfig } from '../src/config/config.js';
import { DatabaseService, inTransaction } from '../src/database/database.js';
import type { TransactionOptions } from '../src/database/database.js';
import { MIGRATION_LOCK, readMigrations } from '../src/database/migrations.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
  transactionLifetime,
} from '../src/database/transaction-deadlines.js';
import { ApplicationError } from '../src/http/application-error.js';
import { IdentityRepository } from '../src/identity/identity.repository.js';
import { IdentityService } from '../src/identity/identity.service.js';
import { IDENTITY_PROVIDER } from '../src/identity/contracts.js';
import type { ProviderIdentity } from '../src/identity/contracts.js';
import { hashToken, mintToken } from '../src/identity/tokens.js';
import {
  configureHistoricalDeletionIdentity,
  historicalDeletionIdentity,
  historicalDeletionSchemaSql,
  isHistoricalDeletionIdentity,
} from './support/historical-lifecycle-identity/deletion.js';
const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://fixture@127.0.0.1/whaleu_test',
  PG_SSL_MODE: 'disable',
  LOG_LEVEL: 'silent',
});
const sha = (bytes: string | Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const migrations = await readMigrations(
  fileURLToPath(new URL('../migrations', import.meta.url)),
);
const expected = (prefix: number) =>
  migrations
    .filter(({ name }) => Number(name.slice(0, 4)) <= prefix)
    .map(({ name, checksum }) => ({ name, checksum }));
const code = (value: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === value;
const accountId = '10000000-0000-4000-8000-000000000001';
const sessionId = '20000000-0000-4000-8000-000000000002';
const tokens = { access: 'a'.repeat(64), refresh: 'b'.repeat(64) };
const synthetic = (
  appId = 'synthetic-account-deletion-rehearsal',
): ProviderIdentity => ({
  provider: 'wechat',
  appId,
  subject:
    (appId === 'synthetic-account-deletion-rehearsal'
      ? 'synthetic-'
      : appId === 'synthetic-nonfixture-follow-peer'
        ? 'generated-'
        : '') + randomUUID(),
});
// Local Git object provenance. SSH signature presence is not fresh signer trust.
const origin = Object.freeze({
  commit: '2f9f77260119664af3a06c488963153fdc12dab3',
  parent: 'f21bd371680c84849c92ac2360607f2084f2b56e',
  tree: '4ac8f485cd905d36e900bef15c19d491cd13d062',
  blob: 'b1104ba337eb15f290c9330cd307b523804a1938',
  sha256: '1d0b8d9f79bb95b0884baa26dcf7788ea028f6d8521be1d8282db9fe4dd8c446',
});
const dependencyHashes = Object.freeze({
  'account-deletion/synthetic-policy.ts':
    '34e580d24f2034b38744376a513ecee71934cc4de3bb798415d39cff260a5ff5',
  'config/config.ts':
    '7c5b02c13ba0ad5b689e239f47cb8952e908239babdde04bb1f2c2d86e3e2268',
  'database/database.ts':
    '3875dcf2d64561bd842aafb65c26787152078d721d1f18bce8f1bb0f9839c9cb',
  'database/required-owner-proof.ts':
    '19d0cde88006c02974beb6e8eab4b8d212234b2fbc637d0ae5c977a14ceb629e',
  'database/transaction-deadlines.ts':
    '284f2b448d005f9235059217e121efb858fffec3852fd29ef0bbd5ec1e924877',
  'experience/lifecycle.ts':
    '0aa94285ee9db28e7226cdf5fedaaa92db1ee20145e2c3375206b2aec09c6c24',
  'http/application-error.ts':
    'b8e891df9541f420b0739a79c804848b86ff5554c8977fbd6c8b2b0854050d84',
  'safety/lifecycle.ts':
    '98acf3893734501a3bf5149712d5747d40424c7f985d21ddfdab3b8e207e2630',
  'verification/lifecycle.ts':
    'de6ce03da54d320d4a83316025ef32f74b10352095c21e83e52b9502c129ce76',
  'identity/contracts.ts':
    '00b82fb9ae77f95730a02bb26fcd3e149e3d76596ea07a40c8217c1c8218d20b',
  'identity/processing-account-proof.ts':
    '7305e1cd5096c165494ec87c4b68a637c32eb6e4d5899d5cc321ec04a0606a00',
  'identity/title-maintenance.contract.ts':
    'ebae2aaa768d946c293cb8fcda51f9aa052ae11e146b7d51291f9f67470b7931',
});
test('full snapshot reverses ONLY import relocation to the pinned 2f9f Git blob and SHA-256', async () => {
  const snapshot = fileURLToPath(
    new URL('./support/historical-m1/identity.repository.ts', import.meta.url),
  );
  const original = fileURLToPath(
    new URL('../src/identity/identity.repository.ts', import.meta.url),
  );
  const bytes = await readFile(snapshot, 'utf8'),
    dependencies = new Set<string>();
  const restored = bytes.replace(
    /from '([^']+)'/g,
    (whole, specifier: string) => {
      if (!specifier.startsWith('.')) return whole;
      const target = path.resolve(path.dirname(snapshot), specifier);
      dependencies.add(
        path
          .relative(path.resolve(path.dirname(original), '..'), target)
          .replace(/\.js$/, '.ts')
          .split(path.sep)
          .join('/'),
      );
      const relative = path
        .relative(path.dirname(original), target)
        .split(path.sep)
        .join('/');
      return `from '${relative.startsWith('.') ? relative : './' + relative}'`;
    },
  );
  assert.equal(sha(restored), origin.sha256);
  assert.equal(
    createHash('sha1')
      .update(`blob ${Buffer.byteLength(restored)}\0`)
      .update(restored)
      .digest('hex'),
    origin.blob,
  );
  assert.deepEqual(
    [...dependencies].sort(),
    Object.keys(dependencyHashes).sort(),
  );
  for (const [file, digest] of Object.entries(dependencyHashes))
    assert.equal(
      sha(await readFile(new URL('../src/' + file, import.meta.url))),
      digest,
      `Review changed snapshot dependency ${file}`,
    );
  // Config is the only changed direct dependency; retain current config. The
  // original config blob hash was 59e88185c9d9dd8124f884e4bb6f221dcbfcd4b56b9e048b6e932620dbcc52ef.
  assert.deepEqual(
    [...restored.matchAll(/this\.config\??\.([A-Z_]+)/g)].map((m) => m[1]),
    ['NATIVE_VERIFICATION_ENROLLMENT'],
  );
  assert.equal(
    sha(
      await readFile(
        new URL(
          './integration/account-deletion-follow-social-races.test.ts',
          import.meta.url,
        ),
      ),
    ),
    '2b0d3d7ed84f5c111d407ad2bb254d1844960998d93aeccee43fcc3a3cfe8902',
  );
});
test('both exact ordered manifests remain the pinned predecessor migration files', () => {
  assert.equal(
    sha(JSON.stringify(expected(173))),
    'cc1605b4d8f9bffd3242e5efc370c1cd800d131500261a0c35b61d611dbd9fcf',
  );
  assert.equal(
    sha(JSON.stringify(expected(174))),
    'd24fa884cda400efd2de536dec24cbbd1d48e309711168783df2071866032a75',
  );
  assert.equal(expected(173).length, 173);
  assert.equal(expected(174).length, 174);
});

function fixture(prefix: 173 | 174 = 174) {
  const calls: { sql: string; values: unknown[] | undefined }[] = [],
    business: string[] = [],
    optionsSeen: TransactionOptions[] = [];
  const state = {
    ledger: expected(prefix),
    shape: {
      lifecycle_present: true,
      deletion_present: true,
      registration_absent: true,
      epoch_absent: true,
      source_absent: true,
      reading_absent: true,
      home_absent: true,
    },
    database: 'whaleu_test',
    isolation: 'read committed',
    locked: true,
    statementTimeout: '30s',
    lockTimeout: '4s',
    active: false,
    released: 0,
    found: true,
    existing: true,
    revoked: false,
    consumed: false,
    status: 'active',
    lifecycle: 'active',
    expiredAccess: false,
    expiredRefresh: false,
    expiredAbsolute: false,
    account: accountId,
    session: sessionId,
    afterBusiness: undefined as (() => void) | undefined,
    deferred: undefined as (() => void) | undefined,
    beforeCommit: undefined as (() => Promise<void>) | undefined,
    fail: undefined as ((sql: string) => Error | undefined) | undefined,
  };
  const instant = new Date('2026-10-22T00:00:00.000Z'),
    later = new Date('2100-01-01'),
    earlier = new Date('2020-01-01');
  const row = () => ({
    id: state.session,
    account_id: state.account,
    status: state.status,
    lifecycle: state.lifecycle,
    access_expires_at: later,
    refresh_expires_at: state.expiredRefresh ? earlier : later,
    absolute_expires_at: state.expiredAbsolute ? earlier : later,
    revoked_at: state.revoked ? earlier : null,
    consumed_at: state.consumed ? earlier : null,
    token_expires_at: state.expiredAccess ? earlier : later,
    now: instant,
  });
  const response = (rows: unknown[] = []) => ({ rows, rowCount: rows.length });
  const tx = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      if (sql.startsWith('BEGIN')) {
        assert.equal(state.active, false);
        state.active = true;
        return response();
      }
      assert.ok(state.active, 'all checks/use share one live client');
      const failure = state.fail?.(sql);
      if (failure) throw failure;
      if (sql === 'COMMIT') {
        await state.beforeCommit?.();
        return response();
      }
      if (
        sql === 'ROLLBACK' ||
        sql.startsWith('SAVEPOINT ') ||
        sql.startsWith('ROLLBACK TO SAVEPOINT ')
      )
        return response();
      if (sql === 'SET CONSTRAINTS ALL IMMEDIATE') {
        state.deferred?.();
        return response();
      }
      if (sql.startsWith("SELECT current_setting('transaction_isolation')"))
        return response([
          {
            isolation: state.isolation,
            statement_timeout: state.statementTimeout,
            lock_timeout: state.lockTimeout,
          },
        ]);
      if (sql.startsWith("SELECT set_config('statement_timeout'"))
        return response();
      if (sql === 'SELECT current_database() AS database')
        return response([{ database: state.database }]);
      if (sql.startsWith('SELECT pg_try_advisory_xact_lock_shared')) {
        assert.deepEqual(values, [...MIGRATION_LOCK]);
        return response([{ locked: state.locked }]);
      }
      if (sql.startsWith('LOCK TABLE')) return response();
      if (sql.startsWith('SELECT name,checksum')) {
        assert.deepEqual(values, [expected(prefix).length + 1]);
        return response(state.ledger);
      }
      if (sql === historicalDeletionSchemaSql) return response([state.shape]);
      if (
        sql === 'SELECT clock_timestamp() AS now' ||
        sql.includes("date_trunc('milliseconds'")
      )
        return response([{ now: instant }]);
      business.push(sql);
      state.afterBusiness?.();
      if (sql.startsWith('SELECT pg_advisory_xact_lock(')) return response();
      if (
        sql.startsWith(
          'SELECT account_id FROM whaleu_identity.provider_identities',
        )
      )
        return response(state.existing ? [{ account_id: state.account }] : []);
      if (
        sql.startsWith('SELECT status,lifecycle FROM whaleu_identity.accounts')
      )
        return response([{ status: state.status, lifecycle: state.lifecycle }]);
      if (sql.startsWith('SELECT status FROM whaleu_identity.accounts'))
        return response(
          state.lifecycle === 'active' ? [{ status: state.status }] : [],
        );
      if (sql.startsWith('SELECT status,lifecycle,xmin'))
        return response(
          state.found
            ? [
                {
                  status: state.status,
                  lifecycle: state.lifecycle,
                  state_version: '1',
                },
              ]
            : [],
        );
      if (sql.startsWith('SELECT id,status,lifecycle,lifecycle_generation'))
        return response(
          state.found
            ? [
                {
                  id: state.account,
                  status: state.status,
                  lifecycle: state.lifecycle,
                  lifecycle_generation: '0',
                  xmin: '1',
                },
              ]
            : [],
        );
      if (sql.startsWith('SELECT s.account_id,'))
        return response(
          state.found
            ? [{ account_id: state.account, session_id: state.session }]
            : [],
        );
      if (sql.startsWith('SELECT s.*'))
        return response(state.found ? [row()] : []);
      if (sql.startsWith('SELECT consumed_at'))
        return response(
          state.found ? [{ consumed_at: state.consumed ? earlier : null }] : [],
        );
      if (sql.startsWith('SELECT app_id, subject'))
        return response([
          { app_id: 'synthetic-runtime-only', subject: state.account },
        ]);
      if (
        sql.startsWith(
          'SELECT EXISTS (SELECT 1 FROM whaleu_identity.provider_identities',
        )
      )
        return response([{ eligible: true }]);
      if (sql.startsWith('SELECT 1 FROM whaleu_identity.provider_identities'))
        return response([{ exists: 1 }]);
      if (
        sql.startsWith('SELECT id FROM whaleu_identity.') ||
        sql.startsWith('SELECT token_hash FROM whaleu_identity.')
      )
        return response(state.found ? [{ id: state.account }] : []);
      if (sql.startsWith('INSERT INTO whaleu_identity.accounts')) {
        state.account = values![0] as string;
        return response();
      }
      if (sql.startsWith('INSERT INTO whaleu_identity.sessions')) {
        state.session = values![0] as string;
        return response([row()]);
      }
      if (
        sql.startsWith('UPDATE whaleu_identity.sessions') &&
        sql.includes("revoke_reason='refresh_replay'")
      ) {
        state.revoked = true;
        return response();
      }
      if (sql.startsWith('UPDATE whaleu_identity.sessions s')) {
        if (state.found) state.revoked = true;
        return response(state.found ? [{ id: state.session }] : []);
      }
      if (
        /^(INSERT INTO|UPDATE) whaleu_(identity|experience|safety|verification)\./.test(
          sql,
        )
      )
        return response();
      assert.fail('Unexpected predecessor SQL: ' + sql);
    },
    release: () => {
      assert.ok(state.active);
      state.active = false;
      state.released++;
    },
  } as unknown as PoolClient;
  const pool = { connect: async () => tx };
  const transaction = <T>(
    work: (client: PoolClient) => Promise<T>,
    options: TransactionOptions = { isolationLevel: 'read committed' },
  ) => {
    optionsSeen.push(options);
    return inTransaction(pool, work, options);
  };
  const database = {
    transaction,
    query: async () => assert.fail('pool query forbidden'),
  } as unknown as DatabaseService;
  return { state, calls, business, optionsSeen, tx, transaction, database };
}
for (const prefix of [173, 174] as const)
  test(`only explicit disposable test config constructs ${prefix}, without DB precheck`, async () => {
    const f = fixture(prefix);
    for (const invalid of [
      { ...config, NODE_ENV: 'production' as const },
      { ...config, NODE_ENV: 'development' as const },
      { ...config, DATABASE_URL: 'postgres://fixture@example.org/whaleu_test' },
      { ...config, DATABASE_URL: 'postgres://fixture@127.0.0.1/other' },
      { ...config, PG_SSL_MODE: 'verify-full' as const },
      ...['sslmode=require', 'ssl=true', 'SSLMODE=disable', 'sslcert=x'].map(
        (q) => ({ ...config, DATABASE_URL: config.DATABASE_URL + '?' + q }),
      ),
    ])
      await assert.rejects(
        historicalDeletionIdentity(f.database, invalid, prefix),
      );
    for (const invalid of [
      0,
      172,
      175,
      176,
      178,
      179,
      180,
      999,
      NaN,
      173.5,
      '174',
      undefined,
    ])
      await assert.rejects(
        historicalDeletionIdentity(f.database, config, invalid as 173),
      );
    assert.ok(
      isHistoricalDeletionIdentity(
        await historicalDeletionIdentity(f.database, config, prefix),
      ),
    );
    assert.equal(f.calls.length, 0);
  });
test('closed surface exposes neither predecessor, private methods, mutable prefix nor query passthrough', async () => {
  const owner = await historicalDeletionIdentity(
    fixture().database,
    config,
    174,
  );
  assert.ok(Object.isFrozen(owner));
  assert.equal(Object.getPrototypeOf(owner), null);
  assert.deepEqual(
    Object.keys(owner).sort(),
    [
      'dmActiveAccount',
      'processingAccountState',
      'activeAccount',
      'beginTitleMaintenanceSweep',
      'titleMaintenanceCandidateWindow',
      'lockTitleMaintenanceAccount',
      'canonicalWechatTitleEligibility',
      'wechatAppAccount',
      'authenticate',
      'createSession',
      'rotate',
      'revoke',
    ].sort(),
  );
  for (const key of [
    'insertTokens',
    'database',
    'config',
    'constructor',
    'query',
    'prefix',
    'then',
    'unknownMethod',
  ])
    assert.equal(Reflect.get(owner, key), undefined);
});
test('same client BEGIN → first boundary → genuine SQL → retained fact → deferred waits/full final proof → COMMIT', async () => {
  const f = fixture(),
    owner = await historicalDeletionIdentity(f.database, config, 174);
  await f.transaction(async (tx) =>
    assert.equal(await owner.activeAccount(accountId, tx), true),
  );
  const sql = f.calls.map((c) => c.sql),
    use = sql.findIndex((s) => s.startsWith('SELECT status FROM')),
    shapes = sql
      .map((s, i) => (s === historicalDeletionSchemaSql ? i : -1))
      .filter((i) => i >= 0),
    deferred = sql.indexOf('SET CONSTRAINTS ALL IMMEDIATE');
  assert.equal(sql[0], 'BEGIN ISOLATION LEVEL READ COMMITTED');
  assert.equal(shapes.length, 2);
  assert.ok(shapes[0]! < use && use < deferred && deferred < shapes[1]!);
  assert.equal(sql.at(-1), 'COMMIT');
  assert.equal(
    sql.filter((s) => s.startsWith('SELECT pg_try_advisory_xact_lock_shared'))
      .length,
    2,
  );
  assert.ok(
    sql.includes(
      'LOCK TABLE whaleu_identity.accounts, whaleu_identity.sessions IN ACCESS SHARE MODE NOWAIT',
    ),
  );
  assert.ok(
    sql.includes(
      'LOCK TABLE whaleu_meta.schema_migrations IN SHARE MODE NOWAIT',
    ),
  );
  assert.equal(transactionLifetime(f.tx), undefined);
  assert.equal(f.state.released, 1);
  assert.deepEqual(
    f.calls
      .filter((c) => c.sql.startsWith("SELECT set_config('statement_timeout'"))
      .at(-1)?.values,
    ['30s', '4s'],
  );
});
test('standalone authentication keeps genuine account/session/token lock order in one managed transaction', async () => {
  const f = fixture(),
    owner = await historicalDeletionIdentity(f.database, config, 174);
  assert.equal((await owner.authenticate(tokens.access)).accountId, accountId);
  assert.deepEqual(f.optionsSeen, [{ isolationLevel: 'read committed' }]);
  const a = f.business.findIndex((s) =>
      s.startsWith('SELECT id FROM whaleu_identity.accounts'),
    ),
    s = f.business.findIndex((q) =>
      q.startsWith('SELECT id FROM whaleu_identity.sessions'),
    ),
    t = f.business.findIndex(
      (q) => q.startsWith('SELECT s.*') && q.endsWith('FOR SHARE OF t'),
    );
  assert.ok(a >= 0 && a < s && s < t);
  assert.equal(f.calls.at(-1)?.sql, 'COMMIT');
});
test('success awaits actual COMMIT; commit failure rolls back and cleans registries', async () => {
  const f = fixture(),
    owner = await historicalDeletionIdentity(f.database, config, 174);
  let entered!: () => void,
    release!: () => void,
    resolved = false;
  const atCommit = new Promise<void>((r) => {
      entered = r;
    }),
    hold = new Promise<void>((r) => {
      release = r;
    });
  f.state.beforeCommit = async () => {
    entered();
    await hold;
  };
  const result = owner.authenticate(tokens.access).then(() => {
    resolved = true;
  });
  await atCommit;
  assert.equal(resolved, false);
  release();
  await result;
  assert.equal(resolved, true);
  f.state.beforeCommit = async () => {
    throw new Error('commit failed');
  };
  await assert.rejects(owner.authenticate(tokens.access), /commit failed/);
  assert.equal(f.calls.at(-1)?.sql, 'ROLLBACK');
  assert.equal(transactionLifetime(f.tx), undefined);
  assert.equal(f.state.released, 2);
});
test('all explicit transaction argument positions including processingAccountState reject unmanaged/wrong clients', async () => {
  const f = fixture(),
    owner = await historicalDeletionIdentity(f.database, config, 174);
  const cases: [string, unknown[], number][] = [
    ['dmActiveAccount', [accountId], 1],
    ['processingAccountState', [[accountId]], 1],
    ['activeAccount', [accountId], 1],
    ['beginTitleMaintenanceSweep', [], 0],
    [
      'titleMaintenanceCandidateWindow',
      [
        {
          runStartedAt: new Date(),
          upperAccountId: accountId,
          cursorAccountId: null,
        },
      ],
      1,
    ],
    ['lockTitleMaintenanceAccount', [accountId], 1],
    ['canonicalWechatTitleEligibility', [accountId], 1],
    ['wechatAppAccount', [accountId, 'synthetic-runtime-only'], 2],
    ['authenticate', [tokens.access], 1],
  ];
  for (const [name, args, index] of cases) {
    const method = Reflect.get(owner, name) as (
        ...args: unknown[]
      ) => Promise<unknown>,
      before = f.business.length;
    await f.transaction(async (tx) => {
      const actual = [...args];
      actual[index] = tx;
      await Reflect.apply(method, owner, actual);
    });
    assert.ok(f.business.length > before, name);
    for (const wrong of [undefined, null, {}, f.tx, new Proxy(f.tx, {})]) {
      if (name === 'authenticate' && wrong === undefined) continue;
      const actual = [...args];
      actual[index] = wrong;
      await assert.rejects(
        Reflect.apply(method, owner, actual),
        code('AUTH_NOT_CONFIGURED'),
      );
    }
  }
});
for (const drift of [
  'missing',
  'extra',
  'reordered',
  'checksum',
  'upgrade',
] as const)
  test(`ledger ${drift} rejects before business use and never caches acceptance`, async () => {
    const f = fixture(173),
      owner = await historicalDeletionIdentity(f.database, config, 173);
    await owner.authenticate(tokens.access);
    const before = f.business.length;
    f.state.ledger =
      drift === 'missing'
        ? expected(173).slice(1)
        : drift === 'extra'
          ? [
              ...expected(173),
              { name: '0173_unknown.sql', checksum: 'a'.repeat(64) },
            ]
          : drift === 'reordered'
            ? expected(173).reverse()
            : drift === 'upgrade'
              ? expected(174)
              : expected(173).map((r, i) =>
                  i === 2 ? { ...r, checksum: '0'.repeat(64) } : r,
                );
    await assert.rejects(
      owner.authenticate(tokens.access),
      code('AUTH_NOT_CONFIGURED'),
    );
    assert.equal(f.business.length, before);
    assert.equal(f.calls.at(-1)?.sql, 'ROLLBACK');
    assert.equal(transactionLifetime(f.tx), undefined);
  });
for (const family of [
  'lifecycle_present',
  'deletion_present',
  'registration_absent',
  'epoch_absent',
  'source_absent',
  'reading_absent',
  'home_absent',
] as const)
  test(`partial/missing ${family} fails even with unchanged ledger`, async () => {
    const f = fixture(),
      owner = await historicalDeletionIdentity(f.database, config, 174);
    f.state.shape[family] = false;
    await assert.rejects(
      owner.authenticate(tokens.access),
      code('AUTH_NOT_CONFIGURED'),
    );
    assert.deepEqual(f.business, []);
  });
test('partial-install sentinel includes every object family and non-Community Reading triggers', () => {
  for (const name of [
    'pg_class',
    'pg_proc',
    'pg_trigger',
    'pg_type',
    'pg_constraint',
    'pg_attribute',
    'session_revocation_epoch',
    'issued_revocation_epoch',
    'registration_guard',
    'session_epoch_',
    'community_text_sources',
    'text_source_',
    'profile_moderation_definition_pre_text_source',
    'profile_moderation_definition_pre_home',
    'reading_',
    'home_',
  ])
    assert.ok(historicalDeletionSchemaSql.includes(name));
  assert.match(
    historicalDeletionSchemaSql,
    /SELECT oid FROM pg_namespace WHERE starts_with\(nspname,'whaleu_'\)/,
  );
  assert.doesNotMatch(
    historicalDeletionSchemaSql,
    /nspname='whaleu_community'/,
  );
});
for (const boundary of [
  'database',
  'isolation',
  'migration-lock',
  'account-DDL',
  'ledger-DDL',
  'catalog-timeout',
] as const)
  test(`${boundary} fails closed without executing business SQL`, async () => {
    const f = fixture(),
      owner = await historicalDeletionIdentity(f.database, config, 174);
    if (boundary === 'database') f.state.database = 'other';
    else if (boundary === 'isolation') f.state.isolation = 'repeatable read';
    else if (boundary === 'migration-lock') f.state.locked = false;
    else
      f.state.fail = (sql) =>
        (boundary === 'account-DDL' &&
          sql.startsWith('LOCK TABLE whaleu_identity.')) ||
        (boundary === 'ledger-DDL' &&
          sql.startsWith('LOCK TABLE whaleu_meta.')) ||
        (boundary === 'catalog-timeout' && sql === historicalDeletionSchemaSql)
          ? new Error('lock/statement timeout')
          : undefined;
    await assert.rejects(
      owner.authenticate(tokens.access),
      code('AUTH_NOT_CONFIGURED'),
    );
    assert.deepEqual(f.business, []);
    assert.equal(f.calls.at(-1)?.sql, 'ROLLBACK');
  });
test('bounded inspection preserves tighter caller timeouts', async () => {
  const f = fixture(),
    owner = await historicalDeletionIdentity(f.database, config, 174);
  f.state.statementTimeout = '2ms';
  f.state.lockTimeout = '0.5ms';
  await owner.authenticate(tokens.access);
  for (const c of f.calls.filter((c) =>
    c.sql.startsWith("SELECT set_config('statement_timeout'"),
  ))
    assert.deepEqual(c.values, ['2ms', '0.5ms']);
});
for (const when of ['after-business', 'after-method', 'deferred-wait'] as const)
  test(`schema drift ${when} rolls back through post-use/final proof`, async () => {
    const f = fixture(),
      owner = await historicalDeletionIdentity(f.database, config, 174),
      drift = () => {
        f.state.ledger = expected(175);
      };
    if (when === 'after-business') f.state.afterBusiness = drift;
    if (when === 'deferred-wait') f.state.deferred = drift;
    await assert.rejects(
      f.transaction(async (tx) => {
        await owner.activeAccount(accountId, tx);
        if (when === 'after-method') drift();
      }),
      code('AUTH_NOT_CONFIGURED'),
    );
    assert.ok(f.business.length > 0);
    assert.equal(f.calls.at(-1)?.sql, 'ROLLBACK');
    assert.equal(transactionLifetime(f.tx), undefined);
  });
test('retained proof re-fences after savepoint rollback and rejects final drift', async () => {
  const f = fixture(),
    owner = await historicalDeletionIdentity(f.database, config, 174);
  await assert.rejects(
    f.transaction(async (tx) => {
      await owner.activeAccount(accountId, tx);
      const checkpoint = checkpointTransactionDeadlines(tx);
      await tx.query('SAVEPOINT optional_work');
      await owner.activeAccount(accountId, tx);
      await tx.query('ROLLBACK TO SAVEPOINT optional_work');
      restoreTransactionDeadlines(tx, checkpoint);
      f.state.shape.reading_absent = false;
    }),
    code('AUTH_NOT_CONFIGURED'),
  );
  const sql = f.calls.map((c) => c.sql);
  assert.ok(
    sql.lastIndexOf(
      'SELECT pg_try_advisory_xact_lock_shared($1,$2) AS locked',
    ) > sql.indexOf('ROLLBACK TO SAVEPOINT optional_work'),
  );
  assert.equal(sql.at(-1), 'ROLLBACK');
});
test('proof facts deduplicate repeated calls and re-register after checkpoint pruning', async () => {
  const f = fixture(),
    owner = await historicalDeletionIdentity(f.database, config, 174);
  await f.transaction(async (tx) => {
    const checkpoint = checkpointTransactionDeadlines(tx);
    await tx.query('SAVEPOINT optional_work');
    await owner.activeAccount(accountId, tx);
    await tx.query('ROLLBACK TO SAVEPOINT optional_work');
    restoreTransactionDeadlines(tx, checkpoint);
    for (let i = 0; i < 4; i++) await owner.activeAccount(accountId, tx);
  });
  const sql = f.calls.map((c) => c.sql);
  assert.equal(
    sql
      .slice(sql.indexOf('SET CONSTRAINTS ALL IMMEDIATE'))
      .filter((s) => s === historicalDeletionSchemaSql).length,
    1,
  );
});
for (const app of [
  'synthetic-account-deletion-rehearsal',
  'synthetic-nonfixture-follow-peer',
  'synthetic-runtime-only',
])
  test(`synthetic ${app} preserves actual sessions and native creation, never peer deletion admission`, async () => {
    const f = fixture(),
      owner = await historicalDeletionIdentity(f.database, config, 174);
    f.state.existing = app === 'synthetic-account-deletion-rehearsal';
    assert.equal(
      (await owner.createSession(synthetic(app), tokens)).accountId,
      f.state.account,
    );
    for (const table of ['sessions', 'access_tokens', 'refresh_tokens'])
      assert.ok(
        f.business.some((s) =>
          s.startsWith('INSERT INTO whaleu_identity.' + table),
        ),
      );
    assert.ok(
      f.business.some((s) => s.includes("revoke_reason='session_limit'")),
    );
    assert.equal(
      f.business.some((s) =>
        s.startsWith('INSERT INTO whaleu_experience.owners'),
      ),
      app !== 'synthetic-account-deletion-rehearsal',
    );
    assert.equal(
      f.business.some((s) =>
        s.startsWith('INSERT INTO whaleu_safety.account_heads'),
      ),
      app !== 'synthetic-account-deletion-rehearsal',
    );
    assert.ok(!f.business.some((s) => s.includes('fixture_accounts')));
    assert.equal(f.calls.at(-1)?.sql, 'COMMIT');
  });
test('reserved-app first registration is rejected by genuine predecessor business checks', async () => {
  const f = fixture(),
    owner = await historicalDeletionIdentity(f.database, config, 174);
  f.state.existing = false;
  await assert.rejects(
    owner.createSession(synthetic(), tokens),
    code('AUTHENTICATION_REQUIRED'),
  );
  assert.ok(f.business.some((s) => s.startsWith('SELECT account_id FROM')));
  assert.ok(!f.business.some((s) => s.startsWith('INSERT')));
  assert.equal(f.calls.at(-1)?.sql, 'ROLLBACK');
});
test('strict namespace rejects real apps/providers, malformed subjects and union identifiers before SQL', async () => {
  const f = fixture(),
    owner = await historicalDeletionIdentity(f.database, config, 174),
    valid = synthetic();
  for (const invalid of [
    { ...valid, provider: 'other' },
    { ...valid, appId: 'real-app' },
    { ...valid, appId: '__proto__' },
    { ...valid, subject: 'real-user' },
    { ...valid, subject: randomUUID() },
    { ...valid, subject: 'synthetic-' + randomUUID() + '\n' },
    {
      ...synthetic('synthetic-runtime-only'),
      subject: 'generated-' + randomUUID(),
    },
    { ...synthetic('synthetic-nonfixture-follow-peer'), subject: randomUUID() },
    { ...valid, unionSubject: 'real-union-subject' },
    { ...valid, extra: true },
    null,
  ])
    await assert.rejects(
      owner.createSession(invalid as ProviderIdentity, tokens),
      code('AUTH_NOT_CONFIGURED'),
    );
  assert.equal(f.calls.length, 0);
});
test('all three synthetic namespaces reject trailing line terminators and data before any SQL', async () => {
  const f = fixture(),
    owner = await historicalDeletionIdentity(f.database, config, 174);
  for (const app of [
    'synthetic-account-deletion-rehearsal',
    'synthetic-nonfixture-follow-peer',
    'synthetic-runtime-only',
  ]) {
    const identity = synthetic(app);
    for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029', ' ', 'x']) {
      await assert.rejects(
        owner.createSession(
          { ...identity, subject: identity.subject + suffix },
          tokens,
        ),
        code('AUTH_NOT_CONFIGURED'),
      );
    }
  }
  assert.equal(f.calls.length, 0);
});
test('synthetic identity descriptors reject inherited, hidden, symbol and accessor input without evaluating getters', async () => {
  const f = fixture(),
    owner = await historicalDeletionIdentity(f.database, config, 174);
  let getterCalls = 0;
  const inherited = Object.assign(
    Object.create({ unionSubject: 'not-allowed' }),
    synthetic('synthetic-runtime-only'),
  );
  const hiddenExtra = Object.defineProperty(
    synthetic('synthetic-runtime-only'),
    'unionSubject',
    { value: 'not-allowed' },
  );
  const hiddenSubject = Object.defineProperty(
    synthetic('synthetic-runtime-only'),
    'subject',
    { enumerable: false },
  );
  const symbolExtra = Object.assign(synthetic('synthetic-runtime-only'), {
    [Symbol('extra')]: 'not-allowed',
  });
  const accessor = Object.defineProperty(
    synthetic('synthetic-runtime-only'),
    'subject',
    {
      get() {
        getterCalls++;
        return randomUUID();
      },
    },
  );
  for (const identity of [
    inherited,
    hiddenExtra,
    hiddenSubject,
    symbolExtra,
    accessor,
  ])
    await assert.rejects(
      owner.createSession(identity, tokens),
      code('AUTH_NOT_CONFIGURED'),
    );
  assert.equal(getterCalls, 0);
  assert.equal(f.calls.length, 0);
});
test('synthetic identity snapshots prevent caller mutation across the actual managed boundary await', async () => {
  const f = fixture(),
    owner = await historicalDeletionIdentity(f.database, config, 174);
  f.state.existing = false;
  const identity = synthetic('synthetic-runtime-only'),
    subject = identity.subject;
  const pending = owner.createSession(identity, tokens);
  Object.assign(identity, {
    provider: 'other',
    appId: 'unapproved-app',
    subject: 'unapproved-subject',
    unionSubject: 'not-allowed',
  });
  await pending;
  const insert = f.calls.find(({ sql }) =>
    sql.startsWith('INSERT INTO whaleu_identity.provider_identities'),
  );
  assert.deepEqual(insert?.values, [
    'wechat',
    'synthetic-runtime-only',
    subject,
    f.state.account,
    null,
  ]);
  const fence = f.calls.find(
    ({ sql }) =>
      sql === 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
  );
  assert.deepEqual(fence?.values, [
    JSON.stringify(['wechat', 'synthetic-runtime-only', subject]),
  ]);
  assert.equal(f.calls.at(-1)?.sql, 'COMMIT');
});
test('synthetic null-prototype and frozen plain data identities remain supported', async () => {
  for (const identity of [
    Object.assign(Object.create(null), synthetic('synthetic-runtime-only')),
    Object.freeze(synthetic('synthetic-runtime-only')),
  ]) {
    const f = fixture(),
      owner = await historicalDeletionIdentity(f.database, config, 174);
    f.state.existing = false;
    assert.equal(
      (await owner.createSession(identity, tokens)).accountId,
      f.state.account,
    );
    assert.equal(f.calls.at(-1)?.sql, 'COMMIT');
  }
});
for (const denial of [
  'missing',
  'revoked',
  'blocked',
  'cooling',
  'erasing',
  'completed',
  'access-expired',
  'absolute-expired',
] as const)
  test(`genuine authentication denial ${denial} is not disguised as boundary failure`, async () => {
    const f = fixture(),
      owner = await historicalDeletionIdentity(f.database, config, 174);
    let failure = 'SESSION_REVOKED';
    if (denial === 'missing') {
      f.state.found = false;
      failure = 'AUTHENTICATION_REQUIRED';
    } else if (denial === 'revoked') f.state.revoked = true;
    else if (denial === 'blocked') {
      f.state.status = 'blocked';
      failure = 'ACCOUNT_BLOCKED';
    } else if (denial === 'access-expired') {
      f.state.expiredAccess = true;
      failure = 'ACCESS_TOKEN_EXPIRED';
    } else if (denial === 'absolute-expired') {
      f.state.expiredAbsolute = true;
      failure = 'ACCESS_TOKEN_EXPIRED';
    } else f.state.lifecycle = denial;
    await assert.rejects(owner.authenticate(tokens.access), code(failure));
    assert.ok(f.business.length > 0);
    assert.equal(f.calls.at(-1)?.sql, 'ROLLBACK');
  });
test('presented-token deadline remains active after deferred waits', async () => {
  const f = fixture(),
    owner = await historicalDeletionIdentity(f.database, config, 174),
    query = f.tx.query.bind(f.tx);
  let final = false;
  f.tx.query = (async (sql: string, values?: unknown[]) => {
    if (sql === 'SET CONSTRAINTS ALL IMMEDIATE') final = true;
    if (final && sql === 'SELECT clock_timestamp() AS now')
      return { rows: [{ now: new Date('2101-01-01') }], rowCount: 1 };
    return query(sql, values);
  }) as PoolClient['query'];
  await assert.rejects(
    owner.authenticate(tokens.access),
    code('ACCESS_TOKEN_EXPIRED'),
  );
  assert.equal(f.calls.at(-1)?.sql, 'ROLLBACK');
});
for (const denial of [
  'missing',
  'revoked',
  'blocked',
  'cooling',
  'erasing',
  'completed',
  'refresh-expired',
  'absolute-expired',
] as const)
  test(`refresh keeps original committed denial ${denial}`, async () => {
    const f = fixture(),
      owner = await historicalDeletionIdentity(f.database, config, 174);
    let failure = 'SESSION_REVOKED';
    if (denial === 'missing') {
      f.state.found = false;
      failure = 'AUTHENTICATION_REQUIRED';
    } else if (denial === 'revoked') f.state.revoked = true;
    else if (denial === 'blocked') {
      f.state.status = 'blocked';
      failure = 'ACCOUNT_BLOCKED';
    } else if (denial === 'refresh-expired') {
      f.state.expiredRefresh = true;
      failure = 'REFRESH_TOKEN_EXPIRED';
    } else if (denial === 'absolute-expired') {
      f.state.expiredAbsolute = true;
      failure = 'REFRESH_TOKEN_EXPIRED';
    } else f.state.lifecycle = denial;
    await assert.rejects(owner.rotate(tokens.refresh, tokens), code(failure));
    assert.ok(f.business.length > 0);
    assert.equal(f.calls.at(-1)?.sql, 'COMMIT');
  });
test('refresh-replay revocation commits before error reaches caller', async () => {
  const f = fixture(),
    owner = await historicalDeletionIdentity(f.database, config, 174);
  f.state.consumed = true;
  await assert.rejects(
    owner.rotate(tokens.refresh, tokens),
    code('REFRESH_TOKEN_REUSED'),
  );
  assert.equal(f.state.revoked, true);
  assert.equal(f.calls.at(-1)?.sql, 'COMMIT');
  const ordered = f.business.filter(
    (s) =>
      s.startsWith('SELECT id FROM whaleu_identity') ||
      s.startsWith('SELECT token_hash FROM'),
  );
  assert.match(ordered[0]!, /accounts.*FOR SHARE$/);
  assert.match(ordered[1]!, /sessions.*FOR UPDATE$/);
  assert.match(ordered[2]!, /refresh_tokens.*FOR UPDATE$/);
});
test('rotation and logout retain real mutation paths in managed transactions', async () => {
  const f = fixture(),
    owner = await historicalDeletionIdentity(f.database, config, 174);
  assert.equal(
    (await owner.rotate(tokens.refresh, tokens)).sessionId,
    sessionId,
  );
  assert.ok(
    f.business.some((s) =>
      s.startsWith('UPDATE whaleu_identity.refresh_tokens SET consumed_at'),
    ),
  );
  assert.ok(
    f.business.some((s) =>
      s.startsWith('INSERT INTO whaleu_identity.refresh_tokens'),
    ),
  );
  await owner.revoke(tokens.access);
  assert.equal(f.state.revoked, true);
  assert.equal(f.calls.filter((c) => c.sql === 'COMMIT').length, 2);
  f.state.found = false;
  await assert.rejects(
    owner.revoke(tokens.access),
    code('AUTHENTICATION_REQUIRED'),
  );
  assert.equal(f.calls.at(-1)?.sql, 'COMMIT');
});
test('session creation preserves blocked and cooling/erasing/completed business denials', async () => {
  for (const lifecycle of ['cooling', 'erasing', 'completed']) {
    const f = fixture(),
      owner = await historicalDeletionIdentity(f.database, config, 174);
    f.state.lifecycle = lifecycle;
    await assert.rejects(
      owner.createSession(synthetic(), tokens),
      code('SESSION_REVOKED'),
    );
    assert.equal(f.calls.at(-1)?.sql, 'ROLLBACK');
  }
  const f = fixture(),
    owner = await historicalDeletionIdentity(f.database, config, 174);
  f.state.status = 'blocked';
  await assert.rejects(
    owner.createSession(synthetic(), tokens),
    code('ACCOUNT_BLOCKED'),
  );
});
test('Nest uses its own DatabaseService override and current IdentityService retains it after init', async () => {
  const f = fixture(),
    builder = Test.createTestingModule({
      providers: [
        { provide: DatabaseService, useValue: f.database },
        {
          provide: IDENTITY_PROVIDER,
          useValue: { exchange: async () => synthetic() },
        },
        IdentityRepository,
        IdentityService,
      ],
    });
  await configureHistoricalDeletionIdentity(builder, config, 174);
  assert.equal(f.calls.length, 0);
  const module = await builder.compile();
  try {
    const owner = module.get(IdentityRepository);
    assert.ok(isHistoricalDeletionIdentity(owner));
    assert.equal(module.get(DatabaseService), f.database);
    assert.equal(
      (
        module.get(IdentityService) as unknown as {
          repository: IdentityRepository;
        }
      ).repository,
      owner,
    );
    await module.init();
    assert.equal(module.get(IdentityRepository), owner);
    const access = mintToken('access');
    assert.equal(
      (await module.get(IdentityService).session(access)).accountId,
      accountId,
    );
    assert.ok(f.calls.some((c) => c.values?.[0] === hashToken(access)));
  } finally {
    await module.close();
  }
});
test('wiring is exact/awaited, default inventory rejection is retained and production cannot reach historical owner', async () => {
  const base = await readFile(
    new URL('./support/account-deletion-fixture.ts', import.meta.url),
    'utf8',
  );
  assert.match(
    base,
    /options\.throughMigration === undefined\s*\? new IdentityRepository\(database\)\s*:\s*await historicalDeletionIdentity\(/,
  );
  assert.ok(
    base.indexOf('const seal = await inventory(tx, true)') <
      base.indexOf('await historicalDeletionIdentity('),
  );
  assert.match(base, /options\.throughMigration === undefined\s*\? migrations/);
  assert.match(base, /new IdentityService\([\s\S]*?\n\s*identity,/);
  assert.match(base, /return createHistoricalDeletionPeer\(database, config\)/);
  const follow = await readFile(
    new URL(
      './support/account-deletion-follow-social-fixture.ts',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(follow, /accountDeletionFixture\(\{ throughMigration: 174 \}\)/);
  assert.ok(
    follow.indexOf(
      'await configureHistoricalDeletionIdentity(builder, config, 174)',
    ) < follow.indexOf('builder.compile()'),
  );
  assert.ok(
    follow.indexOf('assert.equal(app.get(IdentityRepository), identity)') >
      follow.indexOf('await app.init()'),
  );
  assert.match(follow, /assert.notEqual\(identity, base.identity\)/);
  assert.match(
    follow,
    /if \(options.publication === 'c27_0174'\)\s+await configureHistoricalFollowSocialPublication\(builder, config\);/,
  );
  const src = new URL('../src/', import.meta.url);
  for (const file of await readdir(src, { recursive: true })) {
    if (file.endsWith('.ts'))
      assert.doesNotMatch(
        await readFile(new URL(file, src), 'utf8'),
        /historical-lifecycle-identity|historicalDeletionIdentity/,
      );
  }
  const adapter = await readFile(
    new URL(
      './support/historical-lifecycle-identity/deletion.ts',
      import.meta.url,
    ),
    'utf8',
  );
  assert.doesNotMatch(
    adapter,
    /historicalPrefixes|startTransactionDeadlines|new Pool|INSERT INTO|ALTER TABLE|requireSessionEpoch|retainLiveSessionEpoch/,
  );
});

test('only the exact original 0088 UUID columns are exempt from the global source-family sentinel', () => {
  for (const predicate of [
    "n.nspname='whaleu_ratings' AND c.relname='category_icon_definitions' AND c.relkind='r'",
    "a.attname IN ('text_source_id','text_source_revision')",
    "a.atttypid='pg_catalog.uuid'::regtype AND NOT a.attnotnull",
    "a.attgenerated='' AND a.attidentity='' AND a.atttypmod=-1 AND a.attndims=0",
    'NOT EXISTS (SELECT 1 FROM pg_attrdef d WHERE d.adrelid=a.attrelid AND d.adnum=a.attnum)',
  ])
    assert.ok(historicalDeletionSchemaSql.includes(predicate), predicate);
  assert.match(
    historicalDeletionSchemaSql,
    /SELECT oid FROM pg_namespace WHERE starts_with\(nspname,'whaleu_'\)/,
  );
  assert.match(
    historicalDeletionSchemaSql,
    /FROM application_objects WHERE name ~ '\^_\?\(text_source_\|community_text_sources\)'/,
  );
});

test('all six catalog branches use the exact byte-ordered forbidden-prefix union before the legacy attribute exception', () => {
  const prefixes = [
    'registration_guard',
    'session_epoch_',
    'text_source_',
    'community_text_sources',
    'reading_',
    'home_',
  ];
  const ranges = prefixes
    .flatMap((prefix) => [prefix, '_' + prefix])
    .map(
      (prefix) =>
        [
          prefix,
          prefix.slice(0, -1) +
            String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1),
        ] as const,
    );
  for (const column of [
    'c.relname',
    'p.proname',
    't.tgname',
    't.typname',
    'c.conname',
    'a.attname',
  ]) {
    for (const [lower, upper] of ranges)
      assert.ok(
        historicalDeletionSchemaSql.includes(
          `${column} COLLATE "C" >= '${lower}'::name AND ${column} COLLATE "C" < '${upper}'::name`,
        ),
        column + ':' + lower,
      );
    assert.ok(
      historicalDeletionSchemaSql.includes(
        `${column} IN ('profile_moderation_definition_pre_text_source','profile_moderation_definition_pre_home','session_revocation_epoch','issued_revocation_epoch')`,
      ),
      column,
    );
  }
  assert.match(
    historicalDeletionSchemaSql,
    /candidate_attributes AS MATERIALIZED/,
  );
  assert.match(
    historicalDeletionSchemaSql,
    /FROM candidate_attributes a JOIN pg_class/,
  );
  assert.match(
    historicalDeletionSchemaSql,
    /application_objects AS MATERIALIZED/,
  );
  assert.equal(
    historicalDeletionSchemaSql.match(
      /=ANY\(ARRAY\(SELECT oid FROM application_namespaces\)\)/g,
    )?.length,
    6,
  );
  assert.doesNotMatch(
    historicalDeletionSchemaSql,
    /JOIN application_namespaces/,
  );
  const predicates = [
    /^_?registration_guard/,
    /^_?session_epoch_/,
    /^_?(text_source_|community_text_sources)/,
    /^_?reading_/,
    /^_?home_/,
  ];
  const exact = new Set([
    'profile_moderation_definition_pre_text_source',
    'profile_moderation_definition_pre_home',
    'session_revocation_epoch',
    'issued_revocation_epoch',
  ]);
  const names = [
    ...prefixes,
    ...exact,
    'other',
    'home',
    'reading',
    'text_source',
    'session_epoch',
    'registration',
  ];
  for (const name of names)
    for (const prefix of ['', '_', '__', 'x'])
      for (const suffix of ['', '_partial', 'x', '\u00e9', '\u4e2d']) {
        const value = prefix + name + suffix;
        assert.equal(
          ranges.some(([lower, upper]) => value >= lower && value < upper) ||
            exact.has(value),
          predicates.some((predicate) => predicate.test(value)) ||
            exact.has(value),
          value,
        );
      }
});

test('first + final schema reuse keeps every genuine active-account read and no cross-TX/client reuse', async () => {
  const f = fixture(),
    owner = await historicalDeletionIdentity(f.database, config, 174);
  for (let transaction = 0; transaction < 2; transaction++)
    await f.transaction(async (tx) => {
      for (let i = 0; i < 12; i++)
        assert.equal(await owner.activeAccount(accountId, tx), true);
    });
  assert.equal(
    f.calls.filter((c) => c.sql === historicalDeletionSchemaSql).length,
    4,
  );
  assert.equal(
    f.business.filter((sql) =>
      sql.startsWith('SELECT status FROM whaleu_identity.accounts'),
    ).length,
    24,
  );
  assert.equal(f.calls.filter((c) => c.sql === 'COMMIT').length, 2);
  await assert.rejects(
    owner.activeAccount(accountId, f.tx),
    code('AUTH_NOT_CONFIGURED'),
  );
});
test('schema reuse is private to exact boundary factory, not a client-global authorization', async () => {
  const f = fixture(),
    first = await historicalDeletionIdentity(f.database, config, 174),
    second = await historicalDeletionIdentity(f.database, config, 174);
  await f.transaction(async (tx) => {
    await first.activeAccount(accountId, tx);
    await second.activeAccount(accountId, tx);
  });
  assert.equal(
    f.calls.filter((c) => c.sql === historicalDeletionSchemaSql).length,
    4,
  );
});
test('rollback checkpoint invalidates schema reuse, including proof first registered inside savepoint', async () => {
  const f = fixture(),
    owner = await historicalDeletionIdentity(f.database, config, 174);
  await f.transaction(async (tx) => {
    const checkpoint = checkpointTransactionDeadlines(tx);
    await tx.query('SAVEPOINT local_probe');
    await owner.activeAccount(accountId, tx);
    await tx.query('ROLLBACK TO SAVEPOINT local_probe');
    restoreTransactionDeadlines(tx, checkpoint);
    await owner.activeAccount(accountId, tx);
    await owner.activeAccount(accountId, tx);
  });
  assert.equal(
    f.calls.filter((c) => c.sql === historicalDeletionSchemaSql).length,
    3,
  );
  assert.equal(f.calls.at(-1)?.sql, 'COMMIT');
});
test('failed or epoch-spanning first proof is never admitted for reuse', async () => {
  const f = fixture(),
    owner = await historicalDeletionIdentity(f.database, config, 174);
  await f.transaction(async (tx) => {
    f.state.shape.home_absent = false;
    await assert.rejects(
      owner.activeAccount(accountId, tx),
      code('AUTH_NOT_CONFIGURED'),
    );
    f.state.shape.home_absent = true;
    await owner.activeAccount(accountId, tx);
  });
  assert.equal(
    f.calls.filter((c) => c.sql === historicalDeletionSchemaSql).length,
    3,
  );
  const g = fixture(),
    other = await historicalDeletionIdentity(g.database, config, 174);
  await assert.rejects(
    g.transaction(async (tx) => {
      const checkpoint = checkpointTransactionDeadlines(tx);
      let once = true;
      g.state.fail = (sql) => {
        if (once && sql === historicalDeletionSchemaSql) {
          once = false;
          restoreTransactionDeadlines(tx, checkpoint);
        }
        return undefined;
      };
      await other.activeAccount(accountId, tx);
    }),
    code('AUTH_NOT_CONFIGURED'),
  );
  assert.deepEqual(g.business, []);
});
test('same-epoch DDL may reach tentative business but final full proof refuses any external result', async () => {
  const f = fixture(),
    owner = await historicalDeletionIdentity(f.database, config, 174);
  let intermediate = false,
    escaped = false;
  await assert.rejects(
    f
      .transaction(async (tx) => {
        await owner.activeAccount(accountId, tx);
        f.state.shape.source_absent = false;
        intermediate = await owner.activeAccount(accountId, tx);
        return 'must not escape';
      })
      .then(() => {
        escaped = true;
      }),
    code('AUTH_NOT_CONFIGURED'),
  );
  assert.equal(intermediate, true);
  assert.equal(escaped, false);
  assert.equal(f.calls.at(-1)?.sql, 'ROLLBACK');
  assert.equal(
    f.business.filter((sql) => sql.startsWith('SELECT status FROM')).length,
    2,
  );
});
test('unconditional final proof retains caller 20 ms and does not turn timeout into count unknown', async () => {
  const f = fixture(),
    owner = await historicalDeletionIdentity(f.database, config, 174);
  f.state.statementTimeout = '20ms';
  let final = false;
  f.state.deferred = () => {
    final = true;
  };
  f.state.fail = (sql) =>
    final && sql === historicalDeletionSchemaSql
      ? new Error('statement timeout')
      : undefined;
  await assert.rejects(
    f.transaction(async (tx) => {
      for (let i = 0; i < 8; i++) await owner.activeAccount(accountId, tx);
    }),
    code('AUTH_NOT_CONFIGURED'),
  );
  assert.ok(final);
  assert.equal(f.calls.at(-1)?.sql, 'ROLLBACK');
  for (const call of f.calls.filter((c) =>
    c.sql.startsWith("SELECT set_config('statement_timeout'"),
  ))
    assert.equal(call.values?.[0], '20ms');
});
