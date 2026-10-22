import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { loadConfig } from '../src/config/config.js';
import type { RuntimeConfig } from '../src/config/config.js';
import type {
  DatabaseService,
  TransactionOptions,
} from '../src/database/database.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
  checkTransactionDeadlines,
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { hashToken, requireToken } from '../src/identity/tokens.js';
import type { ProviderIdentity } from '../src/identity/contracts.js';
import {
  HISTORICAL_DELETION_PEER_APP,
  DELETION_PEER_0174_MANIFEST_SHA256,
  requireHistoricalDeletionPeerConfig,
  requireHistoricalDeletionPeerIdentity,
  readHistoricalDeletionPeerMigrations,
  historicalDeletionPeerCatalogSql,
  retainHistoricalDeletionPeer174,
  createHistoricalDeletionPeer,
} from './support/historical-deletion-peer.js';

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://fixture@127.0.0.1/whaleu_test',
  PG_SSL_MODE: 'disable',
  LOG_LEVEL: 'silent',
});
const migrations = await readHistoricalDeletionPeerMigrations();

test('historical deletion peers use all immutable 0174 migration bytes, not a broad historical range', () => {
  assert.equal(migrations.length, 174);
  assert.equal(
    migrations.at(-1)?.name,
    '0174_account_deletion_inventory_collation.sql',
  );
  assert.equal(
    createHash('sha256').update(JSON.stringify(migrations)).digest('hex'),
    DELETION_PEER_0174_MANIFEST_SHA256,
  );
  assert.ok(Object.isFrozen(migrations) && migrations.every(Object.isFrozen));
});

test('historical deletion peer setup rejects non-test, non-loopback, wrong DB and URL/SSL overrides', () => {
  requireHistoricalDeletionPeerConfig(config);
  for (const patch of [
    { NODE_ENV: 'production' },
    { NODE_ENV: 'development' },
    { DATABASE_URL: 'postgres://fixture@example.com/whaleu_test' },
    { DATABASE_URL: 'postgres://fixture@127.0.0.1/production' },
    { DATABASE_URL: 'https://127.0.0.1/whaleu_test' },
    {
      DATABASE_URL: 'postgres://fixture@127.0.0.1/whaleu_test?sslmode=disable',
    },
    {
      DATABASE_URL: 'postgres://fixture@127.0.0.1/whaleu_test?host=example.com',
    },
    {
      DATABASE_URL:
        'postgres://fixture@127.0.0.1/whaleu_test?options=-csearch_path=public',
    },
    { DATABASE_URL: 'postgres://fixture@127.0.0.1/whaleu_test#unexpected' },
    { PG_SSL_MODE: 'verify-full' },
  ])
    assert.throws(() =>
      requireHistoricalDeletionPeerConfig({
        ...config,
        ...patch,
      } as RuntimeConfig),
    );
});

test('historical peer identity is one generated-only namespace with no hidden or provider-supplied fields', () => {
  const identity: ProviderIdentity = {
    provider: 'wechat',
    appId: HISTORICAL_DELETION_PEER_APP,
    subject: randomUUID(),
  };
  requireHistoricalDeletionPeerIdentity(identity);
  for (const invalid of [
    { ...identity, appId: 'synthetic-runtime-only' },
    { ...identity, appId: 'real-provider-application' },
    { ...identity, provider: 'another-provider' },
    { ...identity, subject: 'existing-provider-subject' },
    { ...identity, unionSubject: 'not-allowed' },
    Object.assign(Object.create({ unionSubject: 'inherited' }), identity),
    Object.defineProperty({ ...identity }, 'unionSubject', { value: 'hidden' }),
    Object.defineProperty({ ...identity }, 'subject', {
      get: () => identity.subject,
      enumerable: true,
    }),
    Object.assign({ ...identity }, { [Symbol('hidden')]: true }),
  ])
    assert.throws(() =>
      requireHistoricalDeletionPeerIdentity(invalid as ProviderIdentity),
    );
});

