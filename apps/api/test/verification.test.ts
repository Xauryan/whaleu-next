import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  assertionStatus,
  safeStudentNumber,
} from '../src/verification/policy.js';
import { syntheticAssertion } from './support/verification-fixtures.js';

const account = randomUUID(),
  issuer = randomUUID(),
  now = new Date();
const record = () => syntheticAssertion(account, issuer, 'student_number');
test('canonical number policy preserves text and rejects unsafe/unknown evidence', () => {
  assert.equal(safeStudentNumber('00004721'), true);
  assert.equal(safeStudentNumber('Ab00004'), true);
  for (const number of [
    '',
    ' ',
    ' 001',
    '001 ',
    '0\n1',
    '\u0085',
    'a@school.invalid',
    '0\u202e1',
    'x'.repeat(101),
    42,
  ])
    assert.equal(safeStudentNumber(number), false);
  assert.equal(
    assertionStatus(record(), account, 'student_number', now),
    'verified',
  );
  for (const patch of [
    { coverage_state: 'missing' as const },
    { coverage_state: 'conflict' as const },
    { provenance_state: 'unknown' as const },
    { provenance_state: 'conflict' as const },
    { source_account_id: randomUUID() },
    { source_issuer_institution_id: randomUUID() },
    { issuer_institution_id: null, source_issuer_institution_id: null },
    { policy_reference: null },
    { source_reference: null },
    { method: 'institutional_email' as const },
    { method: 'document_review' as const },
    { expiry_kind: 'unknown' as const, expires_at: null },
    { student_number: 'student@school.invalid' },
    { verified_at: new Date(now.getTime() + 10000) },
  ])
    assert.equal(
      assertionStatus(
        { ...record(), ...patch },
        account,
        'student_number',
        now,
      ),
      'unavailable',
    );
  assert.equal(
    assertionStatus(undefined, account, 'student_number', now),
    'unavailable',
  );
});
test('expiry is exact, explicit absence/revocation does not verify, and independent facts stay separate', () => {
  assert.equal(
    assertionStatus(
      { ...record(), expires_at: now },
      account,
      'student_number',
      now,
    ),
    'expired',
  );
  for (const state of ['unverified', 'expired', 'revoked'] as const)
    assert.equal(
      assertionStatus(
        { ...record(), assertion_state: state },
        account,
        'student_number',
        now,
      ),
      state,
    );
  assert.equal(
    assertionStatus(
      syntheticAssertion(account, issuer, 'affiliation', {
        method: 'institutional_email',
      }),
      account,
      'affiliation',
      now,
    ),
    'verified',
  );
  assert.equal(
    assertionStatus(
      syntheticAssertion(account, issuer, 'affiliation'),
      account,
      'student_number',
      now,
    ),
    'unavailable',
  );
  assert.equal(
    assertionStatus(
      syntheticAssertion(account, issuer, 'phone'),
      account,
      'phone',
      now,
    ),
    'verified',
  );
  assert.equal(
    assertionStatus(
      syntheticAssertion(account, issuer, 'phone', {
        phone_binding_reference: null,
      }),
      account,
      'phone',
      now,
    ),
    'unavailable',
  );
});
