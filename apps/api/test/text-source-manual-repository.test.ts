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
