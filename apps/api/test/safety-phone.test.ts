import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import type { AssertionRecord } from '../src/verification/contracts.js';
import { LocalSafetyPhoneSource } from '../src/verification/safety-phone.source.js';
import { VerificationModule } from '../src/verification/verification.module.js';
import { VerificationRepository } from '../src/verification/verification.repository.js';
import { syntheticAssertion } from './support/verification-fixtures.js';

const accountId = randomUUID(),
  snapshotId = randomUUID();
const now = new Date(1_000),
  expiry = new Date(2_000);

function fixture(patch: Partial<AssertionRecord> = {}) {
  const assertion = syntheticAssertion(accountId, randomUUID(), 'phone', {
    method: 'phone_provider',
    verified_at: new Date(500),
    expires_at: expiry,
    ...patch,
  });
  const state = {
    head: { snapshot_id: snapshotId } as
      { snapshot_id: string | null } | undefined,
    snapshot: { phone_assertion_id: assertion.id } as
      { phone_assertion_id: string | null } | undefined,
    assertion: assertion as AssertionRecord | undefined,
    now,
    headWait: undefined as (() => Promise<void>) | undefined,
    assertionWait: undefined as (() => Promise<void>) | undefined,
  };
  const statements: { sql: string; values: unknown[] | undefined }[] = [];
  const transaction = {
    query: async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values });
      if (sql.includes('FROM whaleu_verification.account_heads')) {
        await state.headWait?.();
        return { rows: state.head ? [state.head] : [] };
      }
      if (sql.includes('FROM whaleu_verification.snapshots'))
        return { rows: state.snapshot ? [state.snapshot] : [] };
      if (sql.includes('FROM whaleu_verification.assertions')) {
        await state.assertionWait?.();
        return { rows: state.assertion ? [state.assertion] : [] };
      }
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: state.now }] };
      throw new Error('Unexpected phone eligibility query');
    },
  } as unknown as PoolClient;
  const repository = new VerificationRepository();
  const source = new LocalSafetyPhoneSource(repository);
  return {
    state,
    statements,
    transaction,
    repository,
    source,
    resolve: () => source.resolve(accountId, transaction),
  };
}

test('phone eligibility reads only its canonical assertion in the supplied transaction', async () => {
  const f = fixture();
  const result = await f.resolve();
  assert.deepEqual(result, {
    status: 'verified',
    validUntil: expiry.getTime(),
  });
  assert.equal(f.statements.length, 4);
  assert.match(f.statements[0]!.sql, /account_id=\$1 FOR SHARE$/);
  assert.deepEqual(f.statements[0]!.values, [accountId]);
  assert.equal(
    f.statements[1]!.sql,
    'SELECT phone_assertion_id FROM whaleu_verification.snapshots WHERE id=$1 AND account_id=$2',
  );
  assert.deepEqual(f.statements[1]!.values, [snapshotId, accountId]);
  assert.match(
    f.statements[2]!.sql,
    /WHERE account_id=\$1 AND id=\$2 AND fact_kind='phone'$/,
  );
  assert.deepEqual(f.statements[2]!.values, [accountId, f.state.assertion!.id]);
  assert.equal(f.statements.at(-1)!.sql, 'SELECT clock_timestamp() AS now');
  assert.doesNotMatch(
    f.statements.map(({ sql }) => sql).join('\n'),
    /student_number|affiliation|application|origin_region|whaleu_identity|whaleu_profile|\*/,
  );
  for (const privateValue of [
    accountId,
    f.state.assertion!.id,
    f.state.assertion!.phone_binding_reference!,
    f.state.assertion!.source_reference!,
  ])
    assert.equal(JSON.stringify(result).includes(privateValue), false);
});

test('phone facade never falls back to the full verification or student identity read', async () => {
  const transaction = {} as PoolClient;
  const source = new LocalSafetyPhoneSource({
    phone: async (account: string, tx: PoolClient) => {
      assert.equal(account, accountId);
      assert.equal(tx, transaction);
      return { status: 'verified', validUntil: null };
    },
    read: async () => {
      throw new Error('Full identity read must not run');
    },
  } as unknown as VerificationRepository);
  assert.deepEqual(await source.resolve(accountId, transaction), {
    status: 'verified',
    validUntil: null,
  });
  const providers = Reflect.getMetadata('providers', VerificationModule) as
    unknown[] | undefined;
  const exports = Reflect.getMetadata('exports', VerificationModule) as
    unknown[] | undefined;
  assert.equal(providers?.includes(LocalSafetyPhoneSource), true);
  assert.equal(exports?.includes(LocalSafetyPhoneSource), true);
});

