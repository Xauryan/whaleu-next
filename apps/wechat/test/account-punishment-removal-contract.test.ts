import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeAdminPostRemovalCommand,
  decodeAdminPostRemovalReceipt,
  matchAdminPostRemovalReceipt,
  adminPostRemovalCommandHash,
} from '../src/admin-post-removal/contract';
import { decodeAdminDiscussionRemovalCommand } from '../src/admin-discussion-removal/contract';
const actor = '11000000-0000-4000-8000-000000000001';
const selection = {
  kind: 'interaction_mute',
  duration: { kind: 'finite', unit: 'days', value: 7 },
  reason: 'Exact source reason',
  expectedRevision: '0',
};
const input = {
  version: 2,
  clientRequestId: '11000000-0000-4000-8000-000000000002',
  target: { kind: 'post', id: '11000000-0000-4000-8000-000000000003' },
  action: 'remove_post',
  expectedTargetVersion: 'a'.repeat(64),
  punishment: selection,
};
test('causal v2 native intent freezes kind duration reason and revision without weakening historical v1', () => {
  const command = decodeAdminPostRemovalCommand(input);
  const receipt = decodeAdminPostRemovalReceipt({
    version: 2,
    requestId: input.clientRequestId,
    target: input.target,
    action: input.action,
    expectedTargetVersion: input.expectedTargetVersion,
    outcome: 'applied',
    eventId: '11000000-0000-4000-8000-000000000004',
    recordedAt: '2026-10-13T00:00:00.000Z',
    selection,
    punishment: {
      kind: selection.kind,
      punishmentId: '11000000-0000-4000-8000-000000000005',
      revision: '1',
    },
  });
  matchAdminPostRemovalReceipt(command, receipt);
  for (const patch of [
    { kind: 'access_suspension' },
    { reason: 'Changed' },
    { expectedRevision: '1' },
    { duration: { kind: 'permanent' } },
  ]) {
    const changed = decodeAdminPostRemovalCommand({
      ...input,
      punishment: { ...selection, ...patch },
    });
    assert.notEqual(
      adminPostRemovalCommandHash(actor, changed),
      adminPostRemovalCommandHash(actor, command),
    );
    assert.throws(() => matchAdminPostRemovalReceipt(changed, receipt));
  }
  const v1 = {
    clientRequestId: input.clientRequestId,
    target: input.target,
    action: input.action,
    expectedTargetVersion: input.expectedTargetVersion,
  };
  assert.notEqual(
    adminPostRemovalCommandHash(actor, decodeAdminPostRemovalCommand(v1)),
    adminPostRemovalCommandHash(actor, command),
  );
  assert.throws(() =>
    decodeAdminPostRemovalCommand({ ...v1, punishment: selection }),
  );
  assert.throws(() =>
    decodeAdminPostRemovalCommand({
      ...input,
      punishment: {
        ...selection,
        duration: { kind: 'finite', unit: 'minutes', value: 1 },
      },
    }),
  );
  assert.throws(() =>
    decodeAdminPostRemovalCommand({
      ...input,
      punishment: { ...selection, subjectId: actor },
    }),
  );
  assert.equal(
    decodeAdminDiscussionRemovalCommand({
      ...input,
      target: { ...input.target, kind: 'reply' },
      action: 'remove_discussion',
      punishment: {
        ...selection,
        duration: { kind: 'finite', unit: 'minutes', value: 1 },
      },
    }).version,
    2,
  );
});
