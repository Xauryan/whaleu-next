import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  schoolIdentityCommandSchema,
  schoolIdentityCommandCanonical,
  schoolIdentityCommandHash,
  schoolIdentityReceiptSchema,
  schoolIdentityManagementSchema,
  schoolIdentityRecoverySchema,
} from '../src/school-identity/contracts.js';
const command = {
  version: 1 as const,
  clientRequestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  action: 'correct_school' as const,
  targetProfileId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  expectedStateVersion: 'a'.repeat(64),
  destinationCampusId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  expectedDestinationVersion: 'b'.repeat(64),
};
test('school identity accepts only action-specific full public intent and UUIDv4 original keys', () => {
  assert.deepEqual(schoolIdentityCommandSchema.parse(command), command);
  for (const patch of [
    { version: 2 },
    { clientRequestId: command.clientRequestId.toUpperCase() },
    { clientRequestId: 'aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa' },
    { accountId: 'private' },
    { assertionId: 'private' },
    { uid: '12' },
    { studentNumber: 'private' },
    { action: 'complete_uid' },
    { expectedDestinationVersion: 'B'.repeat(64) },
    { targetProfileId: command.targetProfileId.toUpperCase() },
  ])
    assert.equal(
      schoolIdentityCommandSchema.safeParse({ ...command, ...patch }).success,
      false,
    );
  const { destinationCampusId, expectedDestinationVersion, ...common } =
    command;
  assert.ok(destinationCampusId && expectedDestinationVersion);
  assert.equal(
    schoolIdentityCommandSchema.safeParse({ ...common, action: 'complete_uid' })
      .success,
    true,
  );
});
test('canonical intent hash has fixed field order, domain and no request ID or trailing newline', () => {
  const canonical =
    'whaleu:school-identity-command:v1\n' +
    [
      '1',
      'correct_school',
      command.targetProfileId,
      command.expectedStateVersion,
      command.destinationCampusId,
      command.expectedDestinationVersion,
    ].join('\n');
  assert.equal(schoolIdentityCommandCanonical(command), canonical);
  assert.equal(
    schoolIdentityCommandHash(command),
    createHash('sha256').update(canonical).digest('hex'),
  );
  assert.equal(
    schoolIdentityCommandHash(command),
    schoolIdentityCommandHash({
      ...command,
      clientRequestId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    }),
  );
  assert.notEqual(
    schoolIdentityCommandHash(command),
    schoolIdentityCommandHash({
      ...command,
      expectedDestinationVersion: 'c'.repeat(64),
    }),
  );
});
test('receipts freeze minimal exact intent without mutable school names or current visibility', () => {
  const { clientRequestId, ...intent } = command;
  const receipt = {
    ...intent,
    requestId: clientRequestId,
    outcome: 'applied',
    eventId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    recordedAt: '2026-10-13T00:00:00.000Z',
  };
  assert.deepEqual(schoolIdentityReceiptSchema.parse(receipt), receipt);
  for (const patch of [
    { schoolName: 'private history' },
    { accountId: 'private' },
    { uid: '1' },
    { version: 2 },
    { outcome: 'queued' },
  ])
    assert.equal(
      schoolIdentityReceiptSchema.safeParse({ ...receipt, ...patch }).success,
      false,
    );
  assert.equal(
    schoolIdentityRecoverySchema.safeParse({ state: 'not_recorded', receipt })
      .success,
    false,
  );
});
test('management cannot claim assigned school UID from a different current school', () => {
  const value = {
    target: { profileId: command.targetProfileId, displayName: '合成' },
    stateVersion: command.expectedStateVersion,
    current: {
      school: { code: '12345', name: '学校' },
      schoolUid: {
        status: 'assigned',
        school: { code: '12345', name: '学校' },
        uid: '1',
        formattedUid: '000001',
      },
    },
    destination: null,
    actions: { correctSchool: true, completeUid: false },
  };
  assert.equal(schoolIdentityManagementSchema.safeParse(value).success, true);
  assert.equal(
    schoolIdentityManagementSchema.safeParse({
      ...value,
      current: { ...value.current, school: { code: '54321', name: '学校' } },
    }).success,
    false,
  );
  assert.equal(
    schoolIdentityManagementSchema.safeParse({
      ...value,
      destination: {
        campusId: command.destinationCampusId,
        campusName: '校区',
        school: { code: '54321', name: '新学校' },
        destinationVersion: command.expectedDestinationVersion,
        predictedUid: '2',
      },
    }).success,
    false,
  );
});
