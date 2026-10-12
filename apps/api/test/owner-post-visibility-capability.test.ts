import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { retainOwnerRestoreCapability } from '../src/community/owner-visibility/capability.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';

const initial = () => ({
  block_coverage: 'complete',
  restriction_coverage: 'complete',
  provenance: 'native_account_creation',
  actions_allowed: true as boolean | null,
  valid_until: null as Date | null,
  version: '100',
});
function fixture() {
  let head: ReturnType<typeof initial> | null = initial();
  let now = Date.now();
  let locked = false;
  const calls: string[] = [];
  const tx = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.includes('FROM whaleu_safety.account_heads')) {
        if (locked)
          throw Object.assign(new Error('busy owner'), { code: '55P03' });
        return { rows: head ? [{ ...head }] : [] };
      }
      if (sql.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '15s',
              lock_timeout: '0',
            },
          ],
        };
      if (sql.includes("current_setting('statement_timeout')"))
        return { rows: [{ statement_timeout: '15s', lock_timeout: '0' }] };
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date(now) }] };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  return {
    tx,
    calls,
    setHead(value: typeof head) {
      head = value;
    },
    setNow(value: number) {
      now = value;
    },
    lock(value = true) {
      locked = value;
    },
    now: () => now,
  };
}

test('visible hide and disabled targets never read optional Safety', async () => {
  const f = fixture();
  try {
    const visible = { ownerHidden: false, canChange: true },
      deleted = { ownerHidden: true, canChange: false };
    await retainOwnerRestoreCapability('actor', visible, f.tx);
    await retainOwnerRestoreCapability('actor', deleted, f.tx);
    assert.equal(visible.canChange, true);
    assert.equal(deleted.canChange, false);
    assert.deepEqual(f.calls, []);
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});
test('restricted, unknown, expired or contended restore stays minimal with canChange false', async () => {
  for (const state of [
    null,
    { ...initial(), actions_allowed: false },
    { ...initial(), restriction_coverage: 'missing' },
    { ...initial(), block_coverage: 'missing' },
    { ...initial(), provenance: 'unknown' },
    { ...initial(), valid_until: new Date(0) },
    'locked',
  ] as const) {
    const f = fixture();
    try {
      if (state === 'locked') f.lock();
      else f.setHead(state);
      const view = { ownerHidden: true, canChange: true };
      await retainOwnerRestoreCapability('actor', view, f.tx);
      assert.equal(view.canChange, false);
      await checkTransactionDeadlines(f.tx);
      assert.ok(
        f.calls.includes('ROLLBACK TO SAVEPOINT owner_restore_capability'),
      );
    } finally {
      clearTransactionDeadlines(f.tx);
    }
  }
});
test('optional final expiry, changed fingerprint and lock uncertainty narrow the exact response object', async () => {
  for (const change of [
    'none',
    'expires',
    'version',
    'restricted',
    'locked',
  ] as const) {
    const f = fixture();
    try {
      const head = { ...initial(), valid_until: new Date(f.now() + 1000) };
      f.setHead(head);
      const view = { ownerHidden: true, canChange: true };
      await retainOwnerRestoreCapability('actor', view, f.tx);
      assert.equal(view.canChange, true);
      if (change === 'expires') f.setNow(f.now() + 1001);
      if (change === 'version') f.setHead({ ...head, version: '101' });
      if (change === 'restricted')
        f.setHead({ ...head, actions_allowed: false });
      if (change === 'locked') f.lock();
      await checkTransactionDeadlines(f.tx);
      assert.equal(view.canChange, change === 'none', change);
    } finally {
      clearTransactionDeadlines(f.tx);
    }
  }
});
