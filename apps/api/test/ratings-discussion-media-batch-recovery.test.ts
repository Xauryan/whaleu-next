import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { RatingsDiscussionMediaBatchRepository } from '../src/media/ratings-discussion-batch-repository.js';
import { RatingsDiscussionUploadApplication } from '../src/media/application-ratings-discussion.js';
import type { RatingsDiscussionMediaOwner } from '../src/media/application-ratings-discussion.js';
import type { MediaPrepareScopes } from '../src/media/prepare-scope.js';
import type { MediaIntentRepository } from '../src/media/intent-repository.js';
import type { RatingsDiscussionMediaAssetRepository } from '../src/media/ratings-discussion-asset-repository.js';
import type { MediaLifecycleRepository } from '../src/media/lifecycle-repository.js';
import {
  ratingsDiscussionBatchRecoverySchema,
  ratingsDiscussionBatchCancelRequestSchema,
} from '../src/media/contracts-ratings-discussion.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';

function fixture() {
  const fences = new Map<
      string,
      {
        identity_hash: string;
        batch_id: null;
        state: 'cancelled_before_prepare';
      }
    >(),
    calls: string[] = [];
  const tx = {
    async query(sql: string, args: unknown[] = []) {
      calls.push(sql);
      if (sql.includes("current_setting('transaction_isolation')"))
        return { rows: [{ isolation: 'read committed', capacity: 120 }] };
      if (sql.includes('SELECT slot,version,epoch::text'))
        return {
          rows: Array.from({ length: 128 }, (_, slot) => ({
            slot,
            version: 1,
            epoch: String(fences.size),
          })),
        };
      if (sql === 'SELECT clock_timestamp() now')
        return { rows: [{ now: new Date() }] };
      if (sql.includes('to_regclass')) return { rows: [{ present: true }] };
      if (sql.includes('count(*)::integer daily'))
        return { rows: [{ daily: fences.size, recent: fences.size }] };
      const key = JSON.stringify(args.slice(0, 2));
      if (
        sql.startsWith(
          'SELECT identity_hash,batch_id,state FROM whaleu_media.ratings_discussion_batch_request_fences',
        )
      ) {
        const row = fences.get(key);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (
        sql.startsWith(
          'INSERT INTO whaleu_media.ratings_discussion_batch_request_fences',
        )
      ) {
        assert.ok(!fences.has(key));
        fences.set(key, {
          identity_hash: String(args[2]),
          batch_id: null,
          state: 'cancelled_before_prepare',
        });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  const unavailable = () => {
    throw new Error(
      'Cancellation must not resolve content or contact a provider',
    );
  };
  const scopes = {
    authorizeRatingsDiscussionBatch: unavailable,
  } as unknown as MediaPrepareScopes;
  const repository = new RatingsDiscussionMediaBatchRepository(
    scopes,
    {} as MediaIntentRepository,
    {} as RatingsDiscussionMediaAssetRepository,
    {} as MediaLifecycleRepository,
  );
  return { tx, repository, calls, fences };
}
test('absent batch cancellation is durable, exact, actor-bound and context/provider independent', async () => {
  const f = fixture(),
    actor = randomUUID(),
    request = randomUUID(),
    identityHash = 'a'.repeat(64),
    body = { protocol: 'ratings-discussion-media-v1', identityHash };
  startTransactionDeadlines(f.tx);
  try {
    assert.equal(
      (await f.repository.recover(actor, request, f.tx)).state,
      'not_recorded',
    );
    const result = await f.repository.cancelRequest(actor, request, body, f.tx);
    assert.equal(result.state, 'cancelled_before_prepare');
    if (result.state === 'cancelled_before_prepare')
      assert.equal(result.identityHash, identityHash);
    assert.equal(
      (await f.repository.cancelRequest(actor, request, body, f.tx)).state,
      'cancelled_before_prepare',
    );
    assert.equal(f.fences.size, 1);
    await assert.rejects(
      f.repository.cancelRequest(
        actor,
        request,
        { ...body, identityHash: 'b'.repeat(64) },
        f.tx,
      ),
    );
    assert.equal(
      (await f.repository.recover(randomUUID(), request, f.tx)).state,
      'not_recorded',
    );
    assert.ok(
      f.calls.some((sql) =>
        sql.includes(
          'UNION ALL SELECT actor_id,created_at FROM whaleu_media.ratings_discussion_batch_request_fences',
        ),
      ),
      'shared request quota includes the durable absence fence',
    );
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});
test('batch cancellation reserves authenticated original Ratings claim before touching Media', async () => {
  const actor = randomUUID(),
    request = randomUUID(),
    tx = {} as PoolClient,
    calls: string[] = [];
  const owner = {
    runtime: null,
    authorized: async (
      _token: string,
      run: (session: { accountId: string }, tx: PoolClient) => Promise<unknown>,
    ) => run({ accountId: actor }, tx),
    reserveBatchRequest: async (
      account: string,
      id: string,
      hash: string,
      read: PoolClient,
    ) => {
      assert.equal(account, actor);
      assert.equal(id, request);
      assert.equal(hash, 'a'.repeat(64));
      assert.equal(read, tx);
      calls.push('owner');
    },
    batches: {
      cancelRequest: async () => {
        calls.push('media');
        return { state: 'cancelled_before_prepare' };
      },
    },
    reserveMemberRequest: async () => {
      calls.push('member-owner');
    },
    recovery: {
      cancelRequest: async () => {
        calls.push('member-media');
        return { state: 'cancelled_before_prepare' };
      },
    },
  } as unknown as RatingsDiscussionMediaOwner;
  await new RatingsDiscussionUploadApplication(owner).cancelBatchRequest(
    'token',
    request,
    { protocol: 'ratings-discussion-media-v1', identityHash: 'a'.repeat(64) },
  );
  assert.deepEqual(calls, ['owner', 'media']);
  await new RatingsDiscussionUploadApplication(owner).cancelRequest(
    'token',
    request,
    { protocol: 'ratings-discussion-media-v1', requestHash: 'a'.repeat(64) },
  );
  assert.deepEqual(calls, ['owner', 'media', 'member-owner', 'member-media']);
  assert.equal(
    ratingsDiscussionBatchCancelRequestSchema.safeParse({
      protocol: 'ratings-discussion-media-v1',
      identityHash: 'a'.repeat(64),
      approved: true,
    }).success,
    false,
  );
  assert.equal(
    ratingsDiscussionBatchRecoverySchema.safeParse({
      protocol: 'ratings-discussion-media-v1',
      batchRequestId: request,
      serverNow: Date.now(),
      state: 'cancelled_before_prepare',
    }).success,
    false,
  );
});
