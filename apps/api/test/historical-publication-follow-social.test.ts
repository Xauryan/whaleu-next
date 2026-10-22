import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import type { InjectionToken } from '@nestjs/common';
import type { TestingModuleBuilder } from '@nestjs/testing';
import type { Pool, PoolClient } from 'pg';
import { APP_CONFIG, loadConfig } from '../src/config/config.js';
import { DatabaseService, inTransaction } from '../src/database/database.js';
import { readMigrations } from '../src/database/migrations.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { AppLogger } from '../src/observability/logger.js';
import { AccountPunishmentPolicy } from '../src/safety/account-moderation/policy.js';
import { PublicationService } from '../src/community/publication.service.js';
import { PublicationRepository } from '../src/community/publication.repository.js';
import { CommunityAccessService } from '../src/community/community-access.service.js';
import type { CommunityRepository } from '../src/community/community.repository.js';
import { IdentityRepository } from '../src/identity/identity.repository.js';
import { IdentityService } from '../src/identity/identity.service.js';
import { mintToken } from '../src/identity/tokens.js';
import { PublicationService as PredecessorPublicationService } from './support/historical-publication/publication.service.js';
import {
  guardedHistoricalPublicationDatabase,
  historicalHomeAbsenceSql,
  historicalPublicationBoundary,
  historicalPublicationPrefixes,
  HistoricalPublicationService,
} from './support/historical-publication/configure.js';
import {
  configureHistoricalFollowSocialPublication,
  historicalDeletionLifecycleSql,
  historicalFollowSocialPublicationBoundary,
} from './support/historical-publication/follow-social.js';

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://fixture@127.0.0.1/whaleu_test',
  PG_SSL_MODE: 'disable',
  LOG_LEVEL: 'silent',
});
const migrations = await readMigrations(
  fileURLToPath(new URL('../migrations', import.meta.url)),
);
const expected = (prefix: number) =>
  migrations
    .filter(({ name }) => Number(name.slice(0, 4)) <= prefix)
    .map(({ name, checksum }) => ({ name, checksum }));

function fixture() {
  const state = {
    rows: expected(174),
    locked: true,
    sourceAbsent: true,
    homeAbsent: true,
    lifecyclePresent: true,
    lifecycleChecks: 0,
    lifecycle: 'active',
    accountLockError: null as Error | null,
    statements: [] as string[],
  };
  const tx = {
    query: async (sql: string, values?: unknown[]) => {
      state.statements.push(sql);
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date() }] };
      if (sql.includes('pg_try_advisory'))
        return { rows: [{ locked: state.locked }] };
      if (sql.includes('SELECT name,checksum')) {
        assert.deepEqual(values, [expected(174).length + 1]);
        return { rows: state.rows };
      }
      if (sql === historicalHomeAbsenceSql)
        return { rows: [{ absent: state.homeAbsent }] };
      if (sql.includes('AS absent'))
        return { rows: [{ absent: state.sourceAbsent }] };
      if (sql.includes('LOCK TABLE whaleu_identity.accounts')) {
        if (state.accountLockError) throw state.accountLockError;
        return { rows: [] };
      }
      if (sql === historicalDeletionLifecycleSql) {
        state.lifecycleChecks++;
        return { rows: [{ present: state.lifecyclePresent }] };
      }
      if (sql.startsWith('SELECT s.account_id,t.session_id'))
        return { rows: [{ account_id: 'actor', session_id: 'session' }] };
      if (sql.startsWith('SELECT s.*, a.status, a.lifecycle'))
        return {
          rows: [
            { status: 'active', lifecycle: state.lifecycle, revoked_at: null },
          ],
        };
      if (sql.includes("AND lifecycle='active' FOR SHARE"))
        return {
          rows: state.lifecycle === 'active' ? [{ status: 'active' }] : [],
        };
      assert.ok(
        !/\b(?:FROM|INTO)\s+whaleu_community\.publication_requests\b/.test(sql),
        'No journal or receipt access before active authentication',
      );
      return { rows: [] };
    },
    release() {},
  } as unknown as PoolClient;
  const pool = { connect: async () => tx } as unknown as Pick<Pool, 'connect'>;
  return { state, tx, pool };
}

