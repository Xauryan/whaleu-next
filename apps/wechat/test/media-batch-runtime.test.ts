import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { Cancellation } from '../src/platform/contracts';
import { createMediaBatchRuntime } from '../src/media/batch-runtime';
import {
  decodeBatchStatus,
  type BatchStatus,
} from '../src/media/batch-contracts';
import { mediaPublicationReference } from '../src/media/upload-runtime';
import {
  attempt,
  batchHarness,
  created,
  history,
  ids,
  readyBatch,
} from './support/media-batch-fixtures';
function batchKey(h: ReturnType<typeof batchHarness>): string {
  return [...h.storage.data.keys()].find((key) =>
    key.startsWith('whaleu.media.batch.pending.v3:'),
  )!;
}
async function seal(h: ReturnType<typeof batchHarness>) {
  const body = attempt();
  h.runtime.reservePublication(body);
  h.publicationPending.freeze(body);
  await h.runtime.beforePublication(body, new Cancellation());
  return body;
}
test('reserve→freeze→link→seal→dispatch persists only exact metadata and original body in separate owners', async () => {
  const h = batchHarness(),
    body = attempt();
  h.runtime.reservePublication(body);
  assert.equal(h.publicationPending.load(ids.actor), null);
  assert.equal(h.pending.load(ids.actor)?.publication?.linkState, 'reserved');
  assert.equal(
    JSON.stringify(h.pending.load(ids.actor)).includes(body.payload.text),
    false,
  );
  await assert.rejects(h.runtime.beforePublication(body, new Cancellation()));
  assert.equal(h.calls.includes('seal'), false);
  h.publicationPending.freeze(body);
  await h.runtime.beforePublication(body, new Cancellation());
  const record = h.pending.load(ids.actor)!;
  assert.equal(record.publication?.linkState, 'linked');
  assert.equal(record.publication?.dispatchState, 'dispatch_uncertain');
  assert.equal(record.phase, 'publication_uncertain');
  assert.deepEqual(
    record.publication?.reference,
    mediaPublicationReference(body),
  );
  h.controller.dispose();
});
test('created receipt needs full exact bound history before stepwise settlement; ready never settles', async () => {
  const h = batchHarness(),
    body = await seal(h),
    receipt = created();
  await assert.rejects(
    h.runtime.verifyReceipt(body, receipt, new Cancellation()),
  );
  assert.ok(h.publicationPending.load(ids.actor));
  const state = h.current();
  assert.equal(state.status, 'publication_pending');
  if (state.status !== 'publication_pending') throw new Error('seal fixture');
  h.setState(history(state));
  h.setReceipt(receipt);
  await h.runtime.verifyReceipt(body, receipt, new Cancellation());
  assert.equal(
    h.pending.load(ids.actor)?.publication?.linkState,
    'settlement_verified',
  );
  h.storage.failRemove = true;
  assert.throws(() => h.publicationPending.settle(body, receipt));
  assert.ok(h.pending.load(ids.actor));
  h.storage.failRemove = false;
  h.publicationPending.settle(body, receipt);
  h.runtime.publicationSettled(body);
  assert.equal(h.pending.load(ids.actor), null);
  h.controller.dispose();
});
test('lost seal response recovers same command after receipt-first query; no second publication key', async () => {
  const h = batchHarness(),
    body = attempt(),
    actual = h.gateway.command;
  let lost = true;
  h.gateway.command = async (...args) => {
    const result = await actual(...args);
    if (lost) {
      lost = false;
      throw new ClientError('network', 'Lost seal response');
    }
    return result;
  };
  h.runtime.reservePublication(body);
  h.publicationPending.freeze(body);
  await assert.rejects(h.runtime.beforePublication(body, new Cancellation()));
  const originalCommand = h.pending.load(ids.actor)!.pendingCommand!.payload
    .commandId;
  assert.equal(h.pending.load(ids.actor)!.phase, 'seal_uncertain');
  h.calls.length = 0;
  const restarted = createMediaBatchRuntime(h.options);
  await restarted.beforePublication(body, new Cancellation());
  assert.equal(h.calls[0], 'receipt');
  assert.equal(h.calls.filter((call) => call === 'seal').length, 1);
  assert.equal(
    h.pending.load(ids.actor)?.publication?.reference.clientRequestId,
    ids.publication,
  );
  assert.ok(originalCommand);
  assert.deepEqual(h.publicationPending.load(ids.actor), body);
  h.controller.dispose();
});
test('missing Media key reconstructs exact ready pre-seal batch only after original receipt lookup', async () => {
  const h = batchHarness(),
    body = attempt();
  h.publicationPending.freeze(body);
  h.storage.remove(batchKey(h));
  await h.runtime.beforePublication(body, new Cancellation());
  assert.deepEqual(h.calls.slice(0, 2), ['receipt', 'recover-publication']);
  assert.equal(
    h.pending.load(ids.actor)?.publication?.reference.clientRequestId,
    ids.publication,
  );
  h.controller.dispose();
});
test('missing Media key refuses subset recovery and retains original Community body', async () => {
  const h = batchHarness(),
    body = attempt();
  h.publicationPending.freeze(body);
  h.storage.remove(batchKey(h));
  h.setState(readyBatch(2));
  await assert.rejects(h.runtime.beforePublication(body, new Cancellation()));
  assert.deepEqual(h.publicationPending.load(ids.actor), body);
  assert.equal(h.calls.includes('seal'), false);
  h.controller.dispose();
});
test('404 and old local time retain reserved metadata; ordinary recovery never installs cancellation fence', async () => {
  const h = batchHarness(),
    body = attempt();
  h.runtime.reservePublication(body);
  h.clock.advance(10 * 86400000);
  await assert.rejects(h.controller.recover());
  assert.deepEqual(h.calls, ['receipt']);
  assert.equal(h.pending.load(ids.actor)?.publication?.linkState, 'reserved');
  assert.equal(h.pending.load(ids.actor)?.members.length, 3);
  h.controller.dispose();
});
test('reserved-before-body cancellation uses typed fence and current unsealed history without reopening', async () => {
  const h = batchHarness(),
    body = attempt();
  h.runtime.reservePublication(body);
  h.gateway.fencePublication = async (_id, reference) => {
    h.calls.push('fence');
    return {
      version: 3,
      status: h.current(),
      cancellation: {
        requestId: reference.clientRequestId,
        operation: 'publish_post',
        outcome: 'cancelled',
        intentHash: reference.intentHash,
      },
    };
  };
  h.gateway.command = async () => {
    throw new Error('An unsealed batch cannot be reopened');
  };
  h.gateway.cancel = async () => {
    h.calls.push('cancel');
    const source = h.current();
    const terminal = decodeBatchStatus({
      version: 3,
      batchIdentity: source.batchIdentity,
      batchRequestId: source.batchRequestId,
      batchRequestHash: source.batchRequestHash,
      batchId: source.batchId,
      revision: source.revision,
      serverNow: 1000,
      orderedMemberIds: source.orderedMemberIds,
      members: source.members,
      retiring: [],
      status: 'terminal',
      reason: 'cancelled',
      cleanup: 'pending',
    });
    return { version: 3, state: 'recorded', status: terminal };
  };
  await h.controller.cancelOriginal();
  assert.deepEqual(h.calls, ['receipt', 'fence', 'recover', 'cancel']);
  assert.equal(h.pending.load(ids.actor), null);
  assert.equal(h.publicationPending.load(ids.actor), null);
  h.controller.dispose();
});
test('typed cancellation evidence cannot clear a different Community key/hash', () => {
  const h = batchHarness(),
    body = attempt();
  h.publicationPending.freeze(body);
  const reference = mediaPublicationReference(body);
  assert.throws(() =>
    h.publicationPending.settleCancelled(
      body,
      {
        requestId: ids.publication,
        operation: 'publish_post',
        outcome: 'cancelled',
        intentHash: '0'.repeat(64),
      },
      reference.intentHash,
    ),
  );
  assert.deepEqual(h.publicationPending.load(ids.actor), body);
  h.controller.dispose();
});
test('settlement restart after Community removal uses receipt-first full history and clears only Media marker', async () => {
  const h = batchHarness(),
    body = await seal(h),
    status = h.current();
  if (status.status !== 'publication_pending') throw new Error('fixture');
  h.setState(history(status));
  h.setReceipt(created());
  await h.runtime.verifyReceipt(body, created(), new Cancellation());
  h.publicationPending.settle(body, created());
  h.calls.length = 0;
  await h.controller.recover();
  assert.deepEqual(h.calls.slice(0, 2), ['receipt', 'recover']);
  assert.equal(h.pending.load(ids.actor), null);
  h.controller.dispose();
});
test('history subset and wrong typed parent cannot settle created receipt', async () => {
  const h = batchHarness(),
    body = await seal(h),
    status = h.current();
  if (status.status !== 'publication_pending') throw new Error('fixture');
  const full = history(status);
  h.setState({ ...full, bindings: full.bindings.slice(1) } as BatchStatus);
  await assert.rejects(
    h.runtime.verifyReceipt(body, created(), new Cancellation()),
  );
  assert.ok(h.publicationPending.load(ids.actor));
  h.controller.dispose();
});

