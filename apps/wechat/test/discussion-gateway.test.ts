import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import { HttpCommunityGateway } from '../src/community/gateway';
import { Cancellation } from '../src/platform/contracts';
import { ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  comment,
  commentId,
  otherId,
  postId,
  receipt,
  reply,
  replyId,
  requestId,
} from './community-helpers';
function setup() {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const transport = new ScriptedTransport();
  let refreshes = 0;
  return {
    transport,
    gateway: new HttpCommunityGateway(
      new ApiClient('https://api.example', transport, sessions, {
        refresh: async () => {
          refreshes++;
          return sessions.rotate(sessions.snapshot(), wireCredentials('b'));
        },
      }),
    ),
    refreshes: () => refreshes,
  };
}
test('discussion reads encode explicit source ordering and bounded pagination and validate ancestry', async () => {
  const s = setup();
  s.transport.reply({ items: [comment()], nextCursor: null });
  await s.gateway.comments(postId, null, new Cancellation());
  assert.match(s.transport.requests[0]!.url, /sort=likes/);
  assert.match(s.transport.requests[0]!.url, /previewLimit=2/);
  s.transport.reply({ items: [reply()], nextCursor: null });
  await s.gateway.replies(commentId, null, new Cancellation());
  assert.match(s.transport.requests[1]!.url, /limit=20/);
  s.transport.reply({
    items: [reply({ rootCommentId: otherId })],
    nextCursor: null,
  });
  await assert.rejects(s.gateway.replies(commentId, null, new Cancellation()));
  const before = s.transport.requests.length;
  await assert.rejects(
    s.gateway.comments(postId, null, new Cancellation(), { previewLimit: 6 }),
  );
  await assert.rejects(
    s.gateway.replies(commentId, null, new Cancellation(), 51),
  );
  assert.equal(s.transport.requests.length, before);
});
test('root/reply/context GETs validate target and hide wrong-thread locations', async () => {
  const s = setup();
  s.transport.reply(comment({ id: otherId }));
  await assert.rejects(s.gateway.comment(commentId, new Cancellation()));
  s.transport.reply(reply({ id: otherId }));
  await assert.rejects(s.gateway.reply(replyId, new Cancellation()));
  s.transport.reply({
    comment: comment(),
    reply: reply(),
    replies: { items: [reply()], nextCursor: null },
  });
  assert.equal(
    (await s.gateway.discussionContext(postId, { replyId }, new Cancellation()))
      .reply?.id,
    replyId,
  );
  s.transport.reply({
    comment: comment(),
    reply: reply({ id: otherId }),
    replies: { items: [], nextCursor: null },
  });
  await assert.rejects(
    s.gateway.discussionContext(postId, { replyId }, new Cancellation()),
  );
});
test('reply creation freezes exact payload through one auth refresh and validates receipt operation/status', async () => {
  const s = setup(),
    payload = {
      clientRequestId: requestId,
      text: ' 原文 ',
      imageAssetIds: [],
      authorMode: 'anonymous' as const,
      targetReplyId: otherId,
    };
  s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  s.transport.reply(
    receipt({ operation: 'publish_reply', resourceId: replyId }),
    201,
  );
  await s.gateway.publishReply(commentId, payload, new Cancellation());
  assert.equal(s.refreshes(), 1);
  assert.deepEqual(
    s.transport.requests[0]!.body,
    s.transport.requests[1]!.body,
  );
  s.transport.reply(receipt({ operation: 'publish_comment' }), 201);
  await assert.rejects(
    s.gateway.publishReply(commentId, payload, new Cancellation()),
  );
});
test('desired state carries durable request body on PUT and DELETE, strict minimal receipt and no blind network retry', async () => {
  const s = setup();
  const applied = {
    requestId,
    operation: 'set_reply_like',
    outcome: 'applied',
    resourceId: replyId,
    desired: true,
  };
  s.transport.reply(applied);
  await s.gateway.discussionLike(
    'reply',
    replyId,
    true,
    requestId,
    new Cancellation(),
  );
  s.transport.reply({ ...applied, desired: false });
  await s.gateway.discussionLike(
    'reply',
    replyId,
    false,
    requestId,
    new Cancellation(),
  );
  assert.deepEqual(
    s.transport.requests.map((request) => request.method),
    ['PUT', 'DELETE'],
  );
  assert.deepEqual(
    s.transport.requests.map((request) => request.body),
    [{ clientRequestId: requestId }, { clientRequestId: requestId }],
  );
  s.transport.reply({ ...applied, resourceId: otherId });
  await assert.rejects(
    s.gateway.discussionLike(
      'reply',
      replyId,
      true,
      requestId,
      new Cancellation(),
    ),
  );
  s.transport.reply({ ...applied, requestId: otherId });
  await assert.rejects(
    s.gateway.discussionReceipt(requestId, new Cancellation()),
  );
  s.transport.reply({
    requestId,
    operation: 'set_comment_pin',
    outcome: 'applied',
    resourceId: commentId,
    desired: true,
  });
  await s.gateway.pinComment(
    postId,
    commentId,
    true,
    requestId,
    new Cancellation(),
  );
  assert.match(s.transport.requests[4]!.url, /comments\/.+\/pin$/);
  s.transport.reply('', 204);
  await s.gateway.deleteReply(replyId, new Cancellation());
  s.transport.reply({ deleted: true }, 204);
  await assert.rejects(s.gateway.deleteReply(replyId, new Cancellation()));
});
