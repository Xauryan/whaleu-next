import assert from 'node:assert/strict';
import test from 'node:test';
import { PendingCoverStore } from '../src/profile/cover-pending';
import { PROFILE_COVER_PROTOCOL as protocol } from '../src/profile/cover-contract';
import { MemoryStorage } from './helpers';
import {
  coverIds,
  coverBase,
  coverPrepare,
  coverReady,
  coverReceipt,
} from './support/cover-fixtures';
test('new journal is exact actor/origin scoped metadata and leaves legacy namespaces unchanged', () => {
  const storage = new MemoryStorage(),
    pending = new PendingCoverStore(storage, 'https://api.example.test');
  storage.set('whaleu.media.pending.v1:legacy', { untouched: true });
  let record = pending.freezeEdit(coverIds.actor, coverPrepare);
  record = pending.observe(record, coverReady());
  record = pending.freezeCommand(coverIds.actor, {
    protocol,
    clientRequestId: coverIds.command,
    expectedRevision: 5,
    source: {
      kind: 'custom',
      editId: coverIds.edit,
      assetId: coverIds.asset,
    },
  });
  assert.equal(pending.load(coverIds.other), null);
  const otherOrigin = new PendingCoverStore(
    storage,
    'https://other.example.test',
  );
  assert.equal(otherOrigin.load(coverIds.actor), null);
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
  const receipt = coverReceipt(record.command!.input);
  assert.throws(() =>
    pending.settleCommand(record, { ...receipt, requestHash: 'f'.repeat(64) }),
  );
  pending.settleCommand(record, receipt);
  assert.equal(pending.load(coverIds.actor), null);
});
test('unknown record is never evicted, rebound, or treated as no pending command', () => {
  const storage = new MemoryStorage(),
    pending = new PendingCoverStore(storage, 'https://api.example.test');
  const input = {
    protocol,
    clientRequestId: coverIds.command,
    expectedRevision: 5,
    source: { kind: 'clear' as const },
  };
  const record = pending.freezeCommand(coverIds.actor, input);
  assert.throws(() =>
    pending.freezeCommand(coverIds.actor, { ...input, expectedRevision: 6 }),
  );
  assert.deepEqual(pending.load(coverIds.actor), record);
  const key = [...storage.data.keys()][0]!;
  storage.set(key, { ...record, token: 'must-not-be-loaded' });
  assert.throws(() => pending.load(coverIds.actor));
  assert.throws(() => pending.freezeCommand(coverIds.actor, input));
});
test('pre-prepare cancellation settles only an exact actor request fence with no fabricated IDs', () => {
  const pending = new PendingCoverStore(
    new MemoryStorage(),
    'https://api.example.test',
  );
  const record = pending.freezeEdit(coverIds.actor, coverPrepare);
  pending.settlePrePrepare(record, {
    protocol,
    requestId: coverIds.request,
    serverNow: 1000,
    state: 'cancelled_before_prepare',
    requestHash: record.edit!.requestHash,
    reason: 'cancelled',
  });
  assert.equal(pending.load(coverIds.actor), null);
});
test('command cancellation fence is same-key/hash exact and preserves unresolved custom edit', () => {
  const pending = new PendingCoverStore(
    new MemoryStorage(),
    'https://api.example.test',
  );
  let record = pending.freezeEdit(coverIds.actor, coverPrepare);
  record = pending.observe(record, coverReady());
  record = pending.freezeCommand(coverIds.actor, {
    protocol,
    clientRequestId: coverIds.command,
    expectedRevision: 5,
    source: {
      kind: 'custom',
      editId: coverIds.edit,
      assetId: coverIds.asset,
    },
  });
  const proof = {
    protocol,
    clientRequestId: coverIds.command,
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
      clientRequestId: coverIds.request,
    }),
  );
  const remaining = pending.settleCancelledCommand(record, proof)!;
  assert.equal(remaining.command, null);
  assert.equal(remaining.edit!.editId, coverIds.edit);
  assert.deepEqual(pending.load(coverIds.actor), remaining);
});

test('terminal or bound-history settlement cannot discard a known mismatched cover intent or asset', () => {
  const pending = new PendingCoverStore(
    new MemoryStorage(),
    'https://api.example.test',
  );
  let record = pending.freezeEdit(coverIds.actor, coverPrepare);
  record = pending.observe(record, coverReady());
  const terminal = {
    ...coverBase(),
    status: 'terminal' as const,
    reason: 'cancelled' as const,
    cleanup: 'retained' as const,
  };
  assert.throws(() =>
    pending.settleEdit(record, { ...terminal, intentId: coverIds.other }),
  );
  const history = {
    ...coverBase(),
    status: 'bound_history' as const,
    assetId: coverIds.other,
    bindingId: coverIds.binding,
    attachmentState: 'detached' as const,
    command: coverReceipt({
      protocol,
      clientRequestId: coverIds.command,
      expectedRevision: 5,
      source: {
        kind: 'custom',
        editId: coverIds.edit,
        assetId: coverIds.asset,
      },
    }),
  };
  assert.throws(() => pending.settleEdit(record, history));
  assert.deepEqual(pending.load(coverIds.actor), record);
  pending.settleEdit(record, terminal);
  assert.equal(pending.load(coverIds.actor), null);
});
