import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { assertionStatus } from '../src/verification/policy.js';
import type {
  AssertionRecord,
  FactKind,
} from '../src/verification/contracts.js';

const account = randomUUID();
const now = new Date();
function absence(kind: FactKind): AssertionRecord {
  return {
    id: randomUUID(),
    account_id: account,
    fact_kind: kind,
    assertion_state: 'unverified',
    coverage_state: 'complete',
    provenance_state: 'accepted',
    method: 'native_enrollment',
    source_reference: `native_enrollment:${account}`,
    policy_reference: 'native-account-absence/v1',
    source_account_id: account,
    issuer_institution_id: null,
    source_issuer_institution_id: null,
    origin_region_id: null,
    student_number: null,
    phone_binding_reference: null,
    verified_at: null,
    expiry_kind: 'policy_exempt',
    expires_at: null,
  };
}
test('native enrollment is covered absence for independent facts, never a verified credential', () => {
  for (const kind of ['affiliation', 'student_number', 'phone'] as const) {
    assert.equal(
      assertionStatus(absence(kind), account, kind, now),
      'unverified',
    );
    assert.equal(assertionStatus(undefined, account, kind, now), 'unavailable');
    for (const patch of [
      { assertion_state: 'verified' },
      { assertion_state: 'revoked' },
      { assertion_state: 'expired' },
      { coverage_state: 'missing' },
      { provenance_state: 'unknown' },
      { source_account_id: randomUUID() },
      { source_reference: `native_enrollment:${randomUUID()}` },
      { policy_reference: 'reconciled-policy' },
      { student_number: '001' },
      { phone_binding_reference: randomUUID() },
      { origin_region_id: randomUUID() },
      {
        issuer_institution_id: randomUUID(),
        source_issuer_institution_id: randomUUID(),
      },
      { verified_at: now },
      { expiry_kind: 'unknown' },
      { expires_at: now },
    ] as readonly Partial<AssertionRecord>[])
      assert.equal(
        assertionStatus({ ...absence(kind), ...patch }, account, kind, now),
        'unavailable',
      );
  }
});
