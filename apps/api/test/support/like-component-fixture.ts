/** Canonical synthetic scope/review facts with unmodified AppModule HTTP policy. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { subscriptionFixture } from './subscription-component-fixture.js';
export async function likeFixture() {
  const f = await subscriptionFixture();
  type Actor = Awaited<ReturnType<typeof f.actor>>;
  const like = async (
    actor: Actor,
    postId: string,
    liked = true,
    requestId = randomUUID(),
  ) => {
    const response = await request(f.app.getHttpServer())
      .put(`/v1/community/posts/${postId}/like`)
      .set('Authorization', `Bearer ${actor.accessToken}`)
      .send({ requestId, liked })
      .expect(200);
    assert.equal(
      response.body.outcome,
      'applied',
      JSON.stringify(response.body),
    );
    return response.body;
  };
  const sources = async (postId: string) =>
    (
      await f.pool.query<{
        id: string;
        like_id: string;
        actor_id: string;
        transition: string;
        source_sequence: string;
        source_transaction: string;
        positive_source_id: string | null;
      }>(
        'SELECT * FROM whaleu_post_hotness.like_sources WHERE post_id=$1 ORDER BY source_sequence',
        [postId],
      )
    ).rows;
  const state = async (postId: string) =>
    (
      await f.pool.query(
        'SELECT * FROM whaleu_post_hotness.like_states WHERE post_id=$1',
        [postId],
      )
    ).rows[0];
  return { ...f, like, sources, state };
}