test('missing heads, snapshots, pointers and assertions remain unavailable', async () => {
  for (const missing of [
    'head',
    'snapshotPointer',
    'snapshot',
    'phonePointer',
    'assertion',
  ] as const) {
    const f = fixture();
    if (missing === 'head') f.state.head = undefined;
    if (missing === 'snapshotPointer') f.state.head!.snapshot_id = null;
    if (missing === 'snapshot') f.state.snapshot = undefined;
    if (missing === 'phonePointer') f.state.snapshot!.phone_assertion_id = null;
    if (missing === 'assertion') f.state.assertion = undefined;
    assert.deepEqual(await f.resolve(), { status: 'unavailable' }, missing);
  }
});

test('phone eligibility preserves provenance, coverage, binding and expiry failures', async () => {
  const invalid: Partial<AssertionRecord>[] = [
    { account_id: randomUUID() },
    { fact_kind: 'student_number' },
    { coverage_state: 'missing' },
    { coverage_state: 'conflict' },
    { provenance_state: 'unknown' },
    { provenance_state: 'conflict' },
    { source_account_id: null },
    { source_account_id: randomUUID() },
    { source_reference: null },
    { source_reference: ' ' },
    { policy_reference: null },
    { policy_reference: ' ' },
    { method: 'unknown' },
    { method: 'institutional_email' },
    { method: 'institutional_sso' },
    { method: 'document_review' },
    { source_issuer_institution_id: randomUUID() },
    { phone_binding_reference: null },
    { verified_at: null },
    { verified_at: new Date(Number.NaN) },
    { verified_at: new Date(now.getTime() + 1) },
    { expiry_kind: 'unknown', expires_at: null },
    { expires_at: null },
    { expires_at: new Date(Number.NaN) },
    { expires_at: new Date(500) },
    { expiry_kind: 'policy_exempt', expires_at: expiry },
  ];
  for (const patch of invalid) {
    const f = fixture(patch);
    assert.deepEqual(await f.resolve(), { status: 'unavailable' });
  }
});

test('covered absence, revocation and exact expiry are unverified without a deadline', async () => {
  for (const assertion_state of ['unverified', 'revoked', 'expired'] as const) {
    const f = fixture({ assertion_state });
    assert.deepEqual(await f.resolve(), { status: 'unverified' });
  }
  assert.deepEqual(await fixture({ expires_at: now }).resolve(), {
    status: 'unverified',
  });
  assert.deepEqual(
    await fixture({ expires_at: new Date(now.getTime() - 1) }).resolve(),
    { status: 'unverified' },
  );
  assert.deepEqual(
    await fixture({
      assertion_state: 'revoked',
      provenance_state: 'unknown',
    }).resolve(),
    { status: 'unavailable' },
  );
});

test('phone requires no affiliation, student number, issuer or application status', async () => {
  for (const method of ['phone_provider', 'reconciled_import'] as const) {
    const f = fixture({
      method,
      expiry_kind: 'policy_exempt',
      expires_at: null,
    });
    // These private fields are not selected by the narrow SQL projection.
    Reflect.deleteProperty(f.state.assertion!, 'student_number');
    Reflect.deleteProperty(f.state.assertion!, 'origin_region_id');
    assert.deepEqual(await f.resolve(), {
      status: 'verified',
      validUntil: null,
    });
  }
});

test('expiry is sampled after the head lock wait and after the assertion read', async () => {
  for (const waitingOn of ['headWait', 'assertionWait'] as const) {
    const f = fixture();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.state[waitingOn] = async () => {
      entered();
      await lock;
    };
    const result = f.resolve();
    await waiting;
    assert.equal(
      f.statements.some(({ sql }) => sql.includes('clock_timestamp')),
      false,
    );
    f.state.now = expiry;
    release();
    assert.deepEqual(await result, { status: 'unverified' });
    assert.equal(f.statements.at(-1)!.sql, 'SELECT clock_timestamp() AS now');
  }
});

test('repository failures propagate without granting phone eligibility', async () => {
  const f = fixture();
  f.state.assertionWait = async () => {
    throw new Error('Synthetic read failure');
  };
  await assert.rejects(f.resolve(), /Synthetic read failure/);
});
