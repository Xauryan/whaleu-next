import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  batchRequestHash,
  memberRequestHash,
  decodeBatchIdentity,
  decodeMemberPrepare,
  decodeBatchStatus,
  decodeBatchRecovery,
  decodeBatchFenceResult,
  attachmentPlanDigest,
  batchCommandHash,
} from '../src/media/batch-contracts';
import { decodeUploadPrepare } from '../src/media/upload-contracts';
import {
  identity,
  ids,
  memberPrepare,
  readyBatch,
  uuid,
} from './support/media-batch-fixtures';
const hash = (domain: string, value: unknown) =>
  createHash('sha256')
    .update(`${domain}\n${JSON.stringify(value)}`)
    .digest('hex');
test('v3 batch and member canonical hashes bind actor, source slot and declaration without changing v2', () => {
  assert.equal(
    batchRequestHash(ids.actor, identity),
    hash('whaleu-media-batch:v1', { actorAccountId: ids.actor, identity }),
  );
  const input = memberPrepare(2);
  assert.equal(
    memberRequestHash(ids.actor, identity, input),
    hash('whaleu-media-member:v3', {
      version: 3,
      actorAccountId: ids.actor,
      batchRequestHash: batchRequestHash(ids.actor, identity),
      clientRequestId: input.clientRequestId,
      memberId: input.memberId,
      sourceSlot: input.sourceSlot,
      declaration: input.declaration,
    }),
  );
  assert.notEqual(
    memberRequestHash(ids.actor, identity, input),
    memberRequestHash(ids.actor, identity, { ...input, sourceSlot: 1 }),
  );
  assert.throws(() =>
    decodeUploadPrepare({
      clientRequestId: input.clientRequestId,
      purpose: 'community-post-image',
      draftId: ids.draft,
      spaceId: ids.space,
      slot: 'images',
      ordinal: 1,
      declaration: input.declaration,
    }),
  );
  assert.throws(() =>
    decodeBatchIdentity({ ...identity, token: 'not-allowed' }),
  );
  assert.throws(() => decodeMemberPrepare({ ...input, sourceSlot: 9 }));
});
test('strict batch status never filters unknown or duplicate membership and requires complete history', () => {
  const status = readyBatch(9);
  assert.equal(decodeBatchStatus(status).members.length, 9);
  for (const raw of [
    { ...status, members: status.members.slice(1) },
    {
      ...status,
      orderedMemberIds: [
        ...status.orderedMemberIds.slice(1),
        status.orderedMemberIds[1],
      ],
    },
    { ...status, orderedAssets: status.orderedAssets.slice(1) },
    { ...status, members: [...status.members.slice(0, 8), status.members[0]] },
    { ...status, url: 'https://invalid.example/private.png' },
    { ...status, bindBefore: status.bindBefore + 1 },
  ])
    assert.throws(() => decodeBatchStatus(raw));
  assert.throws(() =>
    decodeBatchRecovery({
      version: 3,
      state: 'not_recorded',
      batchRequestId: identity.batchRequestId,
      serverNow: 1000,
      status,
    }),
  );
});
test('seal digest and layout hashes distinguish exact order and expected revision', () => {
  const ready = readyBatch(),
    assets = ready.orderedAssets;
  assert.notEqual(
    attachmentPlanDigest(uuid(2), '5', assets),
    attachmentPlanDigest(uuid(2), '5', [...assets].reverse()),
  );
  assert.notEqual(
    attachmentPlanDigest(uuid(2), '5', assets),
    attachmentPlanDigest(uuid(2), '6', assets),
  );
  const command = {
    kind: 'layout' as const,
    payload: {
      commandId: uuid(91),
      expectedRevision: '4',
      orderedMemberIds: ready.orderedMemberIds,
      removeMemberIds: [],
    },
  };
  assert.equal(
    batchCommandHash(uuid(2), command),
    hash('whaleu-media-batch-command:v1', {
      version: 1,
      batchId: uuid(2),
      kind: 'layout',
      command: command.payload,
    }),
  );
});
test('dedicated cancelled fence cannot masquerade as a legacy receipt or omit intent hash', () => {
  const cancellation = {
    outcome: 'cancelled',
    operation: 'publish_post',
    requestId: ids.publication,
    intentHash: 'e'.repeat(64),
  };
  assert.equal(
    decodeBatchFenceResult({ version: 3, status: readyBatch(), cancellation })
      .cancellation.outcome,
    'cancelled',
  );
  assert.throws(() =>
    decodeBatchFenceResult({
      version: 3,
      status: readyBatch(),
      cancellation: { ...cancellation, intentHash: null },
    }),
  );
});