test('separate exact174 boundary refuses other ledgers, partial successors and missing lifecycle ownership', async () => {
  assert.deepEqual(historicalPublicationPrefixes, [137, 144]);
  await assert.rejects(historicalPublicationBoundary(config, 174));
  for (const patch of [
    { NODE_ENV: 'production' as const },
    { DATABASE_URL: 'postgres://fixture@example.org/whaleu_test' },
    { DATABASE_URL: 'postgres://fixture@127.0.0.1/other' },
    {
      DATABASE_URL: 'postgres://fixture@127.0.0.1/whaleu_test?sslmode=disable',
    },
    { PG_SSL_MODE: 'verify-full' as const },
  ])
    await assert.rejects(
      historicalFollowSocialPublicationBoundary({ ...config, ...patch }),
    );
  const boundary = await historicalFollowSocialPublicationBoundary(config);
  const f = fixture();
  await assert.rejects(boundary(f.tx), /managed transaction/);
  await inTransaction(f.pool, boundary);
  assert.equal(f.state.lifecycleChecks, 1);
  for (const prefix of [132, 137, 144, 173, 175, 178]) {
    f.state.rows = expected(prefix);
    await assert.rejects(
      inTransaction(f.pool, boundary),
      /cannot cross an upgrade/,
    );
  }
  f.state.rows = expected(174).map((row, i) =>
    i ? row : { ...row, checksum: 'changed' },
  );
  await assert.rejects(
    inTransaction(f.pool, boundary),
    /cannot cross an upgrade/,
  );
  for (const field of [
    'locked',
    'sourceAbsent',
    'homeAbsent',
    'lifecyclePresent',
  ] as const) {
    Object.assign(f.state, {
      rows: expected(174),
      locked: true,
      sourceAbsent: true,
      homeAbsent: true,
      lifecyclePresent: true,
    });
    f.state[field] = false;
    await assert.rejects(inTransaction(f.pool, boundary));
    assert.equal(f.state.statements.at(-1), 'ROLLBACK');
  }
  for (const fragment of [
    "('lifecycle','text'::regtype,true)",
    "('lifecycle_generation','bigint'::regtype,true)",
    "('deletion_request_id','uuid'::regtype,false)",
    "tgname='deletion_lifecycle_guard' AND NOT tgisinternal AND tgtype=19",
    "tgenabled IN ('O','A')",
    "tgfoid=to_regprocedure('whaleu_account_deletion.lifecycle_guard()')",
  ])
    assert.ok(historicalDeletionLifecycleSql.includes(fragment));
});

test('exact174 accepts only literal PostgreSQL loopback URLs without any query or fragment', async () => {
  for (const DATABASE_URL of [
    'postgres://fixture@127.0.0.1/whaleu_test',
    'postgresql://fixture@localhost:55844/whaleu_test',
    'postgres://fixture@[::1]:55844/whaleu_test',
  ])
    assert.equal(
      typeof (await historicalFollowSocialPublicationBoundary({
        ...config,
        DATABASE_URL,
      })),
      'function',
    );
  let overrides = 0;
  const builder = {
    overrideProvider() {
      overrides++;
      assert.fail('Invalid connection must fail before DI composition');
    },
  } as unknown as TestingModuleBuilder;
  for (const DATABASE_URL of [
    'https://fixture@127.0.0.1/whaleu_test',
    'file://127.0.0.1/whaleu_test',
    'postgres://fixture@remote.example/whaleu_test',
    'postgres://fixture@127.0.0.1/other',
    'postgres://fixture@127.0.0.1/whaleu_test?host=remote.example',
    'postgres://fixture@127.0.0.1/whaleu_test?hostaddr=192.0.2.1',
    'postgres://fixture@127.0.0.1/whaleu_test?dbname=other',
    'postgres://fixture@127.0.0.1/whaleu_test?options=-csearch_path=public',
    'postgres://fixture@127.0.0.1/whaleu_test?sslmode=disable',
    'postgres://fixture@127.0.0.1/whaleu_test?application_name=fixture',
    'postgres://fixture@127.0.0.1/whaleu_test#ignored',
    'postgres://fixture@127.0.0.1/whaleu_test?',
    'postgres://fixture@127.0.0.1/whaleu_test#',
  ])
    await assert.rejects(
      configureHistoricalFollowSocialPublication(builder, {
        ...config,
        DATABASE_URL,
      }),
    );
  assert.equal(overrides, 0);
});

