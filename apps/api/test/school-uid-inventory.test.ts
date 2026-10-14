import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  inventoryDigest,
  schoolUidInventorySchema,
  validateSchoolUidInventory,
  applySyntheticInventory,
} from '../src/school-uid/inventory.js';
import type { SchoolUidInventory } from '../src/school-uid/inventory.js';
import type { PoolClient } from 'pg';
const d = 'a'.repeat(64);
function manifest(): SchoolUidInventory {
  return {
    format: 'school-uid-inventory/v1',
    classification: 'synthetic',
    sourceInstance: 'synthetic-unit-fixture',
    sourceCutoff: '2026-01-01T00:00:00Z',
    snapshotDigest: d,
    schoolCrosswalkDigest: d,
    accountCrosswalkDigest: d,
    reviewerAcceptanceDigest: d,
    writerQuiescenceDigest: d,
    finalDeltaDigest: d,
    schools: [
      {
        sourceSchoolId: 'school-a',
        institutionId: randomUUID(),
        schoolCode: '12345',
        classification: 'reconciled',
        sourceEmptyVerified: false,
        trustedCeiling: '1000',
        ceilingJustificationDigest: d,
        priorAdmittedFloor: '0',
        trustedCounters: [{ type: 'integer', value: '100' }],
        counterReset: false,
        unknownHistoryBounded: true,
        reservations: [],
        unresolvedConflicts: [],
      },
    ],
  };
}
function row(uid: string, accountId = randomUUID()) {
  return {
    uid: { type: 'string' as const, value: uid },
    sourceAccountId: 'source-' + accountId,
    accountId,
    sourceSchoolId: 'school-a',
    kind: 'current' as const,
  };
}
function reasons(value: SchoolUidInventory) {
  return validateSchoolUidInventory(value).quarantinedSchools[0]!.reasons;
}
test('inventory preserves holes as reservation floor without manufacturing accounts', () => {
  const value = manifest();
  value.schools[0]!.reservations = [row('1'), row('100')];
  const report = validateSchoolUidInventory(value);
  assert.equal(report.acceptedSchools[0]!.reservedFloor, '1000');
  assert.equal(report.acceptedSchools[0]!.observedMaximum, '100');
  assert.equal(report.acceptedSchools[0]!.reservationCount, 2);
  assert.equal(report.realApplyAvailable, false);
});
test('inventory bigint maximum and above JS safe-integer remain exact decimal strings', () => {
  for (const uid of ['9007199254740993', '9223372036854775807']) {
    const value = manifest();
    const s = value.schools[0]!;
    s.trustedCeiling = uid;
    s.trustedCounters = [{ type: 'integer', value: uid }];
    s.reservations = [row(uid)];
    const accepted = validateSchoolUidInventory(value).acceptedSchools[0]!;
    assert.equal(accepted.reservedFloor, uid);
    assert.equal(accepted.counterMaximum, uid);
    assert.equal(accepted.observedMaximum, uid);
  }
});
test('inventory rejects coercions, floats, overflow and invalid source types', () => {
  for (const value of [
    '1e3',
    '+1',
    ' 1',
    '1.0',
    '-1',
    '0',
    '9223372036854775808',
    '１',
  ]) {
    const input = manifest();
    input.schools[0]!.reservations = [row(value)];
    assert.ok(reasons(input).includes('RAW_INTEGER_INVALID'));
  }
  const input = manifest();
  input.schools[0]!.trustedCounters = [{ type: 'float', value: '100' }];
  assert.ok(reasons(input).includes('RAW_INTEGER_INVALID'));
  assert.equal(
    schoolUidInventorySchema.safeParse({ ...manifest(), packageDigest: d })
      .success,
    false,
  );
  const bad = manifest();
  (bad.schools[0]!.trustedCounters[0] as unknown as { value: number }).value =
    9007199254740992;
  assert.equal(schoolUidInventorySchema.safeParse(bad).success, false);
});
test('missing/reset low counters and unknown history are quarantined rather than guessed from visible maximum', () => {
  for (const patch of [
    { trustedCounters: [] },
    { counterReset: true },
    { unknownHistoryBounded: false },
    { trustedCeiling: null },
  ]) {
    const input = manifest();
    Object.assign(input.schools[0]!, patch);
    assert.equal(validateSchoolUidInventory(input).acceptedSchools.length, 0);
  }
  const input = manifest();
  input.schools[0]!.reservations = [row('101')];
  assert.ok(reasons(input).includes('COUNTER_BELOW_OBSERVATION'));
});
test('trusted ceiling must cover prior reservations, counters and observed history', () => {
  const input = manifest();
  input.schools[0]!.priorAdmittedFloor = '1001';
  assert.ok(reasons(input).includes('CEILING_BELOW_OBSERVATION'));
});
test('two schools can share a number while same-school conflicting owners quarantine only that institution', () => {
  const input = manifest();
  const first = input.schools[0]!;
  first.reservations = [row('1'), row('1')];
  input.schools.push({
    ...first,
    institutionId: randomUUID(),
    schoolCode: '23456',
    sourceSchoolId: 'school-b',
    reservations: [{ ...row('1'), sourceSchoolId: 'school-b' }],
  });
  const report = validateSchoolUidInventory(input);
  assert.equal(report.acceptedSchools.length, 1);
  assert.equal(report.acceptedSchools[0]!.schoolCode, '23456');
  assert.ok(
    report.quarantinedSchools[0]!.reasons.includes('DUPLICATE_UID_OWNERS'),
  );
});
test('exact repeated history owner is retained, unknown reservation owners are not invented', () => {
  const input = manifest();
  const r = row('1');
  input.schools[0]!.reservations = [
    r,
    { ...r, kind: 'historical' },
    {
      uid: { type: 'integer', value: '90' },
      accountId: null,
      sourceAccountId: null,
      sourceSchoolId: 'school-a',
      kind: 'deleted',
    },
  ];
  assert.equal(validateSchoolUidInventory(input).acceptedSchools.length, 1);
});
test('school/crosswalk ambiguity and account mapping collisions are explicit quarantines', () => {
  const input = manifest();
  input.schools.push({ ...input.schools[0]!, sourceSchoolId: 'another' });
  assert.equal(validateSchoolUidInventory(input).quarantinedSchools.length, 2);
  const mapped = manifest();
  mapped.schools[0]!.reservations = [
    row('1'),
    { ...row('2'), sourceAccountId: 'same-source' },
    { ...row('3'), sourceAccountId: 'same-source' },
  ];
  assert.ok(reasons(mapped).includes('ACCOUNT_MAPPING_CONFLICT'));
  const mismatch = manifest();
  mismatch.schools[0]!.reservations = [
    { ...row('1'), sourceSchoolId: 'wrong-school' },
  ];
  assert.ok(reasons(mismatch).includes('ACCOUNT_SCHOOL_MISMATCH'));
});
test('known-new zero requires explicit absence, ceiling and cutover evidence', () => {
  const input = manifest();
  Object.assign(input.schools[0]!, {
    classification: 'known_new',
    sourceEmptyVerified: true,
    trustedCeiling: '0',
    trustedCounters: [],
  });
  assert.equal(
    validateSchoolUidInventory(input).acceptedSchools[0]!.reservedFloor,
    '0',
  );
  input.schools[0]!.sourceEmptyVerified = false;
  assert.ok(reasons(input).includes('KNOWN_NEW_CONFLICT'));
  input.schools[0]!.sourceEmptyVerified = true;
  input.writerQuiescenceDigest = null;
  assert.ok(reasons(input).includes('WRITER_CUTOVER_MISSING'));
});
test('package canonical digest is order-independent and preserves raw integer type and bytes', () => {
  const input = manifest();
  assert.equal(
    inventoryDigest(input),
    inventoryDigest(Object.fromEntries(Object.entries(input).reverse())),
  );
  const first = inventoryDigest(input);
  input.schools[0]!.trustedCounters[0]!.type = 'string';
  assert.notEqual(inventoryDigest(input), first);
  const second = inventoryDigest(input);
  input.schools[0]!.trustedCounters[0]!.value = '00100';
  assert.notEqual(inventoryDigest(input), second);
});
test('real apply is unavailable before any database action', async () => {
  const input = manifest();
  input.classification = 'real';
  const tx = {
    query: () => {
      throw new Error('must never touch the database');
    },
  } as unknown as PoolClient;
  await assert.rejects(
    applySyntheticInventory(input, input.schools[0]!.institutionId, tx),
    /REAL_SCHOOL_UID_APPLY_UNAVAILABLE/,
  );
});
