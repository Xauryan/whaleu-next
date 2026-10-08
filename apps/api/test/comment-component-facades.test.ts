import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { CommunityCommentEnrollment } from '../src/community/comment-component/enrollment.js';
import type { CommunityAccessService } from '../src/community/community-access.service.js';
import type { CommunityRepository } from '../src/community/community.repository.js';
import type {
  PublicationOperation,
  PublicationReceipt,
} from '../src/community/contracts.js';
import {
  publicationHash,
  PublicationRepository,
} from '../src/community/publication.repository.js';
import { ApplicationError } from '../src/http/application-error.js';

const actor = '11111111-1111-4111-8111-111111111111';
const post = '22222222-2222-4222-8222-222222222222';
const request = '33333333-3333-4333-8333-333333333333';
const input = { postId: post, ownerId: actor, publicationRequestId: request };

test('comment enrollment inserts independent baseline before zero-default state on supplied transaction', async () => {
  const queries: { sql: string; values: readonly unknown[] }[] = [];
  const tx = {
    query: async (sql: string, values: readonly unknown[]) => {
      queries.push({ sql, values });
      return { rows: [] };
    },
  } as unknown as PoolClient;
  await new CommunityCommentEnrollment().enrollPublishedPost(input, tx);
  assert.deepEqual(queries, [
    {
      sql: 'INSERT INTO whaleu_post_hotness.comment_baselines(post_id,owner_id,source_request_id) VALUES($1,$2,$3)',
      values: [post, actor, request],
    },
    {
      sql: 'INSERT INTO whaleu_post_hotness.comment_states(post_id) VALUES($1)',
      values: [post],
    },
  ]);
});

test('comment enrollment never swallows baseline or initial-state insertion failure', async () => {
  for (const failAt of [1, 2]) {
    let queries = 0;
    const tx = {
      query: async () => {
        queries++;
        if (queries === failAt) throw new Error('enrollment guard failed');
        return { rows: [] };
      },
    } as unknown as PoolClient;
    await assert.rejects(
      new CommunityCommentEnrollment().enrollPublishedPost(input, tx),
      /enrollment guard failed/,
    );
    assert.equal(queries, failAt);
  }
});

