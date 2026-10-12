import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  windowDiscussionBodySchema,
  windowRootPublishSchema,
  windowReplyPublishSchema,
  windowDiscussionLikeSchema,
  windowDiscussionReceiptSchema,
  windowDiscussionItemSchema,
} from '../src/ratings/windows/discussion/contracts.js';
import { windowDiscussionIntentHash } from '../src/ratings/windows/discussion/service.js';
import { windowDiscussionReviewDigest } from '../src/community/content-review/window-discussion-review.facade.js';
test('W3 exact bounded Unicode text; no image-only, coercion, anonymity or author spoof', () => {
  for (const text of [
    '0',
    '  x\n',
    'é',
    'e\u0301',
    '🍱'.repeat(2000),
    '菜'.repeat(2666),
  ])
    assert.equal(windowDiscussionBodySchema.parse(text), text);
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
    assert.equal(windowDiscussionBodySchema.safeParse(text).success, false);
  const q = {
    clientRequestId: randomUUID(),
    expectedCatalogRevision: randomUUID(),
    expectedWindowRevision: randomUUID(),
    body: 'text',
  };
  assert.deepEqual(windowRootPublishSchema.parse(q), q);
  for (const extra of [
    { images: [] },
    { actorId: randomUUID() },
    { anonymous: true },
    { rootId: randomUUID() },
    { replyToUserId: randomUUID() },
  ])
    assert.equal(
      windowRootPublishSchema.safeParse({ ...q, ...extra }).success,
      false,
    );
  assert.ok(
    windowReplyPublishSchema.safeParse({ ...q, replyToReplyId: null }).success,
  );
  assert.equal(windowReplyPublishSchema.safeParse(q).success, false);
});
test('W3 exact Review root and reply purposes bind actor/key/source/body/root/explicit target/server-derived actor', () => {
  const e = {
      version: 1 as const,
      purpose: 'window.discussion.reply.v1' as const,
      actorId: randomUUID(),
      requestId: randomUUID(),
      windowId: randomUUID(),
      catalogRevision: randomUUID(),
      windowRevision: randomUUID(),
      body: ' é ',
      rootId: randomUUID(),
      replyToReplyId: randomUUID(),
      replyToActorId: randomUUID(),
    },
    digest = windowDiscussionReviewDigest(e);
  assert.equal(windowDiscussionReviewDigest({ ...e }), digest);
  for (const field of [
    'actorId',
    'requestId',
    'windowId',
    'catalogRevision',
    'windowRevision',
    'rootId',
    'replyToReplyId',
    'replyToActorId',
  ] as const)
    assert.notEqual(
      windowDiscussionReviewDigest({ ...e, [field]: randomUUID() }),
      digest,
    );
  assert.notEqual(windowDiscussionReviewDigest({ ...e, body: 'é' }), digest);
  assert.notEqual(
    windowDiscussionReviewDigest({
      ...e,
      purpose: 'window.discussion.root.v1',
    }),
    digest,
  );
});
test('W3 desired-state CAS and operation/target intent hash cannot be changed under same key', () => {
  const actor = randomUUID(),
    window = randomUUID(),
    subject = randomUUID(),
    q = {
      clientRequestId: randomUUID(),
      expectedCatalogRevision: randomUUID(),
      expectedWindowRevision: randomUUID(),
      expectedMembershipRevision: null,
      active: true,
    };
  assert.deepEqual(windowDiscussionLikeSchema.parse(q), q);
  for (const active of ['true', 1, null])
    assert.equal(
      windowDiscussionLikeSchema.safeParse({ ...q, active }).success,
      false,
    );
  const h = windowDiscussionIntentHash(
    actor,
    window,
    subject,
    'window.discussion.like.v1',
    q,
  );
  for (const changed of [
    { ...q, active: false },
    { ...q, expectedMembershipRevision: randomUUID() },
    { ...q, expectedWindowRevision: randomUUID() },
  ])
    assert.notEqual(
      windowDiscussionIntentHash(
        actor,
        window,
        subject,
        'window.discussion.like.v1',
        changed,
      ),
      h,
    );
  assert.notEqual(
    windowDiscussionIntentHash(
      actor,
      window,
      randomUUID(),
      'window.discussion.like.v1',
      q,
    ),
    h,
  );
  const receipt = {
    requestId: q.clientRequestId,
    windowId: window,
    commentId: subject,
    operation: 'window.discussion.like.v1',
    outcome: 'noop',
    active: false,
    membershipRevision: null,
    recordedAt: null,
  };
  assert.ok(windowDiscussionReceiptSchema.safeParse(receipt).success);
  assert.equal(
    windowDiscussionReceiptSchema.safeParse({ ...receipt, outcome: 'applied' })
      .success,
    false,
  );
  assert.equal(
    windowDiscussionReceiptSchema.safeParse({ ...receipt, active: true })
      .success,
    false,
  );
  assert.equal(
    windowDiscussionReceiptSchema.safeParse({ ...receipt, actorId: actor })
      .success,
    false,
  );
});
test('W3 named safe public profile projection exposes no account ID, avatar URL, delete, anonymity or rewards', () => {
  const item = {
    id: randomUUID(),
    windowId: randomUUID(),
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
  assert.ok(windowDiscussionItemSchema.safeParse(item).success);
  for (const field of [
    'accountId',
    'actorId',
    'avatar',
    'delete',
    'reward',
    'images',
  ])
    assert.equal(
      windowDiscussionItemSchema.safeParse({ ...item, [field]: 'extra' })
        .success,
      false,
    );
});
