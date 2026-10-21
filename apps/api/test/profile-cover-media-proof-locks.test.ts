import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
  checkTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { ProfileCoverMediaProofRegistry } from '../src/media/profile-cover-owner-proof.js';
import type {
  ProfileCoverMediaReadProof,
  ProfileCoverMediaReadRequest,
} from '../src/media/profile-cover-owner-proof.js';
import { ProfileCoverMediaAssetRepository } from '../src/media/profile-cover-asset-repository.js';
import type { ProfileCoverMediaReplacement } from '../src/media/profile-cover-asset-repository.js';
import { ApplicationError } from '../src/http/application-error.js';
import {
  profileCoverRequestMarker,
  reserveProfileCoverRequestMarker,
  rejectProfileCoverRequestMarker,
} from '../src/media/profile-cover-request-marker.js';
import { MediaProfileCoverPrepareScopes } from '../src/media/profile-cover-prepare-scope.js';

function readFixture() {
  const actor = randomUUID(),
    request: ProfileCoverMediaReadRequest = {
      profileId: randomUUID(),
      appearanceId: randomUUID(),
      requestId: randomUUID(),
      purpose: 'download',
    };
  const parent = {
    ownerKind: 'profile' as const,
    resourceKind: 'cover' as const,
    resourceId: request.appearanceId,
    contentVersion: 1 as const,
  };
  const authority = {
    actorAccountId: actor,
    profileId: request.profileId,
    parent,
    assetId: randomUUID(),
    manifestDigest: 'a'.repeat(64),
    bindingId: randomUUID(),
    ownerRevision: 'c'.repeat(64),
    reviewRevision: 'd'.repeat(64),
  };
  let calls = 0;
  const registry = new ProfileCoverMediaProofRegistry({
    async authorizeCurrent(credential, read) {
      calls++;
      if (credential !== null) throw new Error('Invalid session');
      return {
        ...authority,
        principal: { kind: 'guest' as const, requestId: read.requestId },
      };
    },
  });
  return { registry, actor, request, parent, calls: () => calls };
}
test('Profile guest authority is a transaction-branded owner proof, never an empty/forged account', async () => {
  const fixture = readFixture(),
    tx = {} as PoolClient;
  startTransactionDeadlines(tx);
  try {
    const proof = await fixture.registry.authorize(null, fixture.request, tx);
    assert.equal(
      fixture.registry.require(proof, fixture.request, tx).principal.kind,
      'guest',
    );
    assert.throws(() =>
      fixture.registry.require(
        {} as ProfileCoverMediaReadProof,
        fixture.request,
        tx,
      ),
    );
    assert.throws(() =>
      fixture.registry.require(
        proof,
        { ...fixture.request, appearanceId: randomUUID() },
        tx,
      ),
    );
    assert.throws(() =>
      fixture.registry.require(
        proof,
        { ...fixture.request, requestId: randomUUID() },
        tx,
      ),
    );
    await assert.rejects(fixture.registry.authorize('', fixture.request, tx));
    await assert.rejects(
      fixture.registry.authorize('bad-token', fixture.request, tx),
    );
    clearTransactionDeadlines(tx);
    startTransactionDeadlines(tx);
    assert.throws(() => fixture.registry.require(proof, fixture.request, tx));
  } finally {
    clearTransactionDeadlines(tx);
  }
});
test('Profile prepare scope checks exact owner, independent cover revision and cannot be replayed after transaction reset', async () => {
  const actor = randomUUID(),
    tx = {} as PoolClient;
  startTransactionDeadlines(tx);
  const input = {
    protocol: 'profile-cover-v1',
    clientRequestId: randomUUID(),
    expectedRevision: 0,
    slot: 'cover',
    declaration: { mime: 'image/png', bytes: 1, sha256: 'a'.repeat(64) },
  };
  const scopes = new MediaProfileCoverPrepareScopes({
    async authorizePrepare() {
      return {
        actorAccountId: actor,
        serverScopeId: randomUUID(),
        scopeRevision: '0',
        expiresAt: Date.now() + 1000,
        ownerKind: 'profile',
        resourceKind: 'cover',
        targetKind: 'edit',
        contentVersion: 1,
        audience: 'profile-public',
        purpose: 'profile-cover-image',
        slot: 'cover',
        ordinal: 0,
      };
    },
  });
  try {
    const capability = await scopes.authorizeProfileCover(actor, input, tx);
    assert.equal(scopes.require(capability, tx).scope.ownerKind, 'profile');
    await assert.rejects(scopes.authorize(actor, input, tx));
    clearTransactionDeadlines(tx);
    startTransactionDeadlines(tx);
    assert.throws(() => scopes.require(capability, tx));
  } finally {
    clearTransactionDeadlines(tx);
  }
});
test('replacement gathers old and new intents globally before any asset or binding lock, and unfinished replacement cannot commit', async () => {
  const fixture = readFixture(),
    assetOld = 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    assetNew = '00000000-0000-4000-8000-000000000001',
    intentOld = '00000000-0000-4000-8000-000000000002',
    intentNew = 'ffffffff-ffff-4fff-8fff-fffffffffffe',
    binding = randomUUID();
  const calls: { sql: string; values: unknown[] }[] = [];
  const tx = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT b.id,b.asset_id,a.intent_id'))
        return {
          rows: [{ id: binding, asset_id: assetOld, intent_id: intentOld }],
          rowCount: 1,
        };
      if (sql.startsWith('SELECT intent_id FROM whaleu_media.assets'))
        return {
          rows: [{ intent_id: intentOld }, { intent_id: intentNew }],
          rowCount: 2,
        };
      if (sql.startsWith('SELECT * FROM whaleu_media.assets'))
        return {
          rows: [assetNew, assetOld].map((id) => ({
            id,
            actor_id: fixture.actor,
            owner_kind: 'profile',
            resource_kind: 'cover',
            slot: 'cover',
          })),
          rowCount: 2,
        };
      if (sql.startsWith('SELECT id,asset_id,detached_at'))
        return {
          rows: [{ id: binding, asset_id: assetOld, detached_at: null }],
          rowCount: 1,
        };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  try {
    const assets = new ProfileCoverMediaAssetRepository(fixture.registry);
    await assert.rejects(
      assets.acceptProfileCoverOwned(
        { actor: fixture.actor, scopeId: randomUUID(), scopeRevision: '0' },
        assetNew,
        {} as ProfileCoverMediaReplacement,
        tx,
      ),
    );
    await assets.prepareProfileCoverReplacement(
      fixture.actor,
      fixture.parent,
      assetNew,
      tx,
    );
    const batch = calls.findIndex((call) =>
        call.sql.includes('FROM whaleu_media.publication_batches'),
      ),
      intents = calls.findIndex((call) =>
        call.sql.includes('FROM whaleu_media.upload_intents WHERE id IN'),
      ),
      sources = calls.findIndex((call) =>
        call.sql.startsWith('SELECT * FROM whaleu_media.assets'),
      ),
      bindings = calls.findIndex((call) =>
        call.sql.startsWith('SELECT id,asset_id,detached_at'),
      );
    assert.ok(
      batch >= 0 && intents > batch && sources > intents && bindings > sources,
    );
    assert.deepEqual(calls[intents]!.values, [[assetNew, assetOld]]);
    assert.match(calls[intents]!.sql, /ORDER BY id FOR UPDATE NOWAIT/);
    assert.match(calls[sources]!.sql, /ORDER BY id FOR UPDATE NOWAIT/);
    assert.match(calls[bindings]!.sql, /ORDER BY id FOR UPDATE NOWAIT/);
    await assert.rejects(
      checkTransactionDeadlines(tx),
      (error) =>
        error instanceof ApplicationError && error.code === 'MEDIA_UNAVAILABLE',
    );
  } finally {
    clearTransactionDeadlines(tx);
  }
});

