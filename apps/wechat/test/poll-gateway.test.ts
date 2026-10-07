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
  ballotId,
  ballotReceipt,
  createdAt,
  intent,
  optionOne,
  optionTwo,
  otherId,
  poll,
  postId,
  receipt,
  requestId,
} from './community-helpers';
function setup(loggedIn = true) {
  const sessions = new SessionStore();
  if (loggedIn)
    sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const transport = new ScriptedTransport();
  let refreshes = 0;
  const gateway = new HttpCommunityGateway(
    new ApiClient('https://api.example', transport, sessions, {
      refresh: async () => {
        refreshes++;
        return sessions.rotate(sessions.snapshot(), wireCredentials('b'));
      },
    }),
  );
  return { sessions, transport, gateway, refreshes: () => refreshes };
}
test('poll real gateway uses exact parent-visible routes and isolated owner recovery/status', async () => {
  const s = setup();
  s.transport.reply(poll());
  await s.gateway.poll(postId, new Cancellation());
  s.transport.reply(ballotReceipt(), 201);
  await s.gateway.castBallot(
    postId,
    { clientRequestId: requestId, optionIds: [optionTwo, optionOne] },
    new Cancellation(),
  );
  s.transport.reply(ballotReceipt());
  await s.gateway.ballotReceipt(requestId, new Cancellation());
  s.transport.reply({
    postId,
    ballotId,
    createdAt,
    selectedOptionIds: [optionOne],
  });
  await s.gateway.ownBallot(postId, new Cancellation());
  assert.deepEqual(
    s.transport.requests.map((item) => [item.method, item.url]),
    [
      ['GET', `https://api.example/v1/community/posts/${postId}/poll`],
      ['POST', `https://api.example/v1/community/posts/${postId}/poll/ballots`],
      ['GET', `https://api.example/v1/me/community/poll-requests/${requestId}`],
      ['GET', `https://api.example/v1/me/community/poll-ballots/${postId}`],
    ],
  );
  assert.deepEqual(s.transport.requests[1]!.body, {
    clientRequestId: requestId,
    optionIds: [optionOne, optionTwo],
  });
  assert.ok(s.transport.requests.every((item) => item.headers.Authorization));
  const guest = setup(false);
  await assert.rejects(guest.gateway.poll(postId, new Cancellation()));
  assert.equal(guest.transport.requests.length, 0);
});
test('poll endpoints reject wrong success status, parent/request/operation and nested leakage', async () => {
  const s = setup();
  s.transport.reply(poll(), 201);
  await assert.rejects(s.gateway.poll(postId, new Cancellation()));
  s.transport.reply(poll({ postId: otherId }));
  await assert.rejects(s.gateway.poll(postId, new Cancellation()));
  s.transport.reply(ballotReceipt(), 200);
  await assert.rejects(
    s.gateway.castBallot(
      postId,
      { clientRequestId: requestId, optionIds: [optionOne] },
      new Cancellation(),
    ),
  );
  s.transport.reply(receipt());
  await assert.rejects(s.gateway.ballotReceipt(requestId, new Cancellation()));
  s.transport.reply(ballotReceipt({ requestId: otherId }));
  await assert.rejects(s.gateway.ballotReceipt(requestId, new Cancellation()));
  s.transport.reply({
    postId: otherId,
    ballotId,
    createdAt,
    selectedOptionIds: [optionOne],
  });
  await assert.rejects(s.gateway.ownBallot(postId, new Cancellation()));
  s.transport.reply({ error: { code: 'POLL_ALREADY_VOTED' } }, 200);
  await assert.rejects(s.gateway.poll(postId, new Cancellation()), {
    kind: 'protocol',
  });
  s.transport.reply({ error: { code: 'POLL_EXPIRED' } }, 422);
  await assert.rejects(s.gateway.poll(postId, new Cancellation()), {
    kind: 'protocol',
  });
});
test('ballot replay refreshes expired access once with exact frozen set; timeout never dispatches a second request', async () => {
  const s = setup(),
    payload = { clientRequestId: requestId, optionIds: [optionTwo, optionOne] };
  s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  s.transport.reply(ballotReceipt(), 201);
  await s.gateway.castBallot(postId, payload, new Cancellation());
  assert.equal(s.refreshes(), 1);
  assert.deepEqual(
    s.transport.requests[0]!.body,
    s.transport.requests[1]!.body,
  );
  s.transport.steps.push(async () => {
    throw new ClientError('timeout', 'safe');
  });
  await assert.rejects(
    s.gateway.castBallot(postId, payload, new Cancellation()),
  );
  assert.equal(s.transport.requests.length, 3);
});
test('structured post publication preserves question/options in auth replay and never adds component to C1 payload', async () => {
  const s = setup();
  const component = {
    kind: 'poll' as const,
    question: ' 独立问题🐳 ',
    selectionMode: 'single' as const,
    options: ['甲', '乙', '吃瓜🍉'],
  };
  s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  s.transport.reply(receipt(), 201);
  await s.gateway.publishPost(intent({ component }), new Cancellation());
  assert.deepEqual(
    s.transport.requests[0]!.body,
    s.transport.requests[1]!.body,
  );
  assert.deepEqual(
    (s.transport.requests[1]!.body as { component: unknown }).component,
    component,
  );
  s.transport.reply(receipt(), 201);
  await s.gateway.publishPost(intent(), new Cancellation());
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      s.transport.requests[2]!.body,
      'component',
    ),
    false,
  );
});
test('same-tick cancellation and account replacement reject poll and owner reads without restoring prior state', async () => {
  const s = setup();
  const cancel = new Cancellation();
  cancel.cancel();
  await assert.rejects(s.gateway.poll(postId, cancel));
  assert.equal(s.transport.requests.length, 0);
  s.transport.steps.push(async () => {
    s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('c'));
    return { status: 200, headers: {}, body: poll() };
  });
  await assert.rejects(s.gateway.poll(postId, new Cancellation()), {
    kind: 'stale-session',
  });
});
