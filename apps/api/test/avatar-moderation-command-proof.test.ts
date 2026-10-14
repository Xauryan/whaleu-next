import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { retainAvatarCommandCommunity } from '../src/community/avatar-moderation-command-proof.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
function fixture() {
  const initial = Array.from({ length: 128 }, (_, slot) => [slot, 1, '0']);
  const state: {
    raw: unknown[][];
    normalized: unknown;
    values: unknown[][];
    fence: boolean;
  } = { raw: initial, normalized: initial, values: [], fence: true };
  const tx = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes('avatar_moderation_command_community')) {
        state.values.push(values);
        return { rows: [{ value: state.normalized }] };
      }
      if (sql.includes('SELECT slot,version,epoch::text'))
        return {
          rows: state.raw.map(([slot, version, epoch]) => ({
            slot,
            version,
            epoch,
          })),
        };
      if (sql.includes('current_setting'))
        return {
          rows: [
            {
              isolation: 'read committed',
              capacity: 64,
              statement_timeout: '15s',
              lock_timeout: '0',
            },
          ],
        };
      if (sql.includes('generate_series'))
        return {
          rows: Array.from({ length: 128 }, () => ({ locked: state.fence })),
        };
      if (sql.includes('pg_try_advisory'))
        return { rows: [{ locked: state.fence }] };
      if (sql.includes('clock_timestamp() AS now'))
        return { rows: [{ now: new Date() }] };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  return { tx, state, initial };
}
const target = { kind: 'post' as const, id: 'target' };
test('avatar command epoch bridge retains first vector across authorization rerun and binds exact command', async () => {
  const { tx, state } = fixture();
  try {
    await retainAvatarCommandCommunity('actor', target, 'request', tx);
    state.raw = state.raw.map(([slot, version, epoch]) => [
      slot,
      version,
      slot === 0 ? '7' : epoch,
    ]);
    await retainAvatarCommandCommunity('actor', target, 'request', tx);
    await checkTransactionDeadlines(tx);
    assert.deepEqual(state.values, [['actor', 'request', 'post', 'target']]);
  } finally {
    clearTransactionDeadlines(tx);
  }
});
for (const mutation of [
  'unrelated epoch',
  'missing command',
  'malformed vector',
  'missing slot',
  'fence unavailable',
])
  test(`avatar command epoch bridge rejects ${mutation} without replacing original fact`, async () => {
    const { tx, state } = fixture();
    try {
      await retainAvatarCommandCommunity('actor', target, 'request', tx);
      if (mutation === 'unrelated epoch')
        state.normalized = state.raw.map(([slot, version, epoch]) => [
          slot,
          version,
          slot === 0 ? '1' : epoch,
        ]);
      if (mutation === 'missing command') state.normalized = null;
      if (mutation === 'malformed vector')
        state.normalized = Array.from({ length: 128 }, (_, slot) => [
          slot,
          2,
          '0',
        ]);
      if (mutation === 'missing slot') state.normalized = state.raw.slice(1);
      if (mutation === 'fence unavailable') state.fence = false;
      await assert.rejects(checkTransactionDeadlines(tx), {
        code: 'PROFILE_MODERATION_UNAVAILABLE',
      });
    } finally {
      clearTransactionDeadlines(tx);
    }
  });
