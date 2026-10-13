import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { canonicalJson } from '../src/community/content-review/contracts.js';
import { capabilitiesFromGrants } from '../src/authorization/contracts.js';
import {
  schoolAdminManagementCommandSchema,
  schoolAdminManagementSchema,
  schoolAdminManagementReceiptSchema,
  schoolAdminManagementRecoverySchema,
  schoolAdminManagementQuerySchema,
} from '../src/authorization/school-admin-management/contracts.js';
import { schoolAdminManagementIntentHash } from '../src/authorization/school-admin-management/evidence.js';
import { titles } from '../src/experience/catalog.js';
const actor = randomUUID(),
  target = randomUUID(),
  region = randomUUID(),
  request = randomUUID();
const command = {
  clientRequestId: request,
  targetProfileId: target,
  expectedStateVersion: 'a'.repeat(64),
  action: 'appoint' as const,
  regionId: region,
};
const base = {
  requestId: request,
  targetProfileId: target,
  expectedStateVersion: command.expectedStateVersion,
  action: command.action,
  regionId: region,
};
test('school management commands are exact public references and explicit distinct actions', () => {
  assert.deepEqual(schoolAdminManagementCommandSchema.parse(command), command);
  assert.ok(
    schoolAdminManagementCommandSchema.safeParse({
      ...command,
      action: 'reassign',
    }).success,
  );
  const { regionId: removedRegion, ...withoutRegion } = command;
  assert.equal(removedRegion, region);
  assert.ok(
    schoolAdminManagementCommandSchema.safeParse({
      ...withoutRegion,
      action: 'revoke',
    }).success,
  );
  assert.equal(
    schoolAdminManagementCommandSchema.safeParse(withoutRegion).success,
    false,
  );
  for (const patch of [
    { action: 'revoke' },
    { action: 'grant_global' },
    { targetAccountId: actor },
    { role: 'school_admin' },
    { titleKey: 'role_admin' },
    { validFrom: 'now' },
    { expiresAt: null },
    { newStatus: 'verified' },
    { expectedStateVersion: 'A'.repeat(64) },
    { clientRequestId: 'aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa' },
  ])
    assert.equal(
      schoolAdminManagementCommandSchema.safeParse({ ...command, ...patch })
        .success,
      false,
    );
  assert.equal(
    schoolAdminManagementQuerySchema.safeParse({
      targetProfileId: target,
      accountId: actor,
    }).success,
    false,
  );
});
test('actor and complete frozen intent bind original-key canonical hash', () => {
  const expected = createHash('sha256')
    .update(
      'whaleu:school-admin-management-command:v1\n' +
        canonicalJson({ actor, command }),
    )
    .digest('hex');
  assert.equal(schoolAdminManagementIntentHash(actor, command), expected);
  assert.equal(
    schoolAdminManagementIntentHash(actor, {
      regionId: region,
      action: 'appoint',
      expectedStateVersion: command.expectedStateVersion,
      targetProfileId: target,
      clientRequestId: request,
    }),
    expected,
  );
  for (const patch of [
    { clientRequestId: randomUUID() },
    { targetProfileId: randomUUID() },
    { expectedStateVersion: 'b'.repeat(64) },
    { action: 'reassign' as const },
    { regionId: randomUUID() },
  ])
    assert.notEqual(
      schoolAdminManagementIntentHash(actor, { ...command, ...patch }),
      expected,
    );
  assert.notEqual(
    schoolAdminManagementIntentHash(randomUUID(), command),
    expected,
  );
});
test('receipts contain original intent and terminal outcome only; not-recorded proves no failure', () => {
  for (const outcome of ['applied', 'unchanged'] as const) {
    const receipt = {
      ...base,
      outcome,
      eventId: randomUUID(),
      recordedAt: '2026-10-13T05:00:00.000Z',
      titleGranted: true,
    };
    assert.ok(schoolAdminManagementReceiptSchema.safeParse(receipt).success);
    assert.ok(
      schoolAdminManagementRecoverySchema.safeParse({
        state: 'recorded',
        receipt,
      }).success,
    );
    for (const key of [
      'accountId',
      'subjectId',
      'grantId',
      'source',
      'sessionId',
      'phone',
      'studentNumber',
    ])
      assert.equal(
        schoolAdminManagementReceiptSchema.safeParse({
          ...receipt,
          [key]: actor,
        }).success,
        false,
      );
  }
  for (const code of [
    'SCHOOL_ADMIN_MANAGEMENT_STALE',
    'SCHOOL_ADMIN_MANAGEMENT_CANCELLED',
  ])
    assert.ok(
      schoolAdminManagementReceiptSchema.safeParse({
        ...base,
        outcome: 'rejected',
        code,
      }).success,
    );
  assert.ok(
    schoolAdminManagementRecoverySchema.safeParse({ state: 'not_recorded' })
      .success,
  );
  assert.equal(
    schoolAdminManagementRecoverySchema.safeParse({
      state: 'not_recorded',
      canReplaceKey: true,
    }).success,
    false,
  );
  assert.equal(
    schoolAdminManagementReceiptSchema.safeParse({
      ...base,
      action: 'revoke',
      outcome: 'rejected',
      code: 'SCHOOL_ADMIN_MANAGEMENT_CANCELLED',
    }).success,
    false,
  );
});
test('management publicly distinguishes future/expired assignment and unavailable eligibility without private facts', () => {
  const management = {
    target: { profileId: target, displayName: 'Synthetic' },
    stateVersion: command.expectedStateVersion,
    currentAssignment: {
      regionId: region,
      name: 'Synthetic region',
      status: 'future',
    },
    eligibility: {
      status: 'unavailable',
      reason: 'source_unavailable',
      regions: [],
      defaultRegionId: null,
    },
    actions: { appoint: false, reassign: false, revoke: true },
  };
  assert.ok(schoolAdminManagementSchema.safeParse(management).success);
  for (const status of ['active', 'expired', 'unavailable'])
    assert.ok(
      schoolAdminManagementSchema.safeParse({
        ...management,
        currentAssignment: { ...management.currentAssignment, status },
      }).success,
    );
  assert.equal(
    schoolAdminManagementSchema.safeParse({
      ...management,
      target: { ...management.target, accountId: actor },
    }).success,
    false,
  );
});
test('independent management capability requires actual super grant even with developer highest label', () => {
  const grant = { id: randomUUID(), operatingRegionId: null, validUntil: null };
  assert.equal(capabilitiesFromGrants([]).schoolAdminManagement, false);
  assert.equal(
    capabilitiesFromGrants([{ ...grant, role: 'developer' }])
      .schoolAdminManagement,
    false,
  );
  const mixed = capabilitiesFromGrants([
    { ...grant, role: 'developer' },
    { ...grant, id: randomUUID(), role: 'super_admin' },
  ]);
  assert.equal(mixed.role, 'developer');
  assert.equal(mixed.schoolAdminManagement, true);
  assert.deepEqual(
    titles.find((title) => title.key === 'role_admin'),
    { key: 'role_admin', name: '管理员', kind: 'special', unlockLevel: null },
  );
});
