import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { loadConfig } from '../src/config/config.js';
import { ApprovalRepository } from '../src/community/content-review/approval.repository.js';
import {
  approvalDigest,
  canonicalEnvelope,
} from '../src/community/content-review/contracts.js';
import { TextReviewRuntime } from '../src/community/text-review/runtime.js';
import {
  textReviewStatusSchema,
  TextReviewSubmission,
} from '../src/community/text-review/contracts.js';
import {
  reviewOperatorCommandSchema,
  TextReviewOperator,
} from '../src/community/text-review/operator.js';

const spaceId = randomUUID(),
  regionId = randomUUID(),
  accountId = randomUUID(),
  policyId = randomUUID();
const environment = {
  DATABASE_URL: 'postgresql://dev:test@127.0.0.1:55432/whaleu_test',
  NODE_ENV: 'test',
  COMMUNITY_TEXT_REVIEW: 'local_manual',
  COMMUNITY_TEXT_REVIEW_SPACE_ID: spaceId,
  COMMUNITY_TEXT_REVIEW_REGION_ID: regionId,
  COMMUNITY_TEXT_REVIEW_POLICY_ID: policyId,
  COMMUNITY_TEXT_REVIEW_OPERATOR: 'local:test:operator',
};
const envelope = () =>
  canonicalEnvelope({
    version: 1,
    accountId,
    purpose: 'publish_post',
    spaceId,
    category: 'discussion',
    authorMode: 'named',
    commentsPolicy: 'open',
    postId: null,
    rootCommentId: null,
    targetReplyId: null,
    text: 'Exact private text',
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
const runtime = () =>
  new TextReviewRuntime(loadConfig(environment), new ApprovalRepository());
function client(
  reply: (sql: string, values: unknown[]) => unknown[],
): PoolClient {
  return {
    query: async (sql: string, values: unknown[] = []) => ({
      rows: reply(sql, values),
    }),
  } as unknown as PoolClient;
}
test('local review disabled by default, missing fields and production fail closed', () => {
  assert.equal(
    loadConfig({ DATABASE_URL: environment.DATABASE_URL })
      .COMMUNITY_TEXT_REVIEW,
    'disabled',
  );
  assert.throws(() => loadConfig({ ...environment, NODE_ENV: 'production' }));
  for (const key of [
    'COMMUNITY_TEXT_REVIEW_SPACE_ID',
    'COMMUNITY_TEXT_REVIEW_REGION_ID',
    'COMMUNITY_TEXT_REVIEW_POLICY_ID',
    'COMMUNITY_TEXT_REVIEW_OPERATOR',
  ]) {
    const input: NodeJS.ProcessEnv = { ...environment };
    delete input[key];
    assert.throws(() => loadConfig(input));
  }
});
test('review status is separate, strict and accepts no issuer/envelope/client approval', () => {
  const status = {
    requestId: randomUUID(),
    operation: 'publish_post',
    status: 'pending',
  };
  assert.ok(textReviewStatusSchema.safeParse(status).success);
  for (const extra of [
    { outcome: 'created' },
    { issuer: 'admin' },
    { approved: true },
    { envelope: envelope() },
  ])
    assert.equal(
      textReviewStatusSchema.safeParse({ ...status, ...extra }).success,
      false,
    );
});
test('controlled operator schema never defaults a decision or accepts bulk allow', () => {
  const command = {
    command: 'decide',
    accountId,
    requestId: randomUUID(),
    digest: 'a'.repeat(64),
    basis: 'Reviewed displayed exact text',
    decision: 'allow',
  };
  assert.ok(reviewOperatorCommandSchema.safeParse(command).success);
  for (const patch of [
    { decision: undefined },
    { decision: 'approve' },
    { basis: '' },
    { digest: 'bad' },
    { all: true },
  ])
    assert.equal(
      reviewOperatorCommandSchema.safeParse({ ...command, ...patch }).success,
      false,
    );
});
test('operator rejects wrong OS identity before any database access', async () => {
  const tx = client(() => {
    throw new Error('database must not be accessed');
  });
  await assert.rejects(
    new TextReviewOperator(runtime(), 'local:other:user').run(
      { command: 'list' },
      tx,
    ),
    /Operator/,
  );
});
test('available requires exact configured single region/space and accepted policy', async () => {
  const service = runtime(),
    tx = client(() => [{ id: policyId }]);
  assert.equal(
    await service.available({ id: spaceId, operatingRegionId: regionId }, tx),
    true,
  );
  assert.equal(
    await service.available(
      { id: randomUUID(), operatingRegionId: regionId },
      tx,
    ),
    false,
  );
  assert.equal(
    await service.available(
      { id: spaceId, operatingRegionId: randomUUID() },
      tx,
    ),
    false,
  );
  assert.equal(
    await service.available(
      { id: spaceId, operatingRegionId: regionId },
      client(() => []),
    ),
    false,
  );
});
test('only named plain text can enter the local review queue', async () => {
  const service = runtime(),
    tx = client(() => [{ id: policyId }]);
  await service.requireEnvelope(envelope(), tx);
  for (const patch of [
    { authorMode: 'anonymous' },
    { images: [{ assetId: randomUUID(), digest: 'a'.repeat(64) }] },
    { commentsPolicy: 'restricted' },
    { component: { kind: 'poll' } },
    { version: 2, allowAnonymousDm: true },
  ])
    await assert.rejects(
      service.requireEnvelope(
        { ...envelope(), ...patch } as ReturnType<typeof envelope>,
        tx,
      ),
    );
});
test('internal submission canonicalizes server snapshot and never changes input', () => {
  const value = envelope();
  const signal = new TextReviewSubmission(value);
  assert.equal(approvalDigest(signal.envelope), approvalDigest(value));
  assert.ok(Object.isFrozen(signal.envelope));
});
test('an issued decision cannot be consumed by a different request with identical text', async () => {
  const value = envelope(),
    decisionId = randomUUID();
  const tx = client((sql) =>
    sql.includes('WHERE decision_id=$1') ? [{ exists: 1 }] : [],
  );
  await assert.rejects(
    runtime().requireBinding(
      value,
      {
        clientRequestId: randomUUID(),
        operation: 'publish_post',
        intentHash: 'a'.repeat(64),
      },
      {
        decisionId,
        version: value.version,
        digest: approvalDigest(value),
        envelope: value,
      },
      tx,
    ),
  );
});

test('single-region policy requires explicit named-only choices and exact preview acknowledgment', () => {
  const preview = {
    command: 'preview-region',
    postEnabled: true,
    commentEnabled: true,
    namedOnly: true,
    categories: ['discussion'],
    validForHours: 24,
    basis: 'Explicit local experiment',
  };
  assert.ok(reviewOperatorCommandSchema.safeParse(preview).success);
  for (const patch of [
    { namedOnly: false },
    { postEnabled: undefined },
    { commentEnabled: undefined },
    { categories: ['trading'] },
    { categories: ['discussion', 'discussion'] },
    { validForHours: 169 },
  ])
    assert.equal(
      reviewOperatorCommandSchema.safeParse({ ...preview, ...patch }).success,
      false,
    );
  assert.equal(
    reviewOperatorCommandSchema.safeParse({
      ...preview,
      command: 'apply-region',
    }).success,
    false,
  );
  assert.ok(
    reviewOperatorCommandSchema.safeParse({
      ...preview,
      command: 'apply-region',
      expectedRevision: 0,
      previewDigest: 'a'.repeat(64),
    }).success,
  );
});

test('review submission rolls back tentative work and reacquires preparation before queue commit', async () => {
  const { PublicationRepository, publicationHash } =
    await import('../src/community/publication.repository.js');
  type Args = ConstructorParameters<typeof PublicationRepository>;
  const requestId = randomUUID(),
    intent = { text: 'Original intent' },
    events: string[] = [];
  const value = envelope();
  const tx = client((sql) => {
    if (sql === 'SAVEPOINT publication_work') events.push('savepoint');
    if (sql === 'ROLLBACK TO SAVEPOINT publication_work')
      events.push('rollback');
    if (sql === 'RELEASE SAVEPOINT publication_work') events.push('release');
    if (sql.startsWith('UPDATE whaleu_community.publication_requests'))
      throw new Error('Review must not write a terminal receipt');
    if (sql.startsWith('SELECT payload_hash,operation,receipt'))
      return [
        {
          payload_hash: publicationHash('publish_post', intent),
          operation: 'publish_post',
          receipt: null,
        },
      ];
    return [];
  });
  const repository = new PublicationRepository(
    {
      database: {
        transaction: async <T>(fn: (client: PoolClient) => Promise<T>) =>
          fn(tx),
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
        throw new Error(
          'Review-only work must not allocate permanent references',
        );
      },
    },
    {
      configured: () => true,
      submit: async () => {
        events.push('queue');
        return { requestId, operation: 'publish_post', status: 'pending' };
      },
    } as unknown as Args[7],
  );
  const result = await repository.execute(
    'private-session',
    requestId,
    'publish_post',
    intent,
    async () => {
      events.push('prepare');
      throw new TextReviewSubmission(value);
    },
    true,
  );
  assert.equal(result.status, 'pending');
  assert.deepEqual(
    events.filter((e) => e !== 'actor'),
    ['savepoint', 'prepare', 'rollback', 'prepare', 'queue', 'release'],
  );
  assert.equal(events.filter((e) => e === 'actor').length, 3);
});

test('fresh preparation mismatch fails instead of using rolled-back authorization facts', async () => {
  const { PublicationRepository, publicationHash } =
    await import('../src/community/publication.repository.js');
  type Args = ConstructorParameters<typeof PublicationRepository>;
  const intent = { text: 'Original' },
    requestId = randomUUID(),
    value = envelope();
  let prepared = 0,
    queued = false;
  const tx = client((sql) =>
    sql.startsWith('SELECT payload_hash,operation,receipt')
      ? [
          {
            payload_hash: publicationHash('publish_post', intent),
            operation: 'publish_post',
            receipt: null,
          },
        ]
      : [],
  );
  const repository = new PublicationRepository(
    {
      database: {
        transaction: async <T>(fn: (client: PoolClient) => Promise<T>) =>
          fn(tx),
      },
    } as unknown as Args[0],
    { actor: async () => accountId } as unknown as Args[1],
    {} as Args[2],
    {} as Args[3],
    {} as Args[4],
    {} as Args[5],
    {
      allocateForPublication: async () => {
        throw new Error(
          'Review-only work must not allocate permanent references',
        );
      },
    },
    {
      configured: () => true,
      submit: async () => {
        queued = true;
      },
    } as unknown as Args[7],
  );
  await assert.rejects(
    repository.execute(
      'private-session',
      requestId,
      'publish_post',
      intent,
      async () => {
        prepared++;
        throw new TextReviewSubmission(
          prepared === 1
            ? value
            : { ...value, text: 'Changed server snapshot' },
        );
      },
      true,
    ),
  );
  assert.equal(prepared, 2);
  assert.equal(queued, false);
});