function transactionFixture() {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const state = {
    database: 'whaleu_test',
    gate: true,
    exact: true,
    ledger: migrations.map((row) => ({ ...row })),
    existing: false,
    fixtureAdmitted: false,
    accountStatus: 'active',
    lifecycle: 'active',
    corruptAfterOwner: false,
    corruptAfterDeferred: false,
    lockError: false,
    commits: 0,
    rollbacks: 0,
    transactions: 0,
  };
  let createdAccount: string | undefined;
  const now = new Date();
  const tx = {
    query: async (sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values });
      if (sql === 'SELECT current_database() AS database')
        return { rows: [{ database: state.database }] };
      if (sql.startsWith('SELECT pg_try_advisory'))
        return { rows: [{ locked: state.gate }] };
      if (sql.startsWith('LOCK TABLE')) {
        if (state.lockError) throw new Error('lock not available');
        return { rows: [] };
      }
      if (sql.startsWith('SELECT name,checksum')) return { rows: state.ledger };
      if (sql === historicalDeletionPeerCatalogSql)
        return { rows: [{ exact: state.exact }] };
      if (sql.startsWith('SELECT pg_advisory_xact_lock(')) return { rows: [] };
      if (
        sql.startsWith(
          'SELECT account_id FROM whaleu_identity.provider_identities',
        )
      )
        return { rows: state.existing ? [{ account_id: randomUUID() }] : [] };
      if (sql.startsWith('INSERT INTO whaleu_identity.accounts')) {
        createdAccount = String(values[0]);
        return { rows: [], rowCount: 1 };
      }
      if (
        sql.startsWith('SELECT status,lifecycle FROM whaleu_identity.accounts')
      )
        return {
          rows: [{ status: state.accountStatus, lifecycle: state.lifecycle }],
        };
      if (sql.startsWith('INSERT INTO whaleu_identity.sessions'))
        return {
          rows: [
            {
              id: values[0],
              account_id: values[1],
              access_expires_at: values[2],
              refresh_expires_at: values[3],
              absolute_expires_at: values[4],
              revoked_at: null,
            },
          ],
          rowCount: 1,
        };
      if (
        /^INSERT INTO whaleu_(experience\.(owners|baselines|account_states|entitlements|appearance)|safety\.(account_heads|events)|identity\.(provider_identities|access_tokens|refresh_tokens))\b/.test(
          sql,
        )
      )
        return { rows: [], rowCount: 1 };
      if (sql.startsWith('UPDATE whaleu_identity.sessions SET revoked_at='))
        return { rows: [], rowCount: 0 };
      if (
        sql ===
        'SELECT 1 FROM whaleu_account_deletion.fixture_accounts WHERE account_id=$1'
      ) {
        assert.equal(values[0], createdAccount);
        if (state.corruptAfterOwner) state.exact = false;
        return {
          rows: state.fixtureAdmitted ? [{ value: 1 }] : [],
          rowCount: Number(state.fixtureAdmitted),
        };
      }
      if (sql === 'SET CONSTRAINTS ALL IMMEDIATE') {
        if (state.corruptAfterDeferred) state.exact = false;
        return { rows: [] };
      }
      if (sql === 'SELECT clock_timestamp() AS now') return { rows: [{ now }] };
      throw new Error(`Unexpected mocked statement: ${sql}`);
    },
  } as unknown as PoolClient;
  const database = {
    transaction: async <T>(
      operation: (client: PoolClient) => Promise<T>,
      options?: TransactionOptions,
    ) => {
      state.transactions++;
      assert.deepEqual(options, { isolationLevel: 'read committed' });
      startTransactionDeadlines(tx);
      try {
        const result = await operation(tx);
        await checkTransactionDeadlines(tx);
        state.commits++;
        return result;
      } catch (error) {
        state.rollbacks++;
        throw error;
      } finally {
        clearTransactionDeadlines(tx);
      }
    },
    query: () => {
      throw new Error('Unmanaged query forbidden');
    },
  } as unknown as DatabaseService;
  return { tx, database, calls, state };
}

test('exact 0174 peer fence rejects missing, unknown, changed and partial upgrade state before any writes', async () => {
  const unmanaged = transactionFixture();
  await assert.rejects(
    retainHistoricalDeletionPeer174(unmanaged.tx),
    /managed transaction/,
  );
  for (const corruption of [
    'database',
    'gate',
    'partial',
    'unknown',
    'missing',
    'checksum',
    'lock',
  ] as const) {
    const f = transactionFixture();
    if (corruption === 'database') f.state.database = 'production';
    if (corruption === 'gate') f.state.gate = false;
    if (corruption === 'partial') f.state.exact = false;
    if (corruption === 'unknown')
      f.state.ledger.push({
        name: '0175_unreviewed.sql',
        checksum: '0'.repeat(64),
      });
    if (corruption === 'missing') f.state.ledger.pop();
    if (corruption === 'checksum')
      f.state.ledger[173]!.checksum = '0'.repeat(64);
    if (corruption === 'lock') f.state.lockError = true;
    await assert.rejects(createHistoricalDeletionPeer(f.database, config));
    assert.equal(f.state.commits, 0);
    assert.equal(f.state.rollbacks, 1);
    assert.equal(
      f.calls.some(({ sql }) => /^(INSERT|UPDATE|DELETE)/.test(sql)),
      false,
    );
  }
});

