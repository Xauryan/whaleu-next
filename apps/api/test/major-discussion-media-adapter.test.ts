import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { PoolClient } from 'pg';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { ApplicationError } from '../src/http/application-error.js';
import {
  MAJOR_DISCUSSION_MEDIA_PROTOCOL,
  prepareMajorDiscussionMediaSchema,
  majorDiscussionMediaRequestHash,
  majorDiscussionMediaFactsSchema,
  majorDiscussionMediaBindingsSchema,
  majorDiscussionDescriptorSchema,
  cancelMajorDiscussionMediaRequestSchema,
} from '../src/media/contracts-major-discussion.js';
import { MediaMajorDiscussionPrepareScopes } from '../src/media/major-discussion-prepare-scope.js';
import { MajorDiscussionOwnerProofRegistry } from '../src/media/major-discussion-owner-proof.js';
import type {
  MajorDiscussionReadAuthority,
  MajorDiscussionReadProof,
} from '../src/media/major-discussion-owner-proof.js';
import { MajorDiscussionMediaAssetRepository } from '../src/media/major-discussion-asset-repository.js';
import type { AssetRow } from '../src/media/asset-repository.js';
import type { MediaManifest } from '../src/media/contracts.js';
const input = () => ({
  protocol: MAJOR_DISCUSSION_MEDIA_PROTOCOL,
  clientRequestId: randomUUID(),
  publicationRequestId: randomUUID(),
  majorId: randomUUID(),
  catalogRevision: randomUUID(),
  majorRevision: randomUUID(),
  rootId: null,
  replyToReplyId: null,
  ordinal: 0,
  declaration: {
    mime: 'image/png' as const,
    bytes: 100,
    sha256: 'a'.repeat(64),
  },
});
const fact = () => ({ assetId: randomUUID(), manifestDigest: 'a'.repeat(64) });

test('Media17 strict prepare hash binds independent publication, source, hierarchy, ordinal and declaration', () => {
  const raw = input(),
    actor = randomUUID(),
    hash = majorDiscussionMediaRequestHash(actor, raw);
  assert.deepEqual(prepareMajorDiscussionMediaSchema.parse(raw), raw);
  for (const patch of [
    { clientRequestId: randomUUID() },
    { publicationRequestId: randomUUID() },
    { majorId: randomUUID() },
    { catalogRevision: randomUUID() },
    { majorRevision: randomUUID() },
    { rootId: randomUUID() },
    { rootId: randomUUID(), replyToReplyId: randomUUID() },
    { ordinal: 1 },
    { declaration: { ...raw.declaration, sha256: 'b'.repeat(64) } },
  ])
    assert.notEqual(
      majorDiscussionMediaRequestHash(actor, { ...raw, ...patch }),
      hash,
    );
  assert.notEqual(majorDiscussionMediaRequestHash(randomUUID(), raw), hash);
  for (const patch of [
    { protocol: 'private-message-media-v1' },
    { protocol: 'errand-media-v1' },
    { contextDigest: 'a'.repeat(64) },
    { audience: 'public' },
    { url: 'https://example.invalid/image' },
    { ordinal: -1 },
    { ordinal: 3 },
    { ordinal: 0.5 },
    { declaration: { ...raw.declaration, bytes: 5242881 } },
    { declaration: { ...raw.declaration, mime: 'image/gif' } },
  ])
    assert.equal(
      prepareMajorDiscussionMediaSchema.safeParse({ ...raw, ...patch }).success,
      false,
    );
  assert.equal(
    cancelMajorDiscussionMediaRequestSchema.safeParse({
      protocol: raw.protocol,
      requestHash: hash,
      majorId: raw.majorId,
      publicationRequestId: raw.publicationRequestId,
    }).success,
    true,
  );
});

