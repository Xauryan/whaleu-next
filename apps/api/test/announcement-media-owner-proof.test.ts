import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { PoolClient } from 'pg';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { AnnouncementOwnerProofRegistry } from '../src/media/announcement-owner-proof.js';
import type {
  AnnouncementReadRequest,
  AnnouncementReadAuthority,
  AnnouncementReadProof,
} from '../src/media/announcement-owner-proof.js';
import { MediaAnnouncementPrepareScopes } from '../src/media/announcement-prepare-scope.js';
import {
  ANNOUNCEMENT_MEDIA_PROTOCOL,
  announcementMediaRequestHash,
} from '../src/media/contracts-announcement.js';
test('Announcement image exact proof rejects invalid credentials and foreign owner slots before invoking owner', async () => {
  const tx = {} as PoolClient;
  startTransactionDeadlines(tx);
  const request: AnnouncementReadRequest = {
    reference: {
      announcementId: randomUUID(),
      slot: 'gallery0',
      revision: 1,
      bindingId: randomUUID(),
    },
    audience: 'public',
    campusId: null,
    requestId: randomUUID(),
  };
  const value: AnnouncementReadAuthority = {
    principal: {
      kind: 'announcement-public',
      campusId: null,
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
  let calls = 0;
  const registry = new AnnouncementOwnerProofRegistry({
    authorizeCurrent: async (token) => {
      calls++;
      if (token !== 'session') throw new Error('Invalid presented session');
      return value;
    },
  });
  try {
    const proof = await registry.authorize('session', request, tx);
    assert.equal(
      registry.require(proof, request, tx).principal.accountId,
      value.principal.accountId,
    );
    assert.throws(() =>
      registry.require({} as AnnouncementReadProof, request, tx),
    );
    for (const patch of [
      { announcementId: randomUUID() },
      { slot: 'gallery1' as const },
      { revision: 2 },
      { bindingId: randomUUID() },
    ])
      assert.throws(() =>
        registry.require(
          proof,
          { ...request, reference: { ...request.reference, ...patch } },
          tx,
        ),
      );
    const before = calls;
    await assert.rejects(registry.authorize('', request, tx));
    await assert.rejects(
      registry.authorize(
        'session',
        {
          ...request,
          reference: {
            ...request.reference,
            slot: 'managerContact' as AnnouncementReadRequest['reference']['slot'],
          },
        },
        tx,
      ),
    );
    assert.equal(calls, before);
    await assert.rejects(registry.authorize('invalid-token', request, tx));
    clearTransactionDeadlines(tx);
    startTransactionDeadlines(tx);
    assert.throws(() => registry.require(proof, request, tx));
  } finally {
    clearTransactionDeadlines(tx);
  }
});
test('Announcement management draft proof cannot be reused for public publication', async () => {
  const tx = {} as PoolClient;
  startTransactionDeadlines(tx);
  const request: AnnouncementReadRequest = {
    reference: {
      announcementId: randomUUID(),
      slot: 'gallery8',
      revision: 2,
      bindingId: randomUUID(),
    },
    audience: 'management',
    campusId: null,
    requestId: randomUUID(),
  };
  const registry = new AnnouncementOwnerProofRegistry({
    authorizeCurrent: async () => ({
      principal: {
        kind: 'authenticated-announcement-management',
        accountId: randomUUID(),
        sessionId: randomUUID(),
      },
      reference: request.reference,
      appearanceId: randomUUID(),
      assetId: randomUUID(),
      manifestDigest: 'a'.repeat(64),
      ownerRevision: 'b'.repeat(64),
    }),
  });
  try {
    const proof = await registry.authorize('session', request, tx);
    assert.throws(() =>
      registry.require(proof, { ...request, audience: 'public' }, tx),
    );
  } finally {
    clearTransactionDeadlines(tx);
  }
});
test('Announcement preparation scope cannot substitute another owner, revision or slot', async () => {
  const tx = {} as PoolClient;
  startTransactionDeadlines(tx);
  const actor = randomUUID(),
    input = {
      protocol: ANNOUNCEMENT_MEDIA_PROTOCOL,
      clientRequestId: randomUUID(),
      announcementId: randomUUID(),
      slot: 'gallery8' as const,
      revision: 4,
      declaration: {
        mime: 'image/png' as const,
        bytes: 32,
        sha256: 'a'.repeat(64),
      },
    };
  const scope = {
    actorAccountId: actor,
    serverScopeId: randomUUID(),
    scopeRevision: announcementMediaRequestHash(actor, input),
    expiresAt: Date.now() + 60_000,
    ownerKind: 'announcements' as const,
    resourceKind: 'announcement_image' as const,
    targetKind: 'edit' as const,
    contentVersion: 1 as const,
    audience: 'announcement-gated' as const,
    purpose: 'announcement-image' as const,
    slot: input.slot,
    ordinal: 0 as const,
  };
  const issuer = new MediaAnnouncementPrepareScopes({
    authorizePrepare: async () => scope,
  });
  try {
    const proof = await issuer.authorizeAnnouncement(actor, input, tx);
    assert.equal(issuer.require(proof, tx).scope.ownerKind, 'announcements');
    await assert.rejects(
      issuer.authorizeAnnouncement(actor, { ...input, slot: 'gallery0' }, tx),
    );
    await assert.rejects(
      issuer.authorizeAnnouncement(actor, { ...input, revision: 5 }, tx),
    );
    await assert.rejects(issuer.authorizeSchoolQr(actor, input, tx));
    clearTransactionDeadlines(tx);
    startTransactionDeadlines(tx);
    assert.throws(() => issuer.require(proof, tx));
  } finally {
    clearTransactionDeadlines(tx);
  }
});

test('Announcement public guest is distinct from presented bearer and exact campus/principal/session proof', async () => {
  const tx = {} as PoolClient;
  startTransactionDeadlines(tx);
  const request: AnnouncementReadRequest = {
    reference: {
      announcementId: randomUUID(),
      revision: 1,
      slot: 'gallery8',
      bindingId: randomUUID(),
    },
    audience: 'public',
    campusId: randomUUID(),
    requestId: randomUUID(),
  };
  const value: AnnouncementReadAuthority = {
    principal: {
      kind: 'announcement-public',
      campusId: request.campusId,
      requestId: request.requestId,
      accountId: null,
      sessionId: null,
    },
    reference: request.reference,
    appearanceId: randomUUID(),
    assetId: randomUUID(),
    manifestDigest: 'a'.repeat(64),
    ownerRevision: 'b'.repeat(64),
  };
  const registry = new AnnouncementOwnerProofRegistry({
    authorizeCurrent: async () => value,
  });
  try {
    const proof = await registry.authorize(null, request, tx);
    assert.equal(
      registry.require(proof, request, tx).principal.accountId,
      null,
    );
    await assert.rejects(
      registry.authorize('presented-bad-bearer', request, tx),
    );
    await assert.rejects(
      registry.authorize(null, { ...request, audience: 'management' }, tx),
    );
    assert.throws(() =>
      registry.require(proof, { ...request, campusId: randomUUID() }, tx),
    );
    assert.throws(() =>
      registry.require(proof, { ...request, requestId: randomUUID() }, tx),
    );
  } finally {
    clearTransactionDeadlines(tx);
  }
});
