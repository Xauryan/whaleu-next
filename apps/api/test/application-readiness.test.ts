import { assertReadinessUnavailableResponse } from './support/readiness-response.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigurationModule, loadConfig } from '../src/config/config.js';
import type { RuntimeConfig } from '../src/config/config.js';
import { DatabaseService, inTransaction } from '../src/database/database.js';
import type { PoolClient } from 'pg';
import type { TransactionOptions } from '../src/database/database.js';
import { MIGRATION_LOCK, readMigrations } from '../src/database/migrations.js';
import type { Migration } from '../src/database/migrations.js';
import { HealthController, HealthModule } from '../src/health/health.js';
import {
  APPLICATION_MIGRATIONS,
  APPLICATION_SCHEMA_FLOOR,
  ApplicationReadinessService,
  readApplicationMigrations,
} from '../src/health/readiness.js';

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@127.0.0.1/whaleu_test',
  PG_SSL_MODE: 'disable',
  LOG_LEVEL: 'silent',
});
const requirements: Migration[] = Array.from({ length: 179 }, (_, index) => ({
  name:
    index === 178
      ? APPLICATION_SCHEMA_FLOOR
      : `${String(index + 1).padStart(4, '0')}_fixture.sql`,
  sql: `SELECT ${index + 1};\n`,
  checksum: createHash('sha256')
    .update(`SELECT ${index + 1};\n`)
    .digest('hex'),
}));
type HistoryRow = {
  name: string | null;
  checksum: string | null;
};
const history = (
  migrations: readonly Migration[] = requirements,
): HistoryRow[] => migrations.map(({ name, checksum }) => ({ name, checksum }));

function fixture(
  options: {
    config?: RuntimeConfig;
    migrations?: readonly Migration[];
    read?: () => Promise<readonly Migration[]>;
  } = {},
) {
  const state = {
    databaseReady: true,
    rows: history(),
    gateRows: [{ locked: true }] as { locked: boolean }[],
    releases: [] as (boolean | undefined)[],
    error: undefined as Error | undefined,
    reads: 0,
    queries: [] as { sql: string; values: unknown[] | undefined }[],
  };
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      state.queries.push({ sql, values });
      if (sql.includes('schema_migrations')) {
        if (state.error) throw state.error;
        return { rows: state.rows };
      }
      if (sql.includes('pg_try_advisory_xact_lock_shared'))
        return { rows: state.gateRows };
      return { rows: [] };
    },
    release: (destroy?: boolean) => {
      state.releases.push(destroy);
    },
  } as unknown as PoolClient;
  const database = {
    ready: async () => state.databaseReady,
    transaction: <T>(
      operation: (tx: PoolClient) => Promise<T>,
      options: TransactionOptions,
    ) =>
      inTransaction(
        { connect: async () => ({ ...client }) as PoolClient },
        operation,
        options,
      ),
  } as unknown as DatabaseService;
  const read = async () => {
    state.reads++;
    return options.read ? options.read() : (options.migrations ?? requirements);
  };
  const service = new ApplicationReadinessService(
    database,
    options.config ?? config,
    read,
  );
  return { service, state, database, read };
}

test('complete current installation is ready with formatting and providers disabled', async () => {
  const { service, state } = fixture();
  assert.equal(config.COMMUNITY_READING_FORMATTING_PROCESSING, 'disabled');
  assert.equal(config.COMMUNITY_TEXT_REVIEW, 'disabled');
  assert.equal(config.WECHAT_APP_ID, undefined);
  assert.equal(await service.ready(), true);
  assert.deepEqual(state.queries.map(({ sql }) => sql).slice(0, 2), [
    'BEGIN ISOLATION LEVEL READ COMMITTED',
    'SET TRANSACTION READ ONLY',
  ]);
  assert.match(state.queries[2]!.sql, /pg_try_advisory_xact_lock_shared/);
  assert.deepEqual(state.queries[2]?.values, [...MIGRATION_LOCK]);
  assert.deepEqual(state.queries[3]?.values, [180]);
  const sql = state.queries[3]!.sql;
  assert.match(sql, /LIMIT \$1/);
  assert.match(sql, /octet_length\(name\) <= 255/);
  assert.match(sql, /octet_length\(checksum\) = 64/);
  assert.doesNotMatch(
    state.queries.map(({ sql }) => sql).join('\n'),
    /\b(?:CREATE|INSERT|UPDATE|DELETE|TRUNCATE|GRANT|LOCK TABLE)\b/i,
  );
  assert.doesNotMatch(sql, /ORDER BY|coverage|official_account|0175/);
  assert.equal(state.queries[4]?.sql, 'COMMIT');
  assert.deepEqual(state.releases, [false]);
});

