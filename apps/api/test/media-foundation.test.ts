import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  mediaManifestSchema,
  prepareMediaSchema,
  mediaDeliveryRequestSchema,
  mediaAttachmentDescriptorSchema,
} from '../src/media/contracts.js';
import { sealManifest, canonicalManifest } from '../src/media/manifest.js';
import { MediaOwnerProofRegistry } from '../src/media/owner-proof.js';
import type {
  MediaOwnerReadProof,
  OwnerReadRequest,
} from '../src/media/owner-proof.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { SyntheticMediaStorage } from './support/media/synthetic-storage.js';

function manifestFixture() {
  const object = (key: string) => ({
    provider: 'local-fixture',
    environment: 'synthetic',
    bucket: 'synthetic',
    key,
    version: '00000000-0000-4000-8000-000000000004',
  });
  return {
    version: 1,
    policyVersion: 'media-static-v1',
    transformVersion: 'static-reencode-v1',
    original: {
      object: object('00000000-0000-4000-8000-000000000001'),
      sha256: 'a'.repeat(64),
      mime: 'image/png',
      bytes: 500,
      width: 800,
      height: 600,
    },
    variants: [
      {
        name: 'thumb-v1',
        object: object('00000000-0000-4000-8000-000000000002'),
        sha256: 'b'.repeat(64),
        mime: 'image/png',
        bytes: 100,
        width: 400,
        height: 300,
      },
      {
        name: 'display-v1',
        object: object('00000000-0000-4000-8000-000000000003'),
        sha256: 'c'.repeat(64),
        mime: 'image/png',
        bytes: 400,
        width: 800,
        height: 600,
      },
    ],
  };
}
test('manifest canonical bytes bind every exact object and ordered variant', () => {
  const input = manifestFixture();
  const sealed = sealManifest(input);
  assert.equal(
    sealed.digest,
    'c4ec68384636c7e1fc6f28a80df09aa8893248f8d4e80290d669e8a923636c9d',
  );
  assert.equal(
    canonicalManifest({ ...input, original: { ...input.original } }),
    sealed.canonical,
  );
  assert.equal(Object.isFrozen(sealed.manifest.original.object), true);
  input.original.sha256 = 'd'.repeat(64);
  assert.equal(sealed.manifest.original.sha256, 'a'.repeat(64));
  for (const mutate of [
    (m: ReturnType<typeof manifestFixture>) => {
      m.original.object.version = randomUUID();
    },
    (m: ReturnType<typeof manifestFixture>) => {
      m.variants[0]!.sha256 = 'd'.repeat(64);
    },
    (m: ReturnType<typeof manifestFixture>) => {
      m.variants[1]!.bytes++;
    },
  ]) {
    const changed = manifestFixture();
    mutate(changed);
    assert.notEqual(sealManifest(changed).digest, sealed.digest);
  }
  const reversed = manifestFixture();
  reversed.variants.reverse();
  assert.equal(mediaManifestSchema.safeParse(reversed).success, false);
  assert.equal(
    mediaManifestSchema.safeParse({ ...manifestFixture(), malwareClean: true })
      .success,
    false,
  );
  const bomb = manifestFixture();
  bomb.original.width = 8192;
  bomb.original.height = 8192;
  assert.equal(mediaManifestSchema.safeParse(bomb).success, false);
  const duplicate = manifestFixture();
  duplicate.variants[1]!.object = duplicate.variants[0]!.object;
  assert.equal(mediaManifestSchema.safeParse(duplicate).success, false);
});
test('client contracts cannot assert owner approval, public ACL, arbitrary keys or read URLs', () => {
  const input = {
    clientRequestId: randomUUID(),
    purpose: 'community-post-image',
    draftId: randomUUID(),
    spaceId: randomUUID(),
    slot: 'images',
    ordinal: 0,
    declaration: { bytes: 100, mime: 'image/png' },
  };
  assert.equal(prepareMediaSchema.safeParse(input).success, true);
  for (const extra of [
    { approved: true },
    { audience: 'world-public' },
    { ownerAccountId: randomUUID() },
    { url: 'https://example.org/a' },
    { key: '../../a' },
  ])
    assert.equal(
      prepareMediaSchema.safeParse({ ...input, ...extra }).success,
      false,
    );
  assert.equal(
    prepareMediaSchema.safeParse({ ...input, ordinal: 1 }).success,
    false,
  );
  assert.equal(
    mediaDeliveryRequestSchema.safeParse({
      bindingId: randomUUID(),
      variant: 'original',
    }).success,
    false,
  );
  assert.equal(
    mediaAttachmentDescriptorSchema.safeParse({
      version: 1,
      kind: 'authenticated-media',
      assetId: randomUUID(),
      bindingId: randomUUID(),
      width: 100,
      height: 100,
      variants: ['thumb-v1', 'display-v1'],
      displayUrl: 'https://example.org',
    }).success,
    false,
  );
});
test('owner capabilities bind transaction epoch, exact typed parent, viewer and purpose', async () => {
  const tx = {} as PoolClient;
  const other = {} as PoolClient;
  let calls = 0;
  const registry = new MediaOwnerProofRegistry([
    {
      ownerKind: 'community',
      async authorizeCurrent() {
        calls++;
      },
    },
  ]);
  const request: OwnerReadRequest = {
    viewerAccountId: randomUUID(),
    parent: {
      ownerKind: 'community',
      resourceKind: 'post',
      resourceId: randomUUID(),
      contentVersion: 1,
    },
    audience: 'content-gated',
    purpose: 'download',
  };
  await assert.rejects(registry.authorize(request, tx));
  startTransactionDeadlines(tx);
  startTransactionDeadlines(other);
  try {
    const proof = await registry.authorize(request, tx);
    assert.equal(calls, 1);
    registry.require(proof, tx, request);
    for (const changed of [
      { ...request, viewerAccountId: randomUUID() },
      { ...request, purpose: 'list-projection' as const },
      { ...request, parent: { ...request.parent, resourceId: randomUUID() } },
    ])
      assert.throws(() => registry.require(proof, tx, changed));
    assert.throws(() => registry.require(proof, other, request));
    assert.throws(() =>
      registry.require({} as MediaOwnerReadProof, tx, request),
    );
    await assert.rejects(
      registry.authorize({ ...request, audience: 'conversation-private' }, tx),
    );
    await assert.rejects(
      registry.authorize(
        {
          ...request,
          parent: {
            ownerKind: 'messaging',
            resourceKind: 'message',
            resourceId: request.parent.resourceId,
            contentVersion: 1,
          },
          audience: 'conversation-private',
        },
        tx,
      ),
    );
    await assert.rejects(
      registry.authorize(
        {
          ...request,
          parent: {
            ownerKind: 'errands',
            resourceKind: 'order',
            resourceId: request.parent.resourceId,
            contentVersion: 1,
          },
          audience: 'participant-private',
        },
        tx,
      ),
    );
    const checkpoint = checkpointTransactionDeadlines(tx);
    restoreTransactionDeadlines(tx, checkpoint);
    assert.throws(() => registry.require(proof, tx, request));
  } finally {
    clearTransactionDeadlines(tx);
    clearTransactionDeadlines(other);
  }
});
test('synthetic storage seals observed immutable bytes despite a later staging upload', async () => {
  const storage = await SyntheticMediaStorage.create();
  try {
    // These are storage protocol bytes, NOT decoder or image approval fixtures.
    const first = await storage.upload(Buffer.from('synthetic-A'));
    const second = await storage.upload(
      Buffer.from('synthetic-B'),
      first.object.key,
    );
    const destination = storage.newObject();
    const sealed = await storage.seal(first.object, destination);
    assert.equal(sealed.sha256, first.sha256);
    assert.notEqual(sealed.sha256, second.sha256);
    assert.deepEqual(await storage.seal(first.object, destination), sealed);
    await assert.rejects(
      storage.seal(second.object, destination),
      /EFFECT_CONFLICT/,
    );
    assert.equal((await storage.measure(destination)).sha256, first.sha256);
    await assert.rejects(
      storage.openExact({ ...destination, key: '../../escape' }, 100),
    );
    await assert.rejects(
      storage.openExact({ ...destination, bucket: 'other' }, 100),
    );
    await assert.rejects(storage.openExact(destination, 2), /SIZE_LIMIT/);
    await assert.rejects(
      storage.upload(new Uint8Array(5 * 1024 * 1024 + 1)),
      /SIZE_LIMIT/,
    );
    await assert.rejects(storage.upload(new Uint8Array()), /EMPTY/);
    assert.equal(await storage.deleteExact(destination), 'confirmed-absent');
    assert.equal(await storage.deleteExact(destination), 'confirmed-absent');
    await assert.rejects(storage.measure(destination));
    assert.equal((await storage.measure(first.object)).sha256, first.sha256);
  } finally {
    await storage.dispose();
  }
});
test('synthetic writer retirement is irreversible and binds cleanup proof to exact object', async () => {
  const storage = await SyntheticMediaStorage.create();
  try {
    const object = storage.newObject();
    await storage.writePlanned(object, Buffer.from('synthetic-retirement'));
    const proof = await storage.retire(object);
    storage.requireRetired(proof, object);
    assert.throws(() => storage.requireRetired({}, object));
    assert.throws(() => storage.requireRetired(proof, storage.newObject()));
    assert.equal(await storage.deleteExact(object), 'confirmed-absent');
    await assert.rejects(
      storage.writePlanned(object, Buffer.from('late-effect')),
      /RETIRED/,
    );
    await assert.rejects(storage.measure(object));
  } finally {
    await storage.dispose();
  }
});

