import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { PoolClient } from 'pg';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import {
  ERRAND_MEDIA_PROTOCOL,
  prepareErrandMediaSchema,
  errandMediaRequestHash,
  errandDescriptorSchema,
  errandMediaFactsSchema,
  errandMediaBindingsSchema,
} from '../src/media/contracts-errand.js';
import { MediaErrandPrepareScopes } from '../src/media/errand-prepare-scope.js';
import { ErrandOwnerProofRegistry } from '../src/media/errand-owner-proof.js';
import type {
  ErrandReadAuthority,
  ErrandReadProof,
  ErrandReadRequest,
} from '../src/media/errand-owner-proof.js';
import { ErrandMediaAssetRepository } from '../src/media/errand-asset-repository.js';
import type { AssetRow } from '../src/media/asset-repository.js';
import type { MediaManifest } from '../src/media/contracts.js';
const native = createRequire(import.meta.url)(
  '../../wechat/src/errands/media-contract.ts',
);
const input = () => ({
  protocol: ERRAND_MEDIA_PROTOCOL,
  clientRequestId: randomUUID(),
  draftId: randomUUID(),
  draftRevision: 1,
  targetRegionId: randomUUID(),
  slot: 'private0' as const,
  declaration: {
    mime: 'image/png' as const,
    bytes: 100,
    sha256: 'a'.repeat(64),
  },
});

test('Errand prepare identity binds draft revision, target, slot, actor and exact bytes; URLs/audience are never client authority', () => {
  const raw = input(),
    actor = randomUUID(),
    hash = errandMediaRequestHash(actor, raw);
  assert.deepEqual(prepareErrandMediaSchema.parse(raw), raw);
  assert.deepEqual(native.decodeErrandMediaPrepare(raw), raw);
  assert.equal(native.errandMediaPrepareHash(actor, raw), hash);
  for (const patch of [
    { draftId: randomUUID() },
    { draftRevision: 2 },
    { targetRegionId: randomUUID() },
    { slot: 'public0' },
    { clientRequestId: randomUUID() },
    { declaration: { ...raw.declaration, sha256: 'b'.repeat(64) } },
  ])
    assert.notEqual(errandMediaRequestHash(actor, { ...raw, ...patch }), hash);
  assert.notEqual(errandMediaRequestHash(randomUUID(), raw), hash);
  for (const patch of [
    { audience: 'errand-public' },
    { url: 'https://example.invalid' },
    { bindingId: randomUUID() },
    { ownerKind: 'community' },
    { slot: 'gallery0' },
    { draftRevision: 0 },
    { draftRevision: Number.MAX_SAFE_INTEGER },
  ])
    assert.equal(
      prepareErrandMediaSchema.safeParse({ ...raw, ...patch }).success,
      false,
    );
  const descriptor = {
    protocol: ERRAND_MEDIA_PROTOCOL,
    kind: 'errand-media',
    orderId: randomUUID(),
    revision: 1,
    slot: 'public0',
    bindingId: randomUUID(),
    width: 100,
    height: 100,
    variants: ['thumb-v1', 'display-v1'],
  };
  assert.equal(errandDescriptorSchema.safeParse(descriptor).success, true);
  assert.deepEqual(
    errandDescriptorSchema.parse(descriptor),
    native.decodeErrandMediaDescriptor(descriptor),
  );
  for (const patch of [
    { url: 'https://example.invalid' },
    { assetId: randomUUID() },
    { kind: 'announcement-media' },
    { variants: ['original'] },
  ])
    assert.equal(
      errandDescriptorSchema.safeParse({ ...descriptor, ...patch }).success,
      false,
    );
});

