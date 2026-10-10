import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { MemoryStorage } from './helpers';
import { PendingRatingStore } from '../src/ratings/pending';
import { scopedIntent } from './rating-scoped-helpers';
import { decodeRatingDiscussionMediaIntent } from '../src/ratings/discussion-media-contract';
import {
  decodeRatingDiscussionBatchIdentity,
  ratingDiscussionBatchIdentityHash,
  ratingDiscussionMemberRequestHash,
} from '../src/ratings/discussion-media-batch-contract';
import {
  PendingRatingDiscussionMediaStore,
  type PendingRatingDiscussionBatch,
} from '../src/ratings/discussion-media-pending';
const fixture = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '../../../packages/fixtures/ratings-discussion-media-v1.json',
    ),
    'utf8',
  ),
).cases[0] as {
  intent: unknown;
  intentHash: string;
  review: { images: Array<{ manifestDigest: string }> };
};
const decodedIntent = decodeRatingDiscussionMediaIntent(fixture.intent);
if (decodedIntent.operation !== 'create_comment_scoped')
  throw new Error('root fixture required');
const intent = decodedIntent,
  p = intent.payload;
const actor = '00000000-0000-4000-8000-000000000050';
const identity = decodeRatingDiscussionBatchIdentity({
  protocol: 'ratings-discussion-media-v1',
  batchRequestId: p.batchRequestId,
  commandRequestId: p.clientRequestId,
  draftRevision: p.draftRevision,
  categoryId: p.categoryId,
  expectedCategoryRevision: p.expectedCategoryRevision,
  context: intent.context,
  target: {
    kind: 'root',
    targetId: p.targetId,
    expectedTargetRevision: p.expectedTargetRevision,
    expectedDefinitionRevision: p.expectedDefinitionRevision,
    expectedContentVersion: p.expectedContentVersion,
  },
});
const initial: PendingRatingDiscussionBatch = {
  version: 12,
  phase: 'batch',
  accountId: actor,
  identity,
  identityHash: ratingDiscussionBatchIdentityHash(actor, identity),
  batchId: null,
  members: [],
  orderedMemberIds: [],
  sealedPlanDigest: null,
};
function makeSealed(store: PendingRatingDiscussionMediaStore) {
  const before = store.start(initial);
  const batchId = p.batchId!;
  const members = p.images.map((image, sourceSlot) => {
    const member = {
      memberId: image.memberId,
      clientRequestId: `00000000-0000-4000-8000-${String(300 + sourceSlot).padStart(12, '0')}`,
      sourceSlot,
      declaration: {
        mime: 'image/png' as const,
        bytes: 1024,
        sha256: 'a'.repeat(64),
      },
      state: 'ready' as const,
      assetId: image.assetId,
      manifestDigest: fixture.review.images[sourceSlot]!.manifestDigest,
    };
    return {
      ...member,
      requestHash: ratingDiscussionMemberRequestHash(
        actor,
        batchId,
        initial.identityHash,
        member,
      ),
    };
  });
  return store.update(before, {
    ...before,
    batchId,
    members,
    orderedMemberIds: p.images.map((i) => i.memberId),
    sealedPlanDigest: p.sealedPlanDigest,
  });
}
test('every old journal, including corrupt data, blocks new discussion work', () => {
  for (let version = 1; version <= 11; version++) {
    const storage = new MemoryStorage(),
      store = new PendingRatingDiscussionMediaStore(
        storage,
        'https://example.invalid',
      );
    storage.set(
      `whaleu.ratings.pending.v${version}:https://example.invalid:${actor}`,
      { corrupt: true },
    );
    assert.throws(() => store.start(initial));
    assert.equal(storage.data.size, 1);
  }
});
test('failed second journal write retains exact batch keys but cold hydration cannot freeze publication', () => {
  const storage = new MemoryStorage(),
    origin = 'https://example.invalid',
    store = new PendingRatingDiscussionMediaStore(storage, origin);
  const batch = makeSealed(store);
  storage.failWrite = true;
  assert.throws(() => store.freezeCommand(actor, intent));
  storage.failWrite = false;
  const recovered = new PendingRatingDiscussionMediaStore(storage, origin);
  assert.equal(recovered.isOpaque(actor), true);
  assert.throws(() => recovered.load(actor));
  assert.throws(() => recovered.freezeCommand(actor, intent));
  const obligation = recovered.opaqueRecovery(actor);
  assert.equal(obligation.command, null);
  assert.equal(obligation.batch?.batchRequestId, identity.batchRequestId);
  assert.equal(obligation.batch?.identityHash, batch.identityHash);
  assert.equal(
    /"body"|"context"|"token"/.test(JSON.stringify(obligation)),
    false,
  );
  assert.throws(() =>
    recovered.freezeCommand(actor, {
      ...intent,
      payload: { ...intent.payload, body: 'changed' },
    }),
  );
});
test('ninth member, manifest, order and original actor cannot be substituted after seal', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingDiscussionMediaStore(
      storage,
      'https://example.invalid',
    );
  const sealed = makeSealed(store);
  assert.throws(() =>
    store.update(sealed, {
      ...sealed,
      orderedMemberIds: [...sealed.orderedMemberIds].reverse(),
    }),
  );
  assert.throws(() =>
    store.update(sealed, { ...sealed, members: sealed.members.slice(0, 8) }),
  );
  assert.throws(() =>
    store.freezeCommand(actor, {
      ...intent,
      payload: { ...intent.payload, images: intent.payload.images.slice(0, 8) },
    }),
  );
  const otherActor = '00000000-0000-4000-8000-000000000051';
  storage.set(
    `whaleu.ratings.pending.v12.batch:https://example.invalid:${otherActor}`,
    sealed,
  );
  assert.throws(() => store.load(otherActor));
});
test('receipt is persisted without deleting unresolved native or server obligations', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingDiscussionMediaStore(
      storage,
      'https://example.invalid',
    );
  makeSealed(store);
  const command = store.freezeCommand(actor, intent);
  const settled = store.recordReceipt(command, {
    protocolVersion: 4,
    requestId: p.clientRequestId,
    operation: 'create_comment_scoped',
    intentHash: fixture.intentHash,
    outcome: 'applied',
    result: {
      targetId: p.targetId,
      subjectId: '00000000-0000-4000-8000-000000000051',
      revision: '00000000-0000-4000-8000-000000000052',
      occurredAt: '2026-10-10T17:00:00.000Z',
    },
  });
  assert.equal(settled.receipt?.outcome, 'applied');
  assert.equal(storage.data.size, 2);
  assert.throws(() => store.start(initial));
});

test('new discussion keys also block fresh historical writes while historical recovery keeps precedence', () => {
  const storage = new MemoryStorage(),
    origin = 'https://example.invalid';
  const legacy = new PendingRatingStore(storage, origin);
  const old = {
    version: 9 as const,
    accountId: actor,
    intent: scopedIntent('create_comment_scoped'),
  };
  storage.set(`whaleu.ratings.pending.v12.batch:${origin}:${actor}`, {
    corrupt: true,
  });
  assert.throws(() => legacy.freeze(old));
  assert.equal(storage.data.size, 1);
  storage.remove(`whaleu.ratings.pending.v12.batch:${origin}:${actor}`);
  const retained = legacy.freeze(old);
  storage.set(`whaleu.ratings.pending.v12.command:${origin}:${actor}`, {
    corrupt: true,
  });
  assert.deepEqual(legacy.load(actor), retained);
  assert.deepEqual(legacy.freeze(retained), retained);
});
