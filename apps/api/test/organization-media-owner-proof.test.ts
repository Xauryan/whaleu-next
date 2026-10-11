import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { PoolClient } from 'pg';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { OrganizationOwnerProofRegistry } from '../src/media/organization-owner-proof.js';
import type {
  OrganizationReadRequest,
  OrganizationReadAuthority,
  OrganizationReadProof,
} from '../src/media/organization-owner-proof.js';
import { MediaOrganizationPrepareScopes } from '../src/media/organization-prepare-scope.js';
import {
  ORGANIZATION_MEDIA_PROTOCOL,
  organizationMediaRequestHash,
} from '../src/media/contracts-organization.js';
test('Organization image exact proof excludes guest and private managerContact before invoking owner', async () => {
  const tx = {} as PoolClient;
  startTransactionDeadlines(tx);
  const request: OrganizationReadRequest = {
    reference: {
      organizationId: randomUUID(),
      slot: 'avatar',
      applicationRevision: 1,
      bindingId: randomUUID(),
    },
    audience: 'public',
    requestId: randomUUID(),
  };
  const value: OrganizationReadAuthority = {
    principal: {
      kind: 'authenticated-organization',
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
  const registry = new OrganizationOwnerProofRegistry({
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
      registry.require({} as OrganizationReadProof, request, tx),
    );
    for (const patch of [
      { organizationId: randomUUID() },
      { slot: 'mainQr' as const },
      { applicationRevision: 2 },
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
          reference: { ...request.reference, slot: 'managerContact' },
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
test('Organization private managerContact needs exact management owner and cannot reuse public proof', async () => {
  const tx = {} as PoolClient;
  startTransactionDeadlines(tx);
  const request: OrganizationReadRequest = {
    reference: {
      organizationId: randomUUID(),
      slot: 'managerContact',
      applicationRevision: 2,
      bindingId: randomUUID(),
    },
    audience: 'management',
    requestId: randomUUID(),
  };
  const registry = new OrganizationOwnerProofRegistry({
    authorizeCurrent: async () => ({
      principal: {
        kind: 'authenticated-organization',
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
test('Organization preparation scope cannot substitute another owner, revision or slot', async () => {
  const tx = {} as PoolClient;
  startTransactionDeadlines(tx);
  const actor = randomUUID(),
    input = {
      protocol: ORGANIZATION_MEDIA_PROTOCOL,
      clientRequestId: randomUUID(),
      organizationId: randomUUID(),
      slot: 'introImage8' as const,
      applicationRevision: 4,
      declaration: {
        mime: 'image/png' as const,
        bytes: 32,
        sha256: 'a'.repeat(64),
      },
    };
  const scope = {
    actorAccountId: actor,
    serverScopeId: randomUUID(),
    scopeRevision: organizationMediaRequestHash(actor, input),
    expiresAt: Date.now() + 60_000,
    ownerKind: 'organizations' as const,
    resourceKind: 'organization_image' as const,
    targetKind: 'edit' as const,
    contentVersion: 1 as const,
    audience: 'organization-gated' as const,
    purpose: 'organization-image' as const,
    slot: input.slot,
    ordinal: 0 as const,
  };
  const issuer = new MediaOrganizationPrepareScopes({
    authorizePrepare: async () => scope,
  });
  try {
    const proof = await issuer.authorizeOrganization(actor, input, tx);
    assert.equal(issuer.require(proof, tx).scope.ownerKind, 'organizations');
    await assert.rejects(
      issuer.authorizeOrganization(actor, { ...input, slot: 'mainQr' }, tx),
    );
    await assert.rejects(
      issuer.authorizeOrganization(
        actor,
        { ...input, applicationRevision: 5 },
        tx,
      ),
    );
    await assert.rejects(issuer.authorizeSchoolQr(actor, input, tx));
    clearTransactionDeadlines(tx);
    startTransactionDeadlines(tx);
    assert.throws(() => issuer.require(proof, tx));
  } finally {
    clearTransactionDeadlines(tx);
  }
});