test('exact174 DI overrides only database and producer, preserving actual lifecycle-aware Identity methods', async () => {
  const replaced: unknown[] = [];
  await configureHistoricalFollowSocialPublication(
    {
      overrideProvider(token: unknown) {
        replaced.push(token);
        return {
          useFactory() {},
          useClass(owner: unknown) {
            assert.equal(owner, HistoricalPublicationService);
          },
        };
      },
    } as unknown as TestingModuleBuilder,
    config,
  );
  assert.deepEqual(replaced, [DatabaseService, PublicationService]);
  const parameters = Reflect.getMetadata(
    'self:paramtypes',
    PredecessorPublicationService,
  ) as { param: InjectionToken }[];
  const dependencies = new Map<InjectionToken, unknown>(
    parameters.map(({ param }) => [param, {}]),
  );
  dependencies.set(APP_CONFIG, config);
  dependencies.set(AppLogger, {});
  dependencies.set(AccountPunishmentPolicy, new AccountPunishmentPolicy());
  dependencies.delete(IdentityRepository);
  const builder = Test.createTestingModule({
    providers: [
      ...[...dependencies].map(([provide, useValue]) => ({
        provide,
        useValue,
      })),
      { provide: DatabaseService, useValue: {} },
      { provide: PublicationService, useValue: {} },
      IdentityRepository,
    ],
  });
  await configureHistoricalFollowSocialPublication(builder, config);
  const module = await builder.compile();
  try {
    const owner: unknown = module.get(PublicationService);
    assert.ok(owner instanceof HistoricalPublicationService);
    const identity = module.get(IdentityRepository);
    assert.equal(identity.constructor, IdentityRepository);
    for (const method of [
      'authenticate',
      'activeAccount',
      'createSession',
      'rotate',
      'revoke',
    ] as const)
      assert.equal(identity[method], IdentityRepository.prototype[method]);
  } finally {
    await module.close();
  }
  const wiring = await readFile(
    new URL(
      './support/account-deletion-follow-social-fixture.ts',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(
    wiring,
    /if \(options.publication === 'c27_0174'\)\s+await configureHistoricalFollowSocialPublication\(builder, config\);/,
  );
  assert.doesNotMatch(
    wiring,
    /configureHistoricalIdentity|configureHistoricalAccountPolicy/,
  );
  const callers = await readFile(
    new URL(
      './integration/account-deletion-follow-social.test.ts',
      import.meta.url,
    ),
    'utf8',
  );
  assert.equal(
    [...callers.matchAll(/publication: 'c27_0174'/g)].length,
    2,
    'one like/save loop and one real-owner cooling refusal witness',
  );
});

test('exact174 retains callback semantics and rechecks lifecycle at real pre-COMMIT, including receipt-shaped early returns', async () => {
  const f = fixture(),
    boundary = await historicalFollowSocialPublicationBoundary(config);
  const options = { isolationLevel: 'read committed' as const };
  let drift = false;
  const database = {
    transaction<T>(operation: (tx: PoolClient) => Promise<T>, actual?: object) {
      assert.equal(actual, options);
      return inTransaction(
        f.pool,
        async (tx) => {
          const result = await operation(tx);
          if (drift) f.state.lifecyclePresent = false;
          return result;
        },
        options,
      );
    },
  } as unknown as DatabaseService;
  const guarded = guardedHistoricalPublicationDatabase(database, boundary);
  const result = Object.freeze({ outcome: 'created' });
  assert.equal(
    await guarded.transaction(async (tx) => {
      assert.equal(tx, f.tx);
      const saved = checkpointTransactionDeadlines(tx);
      await tx.query('SAVEPOINT publication_work');
      await tx.query('ROLLBACK TO SAVEPOINT publication_work');
      restoreTransactionDeadlines(tx, saved);
      return result;
    }, options),
    result,
  );
  assert.equal(f.state.lifecycleChecks, 3);
  assert.equal(f.state.statements.at(-1), 'COMMIT');
  const failure = new Error('original');
  await assert.rejects(
    guarded.transaction(async () => {
      throw failure;
    }, options),
    (e) => e === failure,
  );
  f.state.accountLockError = failure;
  await assert.rejects(
    guarded.transaction(async () => result, options),
    (e) => e === failure,
  );
  f.state.accountLockError = null;
  drift = true;
  await assert.rejects(
    guarded.transaction(async () => result, options),
    /requires the deletion lifecycle owner/,
  );
  assert.equal(f.state.statements.at(-1), 'ROLLBACK');
});

test('current Identity and publication journal reject nonactive lifecycle before any receipt lookup or content callback', async () => {
  const f = fixture(),
    boundary = await historicalFollowSocialPublicationBoundary(config);
  const database = guardedHistoricalPublicationDatabase(
    {
      transaction: <T>(work: (tx: PoolClient) => Promise<T>) =>
        inTransaction(f.pool, work),
    } as unknown as DatabaseService,
    boundary,
  );
  const identity = new IdentityRepository(database, config);
  const service = new IdentityService(
    {
      exchange: async () => {
        throw new Error('No provider');
      },
    },
    identity,
  );
  const community = { database } as CommunityRepository;
  // Unused business owners cannot authorize anything in this refusal test.
  const unused = new Proxy(
    {},
    {
      get: () => {
        throw new Error('No business owner before authentication');
      },
    },
  );
  const access = Reflect.construct(CommunityAccessService, [
    service,
    unused,
    unused,
    community,
  ]) as CommunityAccessService;
  const journal = Reflect.construct(PublicationRepository, [
    community,
    access,
    unused,
    unused,
    unused,
    unused,
    unused,
  ]) as PublicationRepository;
  for (const lifecycle of ['cooling', 'erasing', 'completed']) {
    f.state.lifecycle = lifecycle;
    assert.equal(
      await database.transaction((tx) => identity.activeAccount('actor', tx)),
      false,
    );
    await assert.rejects(
      journal.execute(
        mintToken('access'),
        'request',
        'publish_post',
        {},
        async () => {
          throw new Error('No content callback');
        },
      ),
      { code: 'SESSION_REVOKED' },
    );
    assert.equal(f.state.statements.at(-1), 'ROLLBACK');
  }
  assert.ok(
    f.state.statements.some(
      (sql) =>
        sql === 'SELECT id FROM whaleu_identity.accounts WHERE id=$1 FOR SHARE',
    ),
  );
  assert.equal(
    f.state.statements.some((sql) =>
      /\b(?:FROM|INTO)\s+whaleu_community\.publication_requests\b/.test(sql),
    ),
    false,
  );
});
