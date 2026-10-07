import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { inTransaction } from '../src/database/database.js';
import {
  checkTransactionDeadlines,
  checkpointTransactionDeadlines,
  clearTransactionDeadlines,
  registerTransactionDeadline,
  restoreTransactionDeadlines,
  startTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { ApplicationError } from '../src/http/application-error.js';

const errorIs = (code: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;
const immediate = 'SET CONSTRAINTS ALL IMMEDIATE';
const clock = 'SELECT clock_timestamp() AS now';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const commands: string[] = [];
  const releases: boolean[] = [];
  const state = {
    now: new Date(100),
    failure: null as { sql: string; error: Error } | null,
    beforeImmediate: async () => {},
  };
  const tx = {
    query: async (sql: string) => {
      commands.push(sql);
      if (state.failure?.sql === sql) throw state.failure.error;
      if (sql === immediate) await state.beforeImmediate();
      return { rows: sql === clock ? [{ now: state.now }] : [] };
    },
    release: (destroy: boolean) => {
      releases.push(destroy);
    },
  } as unknown as PoolClient;
  const pool = { connect: async () => tx } as unknown as Pick<Pool, 'connect'>;
  return { commands, pool, releases, state, tx };
}

test('null and standalone finite deadlines do not introduce database reads', async () => {
  const f = fixture();
  registerTransactionDeadline(f.tx, 0, 'SAFETY_UNAVAILABLE');
  await checkTransactionDeadlines(f.tx);
  startTransactionDeadlines(f.tx);
  registerTransactionDeadline(f.tx, null, 'SAFETY_UNAVAILABLE');
  await checkTransactionDeadlines(f.tx);
  assert.deepEqual(f.commands, []);
  assert.equal(checkpointTransactionDeadlines(f.tx).size, 0);
  clearTransactionDeadlines(f.tx);
});

test('non-finite registrations reject with their owner code even outside a managed transaction', () => {
  for (const active of [false, true]) {
    const f = fixture();
    if (active) startTransactionDeadlines(f.tx);
    for (const until of [NaN, Infinity, -Infinity]) {
      assert.throws(
        () =>
          registerTransactionDeadline(
            f.tx,
            until,
            'PHONE_VERIFICATION_REQUIRED',
          ),
        errorIs('PHONE_VERIFICATION_REQUIRED'),
      );
    }
    assert.equal(checkpointTransactionDeadlines(f.tx).size, 0);
    assert.deepEqual(f.commands, []);
    clearTransactionDeadlines(f.tx);
  }
});

test('registration keeps the earliest deadline per code and preserves distinct owners', async () => {
  const f = fixture();
  startTransactionDeadlines(f.tx);
  registerTransactionDeadline(f.tx, 500, 'SAFETY_UNAVAILABLE');
  registerTransactionDeadline(f.tx, 200, 'SAFETY_UNAVAILABLE');
  registerTransactionDeadline(f.tx, 400, 'SAFETY_UNAVAILABLE');
  registerTransactionDeadline(f.tx, null, 'SAFETY_UNAVAILABLE');
  registerTransactionDeadline(f.tx, 150, 'PHONE_VERIFICATION_REQUIRED');
  assert.deepEqual(
    [...checkpointTransactionDeadlines(f.tx)],
    [
      ['SAFETY_UNAVAILABLE', 200],
      ['PHONE_VERIFICATION_REQUIRED', 150],
    ],
  );
  await checkTransactionDeadlines(f.tx);
  f.state.now = new Date(150);
  await assert.rejects(
    checkTransactionDeadlines(f.tx),
    errorIs('PHONE_VERIFICATION_REQUIRED'),
  );
  clearTransactionDeadlines(f.tx);
});

test('finite past and exactly-current deadlines expire without a grace interval', async () => {
  for (const until of [-1, 0, 100]) {
    const f = fixture();
    startTransactionDeadlines(f.tx);
    registerTransactionDeadline(f.tx, until, 'SAFETY_UNAVAILABLE');
    await assert.rejects(
      checkTransactionDeadlines(f.tx),
      errorIs('SAFETY_UNAVAILABLE'),
    );
    assert.deepEqual(f.commands, [immediate, clock]);
    clearTransactionDeadlines(f.tx);
  }
});

test('starting and clearing a transaction reset the reused client registry', async () => {
  const f = fixture();
  startTransactionDeadlines(f.tx);
  registerTransactionDeadline(f.tx, 0, 'SAFETY_UNAVAILABLE');
  const old = checkpointTransactionDeadlines(f.tx);
  startTransactionDeadlines(f.tx);
  await checkTransactionDeadlines(f.tx);
  registerTransactionDeadline(f.tx, 0, 'PHONE_VERIFICATION_REQUIRED');
  clearTransactionDeadlines(f.tx);
  restoreTransactionDeadlines(f.tx, old);
  await checkTransactionDeadlines(f.tx);
  assert.equal(checkpointTransactionDeadlines(f.tx).size, 0);
  assert.deepEqual(f.commands, []);
});

test('savepoint restoration discards inner facts and uses isolated checkpoint copies', async () => {
  const f = fixture();
  startTransactionDeadlines(f.tx);
  registerTransactionDeadline(f.tx, 300, 'SAFETY_UNAVAILABLE');
  const checkpoint = checkpointTransactionDeadlines(f.tx);
  registerTransactionDeadline(f.tx, 50, 'SAFETY_UNAVAILABLE');
  registerTransactionDeadline(f.tx, 50, 'PHONE_VERIFICATION_REQUIRED');
  assert.deepEqual([...checkpoint], [['SAFETY_UNAVAILABLE', 300]]);
  restoreTransactionDeadlines(f.tx, checkpoint);
  checkpoint.set('SAFETY_UNAVAILABLE', 0);
  checkpoint.set('PHONE_VERIFICATION_REQUIRED', 0);
  assert.deepEqual(
    [...checkpointTransactionDeadlines(f.tx)],
    [['SAFETY_UNAVAILABLE', 300]],
  );
  await checkTransactionDeadlines(f.tx);
  clearTransactionDeadlines(f.tx);
});

test('deferred waits complete before the final clock and an expired result never commits', async () => {
  const f = fixture();
  const entered = deferred(),
    released = deferred();
  f.state.beforeImmediate = async () => {
    entered.resolve();
    await released.promise;
  };
  const transaction = inTransaction(f.pool, async (tx) => {
    registerTransactionDeadline(tx, 150, 'SAFETY_UNAVAILABLE');
    return 'private result';
  });
  const rejected = assert.rejects(transaction, errorIs('SAFETY_UNAVAILABLE'));
  await entered.promise;
  assert.deepEqual(f.commands, ['BEGIN', immediate]);
  f.state.now = new Date(150);
  released.resolve();
  await rejected;
  assert.deepEqual(f.commands, ['BEGIN', immediate, clock, 'ROLLBACK']);
  assert.deepEqual(f.releases, [false]);
  assert.equal(checkpointTransactionDeadlines(f.tx).size, 0);
});

test('deadline success checks deferred constraints and one final clock before COMMIT', async () => {
  const f = fixture();
  const result = await inTransaction(f.pool, async (tx) => {
    registerTransactionDeadline(tx, 101, 'SAFETY_UNAVAILABLE');
    registerTransactionDeadline(tx, 200, 'PHONE_VERIFICATION_REQUIRED');
    return 42;
  });
  assert.equal(result, 42);
  assert.deepEqual(f.commands, ['BEGIN', immediate, clock, 'COMMIT']);
  assert.deepEqual(f.releases, [false]);
  assert.equal(checkpointTransactionDeadlines(f.tx).size, 0);
  f.commands.length = 0;
  assert.equal(await inTransaction(f.pool, async () => 43), 43);
  assert.deepEqual(f.commands, ['BEGIN', 'COMMIT']);
});

test('deferred-constraint and clock-query failures roll back instead of returning a result', async () => {
  for (const sql of [immediate, clock]) {
    const f = fixture();
    const failure = new Error('Synthetic database failure');
    f.state.failure = { sql, error: failure };
    await assert.rejects(
      inTransaction(f.pool, async (tx) => {
        registerTransactionDeadline(tx, 200, 'SAFETY_UNAVAILABLE');
        return 'private result';
      }),
      (error) => error === failure,
    );
    assert.deepEqual(
      f.commands,
      sql === immediate
        ? ['BEGIN', immediate, 'ROLLBACK']
        : ['BEGIN', immediate, clock, 'ROLLBACK'],
    );
    assert.deepEqual(f.releases, [false]);
    assert.equal(checkpointTransactionDeadlines(f.tx).size, 0);
    f.state.failure = null;
    f.commands.length = 0;
    await inTransaction(f.pool, async () => 'next transaction');
    assert.deepEqual(f.commands, ['BEGIN', 'COMMIT']);
  }
});

test('operation failure clears deadlines before the pooled client is reused', async () => {
  const f = fixture();
  const failure = new Error('Synthetic operation failure');
  await assert.rejects(
    inTransaction(f.pool, async (tx) => {
      registerTransactionDeadline(tx, 0, 'SAFETY_UNAVAILABLE');
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.deepEqual(f.commands, ['BEGIN', 'ROLLBACK']);
  assert.equal(checkpointTransactionDeadlines(f.tx).size, 0);
  f.commands.length = 0;
  await inTransaction(f.pool, async () => 'next transaction');
  assert.deepEqual(f.commands, ['BEGIN', 'COMMIT']);
});

test('an invalid final clock cannot silently allow a transaction with deadlines', async () => {
  const f = fixture();
  f.state.now = new Date(NaN);
  await assert.rejects(
    inTransaction(f.pool, async (tx) => {
      registerTransactionDeadline(tx, 200, 'SAFETY_UNAVAILABLE');
      return 'private result';
    }),
    errorIs('COMMUNITY_UNAVAILABLE'),
  );
  assert.deepEqual(f.commands, ['BEGIN', immediate, clock, 'ROLLBACK']);
  assert.deepEqual(f.releases, [false]);
});