test('existing migration loader supplies the exact checked-in naming and SHA-256 rules', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'whaleu-application-migrations-'),
  );
  try {
    await Promise.all(
      requirements.map(({ name, sql }) =>
        writeFile(join(directory, name), sql),
      ),
    );
    assert.deepEqual(
      await readApplicationMigrations(directory),
      await readMigrations(directory),
    );
    const { service } = fixture({
      read: () => readApplicationMigrations(directory),
    });
    assert.equal(await service.ready(), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('missing, unknown, drifted, gapped and malformed ledger histories fail closed', async (t) => {
  const mutations: Record<string, (rows: HistoryRow[]) => HistoryRow[]> = {
    empty: () => [],
    historical175: (rows) => rows.slice(0, 175),
    missingLast: (rows) => rows.slice(0, -1),
    middleGap: (rows) => rows.filter((_, index) => index !== 70),
    unknown: (rows) => [
      ...rows.slice(0, -1),
      { ...rows.at(-1)!, name: '0179_unknown.sql' },
    ],
    futureNotPackaged: (rows) => [
      ...rows,
      {
        name: '0180_future_fixture.sql',
        checksum: 'a'.repeat(64),
      },
    ],
    drifted: (rows) =>
      rows.map((row, index) =>
        index === 20 ? { ...row, checksum: 'b'.repeat(64) } : row,
      ),
    duplicate: (rows) => [...rows.slice(0, -1), rows[0]!],
    nullName: (rows) =>
      rows.map((row, index) => (index === 10 ? { ...row, name: null } : row)),
    nullChecksum: (rows) =>
      rows.map((row, index) =>
        index === 10 ? { ...row, checksum: null } : row,
      ),
  };
  for (const [name, mutate] of Object.entries(mutations))
    await t.test(name, async () => {
      const { service, state } = fixture();
      state.rows = mutate(history());
      assert.equal(await service.ready(), false);
    });
});

test('ledger ordering is irrelevant; complete unique checksums remain mandatory', async () => {
  const { service, state } = fixture();
  state.rows.reverse();
  assert.equal(await service.ready(), true);
});

test('missing or inconsistent deployment files cannot lower current requirements', async (t) => {
  const artifacts = {
    absent: [],
    historical175: requirements.slice(0, 175),
    gap: requirements.filter((_, index) => index !== 2),
    wrongFloor: requirements.map((migration, index) =>
      index === 178 ? { ...migration, name: '0179_other.sql' } : migration,
    ),
    wrongSequence: requirements.map((migration, index) =>
      index === 70
        ? { ...migration, name: '0070_duplicate_number.sql' }
        : migration,
    ),
    invalidChecksum: requirements.map((migration, index) =>
      index === 2 ? { ...migration, checksum: 'invalid' } : migration,
    ),
    tooMany: Array.from({ length: 10000 }, () => requirements[0]!),
  };
  for (const [name, migrations] of Object.entries(artifacts))
    await t.test(name, async () => {
      const { service, state } = fixture({ migrations });
      assert.equal(await service.ready(), false);
      assert.equal(state.queries.length, 0);
    });
});

test('future deployment requirements extend from the same migration source, not a permanent 179 cutoff', async () => {
  const next = {
    name: '0180_future_fixture.sql',
    checksum: 'a'.repeat(64),
    sql: 'SELECT 180;',
  };
  const migrations = [...requirements, next];
  const { service, state } = fixture({ migrations });
  assert.equal(await service.ready(), false);
  state.rows = history(migrations);
  assert.equal(await service.ready(), true);
  assert.deepEqual(
    state.queries.filter(({ sql }) => sql.includes('schema_migrations')).at(-1)
      ?.values,
    [181],
  );
});

test('configuration uses existing validation without adding provider activation requirements', async (t) => {
  const changes = {
    missingDefault: { COMMUNITY_READING_FORMATTING_PROCESSING: undefined },
    missingSourceReviewScope: { COMMUNITY_TEXT_REVIEW: 'source_manual' },
    incompleteAuth: { WECHAT_APP_ID: 'wx1234567890123456' },
    missingRequiredSecret: { IDENTITY_REGISTRATION_GUARD: 'required' },
    invalidSecret: {
      IDENTITY_DELETION_DIGEST_KEYRING: 'private-invalid-secret',
    },
    productionWithoutTls: { NODE_ENV: 'production' },
    disabledDependencies: { HOT_FEED_PROCESSING: 'automatic' },
  };
  for (const [name, change] of Object.entries(changes))
    await t.test(name, async () => {
      const { service, state } = fixture({
        config: { ...config, ...change } as RuntimeConfig,
      });
      assert.equal(await service.ready(), false);
      assert.equal(state.queries.length, 0);
    });
});

test('database outage, unsupported version and shutdown remain unready without probing history', async () => {
  const { service, state } = fixture();
  state.databaseReady = false;
  assert.equal(await service.ready(), false);
  assert.equal(state.reads, 0);
  assert.equal(state.queries.length, 0);
});

test('migration files are loaded once, concurrent probes share the load, history is never cached', async () => {
  let release!: (migrations: readonly Migration[]) => void;
  const pending = new Promise<readonly Migration[]>((resolve) => {
    release = resolve;
  });
  const { service, state } = fixture({ read: () => pending });
  const first = service.ready();
  const second = service.ready();
  await Promise.resolve();
  assert.equal(state.reads, 1);
  release(requirements);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  state.rows = history().slice(0, 175);
  assert.equal(await service.ready(), false);
  assert.equal(state.reads, 1);
  assert.equal(
    state.queries.filter(({ sql }) => sql.includes('schema_migrations')).length,
    3,
  );
});

test('unreadable deployment artifact stays closed without repeated filesystem work', async () => {
  const { service, state } = fixture({
    read: async () => {
      throw new Error('private-artifact-path');
    },
  });
  assert.equal(await service.ready(), false);
  assert.equal(await service.ready(), false);
  assert.equal(state.reads, 1);
  assert.equal(state.queries.length, 0);
});

test('missing ledger, denied SELECT and raw SQL errors disclose no internal detail', async () => {
  const { service, state } = fixture();
  const controller = new HealthController(service);
  state.error = new Error('private-database-credential-and-schema-path');
  assert.equal(await service.ready(), false);
  await assert.rejects(controller.ready(), (error: unknown) => {
    assert.ok(error instanceof ServiceUnavailableException);
    assert.equal(error.getStatus(), 503);
    assert.doesNotMatch(
      JSON.stringify(error.getResponse()),
      /private|migration|checksum|credential/i,
    );
    return true;
  });
  assert.deepEqual(controller.live(), { status: 'ok' });
});

test('real HealthModule wiring preserves independent liveness and installs the application gate', async () => {
  const { state, database, read } = fixture();
  const module = await Test.createTestingModule({
    imports: [ConfigurationModule.register(config), HealthModule],
  })
    .overrideProvider(DatabaseService)
    .useValue(database)
    .overrideProvider(APPLICATION_MIGRATIONS)
    .useValue(read)
    .compile();
  try {
    const controller = module.get(HealthController);
    assert.deepEqual(controller.live(), { status: 'ok' });
    assert.equal(state.reads, 0);
    assert.deepEqual(await controller.ready(), { status: 'ok' });
    state.rows = history().slice(0, 175);
    await assert.rejects(controller.ready(), ServiceUnavailableException);
    assert.deepEqual(controller.live(), { status: 'ok' });
  } finally {
    await module.close();
  }
});

test('migration contention or malformed lock response fails before reading history', async (t) => {
  for (const gateRows of [
    [],
    [{ locked: false }],
    [{ locked: true }, { locked: true }],
  ])
    await t.test(JSON.stringify(gateRows), async () => {
      const { service, state } = fixture();
      state.gateRows = gateRows;
      assert.equal(await service.ready(), false);
      assert.equal(
        state.queries.some(({ sql }) => sql.includes('schema_migrations')),
        false,
      );
      assert.equal(state.queries.at(-1)?.sql, 'COMMIT');
      assert.deepEqual(state.releases, [false]);
    });
});

test('ledger query errors roll back and release the shared migration transaction', async () => {
  const { service, state } = fixture();
  state.error = new Error('private-query-error');
  assert.equal(await service.ready(), false);
  assert.equal(state.queries.at(-1)?.sql, 'ROLLBACK');
  assert.deepEqual(state.releases, [false]);
});

test('transaction completion failure cannot escape as readiness success', async () => {
  const database = {
    ready: async () => true,
    transaction: async () => {
      throw new Error('private-commit-error');
    },
  } as unknown as DatabaseService;
  const service = new ApplicationReadinessService(
    database,
    config,
    async () => requirements,
  );
  assert.equal(await service.ready(), false);
});

test('migration contention maps to 503 while liveness remains independent', async () => {
  const { service, state } = fixture();
  state.gateRows = [{ locked: false }];
  const controller = new HealthController(service);
  await assert.rejects(controller.ready(), (error: unknown) => {
    assert.ok(error instanceof ServiceUnavailableException);
    assert.equal(error.getStatus(), 503);
    return true;
  });
  assert.deepEqual(controller.live(), { status: 'ok' });
  assert.equal(
    state.queries.some(({ sql }) => sql.includes('schema_migrations')),
    false,
  );
});

test('readiness disclosure proof permits opaque migration-like request IDs but rejects leaked data', () => {
  const requestId = '00000179-0000-4000-8000-000000000000';
  const body = {
    error: { code: 'NOT_READY', message: 'Service is not ready', requestId },
  };
  assert.doesNotThrow(() =>
    assertReadinessUnavailableResponse(body, requestId),
  );
  assert.throws(() =>
    assertReadinessUnavailableResponse(body, 'different-request'),
  );
  assert.throws(() =>
    assertReadinessUnavailableResponse(
      { error: { ...body.error, message: 'postgresql password private' } },
      requestId,
    ),
  );
  assert.throws(() =>
    assertReadinessUnavailableResponse(
      { error: { ...body.error, checksum: 'private' } },
      requestId,
    ),
  );
});