function fixture(
  operation: PublicationOperation,
  options: { replay?: PublicationReceipt; failEnrollment?: boolean } = {},
) {
  const calls: string[] = [];
  const intent = { text: 'a post' };
  const tx = {
    query: async (sql: string, values: readonly unknown[] = []) => {
      calls.push(sql);
      if (sql.startsWith('INSERT INTO whaleu_community.report_origins'))
        assert.deepEqual(values, [
          operation === 'publish_post'
            ? 'post'
            : operation === 'publish_comment'
              ? 'comment'
              : 'reply',
          post,
          actor,
          'native_publication',
          request,
        ]);
      if (sql.startsWith('UPDATE whaleu_community.publication_requests')) {
        assert.deepEqual(values.slice(0, 2), [actor, request]);
        const receipt = JSON.parse(values[2] as string) as PublicationReceipt;
        assert.equal(receipt.requestId, request);
        assert.equal(receipt.operation, operation);
        if (receipt.outcome === 'created')
          assert.equal(receipt.resourceId, post);
      }
      if (
        options.failEnrollment &&
        sql.startsWith('INSERT INTO whaleu_post_hotness.comment_states')
      )
        throw new Error('comment hook failed');
      return {
        rows: sql.startsWith('SELECT payload_hash')
          ? [
              {
                payload_hash: publicationHash(operation, intent),
                operation,
                receipt: options.replay ?? null,
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
  const access = {
    actor: async () => {
      calls.push('actor');
      return actor;
    },
  } as unknown as CommunityAccessService;
  const enrollment = {
    enrollPublishedPost: async (
      selected: typeof input,
      supplied: PoolClient,
    ) => {
      calls.push('comment-enroll');
      assert.deepEqual(selected, input);
      assert.equal(supplied, tx);
      return new CommunityCommentEnrollment().enrollPublishedPost(
        selected,
        supplied,
      );
    },
  };
  return {
    calls,
    intent,
    repository: new PublicationRepository(
      { database } as unknown as CommunityRepository,
      access,
      {
        enrollPublishedPost: async () => {
          calls.push('subscription-enroll');
        },
      },
      {
        enrollPublishedPost: async () => {
          calls.push('like-enroll');
        },
      },
      {
        enrollPublishedPost: async () => {
          calls.push('view-enroll');
        },
      },
      enrollment,
    ),
  };
}

test('fresh post comment enrollment follows exact native origin and persisted successful receipt', async () => {
  const f = fixture('publish_post');
  const receipt = await f.repository.execute(
    'token',
    request,
    'publish_post',
    f.intent,
    async () => ({ resourceId: post, createdAt: '2026-01-01' }),
  );
  assert.equal(receipt.outcome, 'created');
  const origin = f.calls.findIndex((call) =>
    call.startsWith('INSERT INTO whaleu_community.report_origins'),
  );
  const persistedReceipt = f.calls.findIndex((call) =>
    call.startsWith('UPDATE whaleu_community.publication_requests'),
  );
  const enroll = f.calls.indexOf('comment-enroll');
  const baseline = f.calls.findIndex((call) =>
    call.startsWith('INSERT INTO whaleu_post_hotness.comment_baselines'),
  );
  const state = f.calls.findIndex((call) =>
    call.startsWith('INSERT INTO whaleu_post_hotness.comment_states'),
  );
  assert.ok(
    origin >= 0 && persistedReceipt > origin && enroll > persistedReceipt,
  );
  assert.ok(baseline > enroll && state > baseline);
  assert.equal(f.calls.filter((call) => call === 'comment-enroll').length, 1);
  assert.deepEqual(f.calls.slice(state + 1), [
    'like-enroll',
    'INSERT INTO whaleu_post_hotness.processing(post_id) VALUES($1)',
    'actor',
    'COMMIT',
  ]);
});

test('post replay, rejected publication, root and reply do not enroll comment baselines', async () => {
  const saved: PublicationReceipt = {
    requestId: request,
    operation: 'publish_post',
    outcome: 'created',
    resourceId: post,
    createdAt: '2026-01-01',
  };
  const replay = fixture('publish_post', { replay: saved });
  assert.deepEqual(
    await replay.repository.execute(
      'token',
      request,
      'publish_post',
      replay.intent,
      async () => {
        assert.fail('replay must not create content');
      },
    ),
    saved,
  );
  const rejected = fixture('publish_post');
  const receipt = await rejected.repository.execute(
    'token',
    request,
    'publish_post',
    rejected.intent,
    async () => {
      throw new ApplicationError('CONTENT_REJECTED');
    },
  );
  assert.equal(receipt.outcome, 'rejected');
  for (const f of [replay, rejected]) {
    assert.equal(f.calls.includes('comment-enroll'), false);
    assert.equal(
      f.calls.some((call) => /comment_baselines|comment_states/.test(call)),
      false,
    );
  }
  for (const operation of ['publish_comment', 'publish_reply'] as const) {
    const f = fixture(operation);
    await f.repository.execute(
      'token',
      request,
      operation,
      f.intent,
      async () => ({ resourceId: post, createdAt: '2026-01-01' }),
    );
    assert.equal(f.calls.includes('comment-enroll'), false);
    assert.equal(
      f.calls.some((call) => /comment_baselines|comment_states/.test(call)),
      false,
    );
  }
});

test('comment state enrollment failure propagates out of fresh publication for complete transaction rollback', async () => {
  const f = fixture('publish_post', { failEnrollment: true });
  await assert.rejects(
    f.repository.execute(
      'token',
      request,
      'publish_post',
      f.intent,
      async () => ({ resourceId: post, createdAt: '2026-01-01' }),
    ),
    /comment hook failed/,
  );
  assert.ok(
    f.calls.some((call) =>
      call.startsWith('INSERT INTO whaleu_post_hotness.comment_baselines'),
    ),
  );
  assert.equal(f.calls.at(-1), 'ROLLBACK');
  assert.equal(f.calls.includes('COMMIT'), false);
  assert.equal(f.calls.includes('like-enroll'), false);
});