test('Errand image facts reject repeated assets and slots across public/private audiences', () => {
  const a = {
      slot: 'public0',
      assetId: randomUUID(),
      manifestDigest: 'a'.repeat(64),
    },
    b = {
      slot: 'private0',
      assetId: randomUUID(),
      manifestDigest: 'b'.repeat(64),
    };
  assert.equal(errandMediaFactsSchema.safeParse([a, b]).success, true);
  assert.equal(
    errandMediaFactsSchema.safeParse([a, { ...b, assetId: a.assetId }]).success,
    false,
  );
  assert.equal(
    errandMediaFactsSchema.safeParse([a, { ...b, slot: a.slot }]).success,
    false,
  );
  const bindingId = randomUUID();
  assert.equal(
    errandMediaBindingsSchema.safeParse([
      { ...a, bindingId },
      { ...b, bindingId },
    ]).success,
    false,
  );
});

test('Media14 prepare capability cannot be reused across draft revisions or change private audience into public', async () => {
  const tx = {} as PoolClient;
  startTransactionDeadlines(tx);
  const raw = input(),
    actor = randomUUID();
  let wrong = false;
  const scopes = new MediaErrandPrepareScopes({
    authorizePrepare: async () => ({
      actorAccountId: actor,
      serverScopeId: randomUUID(),
      scopeRevision: errandMediaRequestHash(actor, raw),
      expiresAt: Date.now() + 60000,
      ownerKind: 'errands',
      resourceKind: 'errand_image',
      targetKind: 'edit',
      contentVersion: 1,
      audience: wrong ? 'errand-public' : 'errand-private',
      purpose: 'errand-private-image',
      slot: 'private0',
      ordinal: 0,
    }),
  });
  try {
    const proof = await scopes.authorizeErrand(actor, raw, tx);
    assert.equal(scopes.require(proof, tx).scope.audience, 'errand-private');
    await assert.rejects(
      scopes.authorizeErrand(actor, { ...raw, draftRevision: 2 }, tx),
    );
    await assert.rejects(
      scopes.authorizeErrand(actor, { ...raw, slot: 'public0' }, tx),
    );
    wrong = true;
    await assert.rejects(scopes.authorizeErrand(actor, raw, tx));
    clearTransactionDeadlines(tx);
    startTransactionDeadlines(tx);
    assert.throws(() => scopes.require(proof, tx));
  } finally {
    clearTransactionDeadlines(tx);
  }
});

test('Errand read proof retains complete owner set and authenticates exact current order/revision/slot/binding', async () => {
  const tx = {} as PoolClient;
  startTransactionDeadlines(tx);
  const reference = {
    orderId: randomUUID(),
    revision: 1,
    slot: 'public0' as const,
    bindingId: randomUUID(),
  };
  const request: ErrandReadRequest = { reference };
  const value: ErrandReadAuthority = {
    reference,
    orderId: reference.orderId,
    mediaRevision: 1,
    accountId: randomUUID(),
    sessionId: randomUUID(),
    ownerRevision: 'current',
    draftId: randomUUID(),
    draftRevision: 1,
    actorAccountId: randomUUID(),
    media: [
      {
        slot: 'public0',
        assetId: randomUUID(),
        manifestDigest: 'a'.repeat(64),
        bindingId: reference.bindingId,
      },
      {
        slot: 'private0',
        assetId: randomUUID(),
        manifestDigest: 'b'.repeat(64),
        bindingId: randomUUID(),
      },
    ],
  };
  const registry = new ErrandOwnerProofRegistry({
    authorizeCurrent: async (token) => {
      if (token !== 'valid') throw new Error('Invalid session');
      return value;
    },
  });
  try {
    const proof = await registry.authorize('valid', request, tx);
    assert.equal(registry.require(proof, request, tx).media.length, 2);
    assert.throws(() => registry.require({} as ErrandReadProof, request, tx));
    for (const patch of [
      { orderId: randomUUID() },
      { revision: 2 },
      { slot: 'private0' as const },
      { bindingId: randomUUID() },
    ])
      assert.throws(() =>
        registry.require(proof, { reference: { ...reference, ...patch } }, tx),
      );
    await assert.rejects(registry.authorize('', request, tx));
    await assert.rejects(registry.authorize('invalid', request, tx));
    clearTransactionDeadlines(tx);
    startTransactionDeadlines(tx);
    assert.throws(() => registry.require(proof, request, tx));
  } finally {
    clearTransactionDeadlines(tx);
  }
});

