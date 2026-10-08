import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  rewardBeneficiaries,
  isRewardEventType,
} from '../src/community/experience-source/contracts.js';
import type { RewardFacts } from '../src/community/experience-source/contracts.js';
import { CommunityExperienceSourceFacade } from '../src/community/experience-source/facade.js';
import {
  postLikeIntentHash,
  postLikeIntentSchema,
} from '../src/community/post-like/contracts.js';
const actor = randomUUID(),
  post = randomUUID(),
  root = randomUUID(),
  target = randomUUID();
const facts: RewardFacts = {
  eventType: 'post_created',
  actorId: actor,
  resourceAuthorId: actor,
  postAuthorId: post,
  rootAuthorId: root,
  targetReplyAuthorId: target,
};
function units(input: Partial<RewardFacts>) {
  return rewardBeneficiaries({ ...facts, ...input })
    .map((unit) => `${unit.beneficiaryId}:${unit.action}`)
    .sort();
}
test('community reward source matrix retains actual actor, deduplicated nonself recipients and typed actions', () => {
  assert.deepEqual(units({}), [`${actor}:publish`]);
  assert.deepEqual(
    units({ eventType: 'comment_created' }),
    [`${actor}:comment`, `${post}:received_comment`].sort(),
  );
  assert.deepEqual(
    units({ eventType: 'reply_created' }),
    [
      `${actor}:comment`,
      `${root}:received_comment`,
      `${target}:received_comment`,
    ].sort(),
  );
  assert.deepEqual(
    units({ eventType: 'reply_created', targetReplyAuthorId: root }),
    [`${actor}:comment`, `${root}:received_comment`].sort(),
  );
  assert.deepEqual(
    units({
      eventType: 'reply_created',
      rootAuthorId: actor,
      targetReplyAuthorId: actor,
    }),
    [`${actor}:comment`],
  );
  assert.deepEqual(
    units({ eventType: 'reply_created', targetReplyAuthorId: null }),
    [`${actor}:comment`, `${root}:received_comment`].sort(),
  );
  for (const eventType of [
    'post_liked',
    'comment_liked',
    'reply_liked',
    'post_saved',
  ] as const) {
    assert.deepEqual(
      units({ eventType, resourceAuthorId: post }),
      [`${actor}:like_save`, `${post}:received_like_save`].sort(),
    );
    assert.deepEqual(units({ eventType, resourceAuthorId: actor }), [
      `${actor}:like_save`,
    ]);
  }
  for (const kind of ['post', 'comment', 'reply'] as const)
    assert.deepEqual(units({ eventType: `${kind}_deleted` }), [
      `${actor}:delete_${kind}`,
    ]);
});
test('nonreward transition types cannot become an experience source', () => {
  for (const value of [
    'post_unliked',
    'comment_unliked',
    'reply_unliked',
    'post_unsaved',
    'moderation_removed',
    'comment_pinned',
    'formation_joined',
    'poll_voted',
    'post_saved_envelope',
    'sign_in',
  ])
    assert.equal(isRewardEventType(value), false);
  assert.equal(isRewardEventType('post_saved'), true);
});
test('post-like greenfield intent is explicit and strict; exact hashes retain post and desired state', () => {
  const requestId = randomUUID();
  assert.deepEqual(
    postLikeIntentSchema.parse({
      requestId: requestId.toUpperCase(),
      liked: false,
    }),
    { requestId, liked: false },
  );
  for (const value of [
    {},
    { requestId },
    { liked: true },
    { requestId, liked: 'true' },
    { requestId, liked: true, ownerId: actor },
    { requestId, liked: true, points: 1 },
    { requestId, desired: true },
  ])
    assert.equal(postLikeIntentSchema.safeParse(value).success, false);
  assert.equal(
    postLikeIntentHash(post.toUpperCase(), true),
    postLikeIntentHash(post, true),
  );
  assert.notEqual(
    postLikeIntentHash(post, false),
    postLikeIntentHash(post, true),
  );
  assert.notEqual(
    postLikeIntentHash(root, true),
    postLikeIntentHash(post, true),
  );
});
test('source facade reads only immutable snapshots and acknowledges only the exact settled Saved unit', async () => {
  const unitId = randomUUID(),
    groupId = randomUUID(),
    sourceId = randomUUID(),
    settlementId = randomUUID();
  const calls: { sql: string; args: unknown[] }[] = [];
  const tx = {
    query: async (sql: string, args: unknown[]) => {
      calls.push({ sql, args });
      if (sql.includes('AS "unitId"'))
        return {
          rows: [
            {
              unitId,
              groupId,
              beneficiaryId: actor,
              action: 'like_save',
              occurredAt: null,
              sourceKind: 'saved_obligation',
              sourceId,
            },
          ],
        };
      if (sql.startsWith('SELECT u.saved_obligation_id'))
        return { rows: [{ saved_obligation_id: sourceId }] };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const facade = new CommunityExperienceSourceFacade();
  assert.deepEqual(await facade.loadUnit(unitId, tx), {
    unitId,
    groupId,
    beneficiaryId: actor,
    action: 'like_save',
    occurredAt: null,
    sourceKind: 'saved_obligation',
    sourceId,
  });
  await facade.acknowledge(unitId, settlementId, tx);
  assert.ok(
    calls.every(
      ({ sql }) =>
        !/FOR (UPDATE|SHARE)|advisory|post_likes|saved_posts|root_comments|visibility/.test(
          sql,
        ),
    ),
  );
  assert.deepEqual(calls.at(-1)?.args, [sourceId]);
  assert.match(
    calls.at(-1)!.sql,
    /saved_obligations SET status='completed' WHERE id=\$1/,
  );
  const absent = { query: async () => ({ rows: [] }) } as unknown as PoolClient;
  assert.equal(await facade.loadUnit(unitId, absent), null);
  const preciseAt = '2001-01-01 00:00:00.123456+00';
  const precise = {
    query: async () => ({
      rows: [
        {
          unitId,
          groupId,
          beneficiaryId: actor,
          action: 'like_save',
          occurredAt: preciseAt,
          sourceKind: 'saved_obligation',
          sourceId,
        },
      ],
    }),
  } as unknown as PoolClient;
  assert.equal((await facade.loadUnit(unitId, precise))!.occurredAt, preciseAt);
  await assert.rejects(
    facade.acknowledge(unitId, settlementId, absent),
    /does not match/,
  );
});