test('text-only dispatch cannot silently omit an existing selected batch', async () => {
  const h = batchHarness(),
    source = attempt();
  if (source.operation !== 'publish_post') throw new Error('fixture');
  const body = { ...source, payload: { ...source.payload, imageAssetIds: [] } };
  assert.throws(() => h.runtime.reservePublication(body));
  await assert.rejects(h.runtime.beforePublication(body, new Cancellation()));
  assert.equal(h.pending.load(ids.actor)?.members.length, 3);
  h.controller.dispose();
});

test('typed cancellation replays a lost sealed reopen before clearing either recovery key', async () => {
  const h = batchHarness(),
    body = await seal(h);
  h.calls.length = 0;
  let lost = true,
    reopenId: string | null = null;
  h.gateway.fencePublication = async (_id, reference) => {
    h.calls.push('fence');
    return {
      version: 3,
      status: h.current(),
      cancellation: {
        requestId: reference.clientRequestId,
        operation: 'publish_post',
        outcome: 'cancelled',
        intentHash: reference.intentHash,
      },
    };
  };
  h.gateway.command = async (_id, command) => {
    h.calls.push(command.kind);
    assert.equal(command.kind, 'reopen');
    if (reopenId) assert.equal(command.payload.commandId, reopenId);
    else reopenId = command.payload.commandId;
    h.setState({ ...readyBatch(), revision: '6' });
    if (lost) {
      lost = false;
      throw new ClientError('network', 'Lost reopen response');
    }
    return h.current();
  };
  h.gateway.cancel = async () => {
    h.calls.push('cancel');
    const source = h.current();
    return {
      version: 3,
      state: 'recorded',
      status: decodeBatchStatus({
        version: 3,
        batchIdentity: source.batchIdentity,
        batchRequestId: source.batchRequestId,
        batchRequestHash: source.batchRequestHash,
        batchId: source.batchId,
        revision: source.revision,
        serverNow: 1000,
        orderedMemberIds: source.orderedMemberIds,
        members: source.members,
        retiring: [],
        status: 'terminal',
        reason: 'cancelled',
        cleanup: 'pending',
      }),
    };
  };
  await assert.rejects(h.controller.cancelOriginal());
  assert.deepEqual(h.publicationPending.load(ids.actor), body);
  assert.equal(h.pending.load(ids.actor)?.pendingCommand?.kind, 'reopen');
  assert.equal(
    h.pending.load(ids.actor)?.publication?.cancellation?.outcome,
    'cancelled',
  );
  h.controller.hide();
  await h.controller.recover();
  assert.deepEqual(h.calls, [
    'receipt',
    'fence',
    'recover',
    'reopen',
    'receipt',
    'recover',
    'reopen',
    'cancel',
  ]);
  assert.equal(h.publicationPending.load(ids.actor), null);
  assert.equal(h.pending.load(ids.actor), null);
  h.controller.dispose();
});

