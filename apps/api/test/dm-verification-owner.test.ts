import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { DmVerificationFacade } from '../src/verification/dm-eligibility.facade.js';
import { ApplicationError } from '../src/http/application-error.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = new Date('2026-10-09T00:00:00Z');
const errorIs = (code: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;
function fixture() {
  const state = {
      phone: 'verified',
      affiliation: 'verified',
      temporary: 'unavailable',
      snapshot: id(4),
      exact: true,
    },
    commands: string[] = [];
  const tx = {
    query: async (sql: string, values: unknown[] = []) => {
      commands.push(sql);
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
      if (sql === 'SELECT clock_timestamp() AS now') return { rows: [{ now }] };
      if (sql.startsWith('WITH instant') && sql.includes('dm_base_assertions'))
        return {
          rows:
            state.temporary === 'absent'
              ? []
              : [
                  {
                    id: id(5),
                    issuer_version: '1',
                    status: state.temporary,
                    valid_until: new Date(now.getTime() + 60000),
                    issuer_until: null,
                  },
                ],
        };
      if (
        sql.startsWith('WITH instant') &&
        sql.includes('whaleu_verification.assertions')
      ) {
        const kind = values[1] as 'phone' | 'affiliation',
          status = state[kind];
        return {
          rows:
            status === 'absent'
              ? []
              : [
                  {
                    id: kind === 'phone' ? id(2) : id(3),
                    account_id: id(1),
                    fact_kind: kind,
                    assertion_state: status === 'unknown' ? 'verified' : status,
                    coverage_state:
                      status === 'unknown' ? 'missing' : 'complete',
                    provenance_state: 'accepted',
                    method:
                      kind === 'phone' ? 'phone_provider' : 'institutional_sso',
                    source_reference: 'synthetic-canonical',
                    policy_reference: 'synthetic-policy',
                    source_account_id: id(1),
                    issuer_institution_id: kind === 'phone' ? null : id(6),
                    source_issuer_institution_id:
                      kind === 'phone' ? null : id(6),
                    origin_region_id: null,
                    phone_binding_reference:
                      kind === 'phone' ? 'synthetic-phone-reference' : null,
                    verified_at: new Date(now.getTime() - 1000),
                    expiry_kind: 'policy_exempt',
                    expires_at: null,
                    snapshot_id: state.snapshot,
                    exact_time: state.exact,
                    now,
                  },
                ],
        };
      }
      return { rows: [] };
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  return { tx, state, commands, facade: new DmVerificationFacade() };
}
test('DM canonical phone and affiliation independently admit without consulting another purpose temporary', async () => {
  const f = fixture();
  await f.facade.require(id(1), f.tx, { phone: true });
  await checkTransactionDeadlines(f.tx);
  assert.ok(
    !f.commands.some(
      (sql) =>
        sql.startsWith('WITH instant') && sql.includes('dm_base_assertions'),
    ),
  );
  assert.ok(
    !f.commands.some(
      (sql) =>
        sql.includes('rating_base') ||
        sql.includes('errand_base') ||
        sql.includes('student_number'),
    ),
  );
});
test('DM trusted temporary can supplement affiliation but never phone', async () => {
  const f = fixture();
  f.state.affiliation = 'unverified';
  f.state.temporary = 'verified';
  await f.facade.require(id(1), f.tx, { phone: true });
  await checkTransactionDeadlines(f.tx);
  const noPhone = fixture();
  noPhone.state.phone = 'unverified';
  noPhone.state.temporary = 'verified';
  await assert.rejects(
    () => noPhone.facade.require(id(1), noPhone.tx, { phone: true }),
    errorIs('PHONE_VERIFICATION_REQUIRED'),
  );
});
test('DM unread exception skips phone only and still requires base authority', async () => {
  const f = fixture();
  f.state.phone = 'absent';
  await f.facade.require(id(1), f.tx, { phone: false });
  await checkTransactionDeadlines(f.tx);
  const unknown = fixture();
  unknown.state.phone = 'absent';
  unknown.state.affiliation = 'unverified';
  unknown.state.temporary = 'absent';
  await assert.rejects(
    () => unknown.facade.require(id(1), unknown.tx, { phone: false }),
    errorIs('VERIFICATION_UNAVAILABLE'),
  );
});
test('DM unknown/untrusted issuer is unavailable and explicit covered denial requires affiliation', async () => {
  const f = fixture();
  f.state.affiliation = 'unverified';
  f.state.temporary = 'unavailable';
  await assert.rejects(
    () => f.facade.require(id(1), f.tx, { phone: true }),
    errorIs('VERIFICATION_UNAVAILABLE'),
  );
  const denied = fixture();
  denied.state.affiliation = 'revoked';
  denied.state.temporary = 'unverified';
  await assert.rejects(
    () => denied.facade.require(id(1), denied.tx, { phone: true }),
    errorIs('AFFILIATION_VERIFICATION_REQUIRED'),
  );
});
test('DM final canonical snapshot and precise SQL expiry changes revoke prior admission', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.state.snapshot = id(8);
    },
    (f: ReturnType<typeof fixture>) => {
      f.state.exact = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.state.phone = 'revoked';
    },
  ]) {
    const f = fixture();
    await f.facade.require(id(1), f.tx, { phone: true });
    change(f);
    await assert.rejects(
      () => checkTransactionDeadlines(f.tx),
      errorIs('VERIFICATION_UNAVAILABLE'),
    );
  }
});