test('Profile request markers reject both directions of legacy tombstone confusion and exact hash reuse', async () => {
  const actor = randomUUID(),
    key = randomUUID(),
    hash = 'a'.repeat(64);
  let marker: string | null = null,
    occupied = false,
    inserts = 0;
  const tx = {
    async query(sql: string, values: unknown[] = []) {
      if (
        sql.startsWith(
          'SELECT request_hash FROM whaleu_media.profile_cover_request_markers',
        )
      )
        return {
          rows: marker === null ? [] : [{ request_hash: marker }],
          rowCount: marker === null ? 0 : 1,
        };
      if (sql.startsWith('SELECT 1 FROM whaleu_media.upload_request_fences'))
        return { rows: occupied ? [{}] : [], rowCount: occupied ? 1 : 0 };
      if (
        sql.startsWith('INSERT INTO whaleu_media.profile_cover_request_markers')
      ) {
        marker = values[2] as string;
        inserts++;
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected marker query: ${sql}`);
    },
  } as unknown as PoolClient;
  const conflict = (error: unknown) =>
    error instanceof ApplicationError &&
    error.code === 'MEDIA_REQUEST_CONFLICT';
  await assert.rejects(profileCoverRequestMarker(actor, key, tx));
  startTransactionDeadlines(tx);
  try {
    occupied = true;
    await assert.rejects(
      reserveProfileCoverRequestMarker(actor, key, hash, tx),
      conflict,
    );
    assert.equal(inserts, 0);
    occupied = false;
    await rejectProfileCoverRequestMarker(actor, key, tx);
    await reserveProfileCoverRequestMarker(actor, key, hash, tx);
    assert.equal(inserts, 1);
    await reserveProfileCoverRequestMarker(actor, key, hash, tx);
    assert.equal(
      inserts,
      1,
      'exact original Profile marker replays without replacement',
    );
    await assert.rejects(
      reserveProfileCoverRequestMarker(actor, key, 'b'.repeat(64), tx),
      conflict,
    );
    await assert.rejects(
      rejectProfileCoverRequestMarker(actor, key, tx),
      conflict,
    );
  } finally {
    clearTransactionDeadlines(tx);
  }
});