test('Media17 ordered set accepts zero through three exact assets and refuses duplicates, URLs, extra fields and reordered ordinal bindings', () => {
  const images = Array.from({ length: 3 }, fact);
  for (let size = 0; size <= 3; size++)
    assert.equal(
      majorDiscussionMediaFactsSchema.safeParse(images.slice(0, size)).success,
      true,
    );
  for (const value of [
    [...images, fact()],
    [images[0], images[0]],
    '[]',
    'https://example.invalid',
    [{ ...images[0], ordinal: 0 }],
    [{ ...images[0], url: 'https://example.invalid' }],
  ])
    assert.equal(
      majorDiscussionMediaFactsSchema.safeParse(value).success,
      false,
    );
  const bindings = images.map((image, ordinal) => ({
    ...image,
    bindingId: randomUUID(),
    ordinal,
  }));
  assert.equal(
    majorDiscussionMediaBindingsSchema.safeParse(bindings).success,
    true,
  );
  assert.equal(
    majorDiscussionMediaBindingsSchema.safeParse([...bindings].reverse())
      .success,
    false,
  );
  assert.equal(
    majorDiscussionMediaBindingsSchema.safeParse([
      { ...bindings[0], ordinal: 1 },
    ]).success,
    false,
  );
});

test('Media17 descriptor exposes exact Major/comment/binding/ordinal and only derived variants', () => {
  const descriptor = {
    protocol: MAJOR_DISCUSSION_MEDIA_PROTOCOL,
    kind: 'major-discussion-media',
    majorId: randomUUID(),
    commentId: randomUUID(),
    bindingId: randomUUID(),
    ordinal: 2,
    width: 100,
    height: 100,
    variants: ['thumb-v1', 'display-v1'],
  };
  assert.equal(
    majorDiscussionDescriptorSchema.safeParse(descriptor).success,
    true,
  );
  for (const patch of [
    { url: 'https://example.invalid' },
    { original: 'object' },
    { assetId: randomUUID() },
    { kind: 'private-message-media' },
    { ordinal: 3 },
    { variants: ['original'] },
  ])
    assert.equal(
      majorDiscussionDescriptorSchema.safeParse({ ...descriptor, ...patch })
        .success,
      false,
    );
});

test('Media17 prepare capability is current-transaction branded and requires exact ordinal and owner namespace', async () => {
  const tx = {} as PoolClient,
    raw = input(),
    actor = randomUUID();
  startTransactionDeadlines(tx);
  const scopes = new MediaMajorDiscussionPrepareScopes({
    authorizePrepare: async () => ({
      actorAccountId: actor,
      serverScopeId: randomUUID(),
      scopeRevision: majorDiscussionMediaRequestHash(actor, raw),
      expiresAt: Date.now() + 60000,
      ownerKind: 'majors',
      resourceKind: 'major_discussion_image',
      targetKind: 'edit',
      contentVersion: 1,
      audience: 'content-gated',
      purpose: 'major-discussion-image',
      slot: 'images',
      ordinal: 0,
    }),
  });
  try {
    const capability = await scopes.authorizeMajorDiscussion(actor, raw, tx);
    assert.equal(
      scopes.require(capability, tx).scope.resourceKind,
      'major_discussion_image',
    );
    await assert.rejects(
      scopes.authorizeMajorDiscussion(actor, { ...raw, ordinal: 1 }, tx),
    );
    await assert.rejects(
      scopes.authorizeMajorDiscussion(
        actor,
        { ...raw, majorId: randomUUID() },
        tx,
      ),
    );
    clearTransactionDeadlines(tx);
    startTransactionDeadlines(tx);
    assert.throws(() => scopes.require(capability, tx));
  } finally {
    clearTransactionDeadlines(tx);
  }
});

