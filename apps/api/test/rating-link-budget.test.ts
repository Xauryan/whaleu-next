import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  dependencyRows,
  observeDependencyRead,
  withDependencyReadBudget,
} from '../src/database/dependency-read-budget.js';
import { SnapshotReadBudget } from '../src/community/content-review/count-snapshot.repository.js';

test('rating card dependency byte preflight preserves client and native parsers, charges full owner rows, fails before oversized evidence', async () => {
  const instant = new Date(),
    budget = new SnapshotReadBudget();
  let last = '';
  let oversized = false;
  const tx = {
    query: async (sql: string) => {
      last = sql;
      return {
        rows: [
          oversized
            ? {
                __dependency_count: '1',
                __dependency_bytes: String(4 * 1024 * 1024 + 1),
                body: null,
              }
            : {
                __dependency_count: '1',
                __dependency_bytes: '128',
                id: 'current',
                at: instant,
                body: 'qualified proof',
              },
        ],
      };
    },
  } as unknown as PoolClient;
  await withDependencyReadBudget(tx, budget, async () => {
    const rows = await dependencyRows(
      tx,
      'SELECT id,at,body FROM accepted_owner WHERE id=$1',
      ['current'],
      256,
    );
    assert.equal(rows[0]!['at'], instant);
    assert.deepEqual(Object.keys(rows[0]!), ['id', 'at', 'body']);
    assert.match(last, /pg_column_size/);
    assert.match(last, /LEFT JOIN dependency_source s ON/);
    const before = budget.remainingBytes();
    observeDependencyRead(tx, rows);
    assert.equal(
      budget.remainingBytes(),
      before - Buffer.byteLength(JSON.stringify(rows)),
    );
    oversized = true;
    await assert.rejects(
      dependencyRows(tx, 'SELECT body FROM accepted_owner', [], 768),
    );
    await assert.rejects(
      withDependencyReadBudget(tx, budget, async () => undefined),
    );
  });
  const legacy = {
    query: async (sql: string) => {
      assert.equal(sql, 'SELECT native_old_query');
      return { rows: [{ id: 'old' }] };
    },
  } as unknown as PoolClient;
  assert.deepEqual(
    await dependencyRows(legacy, 'SELECT native_old_query', [], 256),
    [{ id: 'old' }],
  );
});
