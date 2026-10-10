import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { Cancellation } from '../src/platform/contracts';
import {
  decodeBatchStatus,
  type BatchStatus,
} from '../src/media/batch-contracts';
import {
  batchHarness,
  ids,
  memberStatus,
} from './support/media-batch-fixtures';
import { credentials, deferred, flush } from './helpers';
test('explicit remove persists retirement and confirms terminal before shrinking selected set', async () => {
  const h = batchHarness(),
    first = h.record.members[0]!.memberId;
  const original = h.gateway.command;
  h.gateway.command = async (...args) => {
    const saved = h.pending.load(ids.actor)!;
    assert.equal(saved.phase, 'layout_uncertain');
    assert.equal(saved.members.length, 2);
    assert.equal(saved.retiring[0]?.memberId, first);
    return original(...args);
  };
  await h.controller.remove(first);
  assert.equal(h.pending.load(ids.actor)?.members.length, 2);
  assert.equal(h.pending.load(ids.actor)?.retiring.length, 0);
  assert.equal(h.views[h.views.length - 1]?.selected, 2);
  assert.equal(h.views[h.views.length - 1]?.ready, 2);
  h.controller.dispose();
});
test('reorder changes complete layout only; immutable source slots and upload identities survive', async () => {
  const h = batchHarness(),
    first = h.record.members[0]!,
    second = h.record.members[1]!;
  await h.controller.move(first.memberId, 1);
  const record = h.pending.load(ids.actor)!;
  assert.deepEqual(record.orderedMemberIds.slice(0, 2), [
    second.memberId,
    first.memberId,
  ]);
  assert.deepEqual(
    record.members.find((m) => m.memberId === first.memberId)?.prepare,
    first.prepare,
  );
  assert.equal(h.calls.includes('pick'), false);
  h.controller.dispose();
});
test('unknown or failed selected member is retained and blocks full-array publication', async () => {
  const h = batchHarness(),
    source = h.current();
  const members = source.members.map((m, index) =>
    index
      ? m
      : {
          ...m,
          observation: {
            version: 2 as const,
            requestId: m.requestId,
            requestHash: m.requestHash,
            intentId: m.intentId,
            serverNow: 1000,
            status: 'unavailable' as const,
            reason: 'MEDIA_UNAVAILABLE' as const,
            retryable: true,
          },
        },
  );
  const state = decodeBatchStatus({
    version: 3,
    batchIdentity: source.batchIdentity,
    batchRequestId: source.batchRequestId,
    batchRequestHash: source.batchRequestHash,
    batchId: source.batchId,
    revision: source.revision,
    serverNow: 1000,
    orderedMemberIds: source.orderedMemberIds,
    members,
    retiring: [],
    status: 'preparing',
  });
  h.setState(state);
  await assert.rejects(
    h.controller.publicationAssets(ids.space, new Cancellation()),
  );
  assert.equal(h.pending.load(ids.actor)?.members.length, 3);
  assert.equal(
    h.pending.load(ids.actor)?.members[0]?.observation?.observation.status,
    'unavailable',
  );
  assert.equal(h.views[h.views.length - 1]?.canAdd, false);
  h.controller.dispose();
});
test('sequential selection reaches nine metadata members while holding at most one original file', async () => {
  const h = batchHarness();
  let live = 0,
    peak = 0;
  h.transfer.pick = async () => {
    live++;
    peak = Math.max(peak, live);
    return { localId: `picked-${live}` };
  };
  h.transfer.remove = async () => {
    live--;
  };
  h.gateway.prepareMember = async (_id, input) => {
    const source = h.current(),
      added = memberStatus(input, 'ready_unbound', source.batchIdentity!);
    const members = [...source.members, added];
    h.setState(
      decodeBatchStatus({
        version: 3,
        batchIdentity: source.batchIdentity,
        batchRequestId: source.batchRequestId,
        batchRequestHash: source.batchRequestHash,
        batchId: source.batchId,
        revision: String(BigInt(source.revision) + 1n),
        serverNow: 1000,
        orderedMemberIds: members.map((m) => m.memberId),
        members,
        retiring: [],
        status: 'ready_unbound',
        orderedAssets: members.map((m) => ({
          memberId: m.memberId,
          assetId: m.assetId,
          manifestDigest: m.manifestDigest,
        })),
        draftExpiresAt: 80000,
        bindBefore: 80000,
      }),
    );
    return added;
  };
  for (let n = 3; n < 9; n++)
    await h.controller.select({ draftId: ids.draft, spaceId: ids.space });
  assert.equal(h.pending.load(ids.actor)?.members.length, 9);
  assert.equal(peak, 1);
  assert.equal(live, 0);
  await assert.rejects(
    h.controller.select({ draftId: ids.draft, spaceId: ids.space }),
  );
  assert.equal(
    (await h.controller.publicationAssets(ids.space, new Cancellation()))
      .length,
    9,
  );
  h.controller.dispose();
});
test('lost layout response replays original command and never silently restores removed UI member', async () => {
  const h = batchHarness(),
    first = h.record.members[0]!.memberId,
    command = h.gateway.command;
  let lose = true;
  h.gateway.command = async (...args) => {
    const result = await command(...args);
    if (lose) {
      lose = false;
      throw new ClientError('network', 'Lost layout response');
    }
    return result;
  };
  await assert.rejects(h.controller.remove(first));
  const expected = h.pending.load(ids.actor)!.pendingCommand!.payload.commandId;
  h.controller.hide();
  await h.controller.recover();
  assert.equal(h.pending.load(ids.actor)?.pendingCommand, null);
  assert.equal(h.pending.load(ids.actor)?.members.length, 2);
  assert.ok(expected);
  h.controller.dispose();
});
test('same-account relogin invalidates a late picker and cleans its output without creating a member', async () => {
  const h = batchHarness(),
    picked = deferred<{ localId: string }>(),
    arrived = deferred<void>();
  h.transfer.pick = async () => {
    arrived.resolve();
    return picked.promise;
  };
  const choosing = h.controller.select({
    draftId: ids.draft,
    spaceId: ids.space,
  });
  await arrived.promise;
  h.sessions.completeLogin(
    h.sessions.beginLogin(),
    credentials(ids.actor, 'new'),
  );
  picked.resolve({ localId: 'late-file' });
  await assert.rejects(choosing);
  await flush();
  assert.equal(h.pending.load(ids.actor)?.members.length, 3);
  assert.equal(h.calls.includes('remove-file'), true);
  h.controller.dispose();
});
test('malformed external missing member status never mutates stored complete plan', async () => {
  const h = batchHarness(),
    original = h.pending.load(ids.actor);
  h.setState({ ...h.current(), members: [] } as BatchStatus);
  await assert.rejects(h.controller.recover());
  assert.deepEqual(h.pending.load(ids.actor), original);
  h.controller.dispose();
});
