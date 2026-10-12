import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  MAJOR_DISCUSSION_V2,
  majorRootPublishV2Schema,
  majorReplyPublishV2Schema,
  majorDiscussionIntentHashV2,
} from '../src/majors/discussion/contracts-v2.js';
import { majorRootPublishSchema } from '../src/majors/discussion/contracts.js';
import { majorDiscussionMediaReviewDigest } from '../src/community/content-review/major-discussion-media-review.facade.js';

const command = () => ({
  protocol: MAJOR_DISCUSSION_V2,
  clientRequestId: randomUUID(),
  expectedCatalogRevision: randomUUID(),
  expectedMajorRevision: randomUUID(),
  body: '专业讨论',
  images: [
    { assetId: randomUUID(), manifestDigest: 'a'.repeat(64) },
    { assetId: randomUUID(), manifestDigest: 'b'.repeat(64) },
  ],
});

test('Major v2 root and reply require unchanged valid text even with accepted images', () => {
  const raw = command();
  for (const body of [
    '',
    ' ',
    '\t\r\n',
    '\u3000',
    '\u0000',
    '\ud800',
    '界'.repeat(2667),
  ]) {
    assert.equal(
      majorRootPublishV2Schema.safeParse({ ...raw, body }).success,
      false,
    );
    assert.equal(
      majorReplyPublishV2Schema.safeParse({
        ...raw,
        body,
        replyToReplyId: null,
      }).success,
      false,
    );
  }
  for (const body of ['0', '  保留空格  ', '界'.repeat(2666)]) {
    assert.equal(majorRootPublishV2Schema.parse({ ...raw, body }).body, body);
    assert.equal(
      majorReplyPublishV2Schema.parse({ ...raw, body, replyToReplyId: null })
        .body,
      body,
    );
  }
  assert.equal(
    majorRootPublishV2Schema.safeParse({ ...raw, images: [] }).success,
    true,
  );
});

test('Major v1 admission stays text-only; v2 hash binds exact ordered images, purpose and Major', () => {
  const raw = command(),
    actor = randomUUID(),
    major = randomUUID();
  const hash = majorDiscussionIntentHashV2(
    actor,
    major,
    null,
    'major.discussion.root.v2',
    raw,
  );
  assert.equal(majorRootPublishSchema.safeParse(raw).success, false);
  const v1 = {
    clientRequestId: raw.clientRequestId,
    expectedCatalogRevision: raw.expectedCatalogRevision,
    expectedMajorRevision: raw.expectedMajorRevision,
    body: raw.body,
  };
  assert.equal(majorRootPublishSchema.safeParse(v1).success, true);
  assert.equal(
    majorRootPublishSchema.safeParse({ ...v1, images: [] }).success,
    false,
  );
  for (const next of [
    { ...raw, images: [...raw.images].reverse() },
    { ...raw, body: raw.body + ' ' },
  ])
    assert.notEqual(
      majorDiscussionIntentHashV2(
        actor,
        major,
        null,
        'major.discussion.root.v2',
        next,
      ),
      hash,
    );
  assert.notEqual(
    majorDiscussionIntentHashV2(
      actor,
      randomUUID(),
      null,
      'major.discussion.root.v2',
      raw,
    ),
    hash,
  );
  assert.notEqual(
    majorDiscussionIntentHashV2(
      actor,
      major,
      randomUUID(),
      'major.discussion.reply.v2',
      { ...raw, replyToReplyId: null },
    ),
    hash,
  );
  assert.equal(
    majorRootPublishV2Schema.safeParse({
      ...raw,
      protocol: 'window-discussion-v2',
    }).success,
    false,
  );
});

test('Major v2 Review has an independent purpose and exact ordered image domain', () => {
  const raw = command();
  const envelope = {
    version: 2 as const,
    purpose: 'major.discussion.root.v2' as const,
    actorId: randomUUID(),
    requestId: raw.clientRequestId,
    majorId: randomUUID(),
    catalogRevision: raw.expectedCatalogRevision,
    majorRevision: raw.expectedMajorRevision,
    body: raw.body,
    images: raw.images,
    rootId: null,
    replyToReplyId: null,
    replyToActorId: null,
  };
  assert.notEqual(
    majorDiscussionMediaReviewDigest(envelope),
    majorDiscussionMediaReviewDigest({
      ...envelope,
      images: [...raw.images].reverse(),
    }),
  );
  assert.notEqual(
    majorDiscussionMediaReviewDigest(envelope),
    majorDiscussionMediaReviewDigest({
      ...envelope,
      purpose: 'major.discussion.reply.v2',
      rootId: randomUUID(),
    }),
  );
});
