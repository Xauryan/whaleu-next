import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  IdentityMaintenance,
  maintenanceOptions,
} from '../src/identity/maintenance.js';
import {
  assertMaintenancePermission,
  parseMaintenanceCommand,
} from '../src/identity/maintenance-options.js';

function fixture(
  query: (
    sql: string,
    values: unknown[],
  ) => { rows: object[]; rowCount?: number },
) {
  const statements: string[] = [];
  let commits = 0;
  let rollbacks = 0;
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      statements.push(sql);
      return query(sql, values);
    },
  } as unknown as PoolClient;
  const service = new IdentityMaintenance({
    transaction: async (operation) => {
      try {
        const result = await operation(client);
        commits += 1;
        return result;
      } catch (error) {
        rollbacks += 1;
        throw error;
      }
    },
  });
  return {
    service,
    statements,
    commits: () => commits,
    rollbacks: () => rollbacks,
  };
}
const state = { version: 180006, cutoff: new Date('2026-01-01T00:00:00Z') };

test('maintenance defaults are dry-run, bounded and retain terminal sessions thirty days', () => {
  assert.deepEqual(maintenanceOptions({}), {
    mode: 'dry-run',
    batchSize: 100,
    retentionDays: 30,
  });
  for (const input of [
    { batchSize: 0 },
    { batchSize: 1001 },
    { retentionDays: 0 },
    { retentionDays: 3651 },
    { mode: 'delete-all' },
    { unsafe: true },
  ])
    assert.throws(
      () => maintenanceOptions(input),
      /Invalid authentication maintenance options/,
    );
});

test('CLI requires explicit apply and additional production opt-in, never broadens data scope', () => {
  const defaults = parseMaintenanceCommand([]);
  assert.equal(defaults.mode, 'dry-run');
  assert.equal(defaults.allowProduction, false);
  assert.doesNotThrow(() =>
    assertMaintenancePermission(defaults, 'production'),
  );
  const apply = parseMaintenanceCommand([
    'apply',
    '--batch-size=25',
    '--retention-days=90',
    '--batches=3',
  ]);
  assert.equal(apply.batchSize, 25);
  assert.equal(apply.retentionDays, 90);
  assert.equal(apply.batches, 3);
  assert.throws(
    () => assertMaintenancePermission(apply, 'production'),
    /explicit operator opt-in/,
  );
  assert.doesNotThrow(() =>
    assertMaintenancePermission(
      parseMaintenanceCommand(['apply', '--allow-production']),
      'production',
    ),
  );
  for (const args of [
    ['unknown'],
    ['apply', '--batch-size=1', '--batch-size=2'],
    ['apply', '--batches=101'],
    ['dry-run', '--batches=2'],
    ['apply', '--allow-production', '--allow-production'],
    ['--retention-days=private-secret'],
  ])
    assert.throws(
      () => parseMaintenanceCommand(args),
      (error: Error) => !error.message.includes('private-secret'),
    );
});

test('dry-run previews at most the row budget in a read-only transaction without locks or deletions', async () => {
  const database = fixture((sql, values) => {
    if (sql.startsWith('SET TRANSACTION')) return { rows: [] };
    if (sql.startsWith('SELECT current_setting')) return { rows: [state] };
    if (sql.startsWith('SELECT id FROM')) {
      assert.equal(values[1], 3);
      return { rows: [{ id: 'session' }] };
    }
    if (sql.startsWith('SELECT token_hash FROM whaleu_identity.access')) {
      assert.equal(values[1], 3);
      return { rows: [{ token_hash: 'a' }, { token_hash: 'b' }] };
    }
    if (sql.startsWith('SELECT token_hash FROM whaleu_identity.refresh')) {
      assert.equal(values[1], 1);
      return { rows: [{ token_hash: 'c' }] };
    }
    if (sql.startsWith('SELECT s.id')) {
      assert.equal(values[3], 0);
      return { rows: [] };
    }
    assert.fail('Unexpected mutating SQL');
  });
  const result = await database.service.run({ batchSize: 3 });
  assert.equal(result.accessTokens + result.refreshTokens + result.sessions, 3);
  assert.equal(result.sessions, 0);
  assert.ok(database.statements[0]?.includes('READ ONLY'));
  assert.ok(
    database.statements.every((sql) => !/DELETE|UPDATE|INSERT/.test(sql)),
  );
});

test('apply locks terminal sessions and deletes only planned token rows and empty sessions', async () => {
  const database = fixture((sql, values) => {
    if (sql.startsWith('SELECT current_setting')) return { rows: [state] };
    if (sql.startsWith('SELECT id FROM')) {
      assert.match(sql, /FOR UPDATE SKIP LOCKED/);
      assert.equal(values[1], 3);
      return { rows: [{ id: 'session' }] };
    }
    if (sql.startsWith('SELECT token_hash'))
      return {
        rows: [{ token_hash: sql.includes('access_tokens') ? 'a' : 'b' }],
      };
    if (sql.startsWith('SELECT s.id')) {
      assert.equal(values[3], 1);
      return { rows: [{ id: 'session' }] };
    }
    if (sql.startsWith('DELETE FROM whaleu_identity.sessions')) {
      assert.match(sql, /NOT EXISTS.*access_tokens/s);
      assert.match(sql, /NOT EXISTS.*refresh_tokens/s);
      return { rows: [], rowCount: 1 };
    }
    assert.match(
      sql,
      /^DELETE FROM whaleu_identity\.(access_tokens|refresh_tokens)/,
    );
    assert.equal((values[0] as unknown[]).length, 1);
    return { rows: [], rowCount: 1 };
  });
  const result = await database.service.run({ mode: 'apply', batchSize: 3 });
  assert.equal(result.accessTokens + result.refreshTokens + result.sessions, 3);
  assert.ok(
    database.statements.every(
      (sql) =>
        !/accounts|provider_identities|legacy_account_mappings/.test(sql),
    ),
  );
  assert.equal(database.commits(), 1);
});

test('a database failure rolls back the whole cleanup batch', async () => {
  const database = fixture((sql) => {
    if (sql.startsWith('SELECT current_setting')) return { rows: [state] };
    if (sql.startsWith('SELECT id FROM') || sql.startsWith('SELECT s.id'))
      return { rows: [{ id: 'session' }] };
    if (sql.startsWith('SELECT token_hash'))
      return { rows: [{ token_hash: 'hash' }] };
    if (sql.startsWith('DELETE FROM whaleu_identity.refresh'))
      throw new Error('synthetic cleanup failure');
    return { rows: [], rowCount: 1 };
  });
  await assert.rejects(
    database.service.run({ mode: 'apply' }),
    /synthetic cleanup failure/,
  );
  assert.equal(database.commits(), 0);
  assert.equal(database.rollbacks(), 1);
});

test('unsupported PostgreSQL or an empty candidate list never deletes anything', async () => {
  const unsupported = fixture(() => ({
    rows: [{ ...state, version: 170000 }],
  }));
  await assert.rejects(
    unsupported.service.run({ mode: 'apply' }),
    /PostgreSQL 18.6/,
  );
  assert.equal(unsupported.statements.length, 1);
  const empty = fixture((sql) => ({
    rows: sql.startsWith('SELECT current_setting') ? [state] : [],
  }));
  const result = await empty.service.run({ mode: 'apply' });
  assert.equal(result.candidateSessions, 0);
  assert.ok(empty.statements.every((sql) => sql.startsWith('SELECT')));
});
