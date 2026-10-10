import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { RatingsDiscussionMediaAssetRepository } from '../src/media/ratings-discussion-asset-repository.js';
import type {
  RatingsDiscussionSetSelection,
  RatingsDiscussionWholeSet,
} from '../src/media/ratings-discussion-asset-repository.js';
import { ratingsDiscussionSealedPlanHash } from '../src/media/contracts-ratings-discussion.js';
import type { AssetRow } from '../src/media/asset-repository.js';
import { sealManifest } from '../src/media/manifest.js';
import { manifestFixture } from './support/media/discovery-manifest.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
  checkTransactionDeadlines,
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
const sealed = sealManifest(manifestFixture());
class FixtureAssets extends RatingsDiscussionMediaAssetRepository {
  protected override async current(_row: AssetRow, _tx: PoolClient) {
    return sealed.manifest;
  }
  protected override async requireRetention(_row: AssetRow, _tx: PoolClient) {}
}
function fixture(count = 9, failBinding = 0) {
  const actor = randomUUID(),
    batchId = randomUUID(),
    scope = randomUUID(),
    hash = 'a'.repeat(64),
    targetId = randomUUID();
  const images = Array.from({ length: count }, (_, ordinal) => ({
    ordinal,
    memberId: randomUUID(),
    assetId: randomUUID(),
  }));
  const members = images.map((image, index) => ({
    member_id: image.memberId,
    source_slot: 127 - index,
    intent_id: randomUUID(),
    state: 'live',
  }));
  const rows = images.map((image, index) => ({
    id: image.assetId,
    intent_id: members[index]!.intent_id,
    actor_id: actor,
    purpose: 'ratings-comment-image',
    audience: 'content-gated',
    owner_kind: 'ratings',
    resource_kind: 'rating_comment',
    target_kind: 'draft',
    resource_id: scope,
    content_version: '1',
    scope_revision: hash,
    slot: 'images',
    ordinal: members[index]!.source_slot,
    policy_revision: 'media-static-v1',
    manifest_digest: sealed.digest,
    manifest: sealed.manifest,
    created_at: new Date(),
    protocol_version: 7,
  }));
  const plan = {
    batchId,
    batchIdentityHash: hash,
    orderedMembers: images.map((image) => ({
      ...image,
      manifestDigest: sealed.digest,
    })),
  };
  const batch = {
    id: batchId,
    actor_id: actor,
    identity_hash: hash,
    server_scope_id: scope,
    scope_revision: hash,
    state: 'sealed',
    expires_at: new Date(Date.now() + 60000),
    sealed_plan: plan,
    sealed_plan_digest: ratingsDiscussionSealedPlanHash(plan),
    identity: { target: { kind: 'root', targetId } },
  };
  const calls: string[] = [];
  let epoch = 0,
    inserted = 0;
  const tx = {
    async query(sql: string) {
      calls.push(sql);
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
      if (sql.includes('SELECT slot,version,epoch::text'))
        return {
          rows: Array.from({ length: 128 }, (_, slot) => ({
            slot,
            version: 1,
            epoch: String(epoch),
          })),
        };
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date() }] };
      if (
        sql.startsWith('SELECT * FROM whaleu_media.ratings_discussion_batches')
      )
        return { rows: [batch], rowCount: 1 };
      if (sql.startsWith('SELECT member_id,source_slot,intent_id,state'))
        return { rows: members, rowCount: members.length };
      if (sql.startsWith('SELECT a.*,i.protocol_version'))
        return { rows, rowCount: rows.length };
      if (sql.startsWith('INSERT INTO whaleu_media.bindings')) {
        if (++inserted === failBinding)
          throw new Error('synthetic ninth binding failure');
        epoch++;
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE whaleu_media.ratings_discussion_members')) {
        epoch++;
        return { rows: [], rowCount: members.length };
      }
      if (sql.startsWith('INSERT') || sql.startsWith('UPDATE')) {
        epoch++;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  const selection: RatingsDiscussionSetSelection = {
    actor,
    batchId,
    batchIdentityHash: hash,
    sealedPlanDigest: batch.sealed_plan_digest,
    images,
  };
  return {
    tx,
    selection,
    calls,
    parent: {
      ownerKind: 'ratings' as const,
      resourceKind: 'rating_comment' as const,
      targetId,
      resourceId: randomUUID(),
      contentVersion: 1 as const,
    },
    assets: new FixtureAssets(undefined, () => undefined),
    inserted: () => inserted,
  };
}
test('whole root9 locks batch/member/intent/assets, binds once and requires final finish', async () => {
  const f = fixture();
  startTransactionDeadlines(f.tx);
  try {
    const cap = await f.assets.prepareWholeSet(f.selection, f.tx);
    const batch = f.calls.findIndex((sql) =>
        sql.startsWith('SELECT * FROM whaleu_media.ratings_discussion_batches'),
      ),
      members = f.calls.findIndex((sql) =>
        sql.startsWith('SELECT member_id,source_slot'),
      ),
      intents = f.calls.findIndex((sql) =>
        sql.startsWith('SELECT id FROM whaleu_media.upload_intents'),
      ),
      assets = f.calls.findIndex((sql) =>
        sql.startsWith('SELECT a.*,i.protocol_version'),
      );
    assert.ok(
      batch >= 0 && members > batch && intents > members && assets > intents,
    );
    assert.equal((await f.assets.accept(cap, f.tx)).length, 9);
    assert.equal(
      (await f.assets.bindDiscussion(cap, f.parent, f.tx)).length,
      9,
    );
    assert.equal(f.inserted(), 9);
    await assert.rejects(
      checkTransactionDeadlines(f.tx),
      'all owner writes must finish before proof completion',
    );
    await f.assets.finish(cap, f.tx);
    await checkTransactionDeadlines(f.tx);
    await assert.rejects(f.assets.finish(cap, f.tx));
    await assert.rejects(f.assets.bindDiscussion(cap, f.parent, f.tx));
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});
test('ninth binding failure cannot finish and a savepoint invalidates narrow capabilities', async () => {
  const f = fixture(9, 9);
  startTransactionDeadlines(f.tx);
  try {
    const checkpoint = checkpointTransactionDeadlines(f.tx),
      cap = await f.assets.prepareWholeSet(f.selection, f.tx);
    await assert.rejects(
      f.assets.accept({} as RatingsDiscussionWholeSet, f.tx),
    );
    await f.assets.accept(cap, f.tx);
    await assert.rejects(f.assets.bindDiscussion(cap, f.parent, f.tx));
    await assert.rejects(f.assets.finish(cap, f.tx));
    await assert.rejects(checkTransactionDeadlines(f.tx));
    // This only verifies capability invalidation; actual SQL rollback is covered
    // by the separately required disposable PostgreSQL publication gate.
    restoreTransactionDeadlines(f.tx, checkpoint);
    await assert.rejects(f.assets.accept(cap, f.tx));
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});
