import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ratingDiscussionContextSchema,
  ratingDiscussionMediaHashCancelSchema,
  ratingDiscussionMediaIntentSchema,
  ratingDiscussionMediaCommandHash,
  ratingDiscussionMediaReceiptSchema,
} from '../src/ratings/scoped/discussion-media-contracts.js';
import {
  ratingScopedIntentSchema,
  ratingScopedContextSchema,
} from '../src/ratings/scoped/contracts.js';
import {
  ratingTargetCoverIntentSchema,
  ratingTargetCoverContextSchema,
} from '../src/ratings/scoped/target-cover-contracts.js';
import {
  canonicalRatingDiscussionMediaEnvelope,
  ratingDiscussionMediaApprovalDigest,
  ratingDiscussionAttachmentSetDigest,
} from '../src/community/content-review/rating-discussion-media-contracts.js';
import { canonicalRatingScopedEnvelope } from '../src/community/content-review/rating-scoped-contracts.js';
import { canonicalRatingTargetCoverEnvelope } from '../src/community/content-review/rating-target-cover-contracts.js';
import { ratingDiscussionNoticePreviewSchema } from '../src/notifications/ratings/discussion-media-contracts.js';
const fixtures = JSON.parse(
  readFileSync(
    new URL(
      '../../../packages/fixtures/ratings-discussion-media-v1.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  contexts: { discussion4: unknown; targetCover3: unknown };
  cases: Array<{
    name: string;
    intent: unknown;
    intentHash: string;
    review: unknown;
    reviewDigest: string;
  }>;
};
for (const fixture of fixtures.cases)
  test(`discussion ${fixture.name} independent immutable golden`, () => {
    const intent = ratingDiscussionMediaIntentSchema.parse(fixture.intent);
    assert.equal(ratingDiscussionMediaCommandHash(intent), fixture.intentHash);
    assert.equal(ratingScopedIntentSchema.safeParse(intent).success, false);
    assert.equal(
      ratingTargetCoverIntentSchema.safeParse(intent).success,
      false,
    );
    const envelope = canonicalRatingDiscussionMediaEnvelope(fixture.review);
    assert.equal(
      ratingDiscussionMediaApprovalDigest(envelope),
      fixture.reviewDigest,
    );
    assert.equal(
      ratingDiscussionAttachmentSetDigest(envelope.images),
      envelope.attachmentSetDigest,
    );
    assert.throws(() => canonicalRatingScopedEnvelope(envelope));
    assert.throws(() => canonicalRatingTargetCoverEnvelope(envelope));
    assert.equal(Object.isFrozen(envelope.images), true);
    assert.equal(Object.isFrozen(envelope.scope), true);
  });
test('root9/reply3 exact set, text canonicalization and client authority rejection', () => {
  for (const fixture of fixtures.cases.slice(0, 2)) {
    const intent = ratingDiscussionMediaIntentSchema.parse(fixture.intent);
    const p = intent.payload;
    for (const payload of [
      {
        ...p,
        images: [
          ...p.images,
          {
            ordinal: p.images.length,
            memberId: '00000000-0000-4000-8000-000000009999',
            assetId: '00000000-0000-4000-8000-000000009998',
          },
        ],
      },
      { ...p, images: [] },
      {
        ...p,
        images: p.images.map((image, index) => ({
          ...image,
          assetId: index ? p.images[0]!.assetId : image.assetId,
        })),
      },
      { ...p, images: [...p.images].reverse() },
      {
        ...p,
        images: p.images.map((image) => ({
          ...image,
          manifestDigest: 'a'.repeat(64),
        })),
      },
      { ...p, body: ' noncanonical ' },
      { ...p, authorId: '00000000-0000-4000-8000-000000009999' },
      { ...p, batchRequestId: p.clientRequestId },
    ])
      assert.equal(
        ratingDiscussionMediaIntentSchema.safeParse({ ...intent, payload })
          .success,
        false,
      );
    assert.equal(
      ratingDiscussionMediaReceiptSchema.safeParse({
        protocolVersion: 4,
        requestId: p.clientRequestId,
        operation: intent.operation,
        intentHash: fixture.intentHash,
        outcome: 'noop',
        result: {},
      }).success,
      false,
    );
  }
});
test('changing the ninth manifest or dropping a slot invalidates whole Review', () => {
  const original = canonicalRatingDiscussionMediaEnvelope(
    fixtures.cases[0]!.review,
  );
  assert.throws(() =>
    canonicalRatingDiscussionMediaEnvelope({
      ...original,
      images: original.images.map((image, ordinal) =>
        ordinal === 8 ? { ...image, manifestDigest: 'f'.repeat(64) } : image,
      ),
    }),
  );
  assert.throws(() =>
    canonicalRatingDiscussionMediaEnvelope({
      ...original,
      images: original.images.slice(0, 8),
    }),
  );
  const changed = original.images.map((image, ordinal) =>
    ordinal === 8 ? { ...image, manifestDigest: 'f'.repeat(64) } : image,
  );
  const whole = canonicalRatingDiscussionMediaEnvelope({
    ...original,
    images: changed,
    attachmentSetDigest: ratingDiscussionAttachmentSetDigest(changed),
  });
  assert.notEqual(
    ratingDiscussionMediaApprovalDigest(whole),
    fixtures.cases[0]!.reviewDigest,
  );
});
test('notification media preview is separate and cannot encode an empty success', () => {
  assert.equal(
    ratingDiscussionNoticePreviewSchema.safeParse({
      body: '',
      imageCount: 0,
      thumbnail: null,
      author: {
        mode: 'anonymous',
        targetId: '00000000-0000-4000-8000-000000000008',
        personaId: '00000000-0000-4000-8000-000000000077',
        displayName: 'A',
      },
    }).success,
    false,
  );
});

test('shared context golden keeps cover3 and discussion4 separately branded', () => {
  const discussion = ratingDiscussionContextSchema.parse(
    fixtures.contexts.discussion4,
  );
  const cover = ratingTargetCoverContextSchema.parse(
    fixtures.contexts.targetCover3,
  );
  assert.notEqual(discussion.id, cover.id);
  assert.notEqual(discussion.token, cover.token);
  assert.deepEqual(discussion.heads, cover.heads);
  assert.equal(
    ratingTargetCoverContextSchema.safeParse(discussion).success,
    false,
  );
  assert.equal(ratingDiscussionContextSchema.safeParse(cover).success, false);
  assert.equal(ratingScopedContextSchema.safeParse(discussion).success, false);
  assert.equal(
    ratingDiscussionContextSchema.safeParse({ ...cover, protocolVersion: 4 })
      .success,
    false,
  );
  assert.equal(
    ratingDiscussionContextSchema.safeParse({
      ...discussion,
      capabilities: ['target_cover'],
    }).success,
    false,
  );
});
test('scrubbed command cancellation accepts only original opaque operation/hash', () => {
  const input = {
    protocolVersion: 4,
    operation: 'create_comment_scoped',
    intentHash: 'a'.repeat(64),
  };
  assert.equal(
    ratingDiscussionMediaHashCancelSchema.safeParse(input).success,
    true,
  );
  for (const extra of [
    { body: 'private' },
    { context: {} },
    { images: [] },
    { protocolVersion: 3 },
    { operation: 'create_target_scoped' },
  ])
    assert.equal(
      ratingDiscussionMediaHashCancelSchema.safeParse({ ...input, ...extra })
        .success,
      false,
    );
});
