import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { inTransaction } from '../src/database/database.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
  registerOptionalTransactionProof,
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../src/database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../src/database/transaction-deadlines.js';
import { ApplicationError } from '../src/http/application-error.js';
import { SafetyRepository } from '../src/safety/repository.js';
import { NamedBlockVisibility } from '../src/safety/visibility.js';
import {
  enableSafetyRelationshipProof,
  requireAllowedSafetyRelationship,
  MAX_REQUIRED_RELATIONSHIPS,
} from '../src/safety/relationship-proof.js';

const errorIs = (code: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;
const key = (a: string, b: string) => `${a}:${b}`;
function fixture() {
  const commands: string[] = [];
  const heads: string[] = [];
  const batchLengths: number[] = [];
  const blocks = new Set<string>();
  const state = {
    isolation: 'read committed',
    failFence: false,
    beforeImmediate: async () => {},
  };
  const tx = {
    query: async (sql: string, values?: unknown[]) => {
      commands.push(sql);
      if (sql === 'SET CONSTRAINTS ALL IMMEDIATE')
        await state.beforeImmediate();
      if (
        sql === 'LOCK TABLE whaleu_safety.blocks IN SHARE MODE NOWAIT' &&
        state.failFence
      )
        throw Object.assign(new Error('raw block writer'), { code: '55P03' });
      if (sql.includes('FROM whaleu_safety.account_heads')) {
        heads.push(values![0] as string);
        return {
          rows: [
            {
              block_coverage: 'complete',
              restriction_coverage: 'complete',
              provenance: 'native_account_creation',
              actions_allowed: true,
              valid_until: null,
            },
          ],
        };
      }
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date(100) }] };
      if (sql.includes('current_setting'))
        return {
          rows: [
            {
              isolation: state.isolation,
              statement_timeout: '10s',
              lock_timeout: '0',
            },
          ],
        };
      if (sql.includes('SELECT EXISTS')) {
        const [viewer, author] = values! as string[];
        return {
          rows: [
            {
              outgoing: blocks.has(key(viewer!, author!)),
              incoming: blocks.has(key(author!, viewer!)),
            },
          ],
        };
      }
      if (sql.includes('FROM unnest')) {
        const [viewers, authors, bilateral] = values! as [
          string[],
          string[],
          boolean[],
        ];
        batchLengths.push(viewers.length);
        return {
          rows: viewers.map((viewer, index) => ({
            ordinal: index + 1,
            outgoing: blocks.has(key(viewer, authors[index]!)),
            incoming:
              bilateral[index] && blocks.has(key(authors[index]!, viewer)),
          })),
        };
      }
      return { rows: [] };
    },
    release: () => {},
  } as unknown as PoolClient;
  const pool = { connect: async () => tx } as unknown as Pick<Pool, 'connect'>;
  return {
    tx,
    pool,
    state,
    commands,
    heads,
    batchLengths,
    blocks,
    records: new SafetyRepository(),
  };
}

test('mandatory profile allow is rechecked after deferred waits before optional proofs and the final clock', async () => {
  const f = fixture(),
    viewer = randomUUID(),
    author = randomUUID();
  let optionalRan = false;
  f.state.beforeImmediate = async () => {
    f.blocks.add(key(author, viewer));
  };
  await assert.rejects(
    inTransaction(f.pool, async (tx) => {
      enableSafetyRelationshipProof(tx);
      assert.deepEqual(
        await f.records.directions(viewer, author, 'public_profile', tx),
        { outgoing: false, incoming: false },
      );
      registerOptionalTransactionProof(tx, {
        validate: async () => {
          optionalRan = true;
          return true;
        },
        invalidate: () => {},
      });
    }),
    errorIs('SAFETY_UNAVAILABLE'),
  );
  assert.equal(optionalRan, false);
  assert.equal(f.commands.at(-1), 'ROLLBACK');
  assert.ok(
    f.commands.indexOf('LOCK TABLE whaleu_safety.blocks IN SHARE MODE NOWAIT') >
      f.commands.indexOf('SET CONSTRAINTS ALL IMMEDIATE'),
  );
});