class CurrentSetRepository extends ErrandMediaAssetRepository {
  checked: string[] = [];
  revoked: string | null = null;
  protected override async lockIntents() {}
  protected override async current(asset: AssetRow): Promise<MediaManifest> {
    this.checked.push(asset.id);
    if (asset.id === this.revoked)
      throw new Error('Sibling current Safety revoked');
    return {
      variants: [
        { width: 100, height: 100 },
        { width: 200, height: 200 },
      ],
    } as MediaManifest;
  }
}
test('Public descriptor checks private sibling Safety and exact owner complete set, without returning private facts', async () => {
  const orderId = randomUUID(),
    publicId = randomUUID(),
    privateId = randomUUID();
  const items = [
    {
      slot: 'public0' as const,
      assetId: publicId,
      manifestDigest: 'a'.repeat(64),
      bindingId: randomUUID(),
    },
    {
      slot: 'private0' as const,
      assetId: privateId,
      manifestDigest: 'b'.repeat(64),
      bindingId: randomUUID(),
    },
  ];
  const reference = {
    orderId,
    revision: 1,
    slot: 'public0' as const,
    bindingId: items[0]!.bindingId,
  };
  const authority: ErrandReadAuthority = {
    reference,
    orderId,
    mediaRevision: 1,
    accountId: randomUUID(),
    sessionId: randomUUID(),
    ownerRevision: 'current',
    draftId: randomUUID(),
    draftRevision: 1,
    actorAccountId: randomUUID(),
    media: items,
  };
  const registry = new ErrandOwnerProofRegistry({
    authorizeCurrent: async () => authority,
  });
  const repository = new CurrentSetRepository(registry);
  Object.defineProperty(repository, 'proof', {
    value: { capture: async () => '' },
  });
  const tx = {
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes('SELECT p.binding_id'))
        return { rows: items.map((x) => ({ binding_id: x.bindingId })) };
      if (sql.includes('SELECT a.*,i.protocol_version')) {
        const item = items.find((x) => x.assetId === params[2])!;
        return {
          rows: [
            {
              id: item.assetId,
              slot: item.slot,
              manifest_digest: item.manifestDigest,
              protocol_version: 14,
              owner_kind: 'errands',
              resource_kind: 'errand_image',
              target_kind: 'edit',
              content_version: '1',
              audience: item.slot.startsWith('public')
                ? 'errand-public'
                : 'errand-private',
              purpose: item.slot.startsWith('public')
                ? 'errand-public-image'
                : 'errand-private-image',
              ordinal: 0,
            },
          ],
        };
      }
      if (sql.includes('SELECT revision::text,event_id'))
        return { rows: [{ revision: '1', event_id: randomUUID() }] };
      if (sql.includes('AND (draft_id<>')) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query ${sql}`);
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  try {
    const proof = await registry.authorize('valid', { reference }, tx);
    const descriptor = await repository.describe(proof, { reference }, tx);
    assert.deepEqual(repository.checked, [publicId, privateId]);
    assert.equal(descriptor.bindingId, items[0]!.bindingId);
    assert.equal(JSON.stringify(descriptor).includes(privateId), false);
    assert.equal(
      JSON.stringify(descriptor).includes(items[1]!.bindingId),
      false,
    );
    repository.revoked = privateId;
    await assert.rejects(
      repository.describe(proof, { reference }, tx),
      /Sibling current Safety revoked/,
    );
    await assert.rejects(repository.currentFacts(orderId, 1, [items[0]!], tx));
  } finally {
    clearTransactionDeadlines(tx);
  }
});
