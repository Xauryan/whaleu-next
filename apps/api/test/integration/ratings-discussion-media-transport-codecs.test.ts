import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ratingDiscussionFixture } from '../support/rating-discussion-fixture.js';
import { ratingDiscussionMediaIntentSchema } from '../../src/ratings/scoped/discussion-media-contracts.js';
import {
  ratingsDiscussionBatchIdentitySchema,
  ratingsDiscussionBatchHash,
  ratingsDiscussionMemberHash,
  ratingsDiscussionSealedPlanHash,
} from '../../src/media/contracts-ratings-discussion.js';
const fixtureData = JSON.parse(
  readFileSync(
    new URL(
      '../../../../packages/fixtures/ratings-discussion-media-v1.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { cases: Array<{ intent: unknown }> };
/** SQL parity only. This source is not evidence that PG or publication ran. */
test(
  'Media7 SQL independent batch/member/sealed-plan domains match TS',
  { timeout: 120000 },
  async (t) => {
    const f = await ratingDiscussionFixture();
    t.after(() => f.close());
    for (const item of fixtureData.cases) {
      const i = ratingDiscussionMediaIntentSchema.parse(item.intent),
        p = i.payload;
      if (!p.images.length) continue;
      const actor = randomUUID();
      const identity = ratingsDiscussionBatchIdentitySchema.parse({
        protocol: 'ratings-discussion-media-v1',
        batchRequestId: p.batchRequestId,
        commandRequestId: p.clientRequestId,
        draftRevision: p.draftRevision,
        categoryId: p.categoryId,
        expectedCategoryRevision: p.expectedCategoryRevision,
        context: i.context,
        target: {
          kind: i.operation === 'create_comment_scoped' ? 'root' : 'reply',
          targetId: p.targetId,
          expectedTargetRevision: p.expectedTargetRevision,
          expectedDefinitionRevision: p.expectedDefinitionRevision,
          expectedContentVersion: p.expectedContentVersion,
          ...(i.operation === 'create_reply_scoped'
            ? {
                rootId: i.payload.rootId,
                expectedRootRevision: i.payload.expectedRootRevision,
                replyTo: i.payload.replyTo,
              }
            : {}),
        },
      });
      const hash = ratingsDiscussionBatchHash(actor, identity),
        member = {
          protocol: 'ratings-discussion-media-v1',
          clientRequestId: randomUUID(),
          batchId: p.batchId,
          batchIdentityHash: hash,
          memberId: p.images[0]!.memberId,
          sourceSlot: 127,
          declaration: {
            mime: 'image/png',
            bytes: 2048,
            sha256: 'a'.repeat(64),
          },
        },
        plan = {
          batchId: p.batchId,
          batchIdentityHash: hash,
          orderedMembers: p.images.map((image) => ({
            ...image,
            manifestDigest: 'b'.repeat(64),
          })),
        };
      const row = (
        await f.pool.query<{
          batch_valid: boolean;
          batch_hash: string;
          member_valid: boolean;
          member_hash: string;
          plan_hash: string;
        }>(
          `SELECT whaleu_media.ratings_discussion_batch_shape($2::jsonb) batch_valid,whaleu_media.ratings_discussion_batch_hash($1::uuid,$2::jsonb) batch_hash,whaleu_media.ratings_discussion_member_shape($3::jsonb) member_valid,whaleu_media.ratings_discussion_member_hash($1::uuid,$3::jsonb) member_hash,whaleu_media.ratings_discussion_plan_hash($4::jsonb) plan_hash`,
          [
            actor,
            JSON.stringify(identity),
            JSON.stringify(member),
            JSON.stringify(plan),
          ],
        )
      ).rows[0]!;
      assert.equal(row.batch_valid, true);
      assert.equal(row.batch_hash, hash);
      assert.equal(row.member_valid, true);
      assert.equal(row.member_hash, ratingsDiscussionMemberHash(actor, member));
      assert.equal(row.plan_hash, ratingsDiscussionSealedPlanHash(plan));
      for (const value of [
        { ...member, sourceSlot: 128 },
        { ...member, purpose: 'community-post-image' },
        { ...member, manifestDigest: 'a'.repeat(64) },
      ])
        assert.equal(
          (
            await f.pool.query<{ valid: boolean }>(
              'SELECT whaleu_media.ratings_discussion_member_shape($1::jsonb) valid',
              [JSON.stringify(value)],
            )
          ).rows[0]!.valid,
          false,
        );
    }
  },
);
