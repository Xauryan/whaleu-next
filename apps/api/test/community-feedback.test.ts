import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { loadConfig } from '../src/config/config.js';
import { publishPostSchema } from '../src/community/contracts.js';
import { postIntent } from '../src/community/publication-intent.js';
import { publicationHash } from '../src/community/publication.repository.js';
import {
  approvalDigest,
  canonicalEnvelope,
} from '../src/community/content-review/contracts.js';
import { ApprovalRepository } from '../src/community/content-review/approval.repository.js';
import { TextReviewRuntime } from '../src/community/text-review/runtime.js';
import { requireFeedbackSpace } from '../src/community/feedback/topic.js';
import {
  requirePublication,
  type Authority,
} from '../src/community/community-policy.js';
const actor = randomUUID(),
  spaceId = randomUUID(),
  regionId = randomUUID(),
  policyId = randomUUID();
const feedback = () =>
  publishPostSchema.parse({
    clientRequestId: randomUUID(),
    spaceId,
    category: 'feedback',
    text: '公开建议',
    imageAssetIds: [],
    authorMode: 'anonymous',
    commentsPolicy: 'open',
    feedback: { contacts: { wechat: '', qq: '', phone: '' } },
  });
const envelope = () =>
  canonicalEnvelope({
    version: 3,
    accountId: actor,
    purpose: 'publish_post',
    spaceId,
    category: 'feedback',
    text: '公开建议',
    images: [],
    authorMode: 'anonymous',
    commentsPolicy: 'open',
    postId: null,
    rootCommentId: null,
    targetReplyId: null,
    component: { kind: 'none' },
    trading: null,
    feedback: feedback().feedback,
    scope: {
      originalSpaceId: spaceId,
      originalRegionId: null,
      authorOriginRegionId: regionId,
      identityRegionId: regionId,
      topologySnapshotId: null,
      sync: 'none',
    },
  });
const tx = (fn: (sql: string) => unknown[]) =>
  ({
    query: async (sql: string) => ({ rows: fn(sql) }),
  }) as unknown as PoolClient;
