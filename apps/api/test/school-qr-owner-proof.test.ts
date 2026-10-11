import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { PoolClient } from 'pg';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { SchoolQrOwnerProofRegistry } from '../src/media/school-qr-owner-proof.js';
import type {
  SchoolQrReadRequest,
  SchoolQrReadAuthority,
  SchoolQrReadProof,
} from '../src/media/school-qr-owner-proof.js';
test('School public QR has a distinct campus principal, transaction proof, exact revision and permanent review exclusion', async () => {
  const tx = {} as PoolClient,
    campusId = randomUUID();
  startTransactionDeadlines(tx);
  const request: SchoolQrReadRequest = {
    reference: {
      regionId: randomUUID(),
      entryKey: 'treehole',
      entryRevision: 1,
      bindingId: randomUUID(),
    },
    audience: 'public',
    campusId,
    requestId: randomUUID(),
  };
  let calls = 0;
  const value: SchoolQrReadAuthority = {
    principal: {
      kind: 'school-public',
      campusId,
      requestId: request.requestId,
      accountId: null,
    },
    reference: request.reference,
    appearanceId: randomUUID(),
    assetId: randomUUID(),
    manifestDigest: 'a'.repeat(64),
    ownerRevision: 'b'.repeat(64),
  };
  const registry = new SchoolQrOwnerProofRegistry({
    authorizeCurrent: async (token) => {
      calls++;
      if (token !== null) throw new Error('Invalid presented session');
      return value;
    },
  });
  try {
    const proof = await registry.authorize(null, request, tx);
    assert.equal(
      registry.require(proof, request, tx).principal.kind,
      'school-public',
    );
    assert.equal(calls, 1);
    assert.throws(() => registry.require({} as SchoolQrReadProof, request, tx));
    assert.throws(() =>
      registry.require(
        proof,
        { ...request, reference: { ...request.reference, entryRevision: 2 } },
        tx,
      ),
    );
    await assert.rejects(registry.authorize('', request, tx));
    await assert.rejects(registry.authorize('invalid-token', request, tx));
    const before = calls;
    await assert.rejects(
      registry.authorize(
        null,
        { ...request, reference: { ...request.reference, entryKey: 'review' } },
        tx,
      ),
    );
    assert.equal(calls, before);
    await assert.rejects(
      registry.authorize(
        null,
        { ...request, audience: 'management', campusId: null },
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

test('School media proof cannot accept a public-only principal for authenticated management', async () => {
  const tx = {} as PoolClient;
  startTransactionDeadlines(tx);
  const request: SchoolQrReadRequest = {
    reference: {
      regionId: randomUUID(),
      entryKey: 'review',
      entryRevision: 1,
      bindingId: randomUUID(),
    },
    audience: 'management',
    campusId: null,
    requestId: randomUUID(),
  };
  const registry = new SchoolQrOwnerProofRegistry({
    authorizeCurrent: async () => ({
      principal: {
        kind: 'school-public',
        campusId: randomUUID(),
        requestId: request.requestId,
        accountId: randomUUID(),
      },
      reference: request.reference,
      appearanceId: randomUUID(),
      assetId: randomUUID(),
      manifestDigest: 'a'.repeat(64),
      ownerRevision: 'b'.repeat(64),
    }),
  });
  try {
    await assert.rejects(registry.authorize('presented-session', request, tx));
  } finally {
    clearTransactionDeadlines(tx);
  }
});

test('Errand target QR has exact order principal and cannot borrow campus or management authority', async () => {
  const tx = {} as PoolClient;
  startTransactionDeadlines(tx);
  const request: SchoolQrReadRequest = {
    reference: {
      regionId: randomUUID(),
      entryKey: 'errand',
      entryRevision: 2,
      bindingId: randomUUID(),
    },
    audience: 'errand-order',
    campusId: null,
    orderId: randomUUID(),
    requestId: randomUUID(),
  };
  const value: SchoolQrReadAuthority = {
    principal: {
      kind: 'authenticated-errand-target',
      orderId: request.orderId!,
      requestId: request.requestId,
      accountId: randomUUID(),
      sessionId: randomUUID(),
    },
    reference: request.reference,
    appearanceId: randomUUID(),
    assetId: randomUUID(),
    manifestDigest: 'a'.repeat(64),
    ownerRevision: 'b'.repeat(64),
  };
  const registry = new SchoolQrOwnerProofRegistry({
    authorizeCurrent: async () => value,
  });
  try {
    const proof = await registry.authorize('session', request, tx);
    assert.equal(
      registry.require(proof, request, tx).principal.kind,
      'authenticated-errand-target',
    );
    for (const bad of [
      { ...request, audience: 'public' as const, campusId: randomUUID() },
      { ...request, audience: 'management' as const },
      { ...request, orderId: randomUUID() },
      { ...request, campusId: randomUUID() },
      {
        ...request,
        reference: { ...request.reference, entryKey: 'review' as const },
      },
    ])
      await assert.rejects(registry.authorize('session', bad, tx));
    await assert.rejects(registry.authorize(null, request, tx));
    assert.throws(() =>
      registry.require(proof, { ...request, orderId: randomUUID() }, tx),
    );
  } finally {
    clearTransactionDeadlines(tx);
  }
});
