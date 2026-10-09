import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { HttpMessagingGateway } from '../src/messaging/gateway';
import { Cancellation } from '../src/platform/contracts';
import { ScriptedTransport } from './helpers';
import {
  harness,
  conversation,
  conversationId,
  history,
  observationId,
  receipt,
  requestId,
  sendIntent,
} from './messaging-helpers';
function setup() {
  const h = harness(),
    transport = new ScriptedTransport();
  const gateway = new HttpMessagingGateway(
    new ApiClient('https://api.example', transport, h.sessions, {
      refresh: async () => {
        throw new Error('Unexpected refresh');
      },
    }),
  );
  return { transport, gateway };
}
test('strict DM gateway uses cursor query contract, auth, no GET body and original POST key', async () => {
  const h = setup(),
    cancel = new Cancellation();
  h.transport.reply(conversation());
  await h.gateway.conversation(conversationId, cancel);
  h.transport.reply(history());
  await h.gateway.history(conversationId, null, cancel);
  h.transport.reply({
    items: [],
    nextCursor: 'initial_cursor',
    hasMore: false,
    observationId,
    throughSequence: '0',
  });
  await h.gateway.events(conversationId, 'initial_cursor', cancel);
  h.transport.reply(receipt(sendIntent()));
  await h.gateway.apply(sendIntent(), cancel);
  h.transport.reply(receipt(sendIntent()));
  await h.gateway.receipt(requestId, cancel);
  assert.deepEqual(
    h.transport.requests.map((r) => [r.method, new URL(r.url).pathname]),
    [
      ['GET', `/v1/private-messages/conversations/${conversationId}`],
      ['GET', `/v1/private-messages/conversations/${conversationId}/messages`],
      ['GET', `/v1/private-messages/conversations/${conversationId}/events`],
      ['POST', `/v1/private-messages/conversations/${conversationId}/messages`],
      ['GET', `/v1/private-messages/requests/${requestId}`],
    ],
  );
  assert.equal(
    new URL(h.transport.requests[2]!.url).searchParams.get('cursor'),
    'initial_cursor',
  );
  assert.deepEqual(h.transport.requests[3]!.body, {
    clientRequestId: requestId,
    text: '原文',
  });
  for (const request of h.transport.requests) {
    assert.ok(request.headers.Authorization);
    if (request.method === 'GET') assert.equal(request.body, undefined);
  }
});
test('unsafe routes, absent initial events checkpoint and cancellation cannot dispatch', async () => {
  const h = setup();
  await assert.rejects(
    h.gateway.history('../private', null, new Cancellation()),
  );
  await assert.rejects(
    h.gateway.events(conversationId, '', new Cancellation()),
  );
  const cancelled = new Cancellation();
  cancelled.cancel();
  await assert.rejects(h.gateway.apply(sendIntent(), cancelled));
  assert.equal(h.transport.requests.length, 0);
});
test('event cursor must advance when data is returned; private DTO extras are rejected', async () => {
  const h = setup();
  h.transport.reply({ ...conversation(), hiddenAccountId: 'private' });
  await assert.rejects(
    h.gateway.conversation(conversationId, new Cancellation()),
  );
  h.transport.reply({
    items: [{ sequence: '1', kind: 'sent', message: history().items[0] }],
    nextCursor: 'same',
    hasMore: false,
    observationId,
    throughSequence: '1',
  });
  await assert.rejects(
    h.gateway.events(conversationId, 'same', new Cancellation()),
  );
});
test('safe cancellation has a separate strict result and does not pretend a committed send was cancelled', async () => {
  const h = setup(),
    hash = 'a'.repeat(64);
  h.transport.reply({
    outcome: 'already_terminal',
    receipt: receipt(sendIntent()),
  });
  const result = await h.gateway.cancel(
    requestId,
    'send',
    hash,
    new Cancellation(),
  );
  assert.equal(result.outcome, 'already_terminal');
  assert.deepEqual(h.transport.requests[0]?.body, {
    operation: 'send',
    intentHash: hash,
  });
  assert.equal(
    new URL(h.transport.requests[0]!.url).pathname,
    `/v1/private-messages/requests/${requestId}/cancel`,
  );
  h.transport.reply({ outcome: 'cancelled', receipt: receipt(sendIntent()) });
  await assert.rejects(
    h.gateway.cancel(requestId, 'send', hash, new Cancellation()),
  );
});
