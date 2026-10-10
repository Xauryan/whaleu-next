import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
  checkTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { RatingsMediaProofRegistry } from '../src/media/ratings-owner-proof.js';
import type {
  RatingsMediaReadProof,
  RatingsMediaReadRequest,
} from '../src/media/ratings-owner-proof.js';
import { RatingsMediaAssetRepository } from '../src/media/ratings-asset-repository.js';
import type { RatingsMediaReplacement } from '../src/media/ratings-asset-repository.js';
import { ApplicationError } from '../src/http/application-error.js';
import {
  ratingsRequestMarker,
  reserveRatingsRequestMarker,
  rejectRatingsRequestMarker,
} from '../src/media/ratings-request-marker.js';
import { MediaRatingsPrepareScopes } from '../src/media/ratings-prepare-scope.js';

function readFixture() {
  const actor = randomUUID(),
    request: RatingsMediaReadRequest = {
      targetId: randomUUID(),
      contextId: randomUUID(),
      contextToken: 'a'.repeat(43),
      appearanceId: randomUUID(),
      requestId: randomUUID(),
      purpose: 'download',
    };
  const parent = {
    ownerKind: 'ratings' as const,
    resourceKind: 'target_cover' as const,
    resourceId: request.appearanceId,
    contentVersion: 1 as const,
  };
  const authority = {
    actorAccountId: actor,
    targetId: request.targetId,
    parent,
    assetId: randomUUID(),
    manifestDigest: 'a'.repeat(64),
    bindingId: randomUUID(),
    ownerRevision: 'c'.repeat(64),
    reviewRevision: 'd'.repeat(64),
  };
  let calls = 0;
  const registry = new RatingsMediaProofRegistry({
    async authorizeCurrent(credential, read) {
      calls++;
      if (credential !== 'valid-token') throw new Error('Invalid session');
      return {
        ...authority,
        principal: {
          kind: 'authenticatedRatings' as const,
          accountId: actor,
          sessionId: read.requestId,
        },
      };
    },
  });
  return { registry, actor, request, parent, calls: () => calls };
}
test('Ratings authenticated authority is a transaction-branded owner proof, never an empty/forged account', async () => {
  const fixture = readFixture(),
    tx = {} as PoolClient;
  startTransactionDeadlines(tx);
  try {
    const proof = await fixture.registry.authorize(
      'valid-token',
      fixture.request,
      tx,
    );
    assert.equal(
      fixture.registry.require(proof, fixture.request, tx).principal.kind,
      'authenticatedRatings',
    );
    assert.throws(() =>
      fixture.registry.require(
        {} as RatingsMediaReadProof,
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
test('Ratings prepare scope checks exact owner, shared revision and cannot be replayed after transaction reset', async () => {
  const actor = randomUUID(),
    tx = {} as PoolClient;
  startTransactionDeadlines(tx);
  const input = {
    protocol: 'ratings-target-media-v1',
    clientRequestId: randomUUID(),
    editScopeId: randomUUID(),
    scopeRevision: 'a'.repeat(64),
    slot: 'cover',
    declaration: { mime: 'image/png', bytes: 1, sha256: 'a'.repeat(64) },
  };
  const scopes = new MediaRatingsPrepareScopes({
    async authorizePrepare() {
      return {
        actorAccountId: actor,
        serverScopeId: input.editScopeId,
        scopeRevision: input.scopeRevision,
        expiresAt: Date.now() + 1000,
        ownerKind: 'ratings',
        resourceKind: 'target_cover',
        targetKind: 'edit',
        contentVersion: 1,
        audience: 'content-gated',
        purpose: 'ratings-target-cover-image',
        slot: 'cover',
        ordinal: 0,
      };
    },
  });
  try {
    const capability = await scopes.authorizeRatings(actor, input, tx);
    assert.equal(scopes.require(capability, tx).scope.ownerKind, 'ratings');
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
            owner_kind: 'ratings',
            resource_kind: 'target_cover',
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
    const assets = new RatingsMediaAssetRepository(fixture.registry);
    await assert.rejects(
      assets.acceptRatingsOwned(
        {
          actor: fixture.actor,
          scopeId: randomUUID(),
          scopeRevision: 'a'.repeat(64),
          expiresAt: Date.now() + 1000,
        },
        assetNew,
        {} as RatingsMediaReplacement,
        tx,
      ),
    );
    await assets.prepareRatingsReplacement(
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

test('Ratings request markers reject both directions of legacy tombstone confusion and exact hash reuse', async () => {
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
          'SELECT request_hash FROM whaleu_media.ratings_request_markers',
        )
      )
        return {
          rows: marker === null ? [] : [{ request_hash: marker }],
          rowCount: marker === null ? 0 : 1,
        };
      if (sql.startsWith('SELECT 1 FROM whaleu_media.upload_request_fences'))
        return { rows: occupied ? [{}] : [], rowCount: occupied ? 1 : 0 };
      if (sql.startsWith('INSERT INTO whaleu_media.ratings_request_markers')) {
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
  await assert.rejects(ratingsRequestMarker(actor, key, tx));
  startTransactionDeadlines(tx);
  try {
    occupied = true;
    await assert.rejects(
      reserveRatingsRequestMarker(actor, key, hash, tx),
      conflict,
    );
    assert.equal(inserts, 0);
    occupied = false;
    await rejectRatingsRequestMarker(actor, key, tx);
    await reserveRatingsRequestMarker(actor, key, hash, tx);
    assert.equal(inserts, 1);
    await reserveRatingsRequestMarker(actor, key, hash, tx);
    assert.equal(
      inserts,
      1,
      'exact original Ratings marker replays without replacement',
    );
    await assert.rejects(
      reserveRatingsRequestMarker(actor, key, 'b'.repeat(64), tx),
      conflict,
    );
    await assert.rejects(rejectRatingsRequestMarker(actor, key, tx), conflict);
  } finally {
    clearTransactionDeadlines(tx);
  }
});

test('Ratings replacement finishes exactly once, rejects savepoint reuse, and retains outer Media facts', async () => {
  const { checkpointTransactionDeadlines, restoreTransactionDeadlines } =
    await import('../src/database/transaction-deadlines.js');
  const { MediaRequiredProof } = await import('../src/media/required-proof.js');
  let epoch = 0;
  const sqls: string[] = [];
  const tx = {
    async query(sql: string) {
      sqls.push(sql);
      if (sql.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              capacity: 32,
              statement_timeout: '0',
              lock_timeout: '0',
            },
          ],
        };
      if (
        sql.startsWith(
          'SELECT slot,version,epoch::text FROM whaleu_media.media_owner_states',
        )
      )
        return {
          rows: Array.from({ length: 128 }, (_, slot) => ({
            slot,
            version: 1,
            epoch: String(epoch),
          })),
        };
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date() }] };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  try {
    const fixture = readFixture(),
      assets = new RatingsMediaAssetRepository(fixture.registry);
    const checkpoint = checkpointTransactionDeadlines(tx);
    const rolledBack = await assets.prepareRatingsReplacement(
      fixture.actor,
      null,
      null,
      tx,
    );
    restoreTransactionDeadlines(tx, checkpoint);
    await assert.rejects(assets.finishRatingsReplacement(rolledBack, tx));
    const ready = await assets.prepareRatingsReplacement(
      fixture.actor,
      null,
      null,
      tx,
    );
    await assets.finishRatingsReplacement(ready, tx);
    await assert.rejects(assets.finishRatingsReplacement(ready, tx));
    await checkTransactionDeadlines(tx);
    assert.ok(sqls.some((sql) => sql.includes(' IN SHARE MODE NOWAIT')));
    assert.equal(sqls.at(-1), 'SELECT clock_timestamp() AS now');
  } finally {
    clearTransactionDeadlines(tx);
  }
  startTransactionDeadlines(tx);
  try {
    const fixture = readFixture(),
      assets = new RatingsMediaAssetRepository(fixture.registry);
    await new MediaRequiredProof().capture(tx);
    const replacement = await assets.prepareRatingsReplacement(
      fixture.actor,
      null,
      null,
      tx,
    );
    epoch++;
    await assets.finishRatingsReplacement(replacement, tx);
    await assert.rejects(
      checkTransactionDeadlines(tx),
      (error) =>
        error instanceof ApplicationError && error.code === 'MEDIA_UNAVAILABLE',
    );
  } finally {
    clearTransactionDeadlines(tx);
  }
});
