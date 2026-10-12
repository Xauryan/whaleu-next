import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { PoolClient } from 'pg';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import {
  PRIVATE_MESSAGE_MEDIA_PROTOCOL,
  preparePrivateMessageMediaSchema,
  privateMessageMediaRequestHash,
  privateMessageDescriptorSchema,
  privateMessageMediaFactSchema,
  cancelPrivateMessageMediaRequestSchema,
} from '../src/media/contracts-private-message.js';
import { MediaPrivateMessagePrepareScopes } from '../src/media/private-message-prepare-scope.js';
import { PrivateMessageOwnerProofRegistry } from '../src/media/private-message-owner-proof.js';
import type {
  PrivateMessageReadAuthority,
  PrivateMessageReadProof,
} from '../src/media/private-message-owner-proof.js';
import { PrivateMessageMediaRecoveryRepository } from '../src/media/private-message-recovery-repository.js';
import type { MediaLifecycleRepository } from '../src/media/lifecycle-repository.js';
import { PrivateMessageMediaAssetRepository } from '../src/media/private-message-asset-repository.js';
import type { AssetRow } from '../src/media/asset-repository.js';
import type { MediaManifest } from '../src/media/contracts.js';
const proofRows = (sql: string) =>
  sql.includes("current_setting('transaction_isolation')")
    ? { rows: [{ isolation: 'read committed', capacity: 32 }] }
    : sql.includes('SELECT slot,version,epoch::text')
      ? {
          rows: Array.from({ length: 128 }, (_, slot) => ({
            slot,
            version: 1,
            epoch: '0',
          })),
        }
      : null;
