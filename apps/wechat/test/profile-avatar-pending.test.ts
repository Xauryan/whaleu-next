import assert from 'node:assert/strict';
import test from 'node:test';
import { PendingAvatarStore } from '../src/profile/avatar-pending';
import { PROFILE_MEDIA_PROTOCOL as protocol } from '../src/profile/avatar-contract';
import { MemoryStorage } from './helpers';
import {
  avatarIds,
  avatarPrepare,
  avatarReady,
  avatarReceipt,
} from './support/avatar-fixtures';
test('new journal is exact actor/origin scoped metadata and leaves legacy namespaces unchanged', () => {
  const storage = new MemoryStorage(),
    pending = new PendingAvatarStore(storage, 'https://api.example.test');
  storage.set('whaleu.media.pending.v1:legacy', { untouched: true });
  let record = pending.freezeEdit(avatarIds.actor, avatarPrepare);
  record = pending.observe(record, avatarReady());
  record = pending.freezeCommand(avatarIds.actor, {
    protocol,
    clientRequestId: avatarIds.command,
    expectedRevision: 5,
    source: {
      kind: 'custom',
      editId: avatarIds.edit,
      assetId: avatarIds.asset,
    },
  });
  assert.equal(pending.load(avatarIds.other), null);
  const otherOrigin = new PendingAvatarStore(
    storage,
    'https://other.example.test',
  );
  assert.equal(otherOrigin.load(avatarIds.actor), null);
  const saved = JSON.stringify(record);
  for (const forbidden of [
    'wxfile:',
    'accessToken',
    'refreshToken',
    'grantId',
    'previewSrc',
    'localId',
    'filePath',
  ])
    assert.ok(!saved.includes(forbidden));
  assert.deepEqual(storage.get('whaleu.media.pending.v1:legacy'), {
    untouched: true,
  });
  const receipt = avatarReceipt(record.command!.input);
  assert.throws(() =>
    pending.settleCommand(record, { ...receipt, requestHash: 'f'.repeat(64) }),
  );
  pending.settleCommand(record, receipt);
  assert.equal(pending.load(avatarIds.actor), null);
});
test('unknown record is never evicted, rebound, or treated as no pending command', () => {
  const storage = new MemoryStorage(),
    pending = new PendingAvatarStore(storage, 'https://api.example.test');
  const input = {
    protocol,
    clientRequestId: avatarIds.command,
    expectedRevision: 5,
    source: { kind: 'clear' as const },
  };
  const record = pending.freezeCommand(avatarIds.actor, input);
  assert.throws(() =>
    pending.freezeCommand(avatarIds.actor, { ...input, expectedRevision: 6 }),
  );
  assert.deepEqual(pending.load(avatarIds.actor), record);
  const key = [...storage.data.keys()][0]!;
  storage.set(key, { ...record, token: 'must-not-be-loaded' });
  assert.throws(() => pending.load(avatarIds.actor));
  assert.throws(() => pending.freezeCommand(avatarIds.actor, input));
});
test('pre-prepare cancellation settles only an exact actor request fence with no fabricated IDs', () => {
  const pending = new PendingAvatarStore(
    new MemoryStorage(),
    'https://api.example.test',
  );
  const record = pending.freezeEdit(avatarIds.actor, avatarPrepare);
  pending.settlePrePrepare(record, {
    protocol,
    requestId: avatarIds.request,
    serverNow: 1000,
    state: 'cancelled_before_prepare',
    requestHash: record.edit!.requestHash,
    reason: 'cancelled',
  });
  assert.equal(pending.load(avatarIds.actor), null);
});
test('command cancellation fence is same-key/hash exact and preserves unresolved custom edit', () => {
  const pending = new PendingAvatarStore(
    new MemoryStorage(),
    'https://api.example.test',
  );
  let record = pending.freezeEdit(avatarIds.actor, avatarPrepare);
  record = pending.observe(record, avatarReady());
  record = pending.freezeCommand(avatarIds.actor, {
    protocol,
    clientRequestId: avatarIds.command,
    expectedRevision: 5,
    source: {
      kind: 'custom',
      editId: avatarIds.edit,
      assetId: avatarIds.asset,
    },
  });
  const proof = {
    protocol,
    clientRequestId: avatarIds.command,
    state: 'cancelled' as const,
    requestHash: record.command!.requestHash,
  };
  assert.throws(() =>
    pending.settleCancelledCommand(record, {
      ...proof,
      requestHash: 'f'.repeat(64),
    }),
  );
  assert.throws(() =>
    pending.settleCancelledCommand(record, {
      ...proof,
      clientRequestId: avatarIds.request,
    }),
  );
  const remaining = pending.settleCancelledCommand(record, proof)!;
  assert.equal(remaining.command, null);
  assert.equal(remaining.edit!.editId, avatarIds.edit);
  assert.deepEqual(pending.load(avatarIds.actor), remaining);
});
