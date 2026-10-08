import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import type { DatabaseService } from '../src/database/database.js';
import { ViewComponentCleanup } from '../src/community/view-component/cleanup.js';
import { ApplicationError } from '../src/http/application-error.js';
function cleanupFixture() {
  const calls: { sql: string; values: unknown[] | undefined }[] = [];
  let receiptRows = 300,
    epochRows = 1,
    detailRows = 40;
  let lagging = false,
    broken = false;
  const tx = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      if (broken) throw new Error('database offline');
      if (sql.includes(' AS lagging'))
        return { rows: [{ lagging }], rowCount: 1 };
      if (
        sql.startsWith(
          'SELECT id FROM whaleu_post_hotness.view_reporting_epochs',
        )
      )
        return { rows: epochRows ? [{ id: 'epoch' }] : [] };
      if (
        sql.startsWith('DELETE FROM whaleu_post_hotness.view_report_receipts')
      ) {
        const removed = Math.min(receiptRows, Number(values![1]));
        receiptRows -= removed;
        return { rows: [], rowCount: removed };
      }
      if (
        sql.startsWith('DELETE FROM whaleu_post_hotness.view_reporting_epochs')
      ) {
        const removed = receiptRows ? 0 : epochRows;
        epochRows -= removed;
        return { rows: [], rowCount: removed };
      }
      if (sql.startsWith('WITH candidates')) {
        const removed = Math.min(detailRows, Number(values![0]));
        detailRows -= removed;
        return { rows: [], rowCount: removed };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  const db = {
    transaction: async (fn: (tx: PoolClient) => Promise<unknown>) => fn(tx),
  } as DatabaseService;
  return {
    cleanup: new ViewComponentCleanup(db),
    tx,
    calls,
    lag: () => {
      lagging = true;
    },
    fail: () => {
      broken = true;
    },
  };
}
const unavailable = (error: unknown) =>
  error instanceof ApplicationError &&
  error.code === 'VIEW_REPORTING_UNAVAILABLE';
test('cleanup chunks count child deletions, retain nonempty expired epoch and never touch aggregates', async () => {
  const f = cleanupFixture();
  const result = await f.cleanup.run();
  assert.deepEqual(result, {
    epochs: 1,
    receipts: 300,
    detailWindows: 40,
    quotas: 0,
    lagging: false,
  });
  const receiptQueries = f.calls.filter((c) =>
    c.sql.startsWith('DELETE FROM whaleu_post_hotness.view_report_receipts'),
  );
  assert.equal(receiptQueries.length, 2);
  for (const q of receiptQueries) assert.equal(q.values![1], 255);
  const detailQueries = f.calls.filter((c) =>
    c.sql.startsWith('WITH candidates'),
  );
  assert.equal(detailQueries[0]!.values![0], 1);
  assert.equal(detailQueries[1]!.values![0], 210);
  assert.equal(
    f.calls.some((c) => /view_states|view_baselines/.test(c.sql)),
    false,
  );
  assert.ok(f.calls.some((c) => /FOR UPDATE SKIP LOCKED/.test(c.sql)));
});
test('automatic admission requires a successful sweep and fails closed on later cleanup error', async () => {
  const f = cleanupFixture();
  f.cleanup.requireSuccessfulSweep();
  await assert.rejects(f.cleanup.assertAdmission(f.tx), unavailable);
  await f.cleanup.run();
  await f.cleanup.assertAdmission(f.tx);
  f.fail();
  await assert.rejects(f.cleanup.run(), /database offline/);
  await assert.rejects(f.cleanup.assertAdmission(f.tx), unavailable);
});
test('manual and fresh runtime admissions both reject material database retention lag', async () => {
  const f = cleanupFixture();
  f.lag();
  await assert.rejects(f.cleanup.assertAdmission(f.tx), unavailable);
  f.cleanup.requireSuccessfulSweep();
  assert.equal((await f.cleanup.run()).lagging, true);
  await assert.rejects(f.cleanup.assertAdmission(f.tx), unavailable);
});
