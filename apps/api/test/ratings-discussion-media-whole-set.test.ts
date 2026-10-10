import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Decision } from '../src/community/community-policy.js';
import { canonicalRatingDiscussionMediaEnvelope } from '../src/community/content-review/rating-discussion-media-contracts.js';
import {
  ratingDiscussionWholeSetDecision,
  type RatingDiscussionImageCurrent,
} from '../src/ratings/discussion-media-whole-set.js';
const fixtures = JSON.parse(
  readFileSync(
    new URL(
      '../../../packages/fixtures/ratings-discussion-media-v1.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  cases: Array<{ review: unknown }>;
};
const envelope = canonicalRatingDiscussionMediaEnvelope(
  fixtures.cases[0]!.review,
);
function observations(): Array<Decision<RatingDiscussionImageCurrent>> {
  return envelope.images.map((image) => ({
    kind: 'allow' as const,
    value: {
      actorAccountId: envelope.accountId,
      parent: {
        ownerKind: 'ratings' as const,
        resourceKind: 'rating_comment' as const,
        targetId: envelope.targetId,
        resourceId: envelope.subjectId,
        contentVersion: 1 as const,
      },
      assetId: image.assetId,
      manifestDigest: image.manifestDigest,
      descriptor: {
        protocol: 'ratings-discussion-media-v1' as const,
        kind: 'ratings-discussion-media' as const,
        targetId: envelope.targetId,
        rootId: envelope.subjectId,
        replyId: null,
        subjectRevision: envelope.subjectRevision,
        contextId: envelope.scope.contextId,
        contextToken: 'a'.repeat(43),
        bindingId: `00000000-0000-4000-8000-${String(400 + image.ordinal).padStart(12, '0')}`,
        ordinal: image.ordinal,
        attachmentSetDigest: envelope.attachmentSetDigest,
        width: 2,
        height: 2,
        variants: ['thumb-v1', 'display-v1'] as ['thumb-v1', 'display-v1'],
      },
    },
  }));
}
test('displaying a first thumbnail never authorizes only that image', () => {
  const all = observations();
  assert.equal(ratingDiscussionWholeSetDecision(envelope, all).kind, 'allow');
  assert.equal(
    ratingDiscussionWholeSetDecision(envelope, all.slice(0, 1)).kind,
    'unavailable',
  );
  all[8] = { kind: 'unavailable' };
  assert.equal(
    ratingDiscussionWholeSetDecision(envelope, all).kind,
    'unavailable',
  );
  all[8] = { kind: 'deny', reason: 'RATING_NOT_FOUND' };
  assert.equal(ratingDiscussionWholeSetDecision(envelope, all).kind, 'deny');
  all[0] = { kind: 'unavailable' };
  assert.equal(
    ratingDiscussionWholeSetDecision(envelope, all).kind,
    'unavailable',
  );
});
test('scope, actor, exact manifest and ordinal cannot be borrowed from another binding', () => {
  for (const mutate of [
    (row: RatingDiscussionImageCurrent) => ({
      ...row,
      actorAccountId: envelope.targetId,
    }),
    (row: RatingDiscussionImageCurrent) => ({
      ...row,
      manifestDigest: 'f'.repeat(64),
    }),
    (row: RatingDiscussionImageCurrent) => ({
      ...row,
      descriptor: { ...row.descriptor, contextId: envelope.targetId },
    }),
    (row: RatingDiscussionImageCurrent) => ({
      ...row,
      descriptor: { ...row.descriptor, ordinal: 0 },
    }),
  ]) {
    const all = observations(),
      last = all[8]!;
    if (last.kind !== 'allow') throw new Error('fixture');
    all[8] = { kind: 'allow', value: mutate(last.value) };
    assert.equal(
      ratingDiscussionWholeSetDecision(envelope, all).kind,
      'unavailable',
    );
  }
});
