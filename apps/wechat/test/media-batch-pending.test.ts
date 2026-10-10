import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PendingBatchStore,
  decodePendingBatch,
} from '../src/media/batch-pending';
import { batchCommandHash } from '../src/media/batch-contracts';
import {
  batchHarness,
  identity,
  ids,
  origin,
  uuid,
} from './support/media-batch-fixtures';
import { MemoryStorage } from './helpers';
test('nine ready members survive storage-only restart; media journal never contains publication body or paths', () => {
  const h = batchHarness(9),
    restarted = new PendingBatchStore(h.storage, origin);
  const record = restarted.load(ids.actor)!;
  assert.equal(record.members.length, 9);
  assert.equal(
    record.members.every(
      (m) => m.observation?.observation.status === 'ready_unbound',
    ),
    true,
  );
  const raw = JSON.stringify([...h.storage.data.values()]);
  for (const forbidden of [
    'Original body',
    'wxfile:',
    'Bearer',
    'accessToken',
    'grantId',
    'Review',
  ])
    assert.equal(raw.includes(forbidden), false);
  assert.equal(restarted.load(ids.other), null);
  assert.equal(
    new PendingBatchStore(h.storage, 'https://elsewhere.invalid').load(
      ids.actor,
    ),
    null,
  );
  h.controller.dispose();
});
test('CAS + readback reject stale writers, damaged keys, unknown fields and member deletion without terminal evidence', () => {
  const h = batchHarness(),
    original = h.record;
  const next = h.pending.update(original, { phase: 'editing' });
  assert.throws(() => h.pending.update(original, { phase: 'editing' }));
  assert.throws(() =>
    h.pending.update(next, {
      members: next.members.slice(1),
      orderedMemberIds: next.orderedMemberIds.slice(1),
    }),
  );
  for (const patch of [
    { body: 'forbidden' },
    { filePath: 'wxfile://tmp/private' },
    { members: [{ ...next.members[0], bearer: 'secret' }] },
    { batchRequestHash: '0'.repeat(64) },
  ])
    assert.throws(() =>
      decodePendingBatch({ ...next, ...patch }, ids.actor, origin),
    );
  const key = [...h.storage.data.keys()][0]!;
  h.storage.data.set(key, 'damaged');
  assert.throws(() => h.pending.load(ids.actor));
  h.controller.dispose();
});
test('lost/torn whole-record writes fail readback before any network action', () => {
  class TornStorage extends MemoryStorage {
    override set(key: string, value: unknown): void {
      super.set(key, { ...(value as object), revision: 999 });
    }
  }
  const pending = new PendingBatchStore(new TornStorage(), origin);
  assert.throws(() => pending.freeze(ids.actor, identity, 1000));
});
test('layout persists complete desired order and retiring obligation before network', () => {
  const h = batchHarness(),
    record = h.record,
    removed = record.members[0]!;
  const command = {
    kind: 'layout' as const,
    payload: {
      commandId: uuid(99),
      expectedRevision: record.serverRevision!,
      orderedMemberIds: record.orderedMemberIds.slice(1),
      removeMemberIds: [removed.memberId],
    },
  };
  const saved = h.pending.update(record, {
    phase: 'layout_uncertain',
    orderedMemberIds: command.payload.orderedMemberIds,
    members: record.members.slice(1),
    retiring: [removed],
    pendingCommand: {
      ...command,
      commandHash: batchCommandHash(record.batchId!, command),
    },
  });
  assert.equal(saved.retiring[0]!.memberId, removed.memberId);
  assert.throws(() => h.pending.update(saved, { retiring: [] }));
  h.controller.dispose();
});

test('same-origin legacy coexistence is explicit; corrupt pending.v1 blocks new batch instead of becoming absence', () => {
  const h = batchHarness();
  const legacyPrepare = {
    clientRequestId: ids.request,
    purpose: 'community-post-image' as const,
    draftId: ids.draft,
    spaceId: ids.space,
    slot: 'images' as const,
    ordinal: 0 as const,
    declaration: {
      mime: 'image/png' as const,
      bytes: 100,
      sha256: 'a'.repeat(64),
    },
  };
  h.pending.legacy.freeze(ids.actor, legacyPrepare, 1000);
  assert.equal(h.runtime.modeForActor(ids.actor), 'conflict');
  assert.throws(() => h.pending.assertBatchAdmission(ids.actor));
  const batchKey = [...h.storage.data.keys()].find((key) =>
    key.startsWith('whaleu.media.batch.pending.v3:'),
  )!;
  h.storage.remove(batchKey);
  assert.equal(h.runtime.modeForActor(ids.actor), 'legacy');
  assert.throws(() => h.pending.freeze(ids.actor, identity, 1000));
  const legacyKey = [...h.storage.data.keys()].find((key) =>
    key.startsWith('whaleu.media.pending.v1:'),
  )!;
  h.storage.data.set(legacyKey, { damaged: true });
  assert.throws(() => h.runtime.modeForActor(ids.actor));
  assert.throws(() => h.pending.freeze(ids.actor, identity, 1000));
  h.controller.dispose();
});
