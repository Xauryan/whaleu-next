import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStorage, signedIn, FakeClock, deferred, flush } from './helpers';
import {
  PendingRatingDiscussionMediaStore,
  type PendingRatingDiscussionBatch,
} from '../src/ratings/discussion-media-pending';
import {
  decodeRatingDiscussionMediaIntent,
  ratingDiscussionMediaIntentHash,
} from '../src/ratings/discussion-media-contract';
import {
  decodeRatingDiscussionBatchIdentity,
  ratingDiscussionBatchIdentityHash,
  ratingDiscussionMemberRequestHash,
} from '../src/ratings/discussion-media-batch-contract';
import {
  decodeDiscussionBatchStatus,
  decodeDiscussionDescriptor,
  type DiscussionBatchStatus,
} from '../src/ratings/discussion-media-wire';
import {
  decodeDiscussionMediaRoute,
  discussionMediaPath,
} from '../src/ratings/discussion-media-page-controller';
import { RatingDiscussionMediaController } from '../src/ratings/discussion-media-controller';
import type { RatingDiscussionMediaGateway } from '../src/ratings/discussion-media-gateway';
import { RatingDiscussionGallery } from '../src/ratings/discussion-media-gallery';
const fixtures = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '../../../packages/fixtures/ratings-discussion-media-v1.json',
    ),
    'utf8',
  ),
).cases;
const fixture = fixtures[0],
  intent = decodeRatingDiscussionMediaIntent(fixture.intent),
  p = intent.payload;
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = id(50),
  origin = 'https://example.invalid';
