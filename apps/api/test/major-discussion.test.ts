import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  majorDiscussionBodySchema,
  majorRootPublishSchema,
  majorReplyPublishSchema,
  majorDiscussionLikeSchema,
  majorDiscussionReceiptSchema,
  majorDiscussionItemSchema,
} from '../src/majors/discussion/contracts.js';
import { majorDiscussionIntentHash } from '../src/majors/discussion/service.js';
import { majorDiscussionReviewDigest } from '../src/community/content-review/major-discussion-review.facade.js';
test('M1 exact bounded Unicode text; no image-only, coercion, anonymity or author spoof', () => {
  for (const text of [
    '0',
    '  x\n',
    'é',
    'e\u0301',
    '🍱'.repeat(2000),
    '菜'.repeat(2666),
  ])
    assert.equal(majorDiscussionBodySchema.parse(text), text);
  for (const text of [
    '',
    ' ',
    '\ufeff',
    '\u0000',
    '\ud800',
    '\udc00',
    '🍱'.repeat(2001),
    3,
    null,
    {},
    [],
  ])
    assert.equal(majorDiscussionBodySchema.safeParse(text).success, false);
  const q = {
    clientRequestId: randomUUID(),
    expectedCatalogRevision: randomUUID(),
    expectedMajorRevision: randomUUID(),
    body: 'text',
  };
  assert.deepEqual(majorRootPublishSchema.parse(q), q);
  for (const extra of [
    { images: [] },
    { actorId: randomUUID() },
    { anonymous: true },
    { rootId: randomUUID() },
    { replyToUserId: randomUUID() },
  ])
    assert.equal(
      majorRootPublishSchema.safeParse({ ...q, ...extra }).success,
      false,
    );
  assert.ok(
    majorReplyPublishSchema.safeParse({ ...q, replyToReplyId: null }).success,
  );
  assert.equal(majorReplyPublishSchema.safeParse(q).success, false);
});
test('M1 exact Review root and reply purposes bind actor/key/source/body/root/explicit target/server-derived actor', () => {
  const e = {
      version: 1 as const,
      purpose: 'major.discussion.reply.v1' as const,
      actorId: randomUUID(),
      requestId: randomUUID(),
      majorId: randomUUID(),
      catalogRevision: randomUUID(),
      majorRevision: randomUUID(),
      body: ' é ',
      rootId: randomUUID(),
      replyToReplyId: randomUUID(),
      replyToActorId: randomUUID(),
    },
    digest = majorDiscussionReviewDigest(e);
  assert.equal(majorDiscussionReviewDigest({ ...e }), digest);
  for (const field of [
    'actorId',
    'requestId',
    'majorId',
    'catalogRevision',
    'majorRevision',
    'rootId',
    'replyToReplyId',
    'replyToActorId',
  ] as const)
    assert.notEqual(
      majorDiscussionReviewDigest({ ...e, [field]: randomUUID() }),
      digest,
    );
  assert.notEqual(majorDiscussionReviewDigest({ ...e, body: 'é' }), digest);
  assert.notEqual(
    majorDiscussionReviewDigest({
      ...e,
      purpose: 'major.discussion.root.v1',
    }),
    digest,
  );
});
test('M1 desired-state CAS and operation/target intent hash cannot be changed under same key', () => {
  const actor = randomUUID(),
    major = randomUUID(),
    subject = randomUUID(),
    q = {
      clientRequestId: randomUUID(),
      expectedCatalogRevision: randomUUID(),
      expectedMajorRevision: randomUUID(),
      expectedMembershipRevision: null,
      active: true,
    };
  assert.deepEqual(majorDiscussionLikeSchema.parse(q), q);
  for (const active of ['true', 1, null])
    assert.equal(
      majorDiscussionLikeSchema.safeParse({ ...q, active }).success,
      false,
    );
  const h = majorDiscussionIntentHash(
    actor,
    major,
    subject,
    'major.discussion.like.v1',
    q,
  );
  for (const changed of [
    { ...q, active: false },
    { ...q, expectedMembershipRevision: randomUUID() },
    { ...q, expectedMajorRevision: randomUUID() },
  ])
    assert.notEqual(
      majorDiscussionIntentHash(
        actor,
        major,
        subject,
        'major.discussion.like.v1',
        changed,
      ),
      h,
    );
  assert.notEqual(
    majorDiscussionIntentHash(
      actor,
      major,
      randomUUID(),
      'major.discussion.like.v1',
      q,
    ),
    h,
  );
  const receipt = {
    requestId: q.clientRequestId,
    majorId: major,
    commentId: subject,
    operation: 'major.discussion.like.v1',
    outcome: 'noop',
    active: false,
    membershipRevision: null,
    recordedAt: null,
  };
  assert.ok(majorDiscussionReceiptSchema.safeParse(receipt).success);
  assert.equal(
    majorDiscussionReceiptSchema.safeParse({ ...receipt, outcome: 'applied' })
      .success,
    false,
  );
  assert.equal(
    majorDiscussionReceiptSchema.safeParse({ ...receipt, active: true })
      .success,
    false,
  );
  assert.equal(
    majorDiscussionReceiptSchema.safeParse({ ...receipt, actorId: actor })
      .success,
    false,
  );
});
test('M1 named safe public profile projection exposes no account ID, avatar URL, delete, anonymity or rewards', () => {
  const item = {
    id: randomUUID(),
    majorId: randomUUID(),
    rootId: null,
    replyToReplyId: null,
    body: 'text',
    author: { mode: 'named', profileId: randomUUID(), displayName: 'User' },
    addressedAuthor: null,
    createdAt: new Date().toISOString(),
    likes: 0,
    replyCount: 0,
    isLiked: false,
    myMembershipRevision: null,
  };
  assert.ok(majorDiscussionItemSchema.safeParse(item).success);
  for (const field of [
    'accountId',
    'actorId',
    'avatar',
    'delete',
    'reward',
    'images',
  ])
    assert.equal(
      majorDiscussionItemSchema.safeParse({ ...item, [field]: 'extra' })
        .success,
      false,
    );
});