test('peer fence explicitly inspects independently installable 0175 and later object families', () => {
  for (const catalog of [
    'pg_class',
    'pg_proc',
    'pg_trigger',
    'pg_attribute',
    'pg_constraint',
    'pg_type',
  ])
    assert.ok(historicalDeletionPeerCatalogSql.includes(catalog));
  for (const family of [
    'community_text_sources',
    'text_source_',
    'profile_moderation_definition_pre_text_source',
    'profile_moderation_definition_pre_home',
    'reading_format_',
    'home_',
    'registration_guard',
  ])
    assert.ok(historicalDeletionPeerCatalogSql.includes(family));
  for (const column of [
    'lifecycle',
    'lifecycle_generation',
    'deletion_request_id',
  ])
    assert.ok(historicalDeletionPeerCatalogSql.includes(column));
});

test('a sole 0178 pre-Home renamed procedure is a forbidden partial upgrade witness', () => {
  // Structural predicate witness only; the PostgreSQL suite owns catalog execution.
  // 0178 renames an existing function to a name outside its home_* prefix.
  const rejectsCommunityProcedure = (sql: string, name: string) => {
    const procedures = sql
      .split('FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace')[1]!
      .split("OR (n.nspname='whaleu_identity'")[0]!;
    assert.match(procedures, /n\.nspname='whaleu_community'/);
    const exactNames = [...procedures.matchAll(/p\.proname='([^']+)'/g)].map(
      (match) => match[1]!,
    );
    const prefixes = [
      ...procedures.matchAll(/starts_with\(p\.proname,'([^']+)'\)/g),
    ].map((match) => match[1]!);
    return (
      exactNames.includes(name) ||
      prefixes.some((prefix) => name.startsWith(prefix))
    );
  };
  const witness = 'profile_moderation_definition_pre_home';
  assert.equal(
    rejectsCommunityProcedure(historicalDeletionPeerCatalogSql, witness),
    true,
  );
  assert.equal(
    rejectsCommunityProcedure(
      historicalDeletionPeerCatalogSql,
      'profile_moderation_definition',
    ),
    false,
  );
  const missingWitnessGuard = historicalDeletionPeerCatalogSql.replace(
    " OR p.proname='profile_moderation_definition_pre_home'",
    '',
  );
  assert.notEqual(missingWitnessGuard, historicalDeletionPeerCatalogSql);
  assert.equal(rejectsCommunityProcedure(missingWitnessGuard, witness), false);
  assert.equal(
    rejectsCommunityProcedure(
      missingWitnessGuard,
      'profile_moderation_definition_pre_text_source',
    ),
    true,
  );
});