test('exact current Media denial distinguishes held/revoked from missing, stale or mismatched evidence', async () => {
  const { currentMediaSafety } = await import('../src/media/current-safety.js');
  const current = {
    state: 'allow',
    manifest_digest: 'digest',
    policy_revision: 'policy',
    effective_at: new Date(1000),
    valid_until: new Date(3000),
  };
  for (const state of ['allow', 'held', 'revoked']) {
    assert.equal(
      currentMediaSafety({ ...current, state }, 'digest', 'policy', 2000),
      state === 'allow' ? 'allow' : 'deny',
    );
    assert.equal(
      currentMediaSafety({ ...current, state }, 'digest', 'policy', 3000),
      'unknown',
    );
    assert.equal(
      currentMediaSafety({ ...current, state }, 'other', 'policy', 2000),
      'unknown',
    );
    assert.equal(
      currentMediaSafety({ ...current, state }, 'digest', 'other', 2000),
      'unknown',
    );
    assert.equal(
      currentMediaSafety({ ...current, state }, 'digest', 'policy', 999),
      'unknown',
    );
  }
  assert.equal(
    currentMediaSafety(undefined, 'digest', 'policy', 2000),
    'unknown',
  );
  assert.equal(
    currentMediaSafety(
      { ...current, state: 'unknown' },
      'digest',
      'policy',
      2000,
    ),
    'unknown',
  );
});
