/** Disposable loopback only; ordinary AppModule, canonical source facts and real Review. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { publishPostSchema } from '../../src/community/contracts.js';
import type {
  PublishComment,
  PublishPost,
} from '../../src/community/contracts.js';
import type { PublishReply } from '../../src/community/discussion/contracts.js';
import { postPinFixture } from './post-pin-fixture.js';
import { approveEnvelope } from './community-approval-fixtures.js';
import {
  discussionApprovalEnvelope,
  postApprovalEnvelope,
} from './community-runtime-fixtures.js';

export async function profileModerationFixture() {
  const f = await postPinFixture();
  type Actor = Awaited<ReturnType<typeof f.actor>>;
  const publish = async (actor: Actor, patch: Partial<PublishPost> = {}) => {
    const input = publishPostSchema.parse({
      clientRequestId: randomUUID(),
      spaceId: f.scope.home.spaceId,
      category: 'discussion',
      text: `Synthetic nickname moderation ${randomUUID()}`,
      imageAssetIds: [],
      authorMode: 'named',
      commentsPolicy: 'open',
      ...patch,
    });
    const envelope = await postApprovalEnvelope(
      f.app,
      f.pool,
      actor.accountId,
      input,
    );
    const approval = await approveEnvelope(f.pool, envelope);
    const response = await request(f.app.getHttpServer())
      .post('/v1/community/posts')
      .set('Authorization', `Bearer ${actor.accessToken}`)
      .send(input);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(
      response.body.outcome,
      'created',
      JSON.stringify(response.body),
    );
    return { id: response.body.resourceId as string, input, approval };
  };
  const child = async (
    actor: Actor,
    postId: string,
    rootCommentId: string | null = null,
    authorMode: 'named' | 'anonymous' = 'named',
  ) => {
    const input: PublishComment | PublishReply = {
      clientRequestId: randomUUID(),
      text: `Synthetic moderation ${rootCommentId ? 'reply' : 'comment'} ${randomUUID()}`,
      imageAssetIds: [],
      authorMode,
      ...(rootCommentId ? { targetReplyId: null } : {}),
    };
    const approval = await approveEnvelope(
      f.pool,
      await discussionApprovalEnvelope(
        f.app,
        f.pool,
        actor.accountId,
        postId,
        input,
        rootCommentId,
      ),
    );
    const response = await request(f.app.getHttpServer())
      .post(
        rootCommentId
          ? `/v1/community/comments/${rootCommentId}/replies`
          : `/v1/community/posts/${postId}/comments`,
      )
      .set('Authorization', `Bearer ${actor.accessToken}`)
      .send(input);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(
      response.body.outcome,
      'created',
      JSON.stringify(response.body),
    );
    return { id: response.body.resourceId as string, input, approval };
  };
  return { ...f, publish, child };
}
