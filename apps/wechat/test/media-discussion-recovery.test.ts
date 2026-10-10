import assert from 'node:assert/strict';
import test from 'node:test';
import { Cancellation } from '../src/platform/contracts';
import {
  PendingBatchStore,
  decodePendingBatch,
  decodePendingDiscussionBatch,
} from '../src/media/batch-pending';
import { createMediaBatchRuntime } from '../src/media/batch-runtime';
import {
  batchHarness,
  identity,
  ids,
  origin,
  readyBatch,
  attempt,
  created,
  history,
  uuid,
} from './support/media-discussion-fixtures';
import type { BatchIdentity } from '../src/media/discussion-batch-contracts';
import { identity as postIdentity } from './support/media-batch-fixtures';
import { prepare } from './support/media-upload-fixtures';
const identities: readonly BatchIdentity[] = [
  identity,
  {
    ...identity,
    purpose: 'community-reply-images',
    target: { kind: 'reply', rootCommentId: uuid(51), targetReplyId: null },
  },
  {
    ...identity,
    purpose: 'community-reply-images',
    target: { kind: 'reply', rootCommentId: uuid(51), targetReplyId: uuid(52) },
  },
];
for (const target of identities) {
  test(`pure-image ${target.target.kind} ${target.target.kind === 'reply' ? target.target.targetReplyId : 'root'} keeps exact two-key handshake`, async () => {
    const h = batchHarness(3, target),
      body = attempt(readyBatch(3, target));
    h.runtime.reservePublication(body);
    const record = h.pending.load(ids.actor)!;
    assert.equal(record.version, 4);
    assert.equal(h.publicationPending.load(ids.actor), null);
    assert.throws(() => decodePendingBatch(record, ids.actor, origin));
    assert.deepEqual(
      decodePendingDiscussionBatch(record, ids.actor, origin),
      record,
    );
    h.publicationPending.freeze(body);
    await h.runtime.beforePublication(body, new Cancellation());
    const sealed = h.current();
    if (sealed.status !== 'publication_pending')
      throw new Error('missing exact seal');
    const receipt = created(
      body.operation === 'publish_reply' ? 'publish_reply' : 'publish_comment',
    );
    await assert.rejects(
      h.runtime.verifyReceipt(body, receipt, new Cancellation()),
    );
    h.setState(history(sealed));
    h.setReceipt(receipt);
    await h.runtime.verifyReceipt(body, receipt, new Cancellation());
    h.publicationPending.settle(body, receipt);
    h.runtime.publicationSettled(body);
    assert.equal(h.pending.load(ids.actor), null);
    assert.equal(h.publicationPending.load(ids.actor), null);
    h.controller.dispose();
  });
}
test('v4 WAL blocks post/legacy admission, actor switch, and changing immutable reply target', async () => {
  const h = batchHarness(3, identities[1]!);
  assert.throws(() => h.pending.freeze(ids.actor, postIdentity, 1000));
  assert.throws(() => h.pending.legacy.freeze(ids.actor, prepare, 1000));
  assert.equal(h.pending.load(ids.other), null);
  await assert.rejects(
    h.controller.select({
      draftId: ids.draft,
      spaceId: ids.space,
      target: {
        kind: 'reply',
        rootCommentId: uuid(51),
        targetReplyId: uuid(52),
      },
    }),
  );
  assert.equal(h.calls.includes('pick'), false);
  assert.throws(() =>
    h.runtime.reservePublication(attempt(readyBatch(3, identities[2]!))),
  );
  assert.ok(h.pending.load(ids.actor));
  h.controller.dispose();
});
test('missing v4 Media key checks receipt first and recovers exact typed target; mismatch retains Community key', async () => {
  const h = batchHarness(3, identities[1]!),
    body = attempt(readyBatch(3, identities[1]!));
  h.publicationPending.freeze(body);
  const key = [...h.storage.data.keys()].find((k) =>
    k.startsWith('whaleu.media.batch.pending.v4:'),
  )!;
  h.storage.remove(key);
  const actual = h.gateway.recoverPublication;
  h.gateway.recoverPublication = async (...args) => {
    assert.deepEqual(args[4], identities[1]!.target);
    return actual(...args);
  };
  const restarted = createMediaBatchRuntime(h.options);
  await restarted.beforePublication(body, new Cancellation());
  assert.deepEqual(h.calls.slice(0, 2), ['receipt', 'recover-publication']);
  assert.equal(
    new PendingBatchStore(h.storage, origin).load(ids.actor)?.version,
    4,
  );
  h.storage.remove(key);
  h.setState(readyBatch(3, identities[2]!));
  h.calls.length = 0;
  await assert.rejects(restarted.beforePublication(body, new Cancellation()));
  assert.deepEqual(h.publicationPending.load(ids.actor), body);
  assert.equal(h.pending.load(ids.actor), null);
  h.controller.dispose();
});
test('damaged, simultaneous v3/v4, and incomplete member journals fail closed', () => {
  const h = batchHarness();
  const record = h.pending.load(ids.actor)!;
  assert.throws(() =>
    decodePendingDiscussionBatch(
      { ...record, members: record.members.slice(1) },
      ids.actor,
      origin,
    ),
  );
  h.storage.data.set(`whaleu.media.batch.pending.v3:${origin}:${ids.actor}`, {
    damaged: true,
  });
  assert.throws(() => h.pending.load(ids.actor));
  assert.throws(() => h.runtime.modeForActor(ids.actor));
  h.controller.dispose();
});

test('reply post ancestry is checked against durable original attempt rather than current page', async () => {
  const target = identities[1]!,
    h = batchHarness(3, target),
    correct = attempt(readyBatch(3, target));
  if (correct.operation !== 'publish_reply') throw new Error('reply fixture');
  const wrong = { ...correct, postId: uuid(999) };
  assert.throws(() => h.runtime.reservePublication(wrong));
  assert.equal(h.pending.load(ids.actor)?.resolvedPostId, uuid(50));
  assert.throws(() =>
    h.pending.update(h.pending.load(ids.actor)!, { resolvedPostId: uuid(999) }),
  );
  h.publicationPending.freeze(wrong);
  const key = [...h.storage.data.keys()].find((k) =>
    k.startsWith('whaleu.media.batch.pending.v4:'),
  )!;
  h.storage.remove(key);
  await assert.rejects(h.runtime.beforePublication(wrong, new Cancellation()));
  assert.deepEqual(h.publicationPending.load(ids.actor), wrong);
  assert.equal(h.pending.load(ids.actor), null);
  h.controller.dispose();
});
test('cancel-before-prepare settles v4 WAL only with original null-ancestry typed fence', () => {
  const h = batchHarness();
  const key = [...h.storage.data.keys()].find((k) =>
    k.startsWith('whaleu.media.batch.pending.v4:'),
  )!;
  h.storage.remove(key);
  const record = h.pending.freeze(ids.actor, identity, 1000);
  assert.equal(record.resolvedPostId, null);
  const terminal = {
    version: 4 as const,
    batchIdentity: null,
    resolvedPostId: null,
    batchRequestId: identity.batchRequestId,
    batchRequestHash: record.batchRequestHash,
    batchId: null,
    revision: '1',
    serverNow: 1000,
    orderedMemberIds: [],
    members: [],
    retiring: [],
    status: 'terminal' as const,
    reason: 'cancelled' as const,
    cleanup: 'confirmed' as const,
  };
  h.pending.settle(record, terminal);
  assert.equal(h.pending.load(ids.actor), null);
  h.controller.dispose();
});