test('Media17 read proof binds complete ordered owner set, exact reference, transaction and epoch', async () => {
  const tx = {} as PoolClient;
  startTransactionDeadlines(tx);
  const images = [0, 1].map((ordinal) => ({
    ...fact(),
    ordinal,
    bindingId: randomUUID(),
  }));
  const reference = {
    majorId: randomUUID(),
    commentId: randomUUID(),
    bindingId: images[1]!.bindingId,
    ordinal: 1,
  };
  const authority: MajorDiscussionReadAuthority = {
    reference,
    ...reference,
    accountId: randomUUID(),
    sessionId: randomUUID(),
    actorAccountId: randomUUID(),
    publicationRequestId: randomUUID(),
    contextDigest: 'a'.repeat(64),
    ownerRevision: 'current',
    images,
  };
  const registry = new MajorDiscussionOwnerProofRegistry({
    authorizeCurrent: async () => authority,
  });
  try {
    const proof = await registry.authorize(
      'current-session',
      { reference },
      tx,
    );
    assert.equal(registry.require(proof, { reference }, tx).images.length, 2);
    assert.throws(() =>
      registry.require({} as MajorDiscussionReadProof, { reference }, tx),
    );
    assert.throws(() =>
      registry.require(proof, { reference: { ...reference, ordinal: 0 } }, tx),
    );
    const truncated = new MajorDiscussionOwnerProofRegistry({
      authorizeCurrent: async () => ({ ...authority, images: [images[1]!] }),
    });
    await assert.rejects(
      truncated.authorize('current-session', { reference }, tx),
    );
    clearTransactionDeadlines(tx);
    startTransactionDeadlines(tx);
    assert.throws(() => registry.require(proof, { reference }, tx));
  } finally {
    clearTransactionDeadlines(tx);
  }
});

test('Media17 whole-set read checks all appearances and every Safety sibling before returning any descriptor', async () => {
  const images = [0, 1].map((ordinal) => ({
      ...fact(),
      ordinal,
      bindingId: randomUUID(),
    })),
    commentId = randomUUID(),
    majorId = randomUUID();
  const checked: string[] = [];
  let badSibling = true,
    extra = false;
  const tx = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('SELECT asset_id,manifest_digest'))
        return {
          rows: images.map((x) => ({
            asset_id: x.assetId,
            manifest_digest: x.manifestDigest,
            binding_id: x.bindingId,
            ordinal: x.ordinal,
          })),
        };
      if (sql.startsWith('SELECT b.id'))
        return { rows: [], rowCount: extra ? 3 : 2 };
      if (sql.startsWith('SELECT image_set'))
        return {
          rows: [
            {
              image_set: images.map(({ assetId, manifestDigest }) => ({
                assetId,
                manifestDigest,
              })),
            },
          ],
        };
      if (sql.startsWith('SELECT a.*,i.protocol_version')) {
        const image = images.find((x) => x.assetId === params?.[1])!;
        return {
          rows: [
            {
              id: image.assetId,
              manifest_digest: image.manifestDigest,
              protocol_version: 17,
              actor_id: randomUUID(),
              owner_kind: 'majors',
              resource_kind: 'major_discussion_image',
              target_kind: 'edit',
              content_version: '1',
              audience: 'content-gated',
              purpose: 'major-discussion-image',
              slot: 'images',
              ordinal: image.ordinal,
              major_id: majorId,
            },
          ],
        };
      }
      if (sql.startsWith('SELECT revision::text,event_id'))
        return { rows: [{ revision: '1', event_id: randomUUID() }] };
      if (sql.includes("current_setting('transaction_isolation')"))
        return { rows: [{ isolation: 'read committed', capacity: 32 }] };
      if (sql.includes('SELECT slot,version,epoch::text'))
        return {
          rows: Array.from({ length: 128 }, (_, slot) => ({
            slot,
            version: 1,
            epoch: '0',
          })),
        };
      throw new Error(sql);
    },
  } as unknown as PoolClient;
  class TestAssets extends MajorDiscussionMediaAssetRepository {
    protected override async lockIntents() {}
    protected override async current(row: AssetRow): Promise<MediaManifest> {
      checked.push(row.id);
      if (badSibling && row.ordinal === 1)
        throw new ApplicationError('MEDIA_NOT_READY');
      return {
        variants: [
          { name: 'thumb-v1', width: 10, height: 10 },
          { name: 'display-v1', width: 100, height: 100 },
        ],
      } as unknown as MediaManifest;
    }
  }
  const repository = new TestAssets(
    new MajorDiscussionOwnerProofRegistry({
      authorizeCurrent: async () => {
        throw new Error('not used');
      },
    }),
  );
  startTransactionDeadlines(tx);
  try {
    await assert.rejects(repository.currentFacts(commentId, images, tx));
    assert.deepEqual(
      checked,
      images.map((x) => x.assetId),
    );
    badSibling = false;
    const result = await repository.currentFacts(commentId, images, tx);
    assert.equal(result.images.length, 2);
    assert.deepEqual(
      result.images.map((x) => x.descriptor.ordinal),
      [0, 1],
    );
    await assert.rejects(repository.currentFacts(commentId, [images[0]!], tx));
    extra = true;
    await assert.rejects(repository.currentFacts(commentId, images, tx));
  } finally {
    clearTransactionDeadlines(tx);
  }
});

