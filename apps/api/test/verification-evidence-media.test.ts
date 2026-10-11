import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { PoolClient } from 'pg';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
  checkTransactionDeadlines,
  registerTransactionDeadline,
} from '../src/database/transaction-deadlines.js';
import { VerificationEvidenceOwnerProofRegistry } from '../src/media/verification-evidence-owner-proof.js';
import type {
  VerificationEvidenceReadRequest,
  VerificationEvidenceReadProof,
} from '../src/media/verification-evidence-owner-proof.js';
import { MediaVerificationEvidencePrepareScopes } from '../src/media/verification-evidence-prepare-scope.js';
import {
  VERIFICATION_EVIDENCE_MEDIA_PROTOCOL,
  prepareVerificationEvidenceMediaSchema,
  verificationEvidenceMediaRequestHash,
  verificationEvidenceDescriptorSchema,
  verificationEvidenceUploadDescriptorSchema,
} from '../src/media/contracts-verification-evidence.js';
import { verificationEvidenceRetention } from '../src/verification/evidence/facade.js';
import { ExactMediaDeliveryService } from '../src/media/delivery.js';
import { MediaDeliveryBudgetPool } from '../src/media/delivery-budget.js';
import type { ImmutableMediaStorage } from '../src/media/storage-port.js';
const input = () => ({
  protocol: VERIFICATION_EVIDENCE_MEDIA_PROTOCOL,
  clientRequestId: randomUUID(),
  applicationId: randomUUID(),
  revision: 1,
  declaration: {
    mime: 'image/png' as const,
    bytes: 100,
    sha256: 'a'.repeat(64),
  },
});
test('private evidence contracts reject arbitrary locators and foreign owner descriptors', () => {
  const raw = input();
  assert.deepEqual(prepareVerificationEvidenceMediaSchema.parse(raw), raw);
  for (const key of [
    'imageUrl',
    'url',
    'bucket',
    'object',
    'signedUrl',
    'slot',
  ])
    assert.equal(
      prepareVerificationEvidenceMediaSchema.safeParse({
        ...raw,
        [key]: 'synthetic',
      }).success,
      false,
    );
  const upload = {
    protocol: VERIFICATION_EVIDENCE_MEDIA_PROTOCOL,
    kind: 'verification-evidence-upload',
    assetId: randomUUID(),
  };
  assert.equal(
    verificationEvidenceUploadDescriptorSchema.safeParse(upload).success,
    true,
  );
  assert.equal(
    verificationEvidenceUploadDescriptorSchema.safeParse({
      ...upload,
      kind: 'announcement-media',
    }).success,
    false,
  );
  assert.equal(
    verificationEvidenceUploadDescriptorSchema.safeParse({
      ...upload,
      imageUrl: 'https://example.invalid',
    }).success,
    false,
  );
  assert.equal(
    verificationEvidenceDescriptorSchema.safeParse({
      ...upload,
      kind: 'verification-evidence',
    }).success,
    false,
  );
});
test('original request hash binds account application revision and exact byte declaration', () => {
  const raw = input(),
    actor = randomUUID(),
    hash = verificationEvidenceMediaRequestHash(actor, raw);
  for (const changed of [
    { ...raw, applicationId: randomUUID() },
    { ...raw, revision: 2 },
    { ...raw, clientRequestId: randomUUID() },
    { ...raw, declaration: { ...raw.declaration, sha256: 'b'.repeat(64) } },
  ])
    assert.notEqual(verificationEvidenceMediaRequestHash(actor, changed), hash);
  assert.notEqual(
    verificationEvidenceMediaRequestHash(randomUUID(), raw),
    hash,
  );
});
test('evidence policy requires explicit finite retention and an immutable policy reference', () => {
  assert.throws(() => verificationEvidenceRetention(undefined as never));
  for (const evidenceTtlSeconds of [0, -1, Infinity, 1.5, 31_536_001])
    assert.throws(() =>
      verificationEvidenceRetention({
        policyRef: 'synthetic',
        evidenceTtlSeconds,
        cleanupEnabled: true,
      }),
    );
  const policy = verificationEvidenceRetention({
    policyRef: 'synthetic-v1',
    evidenceTtlSeconds: 3600,
    cleanupEnabled: false,
  });
  assert.equal(Object.isFrozen(policy), true);
});
test('only exact private owner scope can mint a transaction-local upload capability', async () => {
  const tx = {} as PoolClient;
  startTransactionDeadlines(tx);
  const raw = input(),
    actor = randomUUID();
  let wrong = false;
  const scopes = new MediaVerificationEvidencePrepareScopes({
    authorizePrepare: async () => ({
      actorAccountId: actor,
      serverScopeId: randomUUID(),
      scopeRevision: verificationEvidenceMediaRequestHash(actor, raw),
      expiresAt: Date.now() + 60_000,
      ownerKind: wrong ? ('announcements' as never) : 'verification',
      resourceKind: 'student_evidence',
      targetKind: 'edit',
      contentVersion: 1,
      audience: 'verification-private',
      purpose: 'verification-evidence-image',
      slot: 'evidence',
      ordinal: 0,
    }),
  });
  try {
    const proof = await scopes.authorizeVerificationEvidence(actor, raw, tx);
    assert.equal(scopes.require(proof, tx).scope.ownerKind, 'verification');
    wrong = true;
    await assert.rejects(scopes.authorizeVerificationEvidence(actor, raw, tx));
    clearTransactionDeadlines(tx);
    startTransactionDeadlines(tx);
    assert.throws(() => scopes.require(proof, tx));
  } finally {
    clearTransactionDeadlines(tx);
  }
});
test('private read proof requires session and exact request/region/transaction identity', async () => {
  const tx = {} as PoolClient;
  startTransactionDeadlines(tx);
  const request: VerificationEvidenceReadRequest = {
    reference: {
      applicationId: randomUUID(),
      revision: 1,
      bindingId: randomUUID(),
    },
    requestId: randomUUID(),
    reviewRegionId: null,
  };
  let calls = 0;
  const registry = new VerificationEvidenceOwnerProofRegistry({
    authorizeCurrent: async () => {
      calls++;
      return {
        principal: { accountId: randomUUID(), sessionId: randomUUID() },
        actorAccountId: randomUUID(),
        reference: request.reference,
        assetId: randomUUID(),
        manifestDigest: 'a'.repeat(64),
        ownerRevision: 'b'.repeat(64),
        expiresAt: Date.now() + 60_000,
        policyRef: 'synthetic-v1',
      };
    },
  });
  try {
    await assert.rejects(registry.authorize('', request, tx));
    assert.equal(calls, 0);
    const proof = await registry.authorize('synthetic-session', request, tx);
    registry.require(proof, request, tx);
    assert.throws(() =>
      registry.require({} as VerificationEvidenceReadProof, request, tx),
    );
    assert.throws(() =>
      registry.require(proof, { ...request, reviewRegionId: randomUUID() }, tx),
    );
    assert.throws(() =>
      registry.require(
        proof,
        { ...request, reference: { ...request.reference, revision: 2 } },
        tx,
      ),
    );
    clearTransactionDeadlines(tx);
    startTransactionDeadlines(tx);
    assert.throws(() => registry.require(proof, request, tx));
  } finally {
    clearTransactionDeadlines(tx);
  }
});
for (const mutation of [
  'session',
  'account',
  'campus',
  'grant',
  'safety',
  'application',
  'deadline',
] as const)
  test(`private byte delivery emits zero bytes after storage-open ${mutation} change`, async () => {
    const bytes = Buffer.from('synthetic private delivery bytes');
    let consumed = 0,
      calls = 0;
    const tx = {
      query: async (sql: string) => ({
        rows: sql.includes('clock_timestamp') ? [{ now: new Date(1000) }] : [],
        rowCount: 0,
      }),
    } as unknown as PoolClient;
    const storage: ImmutableMediaStorage = {
      provider: 'synthetic',
      environment: 'test',
      seal: async () => {
        throw Error('unused');
      },
      deleteExact: async () => 'confirmed-absent',
      openExact: async () => ({
        bytes: bytes.length,
        stream: new Readable({
          read() {
            consumed++;
            this.push(bytes);
            this.push(null);
          },
        }),
      }),
    };
    const service = new ExactMediaDeliveryService(
      {
        transaction: async (work) => {
          startTransactionDeadlines(tx);
          try {
            const value = await work(tx);
            await checkTransactionDeadlines(tx);
            return value;
          } finally {
            clearTransactionDeadlines(tx);
          }
        },
      },
      storage,
      new MediaDeliveryBudgetPool(),
    );
    const plan = {
      object: {
        provider: 'synthetic',
        environment: 'test',
        bucket: 'synthetic',
        key: randomUUID(),
        version: randomUUID(),
      },
      sha256: createHash('sha256').update(bytes).digest('hex'),
      attachmentSetRevision: 'a'.repeat(64),
      bytes: bytes.length,
      mime: 'image/png' as const,
    };
    await assert.rejects(
      service.open(
        async (client) => {
          calls++;
          if (calls === 2) {
            if (mutation === 'deadline')
              registerTransactionDeadline(client, 1000, 'MEDIA_UNAVAILABLE');
            else return { ...plan, attachmentSetRevision: 'b'.repeat(64) };
          }
          return plan;
        },
        () => 'account:synthetic',
      ),
    );
    assert.equal(calls, 2);
    assert.equal(consumed, 0);
  });
test('private byte transport rejects Range before provider effects', async () => {
  let calls = 0;
  const service = new ExactMediaDeliveryService(
    {
      transaction: async () => {
        calls++;
        throw Error('unexpected');
      },
    },
    { provider: 'synthetic', environment: 'test' } as ImmutableMediaStorage,
    new MediaDeliveryBudgetPool(),
  );
  await assert.rejects(
    service.open(
      async () => {
        throw Error('unexpected');
      },
      () => 'synthetic',
      'bytes=0-1',
    ),
  );
  assert.equal(calls, 0);
});
