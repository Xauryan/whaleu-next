import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applicationStatuses,
  decodeVerificationSummary,
  factStatuses,
} from '../src/verification/contract';
import { summary } from './verification-helpers';

test('verification contract preserves all independent fact and application states without inferring another fact', () => {
  for (const affiliation of factStatuses)
    for (const studentNumber of factStatuses)
      for (const phone of factStatuses)
        for (const application of applicationStatuses) {
          const value = summary({
            affiliation: { status: affiliation },
            studentNumber: { status: studentNumber },
            phone: { status: phone },
            application: { status: application },
          });
          const decoded = decodeVerificationSummary(value);
          assert.deepEqual(decoded, value);
          assert.ok(Object.isFrozen(decoded));
          for (const item of Object.values(decoded))
            assert.ok(Object.isFrozen(item));
        }
});
test('summary decoder rejects unknown, missing, coercible or additional fields at every level', () => {
  const bad: unknown[] = [
    null,
    [],
    {},
    { ...summary(), accountId: '12345678-1234-4123-8123-123456789abc' },
    { ...summary(), legalName: 'private synthetic name' },
  ];
  for (const key of ['affiliation', 'studentNumber', 'phone', 'application']) {
    const missing: Record<string, unknown> = { ...summary() };
    delete missing[key];
    bad.push(missing);
    for (const value of [
      null,
      [],
      {},
      'verified',
      true,
      { status: true },
      { status: 'unknown' },
      { status: undefined },
      { status: 'verified', value: '00123' },
      { status: 'verified', phoneNumber: '+12025550123' },
      { status: 'unavailable', evidenceUrl: 'https://example.invalid/private' },
      { status: { toString: () => 'verified' } },
    ])
      bad.push({ ...summary(), [key]: value });
  }
  bad.push({ ...summary(), application: { status: 'verified' } });
  bad.push({ ...summary(), affiliation: { status: 'pending' } });
  for (const value of bad)
    assert.throws(() => decodeVerificationSummary(value), {
      kind: 'protocol',
      message: 'Invalid verification summary',
    });
});
test('decoding copies status records and never retains a mutable transport payload', () => {
  const raw = {
    affiliation: { status: 'verified' },
    studentNumber: { status: 'unverified' },
    phone: { status: 'unverified' },
    application: { status: 'none' },
  };
  const decoded = decodeVerificationSummary(raw);
  raw.affiliation.status = 'revoked';
  assert.equal(decoded.affiliation.status, 'verified');
  assert.equal(JSON.stringify(decoded).includes('accountId'), false);
});
