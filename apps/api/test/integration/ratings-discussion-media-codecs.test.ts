import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ratingDiscussionFixture } from '../support/rating-discussion-fixture.js';
import { ratingDiscussionMediaIntentSchema } from '../../src/ratings/scoped/discussion-media-contracts.js';
import { canonicalRatingDiscussionMediaEnvelope } from '../../src/community/content-review/rating-discussion-media-contracts.js';
const fixtures = JSON.parse(
  readFileSync(
    new URL(
      '../../../../packages/fixtures/ratings-discussion-media-v1.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  cases: Array<{
    intent: unknown;
    intentHash: string;
    review: unknown;
    reviewDigest: string;
  }>;
};
/** Prerequisite codec parity, not a publication or native end-to-end test. */
test(
  'discussion SQL additive dispatch matches static TS/native golden without seeding adoption',
  { timeout: 120000 },
  async (t) => {
    const f = await ratingDiscussionFixture();
    t.after(() => f.close());
    for (const fixture of fixtures.cases) {
      const intent = ratingDiscussionMediaIntentSchema.parse(fixture.intent),
        review = canonicalRatingDiscussionMediaEnvelope(fixture.review);
      const row = (
        await f.pool.query<{
          shape: boolean;
          hash: string;
          review_shape: boolean;
          review_hash: string;
          owner_dispatch: boolean;
        }>(
          `SELECT whaleu_ratings.discussion_media_intent_valid($1::jsonb) shape,
      whaleu_ratings.discussion_media_intent_hash($1::jsonb) hash,
      whaleu_community.rating_discussion_media_envelope_shape($2::jsonb,$3) review_shape,
      whaleu_community.rating_discussion_media_approval_digest($2::jsonb) review_hash,
      whaleu_ratings.scoped_intent_valid($1::jsonb) owner_dispatch`,
          [JSON.stringify(intent), JSON.stringify(review), review.purpose],
        )
      ).rows[0]!;
      assert.equal(row.shape, true);
      assert.equal(row.hash, fixture.intentHash);
      assert.equal(row.review_shape, true);
      assert.equal(row.review_hash, fixture.reviewDigest);
      assert.equal(row.owner_dispatch, true);
      for (const mutation of [
        { ...review, attachmentSetDigest: 'f'.repeat(64) },
        { ...review, purpose: null },
        { ...review, assetIds: [] },
        { ...review, body: '', images: [] },
      ]) {
        const denied = (
          await f.pool.query<{ valid: boolean }>(
            'SELECT whaleu_community.rating_discussion_media_envelope_shape($1::jsonb,$2) valid',
            [JSON.stringify(mutation), mutation.purpose],
          )
        ).rows[0]!;
        assert.equal(denied.valid, false);
      }
    }
    assert.equal(
      (
        await f.pool.query<{ count: string }>(
          'SELECT count(*) count FROM whaleu_ratings.discussion_media_capability_sources',
        )
      ).rows[0]!.count,
      '0',
    );
  },
);
