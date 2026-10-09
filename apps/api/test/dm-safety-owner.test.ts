import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { DmSafetyFacade } from '../src/safety/dm.facade.js';
import type { SafetyRepository } from '../src/safety/repository.js';
import { ApplicationError } from '../src/http/application-error.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const head = {
  block_coverage: 'complete',
  restriction_coverage: 'complete',
  provenance: 'native_account_creation',
  actions_allowed: true,
  valid_until: null,
};
function setup(outgoing = false, incoming = false) {
  const purposes: string[] = [],
    queries: { sql: string; values: unknown[] | undefined }[] = [];
  let fingerprint = 'current';
  const records = {
    rate: async () => {},
    head: async () => head,
    restriction: async () => null,
    directions: async (_actor: string, _peer: string, purpose: string) => {
      purposes.push(purpose);
      return { outgoing, incoming };
    },
    outgoingReference: async () =>
      outgoing ? { relationshipId: id(4), blocked: true, revision: '1' } : null,
  } as unknown as SafetyRepository;
  const tx = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      if (sql.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '0',
              lock_timeout: '0',
            },
          ],
        };
      if (sql.includes("jsonb_build_object('heads'"))
        return { rows: [{ value: { fingerprint }, exact_time: true }] };
      if (sql.startsWith('SELECT clock_timestamp()'))
        return { rows: [{ now: new Date() }] };
      if (sql.startsWith('INSERT INTO whaleu_safety.blocks'))
        return {
          rows: [
            {
              id: id(4),
              blocker_id: id(1),
              blocked_id: id(2),
              active: true,
              revision: '1',
              display_snapshot: null,
              updated_at: new Date(),
            },
          ],
        };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  return {
    facade: new DmSafetyFacade(records),
    tx,
    purposes,
    queries,
    change: () => {
      fingerprint = 'changed';
    },
  };
}
test('DM named state requires bilateral private_messages purpose and returns only own denial choice', async () => {
  for (const [outgoing, incoming] of [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ]) {
    const f = setup(outgoing, incoming);
    assert.deepEqual(await f.facade.namedState(id(1), id(2), f.tx), {
      allowed: !outgoing && !incoming,
      blockedByYou: outgoing,
    });
    assert.deepEqual(f.purposes, ['private_messages']);
    await checkTransactionDeadlines(f.tx);
  }
});
test('DM Safety final proof retains both positive and negative relationship facts', async () => {
  for (const outgoing of [false, true]) {
    const f = setup(outgoing);
    await f.facade.namedState(id(1), id(2), f.tx);
    f.change();
    await assert.rejects(
      () => checkTransactionDeadlines(f.tx),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === 'SAFETY_UNAVAILABLE',
    );
  }
});
test('DM real named block uses owner relationship and audit without consulting reverse graph or source visibility', async () => {
  const f = setup();
  await f.facade.requireActor(id(1), f.tx);
  const result = await f.facade.blockNamed(id(1), id(2), id(3), f.tx);
  assert.deepEqual(result, {
    relationshipId: id(4),
    blocked: true,
    revision: '1',
    changed: true,
  });
  assert.deepEqual(f.purposes, []);
  assert.ok(
    f.queries.some((q) => q.sql.startsWith('INSERT INTO whaleu_safety.blocks')),
  );
  assert.ok(
    f.queries.some((q) => q.sql.startsWith('INSERT INTO whaleu_safety.events')),
  );
  assert.ok(
    f.queries.some((q) =>
      q.sql.startsWith('INSERT INTO whaleu_safety.dm_block_bindings'),
    ),
  );
  assert.ok(
    f.queries.every(
      (q) =>
        !q.sql.includes('whaleu_profile') &&
        !q.sql.includes('whaleu_community.posts') &&
        !q.sql.includes('BEGIN'),
    ),
  );
  const snapshots = f.queries.filter((q) =>
    q.sql.includes("jsonb_build_object('heads'"),
  );
  assert.ok(snapshots.every((q) => q.values?.[2] !== 'named'));
  assert.ok(
    snapshots.every((q) => !q.sql.includes('blocker_id=$4 AND blocked_id=$2')),
  );
  await checkTransactionDeadlines(f.tx);
});
test('DM own outgoing block projection never asks bilateral directions', async () => {
  const f = setup(true, true);
  assert.deepEqual(await f.facade.currentOwnNamedBlock(id(1), id(2), f.tx), {
    relationshipId: id(4),
    blocked: true,
    revision: '1',
  });
  assert.deepEqual(f.purposes, []);
  await checkTransactionDeadlines(f.tx);
});
test('DM Safety rejects self-pairs before relationship lookup', async () => {
  const f = setup();
  await assert.rejects(() => f.facade.namedState(id(1), id(1), f.tx));
  assert.deepEqual(f.purposes, []);
});
