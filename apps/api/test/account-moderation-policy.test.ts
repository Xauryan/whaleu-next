import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../src/http/application-error.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { enforceAccountPunishment } from '../src/safety/account-moderation/policy.js';
const errorIs = (code: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;
function fixture() {
  const state = {
    fingerprint: 'original',
    allowed: true,
    suspended: false,
    until: null as string | null,
    now: new Date('2026-10-13T00:00:00.000Z'),
  };
  const statements: string[] = [];
  const tx = {
    query: async (sql: string, params?: unknown[]) => {
      statements.push(sql);
      if (sql.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '10s',
              lock_timeout: '0',
            },
          ],
        };
      if (
        sql.includes('account_punishment_policy_observation') ||
        sql.includes('account_punishment_fingerprint')
      )
        return { rows: [{ ...state }] };
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: state.now }] };
      if (sql.includes('unnest') && sql.includes('timestamptz'))
        return {
          rows: [
            {
              now: state.now,
              expired: (params?.[0] as string[]).flatMap((at, index) =>
                Date.parse(at) <= state.now.getTime()
                  ? [String(index + 1)]
                  : [],
              ),
            },
          ],
        };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  return { tx, state, statements };
}
test('Safety nonterminal denial retains a required original negative proof before it is thrown', async () => {
  const f = fixture();
  f.state.allowed = false;
  f.state.suspended = true;
  await assert.rejects(
    enforceAccountPunishment(
      '10000000-0000-4000-8000-000000000001',
      'browse',
      f.tx,
    ),
    errorIs('SAFETY_ACCESS_SUSPENDED'),
  );
  f.state.allowed = true;
  f.state.suspended = false;
  await assert.rejects(
    checkTransactionDeadlines(f.tx),
    errorIs('SAFETY_MODERATION_UNAVAILABLE'),
  );
  clearTransactionDeadlines(f.tx);
});
test('later same-key checks cannot replace an earlier actor policy observation', async () => {
  const f = fixture();
  const actor = '10000000-0000-4000-8000-000000000001';
  await enforceAccountPunishment(actor, 'browse', f.tx);
  f.state.fingerprint = 'changed';
  await enforceAccountPunishment(actor, 'browse', f.tx);
  await assert.rejects(
    checkTransactionDeadlines(f.tx),
    errorIs('SAFETY_MODERATION_UNAVAILABLE'),
  );
  clearTransactionDeadlines(f.tx);
});
test('restricted own recovery does not acquire unrelated moderation sources', async () => {
  const f = fixture();
  f.state.allowed = false;
  f.state.suspended = true;
  await enforceAccountPunishment(
    '10000000-0000-4000-8000-000000000001',
    'restricted_self_service',
    f.tx,
  );
  assert.deepEqual(f.statements, []);
  clearTransactionDeadlines(f.tx);
});

test('finite negative denial cannot commit after the exact boundary even if a later clock check otherwise sees unchanged evidence', async () => {
  const f = fixture();
  f.state.allowed = false;
  f.state.until = '2026-10-13T00:00:01.000Z';
  await assert.rejects(
    enforceAccountPunishment(
      '10000000-0000-4000-8000-000000000001',
      'interaction',
      f.tx,
    ),
    errorIs('SAFETY_ACTION_RESTRICTED'),
  );
  f.state.now = new Date(f.state.until);
  await assert.rejects(
    checkTransactionDeadlines(f.tx),
    errorIs('SAFETY_MODERATION_UNAVAILABLE'),
  );
  clearTransactionDeadlines(f.tx);
});
