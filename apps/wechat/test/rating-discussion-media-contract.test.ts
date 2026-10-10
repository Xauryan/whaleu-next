import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  decodeRatingDiscussionMediaIntent,
  ratingDiscussionMediaIntentHash,
  decodeRatingDiscussionMediaReceipt,
} from '../src/ratings/discussion-media-contract';
import { decodeRatingScopedIntent } from '../src/ratings/scoped-contract';
import { decodeRatingTargetCoverIntent } from '../src/ratings/target-cover-contract';
import { ratingDiscussionViewport } from '../src/ratings/discussion-media-window';
const fixtures = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '../../../packages/fixtures/ratings-discussion-media-v1.json',
    ),
    'utf8',
  ),
) as {
  cases: Array<{ name: string; intent: unknown; intentHash: string }>;
};
for (const fixture of fixtures.cases)
  test(`native discussion ${fixture.name} same golden`, () => {
    const intent = decodeRatingDiscussionMediaIntent(fixture.intent);
    assert.equal(ratingDiscussionMediaIntentHash(intent), fixture.intentHash);
    assert.throws(() => decodeRatingScopedIntent(intent));
    assert.throws(() => decodeRatingTargetCoverIntent(intent));
    assert.equal(Object.isFrozen(intent.payload.images), true);
    assert.throws(() =>
      decodeRatingDiscussionMediaIntent({
        ...intent,
        context: { ...intent.context, discussionMedia: undefined },
      }),
    );
    assert.throws(() =>
      decodeRatingDiscussionMediaIntent({
        ...intent,
        payload: { ...intent.payload, authorId: 'untrusted' },
      }),
    );
    assert.throws(() =>
      decodeRatingDiscussionMediaReceipt({
        protocolVersion: 4,
        requestId: intent.payload.clientRequestId,
        operation: intent.operation,
        intentHash: fixture.intentHash,
        outcome: 'noop',
        result: {},
      }),
    );
  });
test('nine metadata images use a two-allocation viewport', () => {
  for (let at = 0; at < 9; at++) {
    const indexes = ratingDiscussionViewport(9, at);
    assert.equal(indexes[0], at);
    assert.ok(indexes.length <= 2);
  }
  assert.deepEqual(ratingDiscussionViewport(0, 0), []);
  assert.throws(() => ratingDiscussionViewport(10, 0));
  assert.throws(() => ratingDiscussionViewport(9, 9));
});
