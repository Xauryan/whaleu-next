import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  PublicationRepository,
  publicationHash,
} from '../src/community/publication.repository.js';
import { canonicalEnvelope } from '../src/community/content-review/contracts.js';
import type { EffectiveContentEnvelope } from '../src/community/content-review/contracts.js';
import { homeOriginalIntentHash } from '../src/community/home-feed-policy/review-evidence.js';
import { LEGACY_HOME_POLICY_COMMIT } from '../src/community/home-feed-policy/policy.js';
import { sourceDescriptor } from '../src/community/text-source/protocol.js';
import { withReviewedTextSource } from '../src/community/text-source/publication.js';
import { TextReviewSubmission } from '../src/community/text-review/contracts.js';
import type { PublicationOperation } from '../src/community/contracts.js';
type Args = ConstructorParameters<typeof PublicationRepository>;
const accountId = randomUUID(),
  spaceId = randomUUID(),
  regionId = randomUUID();
function envelope(operation: PublicationOperation, source: boolean) {
  const draft = canonicalEnvelope({
    version: 1,
    accountId,
    purpose: operation,
    spaceId,
    category: 'discussion',
    authorMode: 'named',
    commentsPolicy: 'open',
    postId: operation === 'publish_post' ? null : randomUUID(),
    rootCommentId: operation === 'publish_reply' ? randomUUID() : null,
    targetReplyId: null,
    text: 'Original source',
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
  return source
    ? canonicalEnvelope({
        ...withReviewedTextSource(draft, {
          version: 1,
          format: 'plain',
          readingFormatting: 'off',
        }),
        images: [],
      })
    : draft;
}
const intent = {
  text: 'Original source',
  imageAssetIds: [],
  authorMode: 'named',
  textSource: { version: 1, format: 'plain', readingFormatting: 'off' },
};
for (const operation of [
  'publish_post',
  'publish_comment',
  'publish_reply',
] as const) {
  test(`source_manual repository actually queues ${operation} after two exact preparations`, async () => {
    const requestId = randomUUID(),
      value = envelope(operation, true);
    let prepares = 0,
      queues = 0;
    const tx = {
      query: async (sql: string) => ({
        rows: sql.startsWith('SELECT payload_hash,operation,receipt')
          ? [
              {
                payload_hash: publicationHash(operation, intent),
                operation,
                receipt: null,
              },
            ]
          : [],
      }),
    } as unknown as PoolClient;
    const repository = new PublicationRepository(
      {
        database: {
          transaction: async <T>(fn: (tx: PoolClient) => Promise<T>) => fn(tx),
        },
      } as unknown as Args[0],
      { actor: async () => accountId } as unknown as Args[1],
      {} as Args[2],
      {} as Args[3],
      {} as Args[4],
      {} as Args[5],
      {
        allocateForPublication: async () => {
          throw new Error('No reference allocation during queue submission');
        },
      },
      {
        configured: () => false,
        sourceConfigured: () => true,
        submit: async (e: unknown, context: { intentHash: string }) => {
          assert.deepEqual(e, value);
          assert.equal(context.intentHash, publicationHash(operation, intent));
          queues++;
          return { requestId, operation, status: 'pending' };
        },
      } as unknown as Args[7],
    );
    const result = await repository.execute(
      'current-session',
      requestId,
      operation,
      intent,
      async () => {
        prepares++;
        throw new TextReviewSubmission(value);
      },
      true,
    );
    assert.equal(result.status, 'pending');
    assert.equal(prepares, 2);
    assert.equal(queues, 1);
  });
}
test('source-only repository rejects legacy, malformed, feedback, related and media intents before a transaction', async () => {
  const repository = new PublicationRepository(
    {
      database: {
        transaction: async () => {
          throw new Error('Unexpected transaction');
        },
      },
    } as unknown as Args[0],
    {} as Args[1],
    {} as Args[2],
    {} as Args[3],
    {} as Args[4],
    {} as Args[5],
    {} as Args[6],
    {
      configured: () => false,
      sourceConfigured: () => true,
    } as unknown as Args[7],
  );
  for (const bad of [
    { text: 'legacy' },
    { ...intent, textSource: { version: 1, format: 'html' } },
    { ...intent, category: 'feedback' },
    { ...intent, syncToRelatedCampuses: true },
    { ...intent, imageAssetIds: [randomUUID()] },
    { ...intent, component: { kind: 'poll' } },
    { ...intent, commentsPolicy: 'restricted' },
  ])
    await assert.rejects(
      repository.execute(
        'session',
        randomUUID(),
        'publish_post',
        bad,
        async () => {
          throw new Error('Unexpected preparation');
        },
        true,
      ),
      (error: unknown) =>
        (error as { code: string }).code === 'CONTENT_REVIEW_UNAVAILABLE',
    );
});
test('source-shaped intent cannot queue an actual legacy envelope', async () => {
  const operation = 'publish_post',
    value = envelope(operation, false),
    requestId = randomUUID();
  let prepares = 0,
    queues = 0;
  const tx = {
    query: async (sql: string) => ({
      rows: sql.startsWith('SELECT payload_hash,operation,receipt')
        ? [
            {
              payload_hash: publicationHash(operation, intent),
              operation,
              receipt: null,
            },
          ]
        : [],
    }),
  } as unknown as PoolClient;
  const repository = new PublicationRepository(
    {
      database: {
        transaction: async <T>(fn: (tx: PoolClient) => Promise<T>) => fn(tx),
      },
    } as unknown as Args[0],
    { actor: async () => accountId } as unknown as Args[1],
    {} as Args[2],
    {} as Args[3],
    {} as Args[4],
    {} as Args[5],
    {} as Args[6],
    {
      configured: () => false,
      sourceConfigured: () => true,
      submit: async () => {
        queues++;
      },
    } as unknown as Args[7],
  );
  await assert.rejects(
    repository.execute(
      'session',
      requestId,
      operation,
      intent,
      async () => {
        prepares++;
        throw new TextReviewSubmission(value);
      },
      true,
    ),
    (error: unknown) =>
      (error as { code: string }).code === 'CONTENT_REVIEW_UNAVAILABLE',
  );
  assert.equal(prepares, 2);
  assert.equal(queues, 0);
});

function homeEnvelope(operation: PublicationOperation, source: boolean) {
  const base = envelope(operation, source);
  const textSource = base.version === 6 ? base.textSource : null;
  const requestedIntent = {
    spaceId,
    category: 'discussion' as const,
    text: base.text,
    imageAssetIds: [],
    authorMode: 'named' as const,
    commentsPolicy: 'open' as const,
    ...(textSource === null
      ? {}
      : { textSource: sourceDescriptor(textSource) }),
  };
  return canonicalEnvelope(
    operation === 'publish_post'
      ? {
          ...base,
          version: 7,
          allowAnonymousDm: null,
          textSource,
          home: {
            version: 1,
            admission: {
              id: randomUUID(),
              revision: 1,
              digest: 'a'.repeat(64),
              sourceCommit: LEGACY_HOME_POLICY_COMMIT,
              validUntil: '2030-01-01T00:00:00Z',
            },
            requestedIntent,
            requestedIntentHash: homeOriginalIntentHash(requestedIntent),
            requestedRegionId: regionId,
            legacyChoose: 2,
            targetWaterSpaceId: spaceId,
            targetWaterRegionId: regionId,
            auditExempt: false,
            result: null,
          },
        }
      : {
          ...base,
          version: 8,
          allowAnonymousDm: null,
          textSource,
          homeParent: {
            postId: base.postId,
            decisionId: randomUUID(),
            digest: 'b'.repeat(64),
          },
        },
  );
}
function originalHomeIntent(value: EffectiveContentEnvelope) {
  if (value.version === 7) return value.home.requestedIntent;
  if (value.version !== 8 || value.textSource === null)
    throw new Error('Source child required');
  const common = {
    text: value.text,
    imageAssetIds: [],
    authorMode: 'named',
    textSource: sourceDescriptor(value.textSource),
  };
  return value.purpose === 'publish_comment'
    ? { postId: value.postId, ...common }
    : {
        rootCommentId: value.rootCommentId,
        targetReplyId: value.targetReplyId,
        ...common,
      };
}
async function replayHomeReview(
  value: EffectiveContentEnvelope,
  originalIntent: unknown,
  options: { second?: EffectiveContentEnvelope; reject?: string } = {},
) {
  const operation = value.purpose,
    requestId = randomUUID(),
    events: string[] = [];
  let prepares = 0;
  const tx = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql === 'SAVEPOINT publication_work') events.push('savepoint');
      if (sql === 'ROLLBACK TO SAVEPOINT publication_work')
        events.push('rollback');
      if (sql === 'RELEASE SAVEPOINT publication_work') events.push('release');
      if (sql.startsWith('UPDATE whaleu_community.publication_requests'))
        throw new Error('Review-only work must not write a receipt');
      if (sql.startsWith('INSERT INTO whaleu_community.publication_requests')) {
        assert.equal(params[2], publicationHash(operation, originalIntent));
        assert.equal(params[3], operation);
      }
      return {
        rows: sql.startsWith('SELECT payload_hash,operation,receipt')
          ? [
              {
                payload_hash: publicationHash(operation, originalIntent),
                operation,
                receipt: null,
              },
            ]
          : [],
      };
    },
  } as unknown as PoolClient;
  const repository = new PublicationRepository(
    {
      database: {
        transaction: async <T>(fn: (tx: PoolClient) => Promise<T>) => fn(tx),
      },
    } as unknown as Args[0],
    {
      actor: async () => {
        events.push('actor');
        return accountId;
      },
    } as unknown as Args[1],
    {} as Args[2],
    {} as Args[3],
    {} as Args[4],
    {} as Args[5],
    {
      allocateForPublication: async () => {
        throw new Error('Review-only work must not allocate a reference');
      },
    },
    {
      configured: () => false,
      sourceConfigured: () => true,
      submit: async (
        actual: unknown,
        context: {
          clientRequestId: string;
          operation: string;
          intentHash: string;
        },
      ) => {
        assert.deepEqual(actual, value);
        assert.deepEqual(context, {
          clientRequestId: requestId,
          operation,
          intentHash: publicationHash(operation, originalIntent),
        });
        events.push('queue');
        return { requestId, operation, status: 'pending' };
      },
    } as unknown as Args[7],
  );
  const run = repository.execute(
    'current-session',
    requestId,
    operation,
    originalIntent,
    async () => {
      events.push('prepare');
      prepares++;
      throw new TextReviewSubmission(
        prepares === 1 ? value : (options.second ?? value),
      );
    },
    true,
  );
  if (options.reject) {
    await assert.rejects(
      run,
      (error: unknown) => (error as { code: string }).code === options.reject,
    );
    assert.deepEqual(
      events.filter((event) => event !== 'actor'),
      ['savepoint', 'prepare', 'rollback', 'prepare'],
    );
    assert.equal(events.filter((event) => event === 'actor').length, 2);
  } else {
    assert.equal((await run).status, 'pending');
    assert.deepEqual(
      events.filter((event) => event !== 'actor'),
      ['savepoint', 'prepare', 'rollback', 'prepare', 'queue', 'release'],
    );
    assert.equal(events.filter((event) => event === 'actor').length, 3);
  }
  assert.equal(prepares, 2);
}
for (const operation of [
  'publish_post',
  'publish_comment',
  'publish_reply',
] as const) {
  test(`source_manual ${operation} queues composed Review only after matching savepoint replay`, async () => {
    const value = homeEnvelope(operation, true),
      originalIntent = originalHomeIntent(value);
    const originalBytes = JSON.stringify(originalIntent);
    await replayHomeReview(value, originalIntent);
    assert.equal(JSON.stringify(originalIntent), originalBytes);
    if (value.version === 7)
      assert.equal(
        publicationHash(operation, originalIntent),
        value.home.requestedIntentHash,
      );
  });
  test(`source_manual ${operation} cannot queue null-source or mismatched composed descriptor`, async () => {
    const value = homeEnvelope(operation, true),
      originalIntent = originalHomeIntent(value);
    await replayHomeReview(homeEnvelope(operation, false), originalIntent, {
      reject: 'CONTENT_REVIEW_UNAVAILABLE',
    });
    await replayHomeReview(
      value,
      {
        ...originalIntent,
        textSource: { version: 1, format: 'plain', readingFormatting: 'auto' },
      },
      { reject: 'CONTENT_REVIEW_UNAVAILABLE' },
    );
  });
  test(`source_manual ${operation} cannot reuse changed composed evidence after savepoint rollback`, async () => {
    const value = homeEnvelope(operation, true),
      originalIntent = originalHomeIntent(value);
    const changed = structuredClone(value);
    if (changed.version === 7) changed.home.admission.revision++;
    else if (changed.version === 8)
      changed.homeParent.decisionId = randomUUID();
    await replayHomeReview(value, originalIntent, {
      second: canonicalEnvelope(changed),
      reject: 'COMMUNITY_UNAVAILABLE',
    });
  });
}