test('successor column predicates do not reject 0088 ratings text_source_id and text_source_revision', () => {
  // This is a structural SQL regression check, not a substitute for PostgreSQL.
  // 0088's unrelated ratings columns are legitimate on the exact 0174 predecessor.
  const columns = historicalDeletionPeerCatalogSql
    .split('FROM pg_attribute a')[1]!
    .split('AND NOT EXISTS')[0]!;
  assert.doesNotMatch(columns, /starts_with\(n\.nspname/);
  assert.match(
    columns,
    /n\.nspname='whaleu_community' AND \(starts_with\(a\.attname,'text_source_'\)/,
  );
  assert.match(
    columns,
    /n\.nspname='whaleu_identity' AND starts_with\(a\.attname,'registration_guard'\)/,
  );
  assert.doesNotMatch(columns, /whaleu_ratings/);
});

test('real frozen Identity owner creates only a fresh non-admitted peer under one pre/post/final-fenced transaction', async () => {
  const f = transactionFixture();
  const peer = await createHistoricalDeletionPeer(f.database, config);
  assert.equal(f.state.transactions, 1);
  assert.equal(f.state.commits, 1);
  assert.equal(f.state.rollbacks, 0);
  requireToken(peer.accessToken, 'access');
  requireToken(peer.refreshToken, 'refresh');
  const provider = f.calls.find(({ sql }) =>
    sql.startsWith('INSERT INTO whaleu_identity.provider_identities'),
  )!;
  assert.equal(provider.values[0], 'wechat');
  assert.equal(provider.values[1], HISTORICAL_DELETION_PEER_APP);
  assert.equal(provider.values[3], peer.accountId);
  assert.equal(provider.values[4], null);
  assert.match(String(provider.values[2]), /^[a-f0-9-]{36}$/);
  const access = f.calls.find(({ sql }) =>
    sql.startsWith('INSERT INTO whaleu_identity.access_tokens'),
  )!;
  assert.equal(access.values[0], hashToken(peer.accessToken));
  assert.equal(access.values[1], peer.sessionId);
  const refresh = f.calls.find(({ sql }) =>
    sql.startsWith('INSERT INTO whaleu_identity.refresh_tokens'),
  )!;
  assert.equal(refresh.values[0], hashToken(peer.refreshToken));
  assert.equal(refresh.values[1], peer.sessionId);
  const firstWrite = f.calls.findIndex(({ sql }) => sql.startsWith('INSERT'));
  const checks = f.calls.flatMap(({ sql }, index) =>
    sql === historicalDeletionPeerCatalogSql ? [index] : [],
  );
  assert.equal(checks.length, 3);
  assert.ok(
    checks[0]! < firstWrite &&
      checks[1]! > firstWrite &&
      checks[2]! > checks[1]!,
  );
  const locks = f.calls.filter(({ sql }) =>
    sql.startsWith('SELECT pg_advisory_xact_lock('),
  );
  assert.equal(locks.length, 2);
  assert.deepEqual(locks[0]!.values, locks[1]!.values);
  assert.ok(
    f.calls
      .slice(0, firstWrite)
      .some(({ sql }) =>
        sql.includes('schema_migrations IN SHARE MODE NOWAIT'),
      ),
  );
  assert.ok(
    f.calls
      .slice(0, firstWrite)
      .some(({ sql }) => sql.includes('IN ACCESS SHARE MODE NOWAIT')),
  );
  assert.equal(
    f.calls.some(({ sql }) =>
      sql.startsWith('INSERT INTO whaleu_account_deletion.'),
    ),
    false,
  );
});

test('historical peer creation cannot recover an existing identity or erase current lifecycle/session denial', async () => {
  for (const rejection of [
    'existing',
    'blocked',
    'cooling',
    'erasing',
    'completed',
    'admitted',
  ] as const) {
    const f = transactionFixture();
    if (rejection === 'existing') f.state.existing = true;
    else if (rejection === 'blocked') f.state.accountStatus = 'blocked';
    else if (rejection === 'admitted') f.state.fixtureAdmitted = true;
    else f.state.lifecycle = rejection;
    await assert.rejects(
      createHistoricalDeletionPeer(f.database, config),
      rejection === 'existing'
        ? /existing subject/
        : rejection === 'admitted'
          ? /never receive/
          : (error: unknown) =>
              typeof error === 'object' &&
              error !== null &&
              'code' in error &&
              error.code ===
                (rejection === 'blocked'
                  ? 'ACCOUNT_BLOCKED'
                  : 'SESSION_REVOKED'),
    );
    assert.equal(f.state.commits, 0);
    if (rejection === 'existing')
      assert.equal(
        f.calls.some(({ sql }) => sql.startsWith('INSERT')),
        false,
      );
    if (rejection !== 'admitted')
      assert.equal(
        f.calls.some(({ sql }) =>
          sql.startsWith('INSERT INTO whaleu_identity.sessions'),
        ),
        false,
      );
  }
});

test('post-owner and post-deferred upgrade failures prevent commit of real peer writes', async () => {
  for (const point of ['corruptAfterOwner', 'corruptAfterDeferred'] as const) {
    const f = transactionFixture();
    f.state[point] = true;
    await assert.rejects(
      createHistoricalDeletionPeer(f.database, config),
      /Partial or future schema/,
    );
    assert.ok(
      f.calls.some(({ sql }) =>
        sql.startsWith('INSERT INTO whaleu_identity.sessions'),
      ),
    );
    assert.equal(f.state.commits, 0);
    assert.equal(f.state.rollbacks, 1);
  }
});

test('0174 final proof is re-enrolled after savepoint restoration', async () => {
  const f = transactionFixture();
  startTransactionDeadlines(f.tx);
  try {
    const before = checkpointTransactionDeadlines(f.tx);
    await retainHistoricalDeletionPeer174(f.tx);
    restoreTransactionDeadlines(f.tx, before);
    await retainHistoricalDeletionPeer174(f.tx);
    f.state.exact = false;
    await assert.rejects(
      checkTransactionDeadlines(f.tx),
      /Partial or future schema/,
    );
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});
