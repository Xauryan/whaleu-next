import {
  parseSessionEpochStatusCommand,
  sessionEpochStatus,
} from '../src/identity/session-epoch-status.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../src/http/application-error.js';
import {
  sessionEpoch,
  requireSessionEpoch,
  inspectSessionEpochSchema,
  retainSessionEpochSchema,
  retainLiveSessionEpoch,
} from '../src/identity/session-epoch.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { sessionEpochFixture } from './support/session-epoch-fixture.js';
const code = (expected: string) => (e: unknown) =>
  e instanceof ApplicationError && e.code === expected;

for (const value of ['0', '1', '9007199254740993', '9223372036854775807'])
  test(`exact PostgreSQL epoch ${value} is never converted to Number`, () => {
    assert.equal(sessionEpoch(value), value);
    assert.equal(requireSessionEpoch(value, value), value);
  });
for (const value of [
  undefined,
  null,
  0,
  1n,
  '',
  '-1',
  '01',
  ' 1',
  '1.0',
  '1e0',
  '9223372036854775808',
  '9'.repeat(100),
])
  test(`missing, malformed or overflow epoch ${String(value)} fails closed`, () => {
    assert.throws(() => sessionEpoch(value), code('AUTH_NOT_CONFIGURED'));
    assert.throws(
      () => requireSessionEpoch('0', value),
      code('AUTH_NOT_CONFIGURED'),
    );
    assert.throws(
      () => requireSessionEpoch(value, '0'),
      code('AUTH_NOT_CONFIGURED'),
    );
  });
test('epochs adjacent above JS safe integer remain unequal', () => {
  assert.throws(
    () => requireSessionEpoch('9007199254740992', '9007199254740993'),
    code('SESSION_REVOKED'),
  );
});
test('cancel returning lifecycle active cannot authorize a prior epoch', () => {
  assert.throws(() => requireSessionEpoch('0', '1'), code('SESSION_REVOKED'));
  assert.equal(requireSessionEpoch('1', '1'), '1');
});
function fixture(options: { qualified?: boolean; finalValid?: boolean } = {}) {
  const statements: string[] = [];
  const tx = {
    query: async (sql: string) => {
      statements.push(sql);
      if (sql === 'SET TRANSACTION READ ONLY') return { rows: [] };
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date() }] };
      const result = sessionEpochFixture(sql, options);
      if (result) return result;
      assert.fail('Unexpected epoch SQL: ' + sql);
    },
  } as unknown as PoolClient;
  return { tx, statements };
}
test('named schema qualification rejects partial guard metadata', async () => {
  const f = fixture({ qualified: false });
  await assert.rejects(
    inspectSessionEpochSchema(f.tx),
    code('AUTH_NOT_CONFIGURED'),
  );
});
test('schema metadata alone is insufficient if a trigger body hash differs', async () => {
  const tx = {
    query: async (sql: string) => {
      const result = sessionEpochFixture(sql)!;
      return {
        rows: result.rows.map((r) => ({
          ...(r as object),
          body_hashes: ['0'.repeat(64), '0'.repeat(64), '0'.repeat(64)],
        })),
      };
    },
  } as unknown as PoolClient;
  await assert.rejects(
    inspectSessionEpochSchema(tx),
    code('AUTH_NOT_CONFIGURED'),
  );
});
test('epoch proof cannot be registered outside a managed transaction', async () => {
  const f = fixture();
  await assert.rejects(
    retainSessionEpochSchema(f.tx),
    code('AUTH_NOT_CONFIGURED'),
  );
  assert.throws(
    () => retainLiveSessionEpoch(f.tx, 'account', 'session', '0'),
    code('SESSION_REVOKED'),
  );
  assert.equal(f.statements.length, 0);
});
test('successful managed proof rechecks schema then account -> session row fences after deferred constraints', async () => {
  const f = fixture();
  startTransactionDeadlines(f.tx);
  try {
    await retainSessionEpochSchema(f.tx);
    retainLiveSessionEpoch(f.tx, 'account', 'session', '9007199254740993');
    await checkTransactionDeadlines(f.tx);
    const deferred = f.statements.indexOf('SET CONSTRAINTS ALL IMMEDIATE');
    const account = f.statements.findIndex((s) =>
      s.startsWith('SELECT id FROM whaleu_identity.accounts WHERE id=ANY'),
    );
    const session = f.statements.findIndex((s) =>
      s.startsWith('SELECT id FROM whaleu_identity.sessions WHERE id=ANY'),
    );
    const final = f.statements.findIndex((s) =>
      s.includes('identity-session-epoch-final-v1'),
    );
    assert.ok(
      deferred >= 0 &&
        deferred < account &&
        account < session &&
        session < final,
    );
    assert.equal(
      f.statements.filter((s) => s.includes('identity-session-epoch-schema-v1'))
        .length,
      2,
    );
    assert.ok(f.statements.every((s) => !s.includes('LOCK TABLE')));
    assert.match(
      f.statements[final]!,
      /s\.issued_revocation_epoch=f\.epoch AND a\.session_revocation_epoch=f\.epoch/,
    );
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});
test('final revocation or epoch mismatch invalidates a tentative successful session', async () => {
  const f = fixture({ finalValid: false });
  startTransactionDeadlines(f.tx);
  try {
    await retainSessionEpochSchema(f.tx);
    retainLiveSessionEpoch(f.tx, 'account', 'session', '0');
    await assert.rejects(
      checkTransactionDeadlines(f.tx),
      code('SESSION_REVOKED'),
    );
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});
test('a replay error transaction with only schema proof does not require intentionally revoked session to stay live', async () => {
  const f = fixture({ finalValid: false });
  startTransactionDeadlines(f.tx);
  try {
    await retainSessionEpochSchema(f.tx);
    await checkTransactionDeadlines(f.tx);
    assert.equal(
      f.statements.some((s) => s.includes('identity-session-epoch-final-v1')),
      false,
    );
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});

test('operator preflight is read-only and cannot authorize bump or attest old-reader cutover', async () => {
  parseSessionEpochStatusCommand(['status']);
  for (const args of [
    [],
    ['activate'],
    ['status', '--enable'],
    ['status', '--old-readers-stopped'],
  ])
    assert.throws(() => parseSessionEpochStatusCommand(args));
  const f = fixture();
  startTransactionDeadlines(f.tx);
  try {
    assert.deepEqual(await sessionEpochStatus(f.tx), {
      protocol: 'identity-session-revocation-epoch-v2',
      schema: 'qualified',
      advanceAuthority: 'exact-real-request-with-qualified-admission',
      realDeletionAdmission: 'requires-independent-owner-qualification',
      legacyReaderCutover: 'unproven',
    });
    await checkTransactionDeadlines(f.tx);
    assert.equal(f.statements[0], 'SET TRANSACTION READ ONLY');
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});
