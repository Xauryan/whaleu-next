import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  OptionalCountRunner,
  OptionalCountUnavailable,
} from '../src/database/optional-count.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
function client() {
  const commands: string[] = [];
  const tx = {
    query: async (sql: string) => {
      commands.push(sql);
      return {
        rows: sql.includes("current_setting('statement_timeout')")
          ? [{ statement_timeout: '15s', lock_timeout: '0', work_mem: '4MB' }]
          : [],
      };
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  return { tx, commands };
}
test('optional count preserves large bigint and final bounded fallback equality', async () => {
  const f = client();
  try {
    const runner = new OptionalCountRunner(2);
    const count = await runner.attempt(
      f.tx,
      async () => ({ value: 9007199254740993123456789n, candidates: 1 }),
      2000,
      async () => null,
      async () => {},
    );
    assert.equal(count.status, 'known');
    if (count.status === 'known') {
      assert.equal(count.value.toString(), '9007199254740993123456789');
      assert.equal(await count.proof!(), true);
    }
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});
test('one-connection pools retain page capacity without running optional scan', async () => {
  const f = client();
  try {
    let scanned = false;
    const count = await new OptionalCountRunner(1).attempt(
      f.tx,
      async () => {
        scanned = true;
        return { value: 0n, candidates: 0 };
      },
      2000,
      async () => null,
      async () => {},
    );
    assert.equal(count.status, 'unavailable');
    assert.equal(scanned, false);
    assert.deepEqual(f.commands, []);
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});
test('shared pool/config scope caps mixed-domain admission and releases capacity after failure', async () => {
  const a = client(),
    b = client(),
    scope = {};
  try {
    const first = new OptionalCountRunner(2, scope),
      second = new OptionalCountRunner(2, scope);
    let release!: () => void;
    let started!: () => void;
    const began = new Promise<void>((r) => {
      started = r;
    });
    const wait = new Promise<void>((r) => {
      release = r;
    });
    const active = first.attempt(
      a.tx,
      async () => {
        started();
        await wait;
        throw new OptionalCountUnavailable();
      },
      2000,
      async () => null,
      async () => {},
    );
    await began;
    const blocked = await second.attempt(
      b.tx,
      async () => ({ value: 0n, candidates: 0 }),
      2000,
      async () => null,
      async () => {},
    );
    assert.equal(blocked.status, 'unavailable');
    assert.deepEqual(b.commands, []);
    release();
    assert.equal((await active).status, 'unavailable');
    assert.ok(
      a.commands.includes('ROLLBACK TO SAVEPOINT discovery_optional_count'),
    );
    assert.equal(
      (
        await second.attempt(
          b.tx,
          async () => ({ value: 0n, candidates: 0 }),
          2000,
          async () => null,
          async () => {},
        )
      ).status,
      'known',
    );
  } finally {
    clearTransactionDeadlines(a.tx);
    clearTransactionDeadlines(b.tx);
  }
});
