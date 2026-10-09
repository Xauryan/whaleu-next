/** Synthetic exact approvals with the ordinary AppModule HTTP pipeline. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  ratingRuntimeFixture,
  approveRating,
} from './rating-runtime-fixture.js';
import { canonicalRatingEnvelope } from '../../src/community/content-review/rating-contracts.js';
import { createRatingReplySchema } from '../../src/ratings/discussion-contracts.js';
import type { CreateRatingReply } from '../../src/ratings/discussion-contracts.js';
export async function ratingDiscussionFixture(maximumMigration?: number) {
  const f = await ratingRuntimeFixture(maximumMigration);
  type Actor = Awaited<ReturnType<typeof f.actor>>;
  type Catalog = Awaited<ReturnType<typeof f.catalog>>;
  type Target = Catalog['targets'][number];
  type Root = { id: string; revision: string };
  const replyBody = (
    c: Catalog,
    t: Target,
    root: Root,
    patch: Partial<CreateRatingReply> = {},
  ): CreateRatingReply =>
    createRatingReplySchema.parse({
      clientRequestId: randomUUID(),
      regionId: c.regionId,
      targetId: t.id,
      expectedTargetRevision: t.revision,
      expectedRootRevision: root.revision,
      replyTo: null,
      authorMode: 'named',
      body: 'Synthetic rating reply',
      assetIds: [],
      ...patch,
    });
  const replyEnvelope = (
    a: Actor,
    c: Catalog,
    t: Target,
    root: Root,
    input: CreateRatingReply,
  ) =>
    canonicalRatingEnvelope({
      version: 2,
      purpose: 'publish_rating_reply',
      accountId: a.accountId,
      clientRequestId: input.clientRequestId,
      targetId: t.id,
      targetRevision: input.expectedTargetRevision,
      rootId: root.id,
      rootRevision: input.expectedRootRevision,
      replyTo: input.replyTo
        ? {
            replyId: input.replyTo.replyId,
            revision: input.replyTo.expectedRevision,
          }
        : null,
      categoryId: c.categoryId,
      categoryRevision: c.categoryRevision,
      catalogRevision: c.catalogId,
      scope: { regionId: c.regionId },
      assetIds: [],
      authorMode: input.authorMode,
      body: input.body,
    });
  const publishReply = async (
    a: Actor,
    c: Catalog,
    t: Target,
    root: Root,
    input = replyBody(c, t, root),
  ) => {
    const approval = await approveRating(
      f.pool,
      replyEnvelope(a, c, t, root, input),
    );
    const response = await f
      .auth(request(f.http).post(`/v1/ratings/comments/${root.id}/replies`), a)
      .send(input);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(
      response.body.outcome,
      'applied',
      JSON.stringify(response.body),
    );
    return {
      id: response.body.replyId as string,
      revision: response.body.revision as string,
      receipt: response.body,
      approval,
      input,
    };
  };
  const deleteReply = async (
    a: Actor,
    c: Catalog,
    t: Target,
    root: Root,
    reply: Root,
  ) => {
    const input = {
      clientRequestId: randomUUID(),
      regionId: c.regionId,
      targetId: t.id,
      rootId: root.id,
      expectedTargetRevision: t.revision,
      expectedRootRevision: root.revision,
      expectedRevision: reply.revision,
    };
    const response = await f
      .auth(request(f.http).delete(`/v1/ratings/replies/${reply.id}`), a)
      .send(input);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  };
  const deleteRoot = async (a: Actor, c: Catalog, t: Target, root: Root) => {
    const response = await f
      .auth(request(f.http).delete(`/v1/ratings/comments/${root.id}`), a)
      .send({
        clientRequestId: randomUUID(),
        regionId: c.regionId,
        targetId: t.id,
        expectedTargetRevision: t.revision,
        expectedRevision: root.revision,
      });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  };
  return {
    ...f,
    replyBody,
    replyEnvelope,
    publishReply,
    deleteReply,
    deleteRoot,
  };
}
export type RatingDiscussionFixture = Awaited<
  ReturnType<typeof ratingDiscussionFixture>
>;
