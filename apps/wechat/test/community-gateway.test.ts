import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import { SessionStore } from '../src/auth/session';
import { HttpCommunityGateway } from '../src/community/gateway';
import { Cancellation } from '../src/platform/contracts';
import { ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  comment,
  commentCapabilities,
  intent,
  otherId,
  post,
  postId,
  receipt,
  requestId,
  space,
  spaceId,
} from './community-helpers';
function setup(loggedIn = true) {
  const sessions = new SessionStore();
  if (loggedIn)
    sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const transport = new ScriptedTransport();
  let refreshes = 0;
  const auth = {
    refresh: async () => {
      refreshes++;
      return sessions.rotate(sessions.snapshot(), wireCredentials('b'));
    },
  };
  return {
    sessions,
    transport,
    gateway: new HttpCommunityGateway(
      new ApiClient('https://api.example', transport, sessions, auth),
    ),
    refreshes: () => refreshes,
  };
}
test('spaces public request has no credentials; feed optional auth never silently falls back after invalid credentials', async () => {
  const s = setup();
  s.transport.reply({ regional: space(), global: [] });
  await s.gateway.spaces(otherId, new Cancellation());
  assert.equal(s.transport.requests[0]!.headers.Authorization, undefined);
  assert.match(s.transport.requests[0]!.url, /campusId=/);
  s.transport.reply(
    {
      error: {
        code: 'SESSION_REVOKED',
        message: 'raw private error',
        requestId,
      },
    },
    401,
  );
  await assert.rejects(
    s.gateway.feed({ spaceId }, new Cancellation()),
    (error: unknown) =>
      error instanceof ClientError && error.kind === 'auth-required',
  );
  assert.ok(s.transport.requests[1]!.headers.Authorization);
  assert.equal(s.transport.requests.length, 2);
});
test('feed/detail/comments enforce exact target and opaque cursor bounds', async () => {
  const s = setup();
  s.transport.reply({
    items: [
      post({ space: { id: otherId, kind: 'regional', name: 'elsewhere' } }),
    ],
    nextCursor: null,
    continuation: 'end',
  });
  await assert.rejects(s.gateway.feed({ spaceId }, new Cancellation()));
  s.transport.reply(post({ id: otherId }));
  await assert.rejects(s.gateway.post(postId, new Cancellation()));
  s.transport.reply({
    items: [comment({ postId: otherId })],
    nextCursor: null,
  });
  await assert.rejects(s.gateway.comments(postId, null, new Cancellation()));
  await assert.rejects(
    s.gateway.feed({ spaceId, cursor: 'x&limit=100' }, new Cancellation()),
  );
  assert.equal(s.transport.requests.length, 3);
});
test('durable publication alone opts into auth replay; replay preserves request key and every behavior field', async () => {
  const s = setup(),
    payload = intent();
  s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  s.transport.reply(receipt(), 201);
  await s.gateway.publishPost(payload, new Cancellation());
  assert.equal(s.refreshes(), 1);
  assert.deepEqual(
    s.transport.requests[0]!.body,
    s.transport.requests[1]!.body,
  );
  assert.equal(
    (s.transport.requests[1]!.body as { clientRequestId: string })
      .clientRequestId,
    requestId,
  );
  s.transport.steps.push(async () => {
    throw new ClientError('timeout', 'safe');
  });
  await assert.rejects(s.gateway.publishPost(payload, new Cancellation()));
  assert.equal(s.transport.requests.length, 3);
});
test('publication success status and receipt operation/request are strict; rejection receipt is a terminal DTO only at 201', async () => {
  const s = setup();
  s.transport.reply(receipt(), 200);
  await assert.rejects(s.gateway.publishPost(intent(), new Cancellation()));
  s.transport.reply(receipt({ operation: 'publish_comment' }), 201);
  await assert.rejects(s.gateway.publishPost(intent(), new Cancellation()));
  s.transport.reply(receipt({ requestId: otherId }), 200);
  await assert.rejects(s.gateway.receipt(requestId, new Cancellation()));
  s.transport.reply(
    {
      requestId,
      operation: 'publish_post',
      outcome: 'rejected',
      code: 'CONTENT_REJECTED',
    },
    201,
  );
  assert.equal(
    (await s.gateway.publishPost(intent(), new Cancellation())).outcome,
    'rejected',
  );
});
test('durable desired-state likes use PUT bodies; own deletion requires exact 204 empty response', async () => {
  const s = setup();
  for (const liked of [true, false]) {
    const value = {
      requestId: liked ? requestId : otherId,
      operation: 'set_post_like' as const,
      postId,
      liked,
    };
    s.transport.reply({ ...value, outcome: 'applied' });
    await s.gateway.like(value, new Cancellation());
  }
  s.transport.reply('', 204);
  await s.gateway.deletePost(postId, new Cancellation());
  assert.deepEqual(
    s.transport.requests.map((item) => item.method),
    ['PUT', 'PUT', 'DELETE'],
  );
  assert.deepEqual(
    s.transport.requests.map((item) => item.body),
    [
      { requestId, liked: true },
      { requestId: otherId, liked: false },
      undefined,
    ],
  );
  s.transport.reply({ deleted: true }, 204);
  await assert.rejects(s.gateway.deletePost(postId, new Cancellation()));
});
test('comment capabilities use dedicated required-auth parent visibility endpoint', async () => {
  const s = setup();
  s.transport.reply(commentCapabilities());
  await s.gateway.commentCapabilities(postId, new Cancellation());
  assert.equal(
    s.transport.requests[0]!.url,
    `https://api.example/v1/community/posts/${postId}/comment-capabilities`,
  );
  const guest = setup(false);
  await assert.rejects(
    guest.gateway.commentCapabilities(postId, new Cancellation()),
  );
  assert.equal(guest.transport.requests.length, 0);
});