test('Media17 bound history beats expired upload TTL and session-only cancel never detaches or reauthorizes source', async () => {
  const { MajorDiscussionMediaRecoveryRepository } =
    await import('../src/media/major-discussion-recovery-repository.js');
  const actor = randomUUID(),
    intentId = randomUUID(),
    assetId = randomUUID(),
    bindingId = randomUUID(),
    requestId = randomUUID(),
    queries: string[] = [];
  let cancelled = false;
  const tx = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("current_setting('transaction_isolation')"))
        return { rows: [{ isolation: 'read committed', capacity: 32 }] };
      if (sql.includes('SELECT slot,version,epoch::text'))
        return {
          rows: Array.from({ length: 128 }, (_, slot) => ({
            slot,
            version: 1,
            epoch: '0',
          })),
        };
      if (sql.includes('clock_timestamp() now'))
        return { rows: [{ now: new Date() }] };
      if (sql.includes('FROM whaleu_media.upload_intents'))
        return {
          rows: [
            {
              id: intentId,
              client_request_id: requestId,
              request_hash: 'a'.repeat(64),
              state: 'ready',
              expires_at: new Date(1),
            },
          ],
        };
      if (sql.includes('SELECT 1 FROM whaleu_media.bindings'))
        return { rows: [{}], rowCount: 1 };
      if (sql.includes('SELECT b.* FROM whaleu_media.bindings'))
        return {
          rows: [{ id: bindingId, asset_id: assetId, detached_at: null }],
        };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  const recovery = new MajorDiscussionMediaRecoveryRepository(
    {
      cancel: async () => {
        cancelled = true;
      },
    } as unknown as import('../src/media/lifecycle-repository.js').MediaLifecycleRepository,
    {
      readyOwned: async () => {
        throw new Error('Bound receipt cannot require draft readiness');
      },
    },
  );
  try {
    const result = await recovery.cancel(actor, intentId, tx);
    assert.equal(result.status, 'bound_history');
    assert.equal(cancelled, false);
    assert.match(queries[0]!, /pg_advisory_xact_lock/);
    assert.ok(
      !queries.some(
        (sql) =>
          sql.includes('major_discussion_source') ||
          sql.includes('major_discussion_visibility'),
      ),
    );
  } finally {
    clearTransactionDeadlines(tx);
  }
});