test('feedback is a strict public category with optional contacts and no invented poll or DM option', () => {
  assert.ok(feedback().feedback);
  for (const patch of [
    { feedback: undefined },
    { category: 'discussion' },
    {
      component: {
        kind: 'poll',
        question: '?',
        selectionMode: 'single',
        options: ['a', 'b'],
      },
    },
    { allowAnonymousDm: false },
    { commentsPolicy: 'restricted' },
    { feedback: { contacts: { wechat: '中'.repeat(17), qq: '', phone: '' } } },
    {
      feedback: {
        contacts: { wechat: '', qq: '', phone: '', accountId: actor },
      },
    },
  ])
    assert.equal(
      publishPostSchema.safeParse({ ...feedback(), ...patch }).success,
      false,
    );
  const nine = Array.from({ length: 9 }, () => randomUUID());
  assert.ok(
    publishPostSchema.safeParse({ ...feedback(), imageAssetIds: nine }).success,
  );
  assert.equal(
    publishPostSchema.safeParse({
      ...feedback(),
      imageAssetIds: [...nine, randomUUID()],
    }).success,
    false,
  );
});
test('feedback contacts and ordered images participate in exact intent and v3 approval; old hashes remain unchanged', () => {
  const body = feedback();
  const altered = {
    ...body,
    feedback: { contacts: { wechat: 'contact', qq: '', phone: '' } },
  };
  assert.notEqual(
    publicationHash('publish_post', postIntent(body)),
    publicationHash('publish_post', postIntent(altered)),
  );
  assert.equal(envelope().version, 3);
  assert.notEqual(
    approvalDigest(envelope()),
    approvalDigest(
      canonicalEnvelope({ ...envelope(), feedback: altered.feedback }),
    ),
  );
  assert.throws(() => canonicalEnvelope({ ...envelope(), version: 1 }));
  assert.throws(() =>
    canonicalEnvelope({
      ...envelope(),
      scope: { ...envelope().scope, originalRegionId: regionId },
    }),
  );
  const old = { ...body, category: 'discussion' as const, feedback: undefined };
  const intent = {
    spaceId: old.spaceId,
    category: old.category,
    text: old.text,
    imageAssetIds: old.imageAssetIds,
    authorMode: old.authorMode,
    commentsPolicy: old.commentsPolicy,
  };
  assert.equal(JSON.stringify(postIntent(old)), JSON.stringify(intent));
});
test('feedback requires explicit accepted topic binding, never a label or arbitrary global space', async () => {
  const space = {
    id: spaceId,
    kind: 'global' as const,
    name: '意见建议',
    isActive: true,
    operatingRegionId: null,
  };
  await assert.rejects(
    requireFeedbackSpace(
      space,
      tx(() => []),
    ),
  );
  await requireFeedbackSpace(
    space,
    tx(() => [{ space_id: spaceId }]),
  );
  await assert.rejects(
    requireFeedbackSpace(
      { ...space, kind: 'regional', operatingRegionId: regionId },
      tx(() => [{ space_id: spaceId }]),
    ),
  );
});
test('local feedback Review accepts both modes and real owned image digests only inside explicit feedback scope', async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://dev:test@127.0.0.1:55432/whaleu_test',
    COMMUNITY_TEXT_REVIEW: 'local_manual',
    COMMUNITY_TEXT_REVIEW_SPACE_ID: randomUUID(),
    COMMUNITY_TEXT_REVIEW_REGION_ID: regionId,
    COMMUNITY_TEXT_REVIEW_POLICY_ID: policyId,
    COMMUNITY_TEXT_REVIEW_OPERATOR: 'local:test',
    COMMUNITY_FEEDBACK_SPACE_ID: spaceId,
  });
  const service = new TextReviewRuntime(config, new ApprovalRepository()),
    client = tx((sql) =>
      sql.includes('feedback_topic')
        ? [{ space_id: spaceId }]
        : [{ id: policyId }],
    );
  await service.requireEnvelope(envelope(), client);
  await service.requireEnvelope(
    canonicalEnvelope({
      ...envelope(),
      images: Array.from({ length: 9 }, () => ({
        assetId: randomUUID(),
        digest: 'a'.repeat(64),
      })),
    }),
    client,
  );
  await assert.rejects(
    service.requireEnvelope(
      envelope(),
      tx(() => []),
    ),
  );
  assert.equal(
    await service.available(
      { id: spaceId, operatingRegionId: null },
      client,
      'discussion',
    ),
    false,
  );
  const otherSpace = randomUUID();
  await assert.rejects(
    service.requireEnvelope(
      canonicalEnvelope({
        ...envelope(),
        spaceId: otherSpace,
        scope: { ...envelope().scope, originalSpaceId: otherSpace },
      }),
      client,
    ),
  );
});
test('feedback keeps phone, student, identity and safety requirements; regional feedback is rejected', () => {
  const authority: Authority = {
    phoneVerified: true,
    studentVerified: true,
    identityRegionId: regionId,
    crossRegionAllowed: false,
    unverifiedCategories: [],
    unverifiedCommentsAllowed: false,
    restrictedActions: [],
    canManage: false,
  };
  const space = {
    id: spaceId,
    kind: 'global' as const,
    name: 'feedback',
    isActive: true,
    operatingRegionId: null,
  };
  for (const mode of ['named', 'anonymous'] as const)
    requirePublication(authority, space, 'feedback', mode, 'publish_post');
  for (const patch of [
    { phoneVerified: false },
    { studentVerified: false },
    { identityRegionId: null },
    { restrictedActions: ['publish_post' as const] },
  ])
    assert.throws(() =>
      requirePublication(
        { ...authority, ...patch },
        space,
        'feedback',
        'named',
        'publish_post',
      ),
    );
  assert.throws(() =>
    requirePublication(
      authority,
      { ...space, kind: 'regional', operatingRegionId: regionId },
      'feedback',
      'named',
      'publish_post',
    ),
  );
});
