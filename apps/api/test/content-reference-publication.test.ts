import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { PoolClient } from 'pg';
import {
  PublicationRepository,
  publicationHash,
} from '../src/community/publication.repository.js';
import type {
  PublicationOperation,
  PublicationReceipt,
} from '../src/community/contracts.js';
import { ApplicationError } from '../src/http/application-error.js';
import { TextReviewSubmission } from '../src/community/text-review/contracts.js';
import { canonicalEnvelope } from '../src/community/content-review/contracts.js';

function fixture(
  operation: PublicationOperation,
  replay: PublicationReceipt | null = null,
  failAllocation = false,
) {
  type Args = ConstructorParameters<typeof PublicationRepository>;
  const actor = randomUUID(),
    targetId = replay?.outcome === 'created' ? replay.resourceId : randomUUID(),
    requestId = replay?.requestId ?? randomUUID();
  const intent = { text: 'exact accepted publication' },
    calls: string[] = [];
  const tx = {
    query: async (sql: string) => {
      calls.push(sql);
      return {
        rows: sql.startsWith('SELECT payload_hash')
          ? [
              {
                payload_hash: publicationHash(operation, intent),
                operation,
                receipt: replay,
              },
            ]
          : [],
      };
    },
  } as unknown as PoolClient;
  const repository = new PublicationRepository(
    {
      database: {
        transaction: async <T>(work: (tx: PoolClient) => Promise<T>) => {
          try {
            const result = await work(tx);
            calls.push('commit');
            return result;
          } catch (error) {
            calls.push('rollback');
            throw error;
          }
        },
      },
    } as unknown as Args[0],
    { actor: async () => actor } as unknown as Args[1],
    { enrollPublishedPost: async () => {} },
    { enrollPublishedPost: async () => {} },
    { enrollPublishedPost: async () => {} },
    { enrollPublishedPost: async () => {} },
    {
      allocateForPublication: async (target, client) => {
        assert.equal(client, tx);
        assert.deepEqual(target, {
          kind:
            operation === 'publish_post'
              ? 'post'
              : operation === 'publish_comment'
                ? 'comment'
                : 'reply',
          targetId,
        });
        calls.push('allocate');
        if (failAllocation) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
        return { state: 'allocated', code: '10000000' };
      },
    },
    {
      configured: () => true,
      submit: async () => {
        calls.push('queue');
        return { requestId, operation, status: 'pending' };
      },
    } as unknown as Args[7],
  );
  return {
    repository,
    actor,
    targetId,
    requestId,
    intent,
    calls,
    create: async () => {
      calls.push('create');
      return { resourceId: targetId, createdAt: '2026-10-20T00:00:00.000Z' };
    },
    execute: () =>
      repository.execute('token', requestId, operation, intent, async () => {
        calls.push('create');
        return { resourceId: targetId, createdAt: '2026-10-20T00:00:00.000Z' };
      }),
  };
}

test('actual publication owner allocates exact post/root/reply once inside its original savepoint and preserves receipt bytes', async () => {
  for (const operation of [
    'publish_post',
    'publish_comment',
    'publish_reply',
  ] as const) {
    const f = fixture(operation);
    const receipt = await f.execute();
    assert.deepEqual(receipt, {
      requestId: f.requestId,
      operation,
      outcome: 'created',
      resourceId: f.targetId,
      createdAt: '2026-10-20T00:00:00.000Z',
    });
    assert.equal(f.calls.filter((value) => value === 'allocate').length, 1);
    const at = f.calls.indexOf('allocate');
    assert.ok(
      f.calls.indexOf('SAVEPOINT publication_work') < f.calls.indexOf('create'),
    );
    assert.ok(f.calls.indexOf('create') < at);
    assert.ok(at < f.calls.indexOf('RELEASE SAVEPOINT publication_work'));
    const replay = fixture(operation, receipt);
    assert.deepEqual(await replay.execute(), receipt);
    assert.ok(!replay.calls.includes('allocate'));
    assert.ok(!replay.calls.includes('create'));
    assert.ok(!replay.calls.includes('SAVEPOINT publication_work'));
  }
});

test('allocation outage rolls back whole publication, never persists permanent invalid-content receipt', async () => {
  for (const operation of [
    'publish_post',
    'publish_comment',
    'publish_reply',
  ] as const) {
    const f = fixture(operation, null, true);
    await assert.rejects(
      f.execute(),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === 'COMMUNITY_UNAVAILABLE',
    );
    assert.equal(f.calls.at(-1), 'rollback');
    assert.ok(
      !f.calls.some((sql) =>
        sql.startsWith('UPDATE whaleu_community.publication_requests'),
      ),
    );
    assert.ok(!f.calls.includes('RELEASE SAVEPOINT publication_work'));
  }
});

test('terminal rejection, review preparation and even accidental review create never reach allocator', async () => {
  const rejected = fixture('publish_comment');
  await rejected.repository.execute(
    'token',
    rejected.requestId,
    'publish_comment',
    rejected.intent,
    async () => {
      throw new ApplicationError('CONTENT_REJECTED');
    },
  );
  assert.ok(!rejected.calls.includes('allocate'));
  const f = fixture('publish_post'),
    spaceId = randomUUID(),
    regionId = randomUUID();
  const envelope = canonicalEnvelope({
    version: 1,
    accountId: f.actor,
    purpose: 'publish_post',
    spaceId,
    category: 'discussion',
    authorMode: 'named',
    commentsPolicy: 'open',
    postId: null,
    rootCommentId: null,
    targetReplyId: null,
    text: 'exact accepted publication',
    images: [],
    component: { kind: 'none' },
    trading: null,
    scope: {
      originalSpaceId: spaceId,
      originalRegionId: regionId,
      authorOriginRegionId: regionId,
      identityRegionId: regionId,
      topologySnapshotId: randomUUID(),
      sync: 'none',
    },
  });
  const pending = await f.repository.execute(
    'token',
    f.requestId,
    'publish_post',
    f.intent,
    async () => {
      f.calls.push('prepare');
      throw new TextReviewSubmission(envelope);
    },
    true,
  );
  assert.equal(pending.status, 'pending');
  assert.ok(!f.calls.includes('allocate'));
  assert.equal(f.calls.filter((call) => call === 'prepare').length, 2);
  assert.ok(f.calls.includes('queue'));
  const faulty = fixture('publish_post');
  await assert.rejects(
    faulty.repository.execute(
      'token',
      faulty.requestId,
      'publish_post',
      faulty.intent,
      faulty.create,
      true,
    ),
  );
  assert.ok(!faulty.calls.includes('allocate'));
});