test('Media17 original-key recovery rejects foreign namespaces before reading their status', async () => {
  const { MajorDiscussionMediaRecoveryRepository } =
    await import('../src/media/major-discussion-recovery-repository.js');
  const tx = {
    query: async (sql: string) => {
      if (sql.includes('clock_timestamp() now'))
        return { rows: [{ now: new Date() }] };
      if (sql.includes('upload_request_fences'))
        return {
          rows: [
            {
              protocol_namespace: 15,
              request_hash: 'a'.repeat(64),
              intent_id: randomUUID(),
              state: 'active',
            },
          ],
        };
      throw new Error('Foreign intent must not be read');
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  const recovery = new MajorDiscussionMediaRecoveryRepository(
    {} as import('../src/media/lifecycle-repository.js').MediaLifecycleRepository,
    {
      readyOwned: async () => {
        throw new Error('unused');
      },
    },
  );
  try {
    await assert.rejects(
      recovery.recover(randomUUID(), randomUUID(), tx),
      (error) =>
        error instanceof ApplicationError &&
        error.code === 'MEDIA_REQUEST_CONFLICT',
    );
  } finally {
    clearTransactionDeadlines(tx);
  }
});

test('Media17 cancel-before-prepare preserves original upload key without source access or minting a new key', async () => {
  const { MajorDiscussionMediaRecoveryRepository } =
    await import('../src/media/major-discussion-recovery-repository.js');
  const actor = randomUUID(),
    requestId = randomUUID(),
    raw = {
      protocol: MAJOR_DISCUSSION_MEDIA_PROTOCOL,
      requestHash: 'a'.repeat(64),
      majorId: randomUUID(),
      publicationRequestId: randomUUID(),
    };
  let fence: null | {
      protocol_namespace: number;
      request_hash: string;
      intent_id: null;
      state: string;
    } = null,
    scope: null | { major_id: string; publication_request_id: string } = null,
    inserts = 0;
  const queries: string[] = [];
  const tx = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push(sql);
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes("current_setting('transaction_isolation')"))
        return { rows: [{ isolation: 'read committed', capacity: 32 }] };
      if (sql.includes('SELECT slot,version,epoch::text'))
        return {
          rows: Array.from({ length: 128 }, (_, slot) => ({
            slot,
            version: 1,
            epoch: '0',
          })),
        };
      if (sql.includes('clock_timestamp() now'))
        return { rows: [{ now: new Date() }] };
      if (sql.startsWith('SELECT * FROM whaleu_media.upload_request_fences'))
        return { rows: fence ? [fence] : [] };
      if (sql.startsWith('SELECT major_id,publication_request_id'))
        return { rows: scope ? [scope] : [] };
      if (sql.startsWith('SELECT 1 FROM whaleu_media.upload_intents'))
        return { rows: [], rowCount: 0 };
      if (
        sql.startsWith(
          'INSERT INTO whaleu_media.major_discussion_cancel_scopes',
        )
      ) {
        scope = {
          major_id: params![3] as string,
          publication_request_id: params![4] as string,
        };
        inserts++;
        return { rows: [] };
      }
      if (sql.includes('SELECT to_regclass'))
        return { rows: [{ present: false }] };
      if (sql.includes('WITH quota_clock'))
        return {
          rows: [
            {
              daily: 0,
              recent: 0,
              minute_wait_seconds: 1,
              daily_wait_seconds: 1,
            },
          ],
        };
      if (sql.startsWith('INSERT INTO whaleu_media.upload_request_fences')) {
        fence = {
          protocol_namespace: 17,
          request_hash: params![2] as string,
          intent_id: null,
          state: 'cancelled_before_prepare',
        };
        inserts++;
        return { rows: [] };
      }
      throw new Error(sql);
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  const recovery = new MajorDiscussionMediaRecoveryRepository(
    {} as import('../src/media/lifecycle-repository.js').MediaLifecycleRepository,
    {
      readyOwned: async () => {
        throw new Error('Cancellation has no image authority');
      },
    },
  );
  try {
    assert.equal(
      (await recovery.cancelRequest(actor, requestId, raw, tx)).state,
      'cancelled_before_prepare',
    );
    assert.equal(
      (await recovery.cancelRequest(actor, requestId, raw, tx)).state,
      'cancelled_before_prepare',
    );
    assert.equal(inserts, 2);
    await assert.rejects(
      recovery.cancelRequest(
        actor,
        requestId,
        { ...raw, requestHash: 'b'.repeat(64) },
        tx,
      ),
    );
    await assert.rejects(
      recovery.cancelRequest(
        actor,
        requestId,
        { ...raw, majorId: randomUUID() },
        tx,
      ),
    );
    assert.ok(
      !queries.some(
        (sql) =>
          sql.includes('major_discussion_source') ||
          sql.includes('major_discussion_visibility'),
      ),
    );
  } finally {
    clearTransactionDeadlines(tx);
  }
});
