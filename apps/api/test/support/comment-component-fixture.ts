/** Synthetic canonical facts; unmodified AppModule publication, deletion and reporting policy. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { PublishComment } from '../../src/community/contracts.js';
import type { PublishReply } from '../../src/community/discussion/contracts.js';
import { subscriptionFixture } from './subscription-component-fixture.js';
import { discussionApprovalEnvelope } from './community-runtime-fixtures.js';
import { approveEnvelope } from './community-approval-fixtures.js';

export type CommentSource = {
  id: string;
  post_id: string;
  actor_id: string;
  kind: 'root' | 'reply';
  content_id: string;
  root_id: string | null;
  transition: 'created' | 'deleted';
  delta: number;
  source_sequence: string;
  source_transaction: string;
  positive_source_id: string | null;
};
export type CommentState = {
  post_id: string;
  root_count: string;
  reply_count: string;
  eligible_count: string;
  unique_actor_count: string;
  last_sequence: string;
  last_receipt_id: string | null;
};
export async function commentFixture() {
  const f = await subscriptionFixture();
  type Actor = Awaited<ReturnType<typeof f.actor>>;
  const rootBody = (
    authorMode: 'named' | 'anonymous' = 'named',
  ): PublishComment => ({
    clientRequestId: randomUUID(),
    text: 'Synthetic comment component root',
    imageAssetIds: [],
    authorMode,
  });
  const rootRequest = (actor: Actor, postId: string, body: PublishComment) =>
    request(f.app.getHttpServer())
      .post(`/v1/community/posts/${postId}/comments`)
      .set('Authorization', `Bearer ${actor.accessToken}`)
      .send(body);
  const approveRoot = async (
    actor: Actor,
    postId: string,
    body: PublishComment,
    result: 'allow' | 'reject' = 'allow',
  ) =>
    approveEnvelope(
      f.pool,
      await discussionApprovalEnvelope(
        f.app,
        f.pool,
        actor.accountId,
        postId,
        body,
      ),
      { result },
    );
  const root = async (
    actor: Actor,
    postId: string,
    authorMode: 'named' | 'anonymous' = 'named',
  ) => {
    const body = rootBody(authorMode);
    await approveRoot(actor, postId, body);
    const response = await rootRequest(actor, postId, body).expect(201);
    assert.equal(
      response.body.outcome,
      'created',
      JSON.stringify(response.body),
    );
    return {
      id: response.body.resourceId as string,
      body,
      receipt: response.body,
    };
  };
  const replyBody = (
    authorMode: 'named' | 'anonymous' = 'named',
    targetReplyId: string | null = null,
  ): PublishReply => ({ ...rootBody(authorMode), targetReplyId });
  const replyRequest = (actor: Actor, rootId: string, body: PublishReply) =>
    request(f.app.getHttpServer())
      .post(`/v1/community/comments/${rootId}/replies`)
      .set('Authorization', `Bearer ${actor.accessToken}`)
      .send(body);
  const approveReply = async (
    actor: Actor,
    postId: string,
    rootId: string,
    body: PublishReply,
  ) =>
    approveEnvelope(
      f.pool,
      await discussionApprovalEnvelope(
        f.app,
        f.pool,
        actor.accountId,
        postId,
        body,
        rootId,
      ),
    );
  const reply = async (
    actor: Actor,
    postId: string,
    rootId: string,
    authorMode: 'named' | 'anonymous' = 'named',
    targetReplyId: string | null = null,
  ) => {
    const body = replyBody(authorMode, targetReplyId);
    await approveReply(actor, postId, rootId, body);
    const response = await replyRequest(actor, rootId, body).expect(201);
    assert.equal(
      response.body.outcome,
      'created',
      JSON.stringify(response.body),
    );
    return {
      id: response.body.resourceId as string,
      body,
      receipt: response.body,
    };
  };
  const deleteContent = (actor: Actor, kind: 'root' | 'reply', id: string) =>
    request(f.app.getHttpServer())
      .delete(`/v1/community/${kind === 'root' ? 'comments' : 'replies'}/${id}`)
      .set('Authorization', `Bearer ${actor.accessToken}`);
  const report = (
    actor: Actor,
    kind: 'comment' | 'reply',
    id: string,
    clientRequestId = randomUUID(),
  ) =>
    request(f.app.getHttpServer())
      .post('/v1/me/safety/reports')
      .set('Authorization', `Bearer ${actor.accessToken}`)
      .send({ clientRequestId, target: { kind, id } });
  const sources = async (postId: string) =>
    (
      await f.pool.query<CommentSource>(
        'SELECT * FROM whaleu_post_hotness.comment_sources WHERE post_id=$1 ORDER BY source_sequence',
        [postId],
      )
    ).rows;
  const state = async (postId: string) =>
    (
      await f.pool.query<CommentState>(
        'SELECT * FROM whaleu_post_hotness.comment_states WHERE post_id=$1',
        [postId],
      )
    ).rows[0];
  const counts = async (postId: string) => {
    const s = await state(postId);
    assert.ok(s);
    return [
      s.root_count,
      s.reply_count,
      s.eligible_count,
      s.unique_actor_count,
    ];
  };
  return {
    ...f,
    rootBody,
    rootRequest,
    approveRoot,
    root,
    replyBody,
    replyRequest,
    approveReply,
    reply,
    deleteContent,
    report,
    sources,
    state,
    counts,
  };
}