test('list projection remains outgoing-only while direct relationships are bilateral', async () => {
  for (const purpose of ['list_projection', 'direct_post'] as const) {
    const f = fixture(),
      viewer = randomUUID(),
      author = randomUUID();
    f.state.beforeImmediate = async () => {
      f.blocks.add(key(author, viewer));
    };
    const work = inTransaction(f.pool, async (tx) => {
      enableSafetyRelationshipProof(tx);
      await f.records.directions(viewer, author, purpose, tx);
    });
    if (purpose === 'direct_post')
      await assert.rejects(work, errorIs('COMMUNITY_UNAVAILABLE'));
    else await work;
    assert.equal(f.heads.length, purpose === 'direct_post' ? 2 : 1);
  }
});

test('later denial never overwrites a prior allow that authorized private content', async () => {
  const f = fixture(),
    viewer = randomUUID(),
    author = randomUUID();
  await assert.rejects(
    inTransaction(f.pool, async (tx) => {
      enableSafetyRelationshipProof(tx);
      await f.records.directions(viewer, author, 'direct_post', tx);
      f.blocks.add(key(viewer, author));
      assert.equal(
        (await f.records.directions(viewer, author, 'direct_post', tx))
          ?.outgoing,
        true,
      );
    }),
    errorIs('COMMUNITY_UNAVAILABLE'),
  );
  assert.deepEqual(f.batchLengths, [1]);
});

test('unopted mutation consumers do not reject their own intentional block transition', async () => {
  const f = fixture(),
    viewer = randomUUID(),
    author = randomUUID();
  await inTransaction(f.pool, async (tx) => {
    await f.records.directions(viewer, author, 'public_profile', tx);
    f.blocks.add(key(viewer, author));
  });
  assert.equal(
    f.commands.includes('LOCK TABLE whaleu_safety.blocks IN SHARE MODE NOWAIT'),
    false,
  );
  assert.equal(f.commands.at(-1), 'COMMIT');
});

test('guest, anonymous and self bypasses create no identity relationship facts', async () => {
  const f = fixture(),
    viewer = randomUUID(),
    author = randomUUID();
  const visibility = new NamedBlockVisibility(
    { check: async () => ({ kind: 'allow', value: undefined }) },
    f.records,
  );
  await inTransaction(f.pool, async (tx) => {
    enableSafetyRelationshipProof(tx);
    const base = {
      contentId: randomUUID(),
      contentKind: 'post' as const,
      contentVersion: 1 as const,
    };
    await visibility.check(
      viewer,
      { ...base, authorMode: 'anonymous' },
      tx,
      'direct_post',
    );
    await visibility.check(
      null,
      { ...base, authorMode: 'named', namedAccountId: author },
      tx,
      'direct_post',
    );
    await visibility.check(
      viewer,
      { ...base, authorMode: 'named', namedAccountId: viewer },
      tx,
      'direct_post',
    );
  });
  assert.deepEqual(f.heads, []);
  assert.deepEqual(f.batchLengths, []);
  assert.deepEqual(f.commands, ['BEGIN', 'COMMIT']);
});

test('checkpoint rollback prunes appended relationship facts and reusable dedupe keys', async () => {
  const f = fixture(),
    viewer = randomUUID(),
    first = randomUUID(),
    second = randomUUID();
  await inTransaction(f.pool, async (tx) => {
    enableSafetyRelationshipProof(tx);
    requireAllowedSafetyRelationship(viewer, first, 'direct_post', tx);
    const checkpoint = checkpointTransactionDeadlines(tx);
    requireAllowedSafetyRelationship(viewer, second, 'direct_post', tx);
    restoreTransactionDeadlines(tx, checkpoint);
    f.blocks.add(key(viewer, second));
  });
  assert.deepEqual(f.batchLengths, [1]);
  f.batchLengths.length = 0;
  await assert.rejects(
    inTransaction(f.pool, async (tx) => {
      enableSafetyRelationshipProof(tx);
      const checkpoint = checkpointTransactionDeadlines(tx);
      requireAllowedSafetyRelationship(viewer, second, 'direct_post', tx);
      restoreTransactionDeadlines(tx, checkpoint);
      requireAllowedSafetyRelationship(viewer, second, 'direct_post', tx);
    }),
    errorIs('COMMUNITY_UNAVAILABLE'),
  );
  assert.deepEqual(f.batchLengths, [1]);
});