function setup() {
  const storage = new MemoryStorage(),
    store = new PendingRatingDiscussionMediaStore(storage, origin),
    sessions = signedIn(actor);
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
  const first: PendingRatingDiscussionBatch = {
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
  const before = store.start(first),
    members = p.images.map((image, sourceSlot) => {
      const member = {
        memberId: image.memberId,
        clientRequestId: id(300 + sourceSlot),
        sourceSlot,
        declaration: {
          mime: 'image/png' as const,
          bytes: 1024,
          sha256: 'a'.repeat(64),
        },
        state: 'ready' as const,
        assetId: image.assetId,
        manifestDigest: fixture.review.images[sourceSlot].manifestDigest,
      };
      return {
        ...member,
        requestHash: ratingDiscussionMemberRequestHash(
          actor,
          p.batchId!,
          first.identityHash,
          member,
        ),
      };
    });
  const batch = store.update(before, {
    ...before,
    batchId: p.batchId,
    members,
    orderedMemberIds: p.images.map((i) => i.memberId),
    sealedPlanDigest: p.sealedPlanDigest,
  });
  const command = store.freezeCommand(actor, intent);
  const receipt = {
    protocolVersion: 4 as const,
    requestId: p.clientRequestId,
    operation: 'create_comment_scoped' as const,
    intentHash: ratingDiscussionMediaIntentHash(intent),
    outcome: 'applied' as const,
    result: {
      targetId: p.targetId,
      subjectId: id(51),
      revision: id(52),
      occurredAt: '2026-10-10T17:00:00.000Z',
    },
  };
  const server: DiscussionBatchStatus = {
    protocol: 'ratings-discussion-media-v1',
    batchId: p.batchId!,
    identity,
    batchIdentityHash: batch.identityHash,
    revision: id(60),
    state: 'consumed',
    expiresAt: 200000,
    serverNow: 1000,
    members: members.map((m, index) => ({
      memberId: m.memberId,
      requestId: m.clientRequestId,
      intentId: id(700 + index),
      sourceSlot: m.sourceSlot,
      state: 'bound',
    })),
    sealedPlan: {
      batchId: p.batchId!,
      batchIdentityHash: batch.identityHash,
      orderedMembers: members.map((m, ordinal) => ({
        ordinal,
        memberId: m.memberId,
        assetId: m.assetId!,
        manifestDigest: m.manifestDigest!,
      })),
    },
    sealedPlanDigest: p.sealedPlanDigest,
    consumedParent: {
      ownerKind: 'ratings',
      resourceKind: 'rating_comment',
      targetId: p.targetId,
      resourceId: id(51),
      contentVersion: 1,
    },
  };
  return { storage, store, sessions, batch, command, receipt, server };
}
test('strict consumed set cannot settle against wrong parent, incomplete plan or unknown native completion', () => {
  const h = setup(),
    recorded = h.store.recordReceipt(h.command, h.receipt);
  assert.equal(decodeDiscussionBatchStatus(h.server).state, 'consumed');
  assert.throws(() => h.store.settleCommand(recorded, h.server, false));
  assert.throws(() =>
    h.store.settleCommand(
      recorded,
      {
        ...h.server,
        consumedParent: { ...h.server.consumedParent!, resourceId: id(99) },
      },
      true,
    ),
  );
  assert.throws(() =>
    decodeDiscussionBatchStatus({
      ...h.server,
      sealedPlan: {
        ...h.server.sealedPlan!,
        orderedMembers: h.server.sealedPlan!.orderedMembers.slice(1),
      },
    }),
  );
  assert.equal(h.storage.data.size, 2);
  h.store.settleCommand(recorded, h.server, true);
  assert.equal(h.storage.data.size, 0);
});
test('crash after batch-key removal keeps exact receipt-bearing command and can finish original settlement', () => {
  const h = setup();
  h.store.recordReceipt(h.command, h.receipt);
  h.storage.remove(`whaleu.ratings.pending.v12.batch:${origin}:${actor}`);
  const restarted = new PendingRatingDiscussionMediaStore(h.storage, origin),
    opaque = restarted.opaqueRecovery(actor);
  assert.equal(opaque.command?.receipt?.outcome, 'applied');
  assert.throws(() => restarted.load(actor));
  restarted.settleOpaque(
    opaque,
    {
      protocol: 'ratings-discussion-media-v1',
      batchRequestId: p.batchRequestId!,
      serverNow: 1000,
      state: 'recorded',
      status: h.server,
    },
    true,
  );
  assert.equal(h.storage.data.size, 0);
});
test('real controller cold recovery queries original owner receipt before batch and never uploads ready bytes again', async () => {
  const h = setup(),
    calls: string[] = [];
  const gateway = {
    receipt: async () => {
      calls.push('business-receipt');
      return h.receipt;
    },
    recoverBatch: async () => {
      calls.push('batch-status');
      return {
        protocol: 'ratings-discussion-media-v1',
        batchRequestId: p.batchRequestId!,
        serverNow: 1000,
        state: 'recorded',
        status: h.server,
      };
    },
  } as unknown as RatingDiscussionMediaGateway;
  const controller = new RatingDiscussionMediaController(
    h.sessions,
    new PendingRatingDiscussionMediaStore(h.storage, origin),
    gateway,
    undefined,
    async () => {
      throw Error('No fresh request allowed');
    },
    () => undefined,
  );
  await controller.recover();
  assert.deepEqual(calls, ['business-receipt', 'batch-status']);
  assert.equal(h.storage.data.size, 0);
  controller.dispose();
});
test('unknown receipt stops batch, grant, prepare and second publication and keeps original keys', async () => {
  const h = setup(),
    calls: string[] = [];
  const gateway = {
    receipt: async () => {
      calls.push('business-receipt');
      throw Error('unknown');
    },
    statusBatch: async () => {
      throw Error('must not run');
    },
    command: async () => {
      throw Error('must not run');
    },
  } as unknown as RatingDiscussionMediaGateway;
  const controller = new RatingDiscussionMediaController(
    h.sessions,
    h.store,
    gateway,
    undefined,
    async () => id(999),
    () => undefined,
  );
  await controller.recover('retry');
  assert.deepEqual(calls, ['business-receipt']);
  assert.equal(h.storage.data.size, 2);
  controller.dispose();
});
test('A to B to A invalidates late owner response without discarding A obligations', async () => {
  const h = setup(),
    reply = deferred<typeof h.receipt>(),
    gateway = {
      receipt: () => reply.promise,
    } as unknown as RatingDiscussionMediaGateway;
  const controller = new RatingDiscussionMediaController(
    h.sessions,
    h.store,
    gateway,
    undefined,
    async () => id(999),
    () => undefined,
  );
  const pending = controller.recover();
  await flush();
  h.sessions.logout();
  h.sessions.completeLogin(h.sessions.beginLogin(), {
    accountId: id(999),
    sessionId: 'B-synthetic',
    accessToken: 'B-access',
    refreshToken: 'B-refresh',
    expiresAt: 999999,
    refreshExpiresAt: 9999999,
  });
  h.sessions.logout();
  h.sessions.completeLogin(h.sessions.beginLogin(), {
    accountId: actor,
    sessionId: 'new-synthetic',
    accessToken: 'test-access',
    refreshToken: 'test-refresh',
    expiresAt: 999999,
    refreshExpiresAt: 9999999,
  });
  reply.resolve(h.receipt);
  await pending;
  assert.equal(h.storage.data.size, 2);
  assert.equal(h.store.opaqueRecovery(actor).command?.receipt, null);
  assert.equal(h.store.isOpaque(actor), true);
  assert.equal(
    /body|contextToken|discussionMedia/.test(
      JSON.stringify([...h.storage.data.values()]),
    ),
    false,
  );
  assert.deepEqual(controller.snapshot().selected, []);
  assert.equal(controller.snapshot().status, 'idle');
  controller.dispose();
});
test('navigation never carries authority and random remains outside discussion contexts', () => {
  assert.equal(
    decodeDiscussionMediaRoute({ scope: 'global', targetId: id(1) }).rootId,
    null,
  );
  assert.throws(() =>
    decodeDiscussionMediaRoute({
      scope: 'global',
      targetId: id(1),
      contextToken: 'secret',
    }),
  );
  assert.throws(() =>
    decodeDiscussionMediaRoute({ scope: 'random', targetId: id(1) }),
  );
  assert.match(
    discussionMediaPath({ kind: 'global' }, id(1), id(2)),
    /rating-discussion-media/,
  );
});
test('gallery close revokes late download and releases only registry-owned file, without system preview', async () => {
  const sessions = signedIn(actor),
    download = deferred<{ localId: string }>(),
    released: string[] = [];
  let last = '';
  const gallery = new RatingDiscussionGallery(
    sessions,
    {
      download: () => download.promise,
      resolve: async () => 'wxfile://tmp/synthetic.png',
      release: async (file) => {
        released.push(file.localId);
      },
    },
    new FakeClock(),
    (view) => {
      last = view.localSrc;
    },
  );
  const descriptor = decodeDiscussionDescriptor({
    protocol: 'ratings-discussion-media-v1',
    kind: 'ratings-discussion-media',
    targetId: id(1),
    rootId: id(2),
    replyId: null,
    subjectRevision: id(3),
    contextId: id(4),
    contextToken: 'a'.repeat(43),
    bindingId: id(5),
    ordinal: 0,
    attachmentSetDigest: 'b'.repeat(64),
    width: 2,
    height: 2,
    variants: ['thumb-v1', 'display-v1'],
  });
  const loading = gallery.open(async () => ({
    context: {} as never,
    subject: {
      protocolVersion: 4,
      attachmentSetDigest: 'b'.repeat(64),
      images: [descriptor],
    },
  }));
  await flush();
  gallery.close();
  download.resolve({ localId: 'synthetic' });
  await loading;
  assert.equal(last, '');
  assert.deepEqual(released, ['synthetic']);
  gallery.dispose();
});
test('absent batch cancellation needs exact durable actor/hash fence; absence alone never clears', () => {
  const h = setup(),
    storage = new MemoryStorage(),
    store = new PendingRatingDiscussionMediaStore(storage, origin);
  const original = store.start({
    ...h.batch,
    batchId: null,
    members: [],
    orderedMemberIds: [],
    sealedPlanDigest: null,
  });
  const proof = {
    protocol: 'ratings-discussion-media-v1' as const,
    batchRequestId: original.identity.batchRequestId,
    serverNow: 1000,
    state: 'cancelled_before_prepare' as const,
    identityHash: original.identityHash,
  };
  assert.throws(() =>
    store.settleAbsentBatchCancellation(
      original,
      {
        protocol: proof.protocol,
        batchRequestId: proof.batchRequestId,
        serverNow: 1000,
        state: 'not_recorded',
      },
      true,
    ),
  );
  assert.throws(() =>
    store.settleAbsentBatchCancellation(
      original,
      { ...proof, identityHash: 'e'.repeat(64) },
      true,
    ),
  );
  assert.throws(() =>
    store.settleAbsentBatchCancellation(original, proof, false),
  );
  assert.equal(storage.data.size, 1);
  store.settleAbsentBatchCancellation(original, proof, true);
  assert.equal(storage.data.size, 0);
});
test('application-lifetime account watcher scrubs original journal even without an open page', () => {
  const h = setup(),
    stop = h.store.watchSession(h.sessions);
  h.sessions.logout();
  const opaque = h.store.opaqueRecovery(actor);
  assert.equal(h.store.isOpaque(actor), true);
  assert.equal(opaque.command?.intentHash, fixture.intentHash);
  assert.equal(opaque.batch?.batchRequestId, p.batchRequestId);
  assert.equal(
    /"body"|"context"|"token"|"authorMode"|"declaration"/.test(
      JSON.stringify([...h.storage.data.values()]),
    ),
    false,
  );
  assert.throws(() => h.store.freezeCommand(actor, intent));
  assert.deepEqual(h.store.opaqueRecovery(id(999)), {
    batch: null,
    command: null,
  });
  stop();
});
test('second opaque-key write failure keeps reciprocal hashes recoverable and blocks any fresh publication', () => {
  const h = setup(),
    set = h.storage.set.bind(h.storage);
  h.storage.set = (key, value) => {
    if (
      key.includes('.batch:') &&
      (value as { phase?: string }).phase === 'batch-opaque'
    )
      throw Error('synthetic second write failed');
    set(key, value);
  };
  assert.throws(() => h.store.minimize(actor));
  assert.equal(h.store.isOpaque(actor), true);
  assert.equal(
    h.store.opaqueRecovery(actor).command?.intentHash,
    fixture.intentHash,
  );
  assert.throws(() => h.store.freezeCommand(actor, intent));
  assert.equal(h.storage.data.size, 2);
});

test('first opaque-key write failure still scrubs the reciprocal batch and blocks full-intent retries', () => {
  const h = setup(),
    set = h.storage.set.bind(h.storage);
  h.storage.set = (key, value) => {
    if (
      key.includes('.command:') &&
      (value as { phase?: string }).phase === 'command-opaque'
    )
      throw Error('synthetic first write failed');
    set(key, value);
  };
  assert.throws(() => h.store.minimize(actor));
  assert.equal(h.store.isOpaque(actor), true);
  assert.equal(
    h.store.opaqueRecovery(actor).batch?.identityHash,
    h.batch.identityHash,
  );
  assert.throws(() => h.store.freezeCommand(actor, intent));
  assert.equal(h.storage.data.size, 2);
});

test('both rejected scrub writes still latch the live actor into opaque recovery only', () => {
  const h = setup();
  h.storage.set = () => {
    throw Error('synthetic storage unavailable');
  };
  assert.throws(() => h.store.minimize(actor));
  assert.equal(h.store.isOpaque(actor), true);
  assert.throws(() => h.store.load(actor));
  assert.throws(() => h.store.freezeCommand(actor, intent));
  assert.equal(
    h.store.opaqueRecovery(actor).command?.intentHash,
    fixture.intentHash,
  );
  assert.equal(h.storage.data.size, 2);
});

test('cold full journals are receipt/hash-cancel only even with identical actor and rejected scrub writes', () => {
  const h = setup();
  h.storage.set = () => {
    throw Error('synthetic storage unavailable');
  };
  assert.throws(() => h.store.minimize(actor));
  const restarted = new PendingRatingDiscussionMediaStore(h.storage, origin);
  assert.equal(restarted.isOpaque(actor), true);
  assert.throws(() => restarted.load(actor));
  assert.throws(() => restarted.freezeCommand(actor, intent));
  const opaque = restarted.opaqueRecovery(actor);
  assert.equal(opaque.command?.intentHash, fixture.intentHash);
  assert.equal(opaque.batch?.batchRequestId, p.batchRequestId);
  assert.equal(
    /"body"|"context"|"token"|"declaration"/.test(JSON.stringify(opaque)),
    false,
  );
});
test('same-process new journal remains eligible for its original preparation and commit', async () => {
  const h = setup(),
    calls: string[] = [];
  const gateway = {
    receipt: async () => {
      calls.push('receipt');
      throw new ClientError('business', 'Absent', {
        serverCode: 'REQUEST_NOT_FOUND',
      });
    },
    command: async () => {
      calls.push('original-command');
      return h.receipt;
    },
    statusBatch: async () => h.server,
  } as unknown as RatingDiscussionMediaGateway;
  const controller = new RatingDiscussionMediaController(
    h.sessions,
    h.store,
    gateway,
    undefined,
    async () => {
      throw Error('Fresh ID forbidden');
    },
    () => undefined,
  );
  await controller.recover('retry');
  assert.deepEqual(calls, ['receipt', 'original-command']);
  assert.equal(h.storage.data.size, 0);
  controller.dispose();
});

test('cold unknown receipt never turns an applied obligation into cancellation, even on explicit cancel', async () => {
  const h = setup(),
    calls: string[] = [];
  h.store.recordReceipt(h.command, h.receipt);
  const cold = new PendingRatingDiscussionMediaStore(h.storage, origin),
    gateway = {
      receipt: async () => {
        calls.push('receipt');
        throw Error('unknown server state');
      },
      cancelByHash: async () => {
        calls.push('cancel');
        throw Error('must not cancel');
      },
      recoverBatch: async () => {
        calls.push('batch');
        throw Error('must not advance');
      },
    } as unknown as RatingDiscussionMediaGateway;
  const controller = new RatingDiscussionMediaController(
    h.sessions,
    cold,
    gateway,
    undefined,
    async () => {
      throw Error('No new ID');
    },
    () => undefined,
  );
  await controller.recover('cancel');
  assert.deepEqual(calls, ['receipt']);
  assert.equal(h.storage.data.size, 2);
  assert.equal(cold.opaqueRecovery(actor).command?.receipt?.outcome, 'applied');
  assert.deepEqual(controller.snapshot().selected, []);
  controller.dispose();
});
