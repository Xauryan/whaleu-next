import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { PoolClient } from 'pg';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { ActivityOwnerProofRegistry } from '../src/media/activity-owner-proof.js';
import type {
  ActivityReadRequest,
  ActivityReadAuthority,
  ActivityReadProof,
} from '../src/media/activity-owner-proof.js';
import { MediaActivityPrepareScopes } from '../src/media/activity-prepare-scope.js';
import {
  ACTIVITY_MEDIA_PROTOCOL,
  activityMediaRequestHash,
} from '../src/media/contracts-activity.js';
test('Activity image exact proof excludes guest and foreign owner slots before invoking owner', async () => {
  const tx = {} as PoolClient;
  startTransactionDeadlines(tx);
  const request: ActivityReadRequest = {
    reference: {
      activityId: randomUUID(),
      slot: 'cover',
      revision: 1,
      bindingId: randomUUID(),
    },
    audience: 'public',
    requestId: randomUUID(),
  };
  const value: ActivityReadAuthority = {
    principal: {
      kind: 'authenticated-activity',
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
  const registry = new ActivityOwnerProofRegistry({
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
    assert.throws(() => registry.require({} as ActivityReadProof, request, tx));
    for (const patch of [
      { activityId: randomUUID() },
      { slot: 'gallery0' as const },
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
            slot: 'managerContact' as ActivityReadRequest['reference']['slot'],
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
test('Activity management draft proof cannot be reused for public publication', async () => {
  const tx = {} as PoolClient;
  startTransactionDeadlines(tx);
  const request: ActivityReadRequest = {
    reference: {
      activityId: randomUUID(),
      slot: 'gallery8',
      revision: 2,
      bindingId: randomUUID(),
    },
    audience: 'management',
    requestId: randomUUID(),
  };
  const registry = new ActivityOwnerProofRegistry({
    authorizeCurrent: async () => ({
      principal: {
        kind: 'authenticated-activity',
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
test('Activity preparation scope cannot substitute another owner, revision or slot', async () => {
  const tx = {} as PoolClient;
  startTransactionDeadlines(tx);
  const actor = randomUUID(),
    input = {
      protocol: ACTIVITY_MEDIA_PROTOCOL,
      clientRequestId: randomUUID(),
      activityId: randomUUID(),
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
    scopeRevision: activityMediaRequestHash(actor, input),
    expiresAt: Date.now() + 60_000,
    ownerKind: 'activities' as const,
    resourceKind: 'activity_image' as const,
    targetKind: 'edit' as const,
    contentVersion: 1 as const,
    audience: 'activity-gated' as const,
    purpose: 'activity-image' as const,
    slot: input.slot,
    ordinal: 0 as const,
  };
  const issuer = new MediaActivityPrepareScopes({
    authorizePrepare: async () => scope,
  });
  try {
    const proof = await issuer.authorizeActivity(actor, input, tx);
    assert.equal(issuer.require(proof, tx).scope.ownerKind, 'activities');
    await assert.rejects(
      issuer.authorizeActivity(actor, { ...input, slot: 'gallery0' }, tx),
    );
    await assert.rejects(
      issuer.authorizeActivity(actor, { ...input, revision: 5 }, tx),
    );
    await assert.rejects(issuer.authorizeSchoolQr(actor, input, tx));
    clearTransactionDeadlines(tx);
    startTransactionDeadlines(tx);
    assert.throws(() => issuer.require(proof, tx));
  } finally {
    clearTransactionDeadlines(tx);
  }
});
