import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { publishPostSchema } from '../src/community/contracts.js';
import {
  pollComponentSchema,
  ballotSchema,
} from '../src/community/polls/contracts.js';
import { ballotHash } from '../src/community/polls/ballot-requests.repository.js';
import { publicationHash } from '../src/community/publication.repository.js';
import { postIntent } from '../src/community/publication-intent.js';
import { voteReason } from '../src/community/polls/poll-read.service.js';
import { requireAction } from '../src/community/community-policy.js';
import { verified } from './support/community-fixtures.js';
const component = {
  kind: 'poll',
  question: '你选哪一个？',
  selectionMode: 'single',
  options: ['甲', '乙', '吃瓜🍉'],
};
test('poll input has 2–5 total options, >=2 ordinary, optional last reserved label, strict 255 codepoint Unicode and no deadline', () => {
  assert.equal(pollComponentSchema.safeParse(component).success, true);
  assert.equal(
    pollComponentSchema.safeParse({ ...component, options: ['甲', '乙'] })
      .success,
    true,
  );
  assert.equal(
    pollComponentSchema.safeParse({
      ...component,
      question: '🐳'.repeat(255),
      options: ['🐳'.repeat(255), '乙'],
    }).success,
    true,
  );
  for (const change of [
    { question: '' },
    { question: '\t ' },
    { question: '🐳'.repeat(256) },
    { question: '\ud800' },
    { question: '\r' },
    { question: 'a\0' },
    { options: [] },
    { options: ['甲'] },
    { options: ['甲', '乙', '丙', '丁', '戊', '吃瓜🍉'] },
    { options: ['甲', '吃瓜🍉'] },
    { options: ['吃瓜🍉', '甲', '乙'] },
    { options: ['甲', ' 甲 '] },
    { options: ['甲', ' '] },
    { options: ['甲', '🐳'.repeat(256)] },
    { options: ['甲', 1] },
    { options: ['甲', 'x\u0085'] },
    { selectionMode: '1' },
    { selectionMode: 1 },
    { deadline: null },
    { group: { capacity: 5 } },
  ])
    assert.equal(
      pollComponentSchema.safeParse({ ...component, ...change }).success,
      false,
      JSON.stringify(change),
    );
  const preserved = pollComponentSchema.parse({
    ...component,
    question: ' Q\r\n ',
    options: [' A ', 'B', ' 吃瓜🍉 '],
  });
  assert.equal(preserved.question, ' Q\n ');
  assert.deepEqual(preserved.options, [' A ', 'B', ' 吃瓜🍉 ']);
});
test('component mutual exclusion, required post body and historical C1 hashes remain unchanged', () => {
  const body = publishPostSchema.parse({
    clientRequestId: randomUUID(),
    spaceId: randomUUID(),
    category: 'discussion',
    text: 'body',
    authorMode: 'named',
  });
  const historical = {
    spaceId: body.spaceId,
    category: body.category,
    text: body.text,
    imageAssetIds: [],
    authorMode: body.authorMode,
    commentsPolicy: 'open',
  };
  assert.equal(
    publicationHash('publish_post', postIntent(body)),
    publicationHash('publish_post', historical),
  );
  assert.equal(
    publicationHash(
      'publish_post',
      postIntent({ ...body, component: { kind: 'none' } }),
    ),
    publicationHash('publish_post', historical),
  );
  for (const component of [
    { kind: 'group', capacity: 5 },
    { kind: 'link', url: 'https://example.com' },
    { kind: 'none', poll: {} },
  ])
    assert.equal(
      publishPostSchema.safeParse({ ...body, component }).success,
      false,
    );
  assert.equal(
    publishPostSchema.safeParse({ ...body, text: ' ', component }).success,
    false,
  );
  const poll = publishPostSchema.parse({ ...body, component });
  for (const change of [
    { question: 'other' },
    { selectionMode: 'multiple' },
    { options: ['乙', '甲', '吃瓜🍉'] },
  ]) {
    const altered = publishPostSchema.parse({
      ...body,
      component: { ...component, ...change },
    });
    assert.notEqual(
      publicationHash('publish_post', postIntent(poll)),
      publicationHash('publish_post', postIntent(altered)),
    );
  }
});
test('ballot canonicalization is a UUID set, with no selector/coercions/duplicates/empty options', () => {
  const a = randomUUID(),
    b = randomUUID(),
    post = randomUUID(),
    clientRequestId = randomUUID();
  assert.deepEqual(
    ballotSchema.parse({ clientRequestId, optionIds: [b.toUpperCase(), a] })
      .optionIds,
    [a, b].sort(),
  );
  assert.equal(
    ballotHash(post, [a, b]),
    ballotHash(post.toUpperCase(), [b.toUpperCase(), a]),
  );
  for (const extra of [
    { optionIds: [] },
    { optionIds: [a, a] },
    { optionIds: [a, a.toUpperCase()] },
    { optionIds: [0] },
    { accountId: a },
    { optionIds: ['0'] },
  ])
    assert.equal(
      ballotSchema.safeParse({ clientRequestId, optionIds: [a], ...extra })
        .success,
      false,
    );
});
test('voting requires phone and vote restriction only; author/student/identity campus do not invent gates', () => {
  const authority = {
    ...verified(randomUUID()),
    studentVerified: false,
    identityRegionId: null,
    unverifiedCategories: [],
    restrictedActions: ['publish_post' as const],
  };
  requireAction(authority, 'vote');
  assert.equal(voteReason('actor', authority, false, false), null);
  assert.equal(voteReason(null, null, false, false), 'AUTHENTICATION_REQUIRED');
  assert.equal(
    voteReason('actor', null, false, false),
    'COMMUNITY_UNAVAILABLE',
  );
  assert.equal(
    voteReason('actor', { ...authority, phoneVerified: false }, false, false),
    'PHONE_VERIFICATION_REQUIRED',
  );
  assert.equal(
    voteReason(
      'actor',
      { ...authority, restrictedActions: ['vote'] },
      false,
      false,
    ),
    'COMMUNITY_ACTION_RESTRICTED',
  );
  assert.equal(voteReason('actor', authority, false, true), 'POLL_EXPIRED');
  assert.equal(voteReason('actor', null, true, true), 'POLL_ALREADY_VOTED');
});

test('expiry compares the locked stored database deadline, preserving sub-millisecond historical precision', async () => {
  const { PollRepository } =
    await import('../src/community/polls/poll.repository.js');
  const id = randomUUID();
  let statement = '';
  let values: unknown[] = [];
  const tx = {
    query: async (sql: string, args: unknown[]) => {
      statement = sql;
      values = args;
      return { rows: [{ expired: false }] };
    },
  } as unknown as import('pg').PoolClient;
  assert.equal(
    await new PollRepository().expired(
      {
        id,
        post_id: randomUUID(),
        question: 'q',
        selection_mode: 'single',
        deadline: new Date(),
      },
      tx,
    ),
    false,
  );
  assert.match(statement, /deadline<=clock_timestamp\(\)/);
  assert.match(statement, /WHERE id=\$1/);
  assert.deepEqual(values, [id]);
});