const input = () => ({
  protocol: PRIVATE_MESSAGE_MEDIA_PROTOCOL,
  clientRequestId: randomUUID(),
  conversationId: randomUUID(),
  messageRequestId: randomUUID(),
  declaration: {
    mime: 'image/png' as const,
    bytes: 100,
    sha256: 'a'.repeat(64),
  },
});
test('Media15 prepare hash binds original image command, conversation, actor and exact file; one static image only', () => {
  const raw = input(),
    actor = randomUUID(),
    hash = privateMessageMediaRequestHash(actor, raw);
  assert.deepEqual(preparePrivateMessageMediaSchema.parse(raw), raw);
  for (const patch of [
    { conversationId: randomUUID() },
    { messageRequestId: randomUUID() },
    { clientRequestId: randomUUID() },
    { declaration: { ...raw.declaration, sha256: 'b'.repeat(64) } },
  ])
    assert.notEqual(
      privateMessageMediaRequestHash(actor, { ...raw, ...patch }),
      hash,
    );
  assert.notEqual(privateMessageMediaRequestHash(randomUUID(), raw), hash);
  for (const patch of [
    { contextDigest: 'a'.repeat(64) },
    { audience: 'public' },
    { url: 'https://example.invalid' },
    { bindingId: randomUUID() },
    { declaration: { ...raw.declaration, bytes: 5242881 } },
    { declaration: { ...raw.declaration, mime: 'image/gif' } },
  ])
    assert.equal(
      preparePrivateMessageMediaSchema.safeParse({ ...raw, ...patch }).success,
      false,
    );
  const fact = { assetId: randomUUID(), manifestDigest: 'a'.repeat(64) };
  assert.equal(privateMessageMediaFactSchema.safeParse(fact).success, true);
  assert.equal(privateMessageMediaFactSchema.safeParse([fact]).success, false);
  assert.equal(
    privateMessageMediaFactSchema.safeParse({
      ...fact,
      url: 'https://example.invalid',
    }).success,
    false,
  );
  assert.equal(
    cancelPrivateMessageMediaRequestSchema.safeParse({
      protocol: raw.protocol,
      requestHash: hash,
      conversationId: raw.conversationId,
      messageRequestId: raw.messageRequestId,
    }).success,
    true,
  );
  assert.equal(
    cancelPrivateMessageMediaRequestSchema.safeParse({
      protocol: raw.protocol,
      requestHash: hash,
    }).success,
    false,
  );
});
test('Private descriptor contains exact message/binding routing and transformed variants, never storage or original', () => {
  const d = {
    protocol: PRIVATE_MESSAGE_MEDIA_PROTOCOL,
    kind: 'private-message-media',
    conversationId: randomUUID(),
    messageId: randomUUID(),
    bindingId: randomUUID(),
    width: 100,
    height: 100,
    variants: ['thumb-v1', 'display-v1'],
  };
  assert.equal(privateMessageDescriptorSchema.safeParse(d).success, true);
  for (const patch of [
    { url: 'https://example.invalid' },
    { original: 'object' },
    { assetId: randomUUID() },
    { variants: ['original'] },
    { kind: 'authenticated-media' },
  ])
    assert.equal(
      privateMessageDescriptorSchema.safeParse({ ...d, ...patch }).success,
      false,
    );
});
test('Media15 scope is current-transaction branded and cannot substitute command or conversation', async () => {
  const tx = {} as PoolClient;
  startTransactionDeadlines(tx);
  const raw = input(),
    actor = randomUUID();
  const scopes = new MediaPrivateMessagePrepareScopes({
    authorizePrepare: async () => ({
      actorAccountId: actor,
      serverScopeId: randomUUID(),
      scopeRevision: privateMessageMediaRequestHash(actor, raw),
      expiresAt: Date.now() + 60000,
      ownerKind: 'messaging',
      resourceKind: 'private_message_image',
      targetKind: 'edit',
      contentVersion: 1,
      audience: 'conversation-private',
      purpose: 'private-message-image',
      slot: 'image',
      ordinal: 0,
    }),
  });
  try {
    const proof = await scopes.authorizePrivateMessage(actor, raw, tx);
    assert.equal(
      scopes.require(proof, tx).scope.audience,
      'conversation-private',
    );
    for (const patch of [
      { conversationId: randomUUID() },
      { messageRequestId: randomUUID() },
    ])
      await assert.rejects(
        scopes.authorizePrivateMessage(actor, { ...raw, ...patch }, tx),
      );
    clearTransactionDeadlines(tx);
    startTransactionDeadlines(tx);
    assert.throws(() => scopes.require(proof, tx));
  } finally {
    clearTransactionDeadlines(tx);
  }
});
test('Exact private read capability binds current session and message identity and cannot be forged or reused', async () => {
  const tx = {} as PoolClient;
  startTransactionDeadlines(tx);
  const reference = {
    conversationId: randomUUID(),
    messageId: randomUUID(),
    bindingId: randomUUID(),
  };
  const value: PrivateMessageReadAuthority = {
    reference,
    ...reference,
    accountId: randomUUID(),
    sessionId: randomUUID(),
    actorAccountId: randomUUID(),
    messageRequestId: randomUUID(),
    contextDigest: 'a'.repeat(64),
    ownerRevision: 'current',
    image: {
      assetId: randomUUID(),
      manifestDigest: 'b'.repeat(64),
      bindingId: reference.bindingId,
    },
  };
  const registry = new PrivateMessageOwnerProofRegistry({
    authorizeCurrent: async (token) => {
      if (token !== 'valid') throw new Error('No current session');
      return value;
    },
  });
  try {
    const proof = await registry.authorize('valid', { reference }, tx);
    assert.equal(
      registry.require(proof, { reference }, tx).sessionId,
      value.sessionId,
    );
    assert.throws(() =>
      registry.require({} as PrivateMessageReadProof, { reference }, tx),
    );
    for (const patch of [
      { conversationId: randomUUID() },
      { messageId: randomUUID() },
      { bindingId: randomUUID() },
    ])
      assert.throws(() =>
        registry.require(proof, { reference: { ...reference, ...patch } }, tx),
      );
    await assert.rejects(registry.authorize('', { reference }, tx));
    await assert.rejects(registry.authorize('invalid', { reference }, tx));
    clearTransactionDeadlines(tx);
    startTransactionDeadlines(tx);
    assert.throws(() => registry.require(proof, { reference }, tx));
  } finally {
    clearTransactionDeadlines(tx);
  }
});
test('Bound history receipt wins over expired upload deadline and cancellation never fences or cancels a committed message', async () => {
  const intentId = randomUUID(),
    actor = randomUUID(),
    requestId = randomUUID(),
    assetId = randomUUID(),
    bindingId = randomUUID();
  let cancelled = false,
    fenced = false;
  const tx = {
    query: async (sql: string) => {
      const proof = proofRows(sql);
      if (proof) return proof;
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
  const recovery = new PrivateMessageMediaRecoveryRepository(
    {
      cancel: async () => {
        cancelled = true;
      },
    } as unknown as MediaLifecycleRepository,
    {
      readyOwned: async () => {
        throw new Error('Bound receipt must not reauthorize draft');
      },
    },
    async () => {
      fenced = true;
    },
  );
  try {
    const result = await recovery.cancel(actor, intentId, tx);
    assert.equal(result.status, 'bound_history');
    assert.equal(cancelled, false);
    assert.equal(fenced, false);
  } finally {
    clearTransactionDeadlines(tx);
  }
});
class TestAssets extends PrivateMessageMediaAssetRepository {
  denied = false;
  protected override async lockIntents() {}
  protected override async current(_row: AssetRow): Promise<MediaManifest> {
    if (this.denied) throw new Error('MediaSafety unavailable');
    return {
      variants: [
        { width: 50, height: 50 },
        { width: 100, height: 100 },
      ],
    } as MediaManifest;
  }
}
test('Retained binding has no upload-expiry read check but still requires exact current MediaSafety', async () => {
  const image = {
      assetId: randomUUID(),
      manifestDigest: 'a'.repeat(64),
      bindingId: randomUUID(),
    },
    messageId = randomUUID(),
    conversationId = randomUUID();
  const queries: string[] = [];
  const tx = {
    query: async (sql: string) => {
      queries.push(sql);
      const proof = proofRows(sql);
      if (proof) return proof;
      if (sql.includes('SELECT a.*,i.protocol_version'))
        return {
          rows: [
            {
              id: image.assetId,
              intent_id: randomUUID(),
              protocol_version: 15,
              conversation_id: conversationId,
              owner_kind: 'messaging',
              resource_kind: 'private_message_image',
              target_kind: 'edit',
              content_version: '1',
              audience: 'conversation-private',
              purpose: 'private-message-image',
              slot: 'image',
              ordinal: 0,
            },
          ],
        };
      if (sql.includes('SELECT revision::text,event_id'))
        return { rows: [{ revision: '1', event_id: randomUUID() }] };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  const assets = new TestAssets(
    new PrivateMessageOwnerProofRegistry({
      authorizeCurrent: async () => {
        throw new Error('not used');
      },
    }),
  );
  try {
    const facts = await assets.currentFacts(messageId, image, tx);
    assert.equal(facts.image.descriptor.messageId, messageId);
    assert.equal(facts.image.descriptor.conversationId, conversationId);
    assert.equal(
      queries.some((x) => x.includes('expires_at')),
      false,
    );
    assets.denied = true;
    await assert.rejects(assets.currentFacts(messageId, image, tx));
  } finally {
    clearTransactionDeadlines(tx);
  }
});
