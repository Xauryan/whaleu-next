import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { inTransaction } from '../src/database/database.js';
import { CountProofCollector } from '../src/database/count-proof.js';
import type {
  CountEpochRow,
  CountProofOwner,
} from '../src/database/count-proof.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
  registerOptionalTransactionProof,
  registerTransactionDeadline,
} from '../src/database/transaction-deadlines.js';
import { ApplicationError } from '../src/http/application-error.js';
const immediate = 'SET CONSTRAINTS ALL IMMEDIATE';
const clock = 'SELECT clock_timestamp() AS now';
const errorIs = (code: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;
function fixture() {
  const commands: string[] = [];
  const settings: unknown[][] = [];
  const state = {
    now: new Date(100),
    isolation: 'read committed',
    writerCapacity: 108,
    failSettings: false,
    failRestore: false,
    failure: null as { sql: string; error: Error } | null,
    beforeImmediate: async () => {},
  };
  const tx = {
    query: async (sql: string, values?: unknown[]) => {
      commands.push(sql);
      if (values) settings.push(values);
      if (
        (state.failSettings &&
          sql.includes("current_setting('lock_timeout')")) ||
        (state.failRestore && values?.[0] === '10s')
      )
        throw Object.assign(new Error('optional setup cancelled'), {
          code: '57014',
        });
      if (state.failure?.sql === sql) throw state.failure.error;
      if (sql === immediate) await state.beforeImmediate();
      return {
        rows:
          sql === clock
            ? [{ now: state.now }]
            : sql.includes("current_setting('statement_timeout')")
              ? [
                  {
                    statement_timeout: '10s',
                    lock_timeout: '0',
                    timeout: '100ms',
                  },
                ]
              : sql.includes("current_setting('transaction_isolation')")
                ? [
                    {
                      isolation: state.isolation,
                      writer_capacity: state.writerCapacity,
                    },
                  ]
                : [],
      };
    },
    release: () => {},
  } as unknown as PoolClient;
  const pool = { connect: async () => tx } as unknown as Pick<Pool, 'connect'>;
  return { commands, settings, state, tx, pool };
}
function ownerFixture(order = 1) {
  const state = {
    rows: Array.from({ length: 128 }, (_, slot) => ({
      slot,
      version: 1,
      epoch: '0',
    })),
    fence: true,
  };
  const calls: string[] = [];
  const owner: CountProofOwner = {
    order,
    capture: async () => {
      calls.push(`capture${order}`);
      return state.rows;
    },
    fence: async () => {
      calls.push(`fence${order}`);
      return state.fence;
    },
  };
  return { state, calls, owner };
}

test('explicit READ COMMITTED overrides the database default only when requested', async () => {
  const f = fixture();
  await inTransaction(f.pool, async () => 1, {
    isolationLevel: 'read committed',
  });
  assert.deepEqual(f.commands, [
    'BEGIN ISOLATION LEVEL READ COMMITTED',
    'COMMIT',
  ]);
});

test('durable optional proof runs after deferred waits without any finite deadline', async () => {
  const f = fixture();
  let waited = false;
  f.state.beforeImmediate = async () => {
    waited = true;
  };
  const result = await inTransaction(f.pool, async (tx) => {
    const result = { value: 4097 as number | null };
    registerOptionalTransactionProof(tx, {
      validate: async () => {
        assert.equal(waited, true);
        assert.equal(f.commands.includes(clock), false);
        await tx.query('PROOF FENCE');
        return true;
      },
      invalidate: () => {
        result.value = null;
      },
    });
    return result;
  });
  assert.equal(result.value, 4097);
  assert.ok(f.commands.indexOf('PROOF FENCE') > f.commands.indexOf(immediate));
  assert.ok(f.commands.indexOf(clock) > f.commands.indexOf('PROOF FENCE'));
  assert.deepEqual(f.settings, [
    ['100ms', '1ms'],
    ['10s', '0'],
  ]);
  assert.equal(f.commands.at(-1), 'COMMIT');
});

test('conflicting proof releases partial final fences and invalidates only its field', async () => {
  const f = fixture();
  const result = await inTransaction(f.pool, async (tx) => {
    const result = {
      posts: 4097 as number | null,
      trades: 12 as number | null,
    };
    registerOptionalTransactionProof(tx, {
      validate: async () => {
        await tx.query('PARTIAL FENCE');
        return false;
      },
      invalidate: () => {
        result.posts = null;
      },
    });
    registerOptionalTransactionProof(tx, {
      validate: async () => true,
      invalidate: () => {
        result.trades = null;
      },
    });
    return result;
  });
  assert.deepEqual(result, { posts: null, trades: 12 });
  assert.ok(
    f.commands.indexOf('ROLLBACK TO SAVEPOINT optional_final_count_proof') >
      f.commands.indexOf('PARTIAL FENCE'),
  );
});

test('proof checkpoint discards inner callbacks without erasing mandatory deadlines', async () => {
  const f = fixture();
  const checked: number[] = [];
  await inTransaction(f.pool, async (tx) => {
    registerTransactionDeadline(tx, 101, 'SAFETY_UNAVAILABLE');
    registerOptionalTransactionProof(tx, {
      validate: async () => {
        checked.push(1);
        return true;
      },
      invalidate: () => {},
    });
    const snapshot = checkpointTransactionDeadlines(tx);
    registerOptionalTransactionProof(tx, {
      validate: async () => {
        checked.push(2);
        return false;
      },
      invalidate: () => assert.fail('Discarded proof must never invalidate'),
    });
    restoreTransactionDeadlines(tx, snapshot);
  });
  assert.deepEqual(checked, [1]);
});

test('proof horizon equality expires at the final clock; mandatory expiry wins', async () => {
  for (const required of [false, true]) {
    const f = fixture();
    let invalidated = 0;
    const work = inTransaction(f.pool, async (tx) => {
      if (required)
        registerTransactionDeadline(tx, 100, 'ACCESS_TOKEN_EXPIRED');
      registerOptionalTransactionProof(tx, {
        validate: async () => true,
        until: 100,
        invalidate: () => {
          invalidated++;
        },
      });
    });
    if (required) await assert.rejects(work, errorIs('ACCESS_TOKEN_EXPIRED'));
    else await work;
    assert.equal(invalidated, required ? 0 : 1);
  }
});

test('only proof SQL cancellation/lock errors recover and broken rollback fails closed', async () => {
  for (const code of ['55P03', '57014', 'XX000']) {
    const f = fixture();
    const error = Object.assign(new Error('synthetic proof failure'), { code });
    let invalidated = 0;
    const work = inTransaction(f.pool, async (tx) => {
      registerOptionalTransactionProof(tx, {
        validate: async () => {
          throw error;
        },
        invalidate: () => {
          invalidated++;
        },
      });
    });
    if (code === 'XX000')
      await assert.rejects(work, (found) => found === error);
    else await work;
    assert.equal(invalidated, code === 'XX000' ? 0 : 1);
    assert.ok(
      f.commands.includes('ROLLBACK TO SAVEPOINT optional_final_count_proof'),
    );
  }
  const f = fixture();
  const error = new Error('broken savepoint rollback');
  f.state.failure = {
    sql: 'ROLLBACK TO SAVEPOINT optional_final_count_proof',
    error,
  };
  await assert.rejects(
    inTransaction(f.pool, async (tx) => {
      registerOptionalTransactionProof(tx, {
        validate: async () => false,
        invalidate: () => assert.fail('Rollback failed'),
      });
    }),
    (found) => found === error,
  );
  assert.equal(f.commands.at(-1), 'ROLLBACK');
});

test('proof registration rejects unmanaged transactions and invalid horizons', () => {
  const f = fixture();
  const proof = { validate: async () => true, invalidate: () => {} };
  assert.throws(
    () => registerOptionalTransactionProof(f.tx, proof),
    errorIs('COMMUNITY_UNAVAILABLE'),
  );
  startTransactionDeadlines(f.tx);
  for (const until of [NaN, Infinity, -Infinity])
    assert.throws(
      () => registerOptionalTransactionProof(f.tx, { ...proof, until }),
      errorIs('COMMUNITY_UNAVAILABLE'),
    );
  clearTransactionDeadlines(f.tx);
});

test('fixed owner proof rejects snapshot isolation, missing slots and malformed metadata', async () => {
  const f = fixture(),
    owner = ownerFixture();
  await assert.rejects(
    CountProofCollector.capture(f.tx, [owner.owner]),
    errorIs('COMMUNITY_UNAVAILABLE'),
  );
  startTransactionDeadlines(f.tx);
  f.state.isolation = 'repeatable read';
  await assert.rejects(
    CountProofCollector.capture(f.tx, [owner.owner]),
    errorIs('COMMUNITY_UNAVAILABLE'),
  );
  f.state.isolation = 'read committed';
  const rows = [...owner.state.rows];
  for (const invalid of [
    rows.slice(1),
    [...rows.slice(1), rows[0]!],
    rows.map((row) => ({ ...row, version: 2 })),
    rows.map((row) => ({ ...row, epoch: '-1' })),
    rows.map((row) => ({ ...row, epoch: '9223372036854775808' })),
  ]) {
    owner.state.rows = invalid;
    await assert.rejects(
      CountProofCollector.capture(f.tx, [owner.owner]),
      errorIs('COMMUNITY_UNAVAILABLE'),
    );
  }
  clearTransactionDeadlines(f.tx);
});

test('each validation fences before fresh versions, rechecks on reuse, and uses exact bigints', async () => {
  const f = fixture(),
    owner = ownerFixture();
  startTransactionDeadlines(f.tx);
  owner.state.rows[0]!.epoch = '9007199254740992';
  const proof = await CountProofCollector.capture(f.tx, [owner.owner]);
  assert.ok(proof);
  owner.calls.length = 0;
  assert.equal(await proof.validate(f.tx), true);
  assert.deepEqual(owner.calls, ['fence1', 'capture1']);
  owner.state.rows[0]!.epoch = '9007199254740993';
  assert.equal(await proof.validate(f.tx), false);
  owner.state.rows[0]!.epoch = '9007199254740992';
  owner.state.fence = false;
  owner.calls.length = 0;
  assert.equal(await proof.validate(f.tx), false);
  assert.deepEqual(owner.calls, ['fence1']);
  proof.includeUntil(null);
  proof.includeUntil(300);
  proof.includeUntil(100);
  assert.equal(proof.until, 100);
  assert.throws(
    () => proof.includeUntil(Infinity),
    errorIs('COMMUNITY_UNAVAILABLE'),
  );
  clearTransactionDeadlines(f.tx);
});

test('all owner fences are ordered before any owner validation read', async () => {
  const f = fixture();
  const calls: string[] = [];
  const rows: CountEpochRow[] = Array.from({ length: 128 }, (_, slot) => ({
    slot,
    version: 1,
    epoch: '0',
  }));
  const owner = (order: number): CountProofOwner => ({
    order,
    capture: async () => {
      calls.push(`capture${order}`);
      return rows;
    },
    fence: async () => {
      calls.push(`fence${order}`);
      return true;
    },
  });
  startTransactionDeadlines(f.tx);
  const proof = await CountProofCollector.capture(f.tx, [
    owner(3),
    owner(1),
    owner(2),
  ]);
  assert.ok(proof);
  calls.length = 0;
  assert.equal(await proof.validate(f.tx), true);
  assert.deepEqual(calls, [
    'fence1',
    'fence2',
    'fence3',
    'capture1',
    'capture2',
    'capture3',
  ]);
  clearTransactionDeadlines(f.tx);
});

test('unsupported stable server capacity permits a separately fenced small-count proof', async () => {
  const f = fixture(),
    owner = ownerFixture();
  startTransactionDeadlines(f.tx);
  for (const capacity of [128, 256, 1000]) {
    f.state.writerCapacity = capacity;
    assert.equal(await CountProofCollector.capture(f.tx, [owner.owner]), null);
  }
  assert.deepEqual(owner.calls, []);
  clearTransactionDeadlines(f.tx);
});

test('optional settings-read and restoration cancellations recover within the final savepoint', async () => {
  for (const phase of ['failSettings', 'failRestore'] as const) {
    const f = fixture();
    f.state[phase] = true;
    let invalidated = false;
    await inTransaction(f.pool, async (tx) => {
      registerTransactionDeadline(tx, 101, 'ACCESS_TOKEN_EXPIRED');
      registerOptionalTransactionProof(tx, {
        validate: async () => true,
        invalidate: () => {
          invalidated = true;
        },
      });
    });
    assert.equal(invalidated, true);
    assert.ok(
      f.commands.includes('ROLLBACK TO SAVEPOINT optional_final_count_proof'),
    );
    assert.equal(f.commands.at(-1), 'COMMIT');
  }
});