for (const mismatch of [
  'order',
  'missing',
  'extra',
  'unknown',
  'retiring',
  'revision',
] as const)
  test(`typed fence cannot clear original keys when current editing history has ${mismatch} mismatch`, async () => {
    const h = batchHarness(),
      body = attempt();
    h.runtime.reservePublication(body);
    h.publicationPending.freeze(body);
    const original = readyBatch();
    let changed: BatchStatus;
    if (mismatch === 'missing' || mismatch === 'extra') {
      changed = {
        ...readyBatch(mismatch === 'missing' ? 2 : 4),
        revision: original.revision,
      };
    } else if (mismatch === 'order') {
      changed = {
        ...original,
        orderedMemberIds: [...original.orderedMemberIds].reverse(),
        members: [...original.members].reverse(),
        orderedAssets: [...original.orderedAssets].reverse(),
      };
    } else if (mismatch === 'revision') {
      changed = {
        ...original,
        revision: String(BigInt(original.revision) + 1n),
      };
    } else {
      changed = decodeBatchStatus({
        version: 3,
        batchIdentity: original.batchIdentity,
        batchRequestId: original.batchRequestId,
        batchRequestHash: original.batchRequestHash,
        batchId: original.batchId,
        revision: original.revision,
        serverNow: 1000,
        orderedMemberIds: original.orderedMemberIds,
        members:
          mismatch === 'unknown'
            ? original.members.map((member, index) =>
                index
                  ? member
                  : {
                      ...member,
                      observation: {
                        version: 2,
                        requestId: member.requestId,
                        requestHash: member.requestHash,
                        intentId: member.intentId,
                        serverNow: 1000,
                        status: 'unavailable',
                        reason: 'MEDIA_UNAVAILABLE',
                        retryable: true,
                      },
                    },
              )
            : original.members,
        retiring: mismatch === 'retiring' ? [readyBatch(4).members[3]!] : [],
        status: 'preparing',
      });
    }
    h.gateway.fencePublication = async (_id, reference) => ({
      version: 3,
      status: original,
      cancellation: {
        requestId: reference.clientRequestId,
        operation: 'publish_post',
        outcome: 'cancelled',
        intentHash: reference.intentHash,
      },
    });
    h.gateway.recover = async () => ({
      version: 3,
      state: 'recorded',
      status: changed,
    });
    h.gateway.command = async () => {
      throw new Error('Mismatched history cannot reopen');
    };
    h.gateway.cancel = async () => {
      throw new Error('Mismatched history cannot cancel');
    };
    await assert.rejects(
      h.controller.cancelOriginal(),
      (error: unknown) =>
        error instanceof ClientError &&
        error.message ===
          'Complete original cancellation layout is not confirmed',
    );
    assert.deepEqual(h.publicationPending.load(ids.actor), body);
    assert.equal(h.pending.load(ids.actor)?.members.length, 3);
    assert.equal(
      h.pending.load(ids.actor)?.publication?.cancellation?.outcome,
      'cancelled',
    );
    h.controller.dispose();
  });
