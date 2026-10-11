import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryStorage, signedIn } from './helpers';
import {
  managementIntent,
  managementReceipt,
  managedId,
} from './category-scoped-helpers';
import { scopedIntent } from './rating-scoped-helpers';
import {
  PendingRatingStore,
  isRatingCategoryScopedIntent,
  type RatingCommandIntent,
} from '../src/ratings/pending';
import { PendingRatingDiscussionMediaStore } from '../src/ratings/discussion-media-pending';
import { decodeRatingDiscussionMediaIntent } from '../src/ratings/discussion-media-contract';
import {
  decodeRatingCategoryIconIntent,
  decodeRatingCategoryIconReceipt,
  ratingCategoryIconIntentHash,
  type RatingCategoryIconIntent,
} from '../src/ratings/category-icon-contract';
import {
  decodeRatingCategoryScopedIntent,
  type RatingCategoryScopedIntent,
} from '../src/ratings/category-scoped-contract';
import {
  categoryIconPrepareHash,
  type CategoryIconMediaStatus,
} from '../src/ratings/category-icon-media-contract';
import {
  categoryIconPrepareForScope,
  categoryIconScopeRequestHash,
  decodeCategoryIconScopeInput,
  type CategoryIconScope,
  type CategoryIconScopeRecovery,
} from '../src/ratings/category-icon-upload-scope';
import {
  PendingRatingCategoryIconStore,
  decodePendingRatingCategoryIconUploads,
  ratingCategoryIconSlotLayout,
  ratingCategoryIconUploadIdentityHash,
  type PendingRatingCategoryIconUploads,
  type RatingCategoryIconUploadMember,
  type CategoryIconUploadSettlement,
} from '../src/ratings/category-icon-pending';
import { sealCategoryIconDraft } from '../src/ratings/category-icon-draft';
const id = (value: number): string =>
  `b0000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const actor = id(1),
  otherActor = id(2),
  origin = 'https://example.invalid';
const key = (phase: 'uploads' | 'command', owner = actor): string =>
  `whaleu.ratings.pending.v13.${phase}:${origin}:${owner}`;
function initial(
  textIntent = managementIntent(),
  replace = true,
): PendingRatingCategoryIconUploads {
  const identity = {
    draftRevision: id(10),
    textIntent,
    mediaSnapshot: 'b'.repeat(64),
    slots: ratingCategoryIconSlotLayout(textIntent).map((slot) => ({
      ...slot,
      selection: replace
        ? ('replace' as const)
        : slot.kind === 'override'
          ? ('inherit' as const)
          : ('clear' as const),
    })),
  };
  return {
    version: 13,
    phase: 'uploads',
    accountId: actor,
    identity,
    identityHash: ratingCategoryIconUploadIdentityHash(actor, identity),
    members: [],
  };
}
function pendingMember(
  before: PendingRatingCategoryIconUploads,
  index = 0,
): RatingCategoryIconUploadMember {
  const slot = before.identity.slots[index]!;
  const ownerSlot =
    slot.nodeKey !== null
      ? { kind: 'new', key: slot.nodeKey }
      : slot.kind === 'base'
        ? { kind: 'base', categoryId: slot.categoryId }
        : {
            kind: 'override',
            categoryId: slot.categoryId,
            campusId: slot.campusId,
          };
  const scopeInput = decodeCategoryIconScopeInput({
    ...before.identity.textIntent,
    protocolVersion: 5,
    mediaSnapshot: before.identity.mediaSnapshot,
    clientRequestId: id(100 + index),
    draftRevision: before.identity.draftRevision,
    slot: ownerSlot,
    declaration: {
      mime: 'image/png',
      bytes: 1024 + index,
      sha256: 'c'.repeat(64),
    },
  });
  return {
    memberId: id(200 + index),
    slotKey: slot.key,
    scopeInput,
    scope: null,
    prepare: null,
    status: null,
    state: 'pending',
    assetId: null,
  };
}
function makeReady(
  before: PendingRatingCategoryIconUploads,
  member: RatingCategoryIconUploadMember,
  index = 0,
): RatingCategoryIconUploadMember {
  const scope: CategoryIconScope = {
    editScopeId: id(300 + index),
    scopeRevision: 'd'.repeat(64),
    categoryId: before.identity.slots[index]!.categoryId ?? id(400 + index),
    identityId: id(500 + index),
    expiresAt: '2026-10-10T23:50:00.000Z',
  };
  const prepare = categoryIconPrepareForScope(member.scopeInput, scope),
    assetId = id(600 + index);
  const status: CategoryIconMediaStatus = {
    protocol: 'ratings-category-icon-media-v1',
    editScopeId: scope.editScopeId,
    intentId: id(700 + index),
    requestId: member.scopeInput.clientRequestId,
    requestHash: categoryIconPrepareHash(actor, prepare),
    serverNow: 1791674400000,
    status: 'ready_unbound',
    assetId,
    readyRetentionUntil: 1791678000000,
    editExpiresAt: 1791678000000,
    bindBefore: 1791678000000,
    mediaProof: 'current',
  };
  return { ...member, scope, prepare, status, state: 'ready', assetId };
}
function seal(
  store: PendingRatingCategoryIconStore,
  text = managementIntent(),
) {
  let uploads = store.start(initial(text));
  for (let index = 0; index < uploads.identity.slots.length; index++) {
    const pending = pendingMember(uploads, index);
    uploads = store.update(uploads, {
      ...uploads,
      members: [...uploads.members, pending],
    });
    const ready = makeReady(uploads, pending, index);
    uploads = store.update(uploads, {
      ...uploads,
      members: uploads.members.map((member) =>
        member.memberId === ready.memberId ? ready : member,
      ),
    });
  }
  const intent = sealCategoryIconDraft(
    uploads.identity.textIntent,
    uploads.identity.mediaSnapshot,
    uploads.identity.slots,
    uploads.members.map((member) => ({
      slotKey: member.slotKey,
      assetId: member.assetId!,
      uploadScopeId: member.scope!.editScopeId,
    })),
  );
  return { uploads, intent, command: store.freezeCommand(actor, intent) };
}
function receipt(
  intent: RatingCategoryIconIntent,
  outcome: 'applied' | 'noop' | 'closed' = 'applied',
) {
  const common = {
    protocolVersion: 5,
    requestId: intent.payload.clientRequestId,
    operation: intent.operation,
    intentHash: ratingCategoryIconIntentHash(intent),
    outcome,
  };
  if (outcome === 'closed')
    return decodeRatingCategoryIconReceipt({
      ...common,
      code: 'RATING_CATEGORY_CANCELLED',
    });
  const previous = managementReceipt(undefined, outcome);
  if (previous.outcome === 'closed')
    throw new Error('success receipt expected');
  return decodeRatingCategoryIconReceipt({
    ...common,
    result: {
      ...previous.result,
      mediaReleaseDigest:
        previous.result.releaseId === null ? null : 'e'.repeat(64),
    },
  });
}
function proof(
  member: RatingCategoryIconUploadMember,
  mode: 'bound' | 'cancelled' | 'pending' | 'unknown' = 'bound',
): CategoryIconUploadSettlement {
  let response: CategoryIconScopeRecovery;
  if (mode === 'unknown')
    response = { state: 'unknown', scope: null, recovery: null };
  else if (member.scope === null)
    response = { state: 'cancelled', scope: null, recovery: null };
  else {
    const status = member.status!;
    const common = {
      protocol: 'ratings-category-icon-media-v1' as const,
      editScopeId: member.scope.editScopeId,
      intentId: status.intentId,
      requestId: member.scopeInput.clientRequestId,
      requestHash: categoryIconPrepareHash(actor, member.prepare!),
      serverNow: 1791674400000,
    };
    const settled: CategoryIconMediaStatus =
      mode === 'bound'
        ? {
            ...common,
            status: 'bound_history',
            assetId: member.assetId!,
            bindingId: id(800),
            appearanceId: id(801),
            categoryId: member.scope.categoryId,
            attachmentState: 'active',
          }
        : {
            ...common,
            status: 'terminal',
            reason: 'cancelled',
            cleanup: mode === 'pending' ? 'pending' : 'confirmed',
          };
    response = {
      state: mode === 'bound' ? 'known' : 'cancelled',
      scope: member.scope,
      recovery: {
        protocol: common.protocol,
        requestId: common.requestId,
        requestHash: common.requestHash,
        serverNow: common.serverNow,
        state: 'recorded',
        status: settled,
      },
    };
  }
  return {
    clientRequestId: member.scopeInput.clientRequestId,
    scopeRequestHash: categoryIconScopeRequestHash(member.scopeInput),
    response,
  };
}

test('v13 preserves old journal bytes and checks every v1-v12 fresh-write blocker', () => {
  const oldKeys = [
    ...Array.from(
      { length: 11 },
      (_, index) => `whaleu.ratings.pending.v${index + 1}:${origin}:${actor}`,
    ),
    `whaleu.ratings.pending.v12.batch:${origin}:${actor}`,
    `whaleu.ratings.pending.v12.command:${origin}:${actor}`,
  ];
  for (const oldKey of oldKeys) {
    const storage = new MemoryStorage(),
      store = new PendingRatingCategoryIconStore(storage, origin);
    storage.set(oldKey, { corrupt: true });
    const bytes = JSON.stringify([...storage.data]);
    assert.throws(() => store.start(initial()), { kind: 'storage' });
    const text = managementIntent('set_category_visibility_scoped');
    assert.throws(
      () =>
        store.freezeCommand(
          actor,
          decodeRatingCategoryIconIntent({
            ...text,
            protocolVersion: 5,
            mediaSnapshot: 'b'.repeat(64),
          }),
        ),
      { kind: 'storage' },
    );
    assert.equal(JSON.stringify([...storage.data]), bytes);
  }
});
test('v13 corrupt keys block only fresh old writes, preserving original v10 recovery and idempotent freeze', () => {
  for (const phase of ['uploads', 'command'] as const) {
    const storage = new MemoryStorage(),
      legacy = new PendingRatingStore(storage, origin);
    const old = {
      version: 10 as const,
      accountId: actor,
      intent: managementIntent(),
    };
    storage.set(key(phase), { corrupt: true });
    assert.throws(() => legacy.freeze(old), { kind: 'storage' });
    storage.remove(key(phase));
    const original = legacy.freeze(old),
      bytes = JSON.stringify(
        storage.get(`whaleu.ratings.pending.v10:${origin}:${actor}`),
      );
    storage.set(key(phase), { corrupt: true });
    assert.deepEqual(legacy.load(actor), original);
    assert.deepEqual(legacy.freeze(original), original);
    assert.equal(
      JSON.stringify(
        storage.get(`whaleu.ratings.pending.v10:${origin}:${actor}`),
      ),
      bytes,
    );
    legacy.settle(original, managementReceipt());
    assert.equal(storage.data.size, 1);
  }
});
test('fresh v12 text command cannot bypass either v13 key, and old Category guard never admits v5', () => {
  const text = scopedIntent('create_comment_scoped');
  if (text.operation !== 'create_comment_scoped')
    throw new Error('comment expected');
  const discussion = decodeRatingDiscussionMediaIntent({
    ...text,
    protocolVersion: 4,
    context: {
      ...text.context,
      discussionMedia: {
        id: id(91),
        generation: id(92),
        sourceDigest: 'd'.repeat(64),
        validUntil: '2026-10-10T23:50:00.000Z',
      },
    },
    payload: {
      clientRequestId: text.payload.clientRequestId,
      categoryId: text.payload.categoryId,
      expectedCategoryRevision: text.payload.expectedCategoryRevision,
      targetId: text.payload.targetId,
      expectedTargetRevision: text.payload.expectedTargetRevision,
      expectedDefinitionRevision: id(93),
      expectedContentVersion: 1,
      authorMode: text.payload.authorMode,
      body: text.payload.body,
      batchRequestId: null,
      batchId: null,
      draftRevision: id(90),
      sealedPlanDigest: null,
      images: [],
    },
  });
  for (const phase of ['uploads', 'command'] as const) {
    const storage = new MemoryStorage(),
      store = new PendingRatingDiscussionMediaStore(storage, origin);
    storage.set(key(phase), { corrupt: true });
    assert.throws(() => store.freezeCommand(actor, discussion), {
      kind: 'storage',
    });
    assert.equal(storage.data.size, 1);
  }
  const icon = decodeRatingCategoryIconIntent({
    ...managementIntent(),
    protocolVersion: 5,
    mediaSnapshot: 'b'.repeat(64),
    payload: { ...managementIntent().payload, icon: { mode: 'clear' } },
  });
  assert.equal(
    isRatingCategoryScopedIntent(icon as unknown as RatingCommandIntent),
    false,
  );
  assert.equal(isRatingCategoryScopedIntent(managementIntent()), true);
});
test('scope input is durable before scope creation and assets exist only after exact ready response', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingCategoryIconStore(storage, origin);
  let uploads = store.start(initial());
  const member = pendingMember(uploads),
    ready = makeReady(uploads, member);
  assert.throws(() => store.update(uploads, { ...uploads, members: [ready] }));
  uploads = store.update(uploads, { ...uploads, members: [member] });
  assert.equal(store.load(actor).uploads!.members[0]!.scope, null);
  for (const patch of [
    { assetId: id(600) },
    { state: 'ready' },
    {
      scopeInput: {
        ...member.scopeInput,
        declaration: { ...member.scopeInput.declaration, bytes: 2048 },
      },
    },
  ]) {
    assert.throws(() =>
      store.update(uploads, {
        ...uploads,
        members: [{ ...member, ...patch } as RatingCategoryIconUploadMember],
      }),
    );
  }
  uploads = store.update(uploads, { ...uploads, members: [ready] });
  assert.equal(uploads.members[0]!.assetId, id(600));
  assert.throws(() =>
    decodePendingRatingCategoryIconUploads(
      { ...uploads, members: [{ ...ready, localPath: '/tmp/private.png' }] },
      actor,
    ),
  );
  assert.throws(() =>
    decodePendingRatingCategoryIconUploads(
      {
        ...uploads,
        members: [
          { ...ready, prepare: { ...ready.prepare!, uploadGrant: 'secret' } },
        ],
      },
      actor,
    ),
  );
});
test('text, context, snapshot, modes, declarations and member/slot identity cannot drift after freeze', () => {
  const store = new PendingRatingCategoryIconStore(new MemoryStorage(), origin),
    started = store.start(initial());
  const member = pendingMember(started),
    before = store.update(started, { ...started, members: [member] });
  for (const identity of [
    { ...before.identity, mediaSnapshot: 'f'.repeat(64) },
    {
      ...before.identity,
      slots: before.identity.slots.map((slot) => ({
        ...slot,
        selection: 'clear' as const,
      })),
    },
    {
      ...before.identity,
      textIntent: decodeRatingCategoryScopedIntent({
        ...before.identity.textIntent,
        payload: {
          ...before.identity.textIntent.payload,
          name: 'Changed after upload began',
        },
      }),
    },
    {
      ...before.identity,
      textIntent: decodeRatingCategoryScopedIntent({
        ...before.identity.textIntent,
        context: {
          ...before.identity.textIntent.context,
          sourceDigest: 'f'.repeat(64),
        },
      }),
    },
  ])
    assert.throws(() =>
      store.update(before, {
        ...before,
        identity,
        identityHash: ratingCategoryIconUploadIdentityHash(actor, identity),
      }),
    );
  assert.throws(() => store.update(before, { ...before, members: [] }));
  assert.throws(() =>
    store.update(before, {
      ...before,
      members: [{ ...member, slotKey: `base:${id(999)}` }],
    }),
  );
});
test('all 32 nodes have independent stable metadata and one atomic original business command', () => {
  const raw = managementIntent('create_categories_scoped');
  const text = decodeRatingCategoryScopedIntent({
    ...raw,
    payload: {
      ...raw.payload,
      nodes: Array.from({ length: 32 }, (_, index) => ({
        key: `node_${index}`,
        parentKey: null,
        name: `Node ${index}`,
        description: '',
      })),
    },
  });
  const store = new PendingRatingCategoryIconStore(new MemoryStorage(), origin),
    sealed = seal(store, text);
  assert.equal(sealed.uploads.members.length, 32);
  assert.equal(sealed.command.obligations.length, 32);
  assert.equal(
    new Set(sealed.command.obligations.map((o) => o.scope!.editScopeId)).size,
    32,
  );
  assert.equal(
    sealed.command.intent.payload.clientRequestId,
    text.payload.clientRequestId,
  );
  assert.throws(() =>
    store.update(sealed.uploads, {
      ...sealed.uploads,
      members: [...sealed.uploads.members].reverse(),
    }),
  );
  if (sealed.intent.operation !== 'create_categories_scoped')
    throw new Error('create expected');
  const intent = sealed.intent;
  const nodes = intent.payload.nodes;
  assert.throws(() =>
    store.freezeCommand(actor, {
      ...intent,
      payload: {
        ...intent.payload,
        nodes: nodes.map((node, index) => ({
          ...node,
          icon: nodes[(index + 1) % nodes.length]!.icon,
        })),
      },
    }),
  );
});
test('receipt must be persisted before all member cleanup and native completion permit clearing', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingCategoryIconStore(storage, origin),
    sealed = seal(store);
  const bound = sealed.uploads.members.map((member) => proof(member));
  assert.throws(() => store.settleCommand(sealed.command, bound, true));
  assert.throws(() =>
    store.recordReceipt(sealed.command, {
      ...receipt(sealed.intent),
      intentHash: 'f'.repeat(64),
    }),
  );
  const command = store.recordReceipt(sealed.command, receipt(sealed.intent));
  assert.equal(storage.data.size, 2);
  assert.throws(() => store.settleCommand(command, bound, false));
  assert.throws(() => store.settleCommand(command, [], true));
  assert.throws(() =>
    store.settleCommand(
      command,
      sealed.uploads.members.map((member) => proof(member, 'unknown')),
      true,
    ),
  );
  assert.throws(() =>
    store.settleCommand(
      command,
      bound.map((item) => ({ ...item, scopeRequestHash: 'f'.repeat(64) })),
      true,
    ),
  );
  const original = bound[0]!;
  if (
    original.response.recovery?.state !== 'recorded' ||
    original.response.recovery.status.status !== 'bound_history'
  )
    throw new Error('bound proof expected');
  const wrong = {
    ...original,
    response: {
      ...original.response,
      recovery: {
        ...original.response.recovery,
        status: { ...original.response.recovery.status, categoryId: id(998) },
      },
    },
  };
  assert.throws(() => store.settleCommand(command, [wrong], true));
  store.settleCommand(command, bound, true);
  assert.equal(storage.data.size, 0);
});
test('closed receipt retains every Media obligation until cleanup confirmed; unknown cannot be dropped', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingCategoryIconStore(storage, origin),
    sealed = seal(store);
  const command = store.recordReceipt(
    sealed.command,
    receipt(sealed.intent, 'closed'),
  );
  for (const mode of ['bound', 'unknown', 'pending'] as const)
    assert.throws(() =>
      store.settleCommand(
        command,
        sealed.uploads.members.map((member) => proof(member, mode)),
        true,
      ),
    );
  assert.equal(storage.data.size, 2);
  store.settleCommand(
    command,
    sealed.uploads.members.map((member) => proof(member, 'cancelled')),
    true,
  );
  assert.equal(storage.data.size, 0);
});
test('lost owner scope response requires exact cancellation fence and cannot be treated as absent', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingCategoryIconStore(storage, origin);
  let uploads = store.start(initial());
  const member = pendingMember(uploads);
  uploads = store.update(uploads, { ...uploads, members: [member] });
  assert.throws(() =>
    store.settleUploadsCancellation(uploads, [proof(member, 'unknown')], true),
  );
  assert.throws(() =>
    store.clearUploads(uploads, [proof(member, 'cancelled')], false),
  );
  const recovered = new PendingRatingCategoryIconStore(storage, origin),
    opaque = recovered.opaqueRecovery(actor);
  assert.throws(() => recovered.load(actor));
  assert.equal(opaque.uploads!.obligations[0]!.scope, null);
  recovered.settleOpaque(opaque, [proof(member, 'cancelled')], true);
  assert.equal(storage.data.size, 0);
});
test('second-write failure and process restart retain receipt-only obligations without full intent access', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingCategoryIconStore(storage, origin);
  let uploads = store.start(initial());
  const member = pendingMember(uploads);
  uploads = store.update(uploads, { ...uploads, members: [member] });
  const ready = makeReady(uploads, member);
  uploads = store.update(uploads, { ...uploads, members: [ready] });
  const intent = sealCategoryIconDraft(
    uploads.identity.textIntent,
    uploads.identity.mediaSnapshot,
    uploads.identity.slots,
    [
      {
        slotKey: ready.slotKey,
        assetId: ready.assetId!,
        uploadScopeId: ready.scope!.editScopeId,
      },
    ],
  );
  storage.failWrite = true;
  assert.throws(() => store.freezeCommand(actor, intent));
  storage.failWrite = false;
  const recovered = new PendingRatingCategoryIconStore(storage, origin);
  assert.equal(recovered.isOpaque(actor), true);
  assert.throws(() => recovered.load(actor));
  assert.throws(() => recovered.freezeCommand(actor, intent));
  const opaque = recovered.opaqueRecovery(actor);
  assert.equal(opaque.command, null);
  assert.equal(
    opaque.uploads!.obligations[0]!.clientRequestId,
    member.scopeInput.clientRequestId,
  );
  assert.equal(
    /"textIntent"|"context"|"token"|"declaration"|"payload"|"name"/.test(
      JSON.stringify(opaque),
    ),
    false,
  );
});
test('logout minimizes original actor, late callbacks cannot mutate, and other actor cannot recover those bytes', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingCategoryIconStore(storage, origin),
    sessions = signedIn(actor);
  const stop = store.watchSession(sessions),
    sealed = seal(store);
  sessions.logout();
  const opaque = store.opaqueRecovery(actor);
  assert.equal(store.isOpaque(actor), true);
  assert.throws(() => store.update(sealed.uploads, sealed.uploads));
  assert.throws(() => store.freezeCommand(actor, sealed.intent));
  assert.equal(
    /"textIntent"|"context"|"token"|"declaration"|"payload"|"name"/.test(
      JSON.stringify([...storage.data]),
    ),
    false,
  );
  assert.deepEqual(store.load(otherActor), { uploads: null, command: null });
  storage.set(key('command', otherActor), storage.get(key('command')));
  assert.throws(() => store.opaqueRecovery(otherActor));
  const command = store.recordOpaqueReceipt(
    opaque.command!,
    receipt(sealed.intent),
  );
  store.settleOpaque(
    { ...opaque, command },
    sealed.uploads.members.map((member) => proof(member)),
    true,
  );
  assert.equal(storage.get(key('command')), undefined);
  stop();
});
test('silent failed scrub is detected while reload and same-process publication stay revoked', () => {
  class DroppedWrite extends MemoryStorage {
    drop = false;
    override set(storageKey: string, value: unknown): void {
      if (!this.drop) super.set(storageKey, value);
    }
  }
  const storage = new DroppedWrite(),
    store = new PendingRatingCategoryIconStore(storage, origin),
    sealed = seal(store);
  storage.drop = true;
  assert.throws(() => store.minimize(actor), { kind: 'storage' });
  assert.throws(() => store.load(actor), { kind: 'storage' });
  assert.throws(
    () =>
      new PendingRatingCategoryIconStore(storage, origin).freezeCommand(
        actor,
        sealed.intent,
      ),
    { kind: 'storage' },
  );
  storage.drop = false;
  store.minimize(actor);
  assert.equal(
    /"context"|"textIntent"|"payload"/.test(JSON.stringify([...storage.data])),
    false,
  );
});
test('cleanup crash after uploads removal retains complete receipt and all member recovery keys', () => {
  class FailCommandRemoval extends MemoryStorage {
    failCommand = false;
    override remove(storageKey: string): void {
      if (this.failCommand && storageKey === key('command'))
        throw new Error('crash boundary');
      super.remove(storageKey);
    }
  }
  const storage = new FailCommandRemoval(),
    store = new PendingRatingCategoryIconStore(storage, origin),
    sealed = seal(store);
  const command = store.recordReceipt(sealed.command, receipt(sealed.intent));
  storage.failCommand = true;
  assert.throws(() =>
    store.settleCommand(
      command,
      sealed.uploads.members.map((member) => proof(member)),
      true,
    ),
  );
  assert.equal(storage.get(key('uploads')), undefined);
  const recovered = new PendingRatingCategoryIconStore(storage, origin),
    opaque = recovered.opaqueRecovery(actor);
  assert.equal(opaque.uploads, null);
  assert.equal(opaque.command!.receipt!.outcome, 'applied');
  assert.equal(opaque.command!.obligations.length, 1);
  storage.failCommand = false;
  recovered.settleOpaque(
    opaque,
    sealed.uploads.members.map((member) => proof(member)),
    true,
  );
  assert.equal(storage.data.size, 0);
});
test('missing unreceipted uploads, extra provider data and misbound actor are blocking corruption', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingCategoryIconStore(storage, origin),
    sealed = seal(store);
  storage.remove(key('uploads'));
  assert.throws(() => store.load(actor));
  assert.throws(() => store.opaqueRecovery(actor));
  assert.throws(() =>
    decodePendingRatingCategoryIconUploads(
      { ...sealed.uploads, accountId: otherActor },
      actor,
    ),
  );
  assert.throws(() =>
    decodePendingRatingCategoryIconUploads(
      { ...sealed.uploads, providerId: 'not-permitted' },
      actor,
    ),
  );
  assert.equal(sealed.uploads.members[0]!.scope!.categoryId, managedId);
});
test('v13 receipt recovery is independent from later corrupt legacy keys and metadata-only commands need no image', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingCategoryIconStore(storage, origin);
  const text: RatingCategoryScopedIntent = managementIntent(
    'set_category_visibility_scoped',
  );
  const intent = decodeRatingCategoryIconIntent({
    ...text,
    protocolVersion: 5,
    mediaSnapshot: 'b'.repeat(64),
  });
  const command = store.freezeCommand(actor, intent);
  storage.set(`whaleu.ratings.pending.v12.command:${origin}:${actor}`, {
    corrupt: true,
  });
  assert.deepEqual(store.load(actor).command, command);
  const received = store.recordReceipt(command, receipt(intent, 'closed'));
  store.settleCommand(received, [], true);
  assert.equal(storage.data.size, 1);
});