test('required proof opt-in and facts never leak across pooled transaction reuse', async () => {
  const f = fixture(),
    viewer = randomUUID(),
    author = randomUUID();
  await inTransaction(f.pool, async (tx) => {
    enableSafetyRelationshipProof(tx);
    await f.records.directions(viewer, author, 'public_profile', tx);
  });
  f.blocks.add(key(author, viewer));
  f.commands.length = 0;
  f.batchLengths.length = 0;
  await inTransaction(f.pool, async () => {});
  assert.deepEqual(f.commands, ['BEGIN', 'COMMIT']);
  assert.deepEqual(f.batchLengths, []);
});

test('387 distinct liked chain pairs use bounded set rereads without a new256-author cap', async () => {
  const f = fixture(),
    viewer = randomUUID();
  await inTransaction(f.pool, async (tx) => {
    enableSafetyRelationshipProof(tx);
    for (let index = 0; index < 387; index++) {
      const author = randomUUID();
      requireAllowedSafetyRelationship(viewer, author, 'direct_post', tx);
      requireAllowedSafetyRelationship(viewer, author, 'direct_post', tx);
    }
  });
  assert.deepEqual(f.batchLengths, [256, 131]);
  assert.equal(MAX_REQUIRED_RELATIONSHIPS, 110000);
});

test('unknown mandatory fence or stale isolation fails closed rather than nulling a count', async () => {
  for (const problem of ['lock', 'isolation'] as const) {
    const f = fixture();
    if (problem === 'lock') f.state.failFence = true;
    else f.state.isolation = 'repeatable read';
    await assert.rejects(
      inTransaction(f.pool, async (tx) => {
        enableSafetyRelationshipProof(tx);
        requireAllowedSafetyRelationship(
          randomUUID(),
          randomUUID(),
          'public_profile',
          tx,
        );
      }),
      errorIs('SAFETY_UNAVAILABLE'),
    );
    assert.equal(f.commands.at(-1), 'ROLLBACK');
  }
});

test('generic mandatory owner registry restores owner enrollment and fact length independently', async () => {
  const f = fixture();
  const observed: number[][] = [];
  const owner: RequiredTransactionProof<number> = {
    maximumFacts: 2,
    failureCode: 'SAFETY_UNAVAILABLE',
    validate: async (values) => {
      observed.push([...values]);
    },
  };
  await inTransaction(f.pool, async (tx) => {
    const before = checkpointTransactionDeadlines(tx);
    enableRequiredTransactionProof(tx, owner);
    registerRequiredTransactionFact(tx, owner, 'discard', 1);
    restoreTransactionDeadlines(tx, before);
    registerRequiredTransactionFact(tx, owner, 'not-enabled', 2);
    enableRequiredTransactionProof(tx, owner);
    registerRequiredTransactionFact(tx, owner, 'keep', 3);
    const inner = checkpointTransactionDeadlines(tx);
    registerRequiredTransactionFact(tx, owner, 'second', 4);
    assert.throws(
      () => registerRequiredTransactionFact(tx, owner, 'overflow', 5),
      errorIs('SAFETY_UNAVAILABLE'),
    );
    restoreTransactionDeadlines(tx, inner);
    registerRequiredTransactionFact(tx, owner, 'second', 6);
  });
  assert.deepEqual(observed, [[3, 6]]);
});

test('explicit required proof enrollment rejects unmanaged transactions rather than silently losing protection', () => {
  const f = fixture();
  assert.throws(
    () => enableSafetyRelationshipProof(f.tx),
    errorIs('SAFETY_UNAVAILABLE'),
  );
  // Existing standalone owner consumers have not opted into this read protocol.
  assert.doesNotThrow(() =>
    requireAllowedSafetyRelationship(
      randomUUID(),
      randomUUID(),
      'direct_post',
      f.tx,
    ),
  );
});
