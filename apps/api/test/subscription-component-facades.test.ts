import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import {
  PublicationRepository,
  publicationHash,
} from '../src/community/publication.repository.js';
import type { CommunityRepository } from '../src/community/community.repository.js';
import type { CommunityAccessService } from '../src/community/community-access.service.js';
import { CommunitySubscriptionEnrollment } from '../src/community/subscription-component/enrollment.js';
import type {
  PublicationOperation,
  PublicationReceipt,
} from '../src/community/contracts.js';
import { ApplicationError } from '../src/http/application-error.js';
const actor = '11111111-1111-4111-8111-111111111111',
  post = '22222222-2222-4222-8222-222222222222',
  request = '33333333-3333-4333-8333-333333333333';
function fixture(
  operation: PublicationOperation,
  replay: PublicationReceipt | null = null,
  failHook = false,
) {
  const calls: string[] = [];
  const intent = { text: 'a post' };
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
  const database = {
    transaction: async (fn: (tx: PoolClient) => Promise<unknown>) => {
      try {
        const result = await fn(tx);
        calls.push('COMMIT');
        return result;
      } catch (error) {
        calls.push('ROLLBACK');
        throw error;
      }
    },
  };
  const repository = { database } as unknown as CommunityRepository;
  const access = {
    actor: async () => {
      calls.push('actor');
      return actor;
    },
  } as unknown as CommunityAccessService;
  const enrollment = {
    enrollPublishedPost: async (input: unknown, supplied: PoolClient) => {
      assert.deepEqual(input, {
        postId: post,
        ownerId: actor,
        publicationRequestId: request,
      });
      assert.equal(supplied, tx);
      calls.push('enroll');
      if (failHook) throw new Error('hook failed');
    },
  } as CommunitySubscriptionEnrollment;
  return {
    calls,
    intent,
    repository: new PublicationRepository(
      repository,
      access,
      enrollment,
      { enrollPublishedPost: async () => {} },
      { enrollPublishedPost: async () => {} },
      { enrollPublishedPost: async () => {} },
    ),
  };
}
test('fresh post enrollment follows persisted origin and receipt on the existing transaction', async () => {
  const f = fixture('publish_post');
  await f.repository.execute(
    'token',
    request,
    'publish_post',
    f.intent,
    async () => ({ resourceId: post, createdAt: '2026-01-01' }),
  );
  const at = f.calls.indexOf('enroll');
  assert.ok(
    at >
      f.calls.findIndex((x) =>
        x.startsWith('INSERT INTO whaleu_community.report_origins'),
      ),
  );
  assert.ok(
    at >
      f.calls.findIndex((x) =>
        x.startsWith('UPDATE whaleu_community.publication_requests'),
      ),
  );
  assert.deepEqual(f.calls.slice(at), ['enroll', 'actor', 'COMMIT']);
});
test('replay, rejected post, comment and reply never enroll a subscription baseline', async () => {
  const replay = fixture('publish_post', {
    requestId: request,
    operation: 'publish_post',
    outcome: 'created',
    resourceId: post,
    createdAt: '2026-01-01',
  });
  await replay.repository.execute(
    'token',
    request,
    'publish_post',
    replay.intent,
    async () => {
      throw new Error('replay must not create');
    },
  );
  assert.equal(replay.calls.includes('enroll'), false);
  const rejected = fixture('publish_post');
  await rejected.repository.execute(
    'token',
    request,
    'publish_post',
    rejected.intent,
    async () => {
      throw new ApplicationError('CONTENT_REJECTED');
    },
  );
  assert.equal(rejected.calls.includes('enroll'), false);
  for (const operation of ['publish_comment', 'publish_reply'] as const) {
    const f = fixture(operation);
    await f.repository.execute(
      'token',
      request,
      operation,
      f.intent,
      async () => ({ resourceId: post, createdAt: '2026-01-01' }),
    );
    assert.equal(f.calls.includes('enroll'), false);
  }
});
test('enrollment failure propagates through the publication transaction rollback', async () => {
  const f = fixture('publish_post', null, true);
  await assert.rejects(
    f.repository.execute(
      'token',
      request,
      'publish_post',
      f.intent,
      async () => ({ resourceId: post, createdAt: '2026-01-01' }),
    ),
    /hook failed/,
  );
  assert.equal(f.calls.at(-1), 'ROLLBACK');
  assert.equal(f.calls.includes('COMMIT'), false);
});
