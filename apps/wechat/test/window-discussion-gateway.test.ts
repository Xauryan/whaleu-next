import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import { Cancellation } from '../src/platform/contracts';
import { HttpWindowDiscussionGateway } from '../src/window-discussion/gateway';
import { ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  page,
  item,
  intent,
  like,
  own,
  receipt,
  cancelled,
  notice,
  id,
  rootId,
  replyId,
  requestId,
  recordedAt,
} from './window-discussion-helpers';
function setup() {
  const sessions = new SessionStore(),
    transport = new ScriptedTransport();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const gateway = new HttpWindowDiscussionGateway(
    new ApiClient('https://discussion.example', transport, sessions, {
      refresh: async () =>
        sessions.rotate(sessions.snapshot(), wireCredentials('b')),
    }),
  );
  return { sessions, transport, gateway };
}
test('real ApiClient uses exact W3 root/reply/desired-state/own/receipt/cancel and notices namespaces', async () => {
  const s = setup(),
    c = new Cancellation(),
    i = intent(' A😀 ');
  s.transport.reply(page());
  await s.gateway.list(id, null, 'likes', null, c);
  s.transport.reply(page({ root: item(), items: [], totalCount: 0 }));
  await s.gateway.list(id, rootId, 'time', null, c);
  s.transport.reply(receipt(i));
  await s.gateway.submit(i, c);
  const r = {
    operation: 'window.discussion.reply.v1' as const,
    windowId: id,
    rootId,
    command: { ...i.command, body: 'reply', replyToReplyId: replyId },
  };
  s.transport.reply(receipt(r));
  await s.gateway.submit(r, c);
  s.transport.reply(receipt(like()));
  await s.gateway.submit(like(), c);
  s.transport.reply(own());
  await s.gateway.own(id, rootId, c);
  s.transport.reply(receipt(i));
  await s.gateway.receipt(requestId, c);
  s.transport.reply(cancelled(i));
  await s.gateway.cancel(i, c);
  s.transport.reply({ items: [notice()], nextCursor: null, unreadCount: 1 });
  await s.gateway.notices(null, c);
  s.transport.reply({ windowId: id, rootId, commentId: replyId });
  await s.gateway.target(requestId, c);
  s.transport.reply({ noticeId: requestId, readAt: recordedAt });
  await s.gateway.read(requestId, c);
  const paths = s.transport.requests.map((r) => new URL(r.url).pathname);
  assert.deepEqual(paths, [
    `/v1/ratings/windows/${id}/discussion`,
    `/v1/ratings/windows/${id}/discussion/${rootId}`,
    `/v1/ratings/windows/${id}/discussion`,
    `/v1/ratings/windows/${id}/discussion/${rootId}/replies`,
    `/v1/ratings/windows/${id}/discussion/${rootId}/like`,
    `/v1/ratings/windows/${id}/discussion/${rootId}/my-like`,
    `/v1/ratings/windows/discussion-requests/${requestId}`,
    `/v1/ratings/windows/discussion-requests/${requestId}/cancel`,
    '/v1/me/window-discussion/notices',
    `/v1/me/window-discussion/notices/${requestId}/target`,
    `/v1/me/window-discussion/notices/${requestId}/read`,
  ]);
  assert.deepEqual(s.transport.requests[7]!.body, i);
  assert.equal(
    new URL(s.transport.requests[1]!.url).searchParams.has('sort'),
    false,
  );
  assert.deepEqual(s.transport.requests[10]!.body, {});
  assert.equal(s.transport.requests[10]!.method, 'PUT');
  for (const q of s.transport.requests)
    assert.equal(
      q.headers.Authorization,
      `Bearer ${wireCredentials().accessToken}`,
    );
});
test('strict transport rejects unexpected target, repeated cursor, private leaks, wrong status and ordering', async () => {
  const s = setup(),
    c = new Cancellation();
  s.transport.reply(page({ windowId: replyId }));
  await assert.rejects(s.gateway.list(id, null, 'likes', null, c));
  s.transport.reply(page({ nextCursor: 'cursor', continuation: 'more' }));
  await assert.rejects(s.gateway.list(id, null, 'likes', 'cursor', c));
  s.transport.reply({ ...receipt(), body: 'leak' });
  await assert.rejects(s.gateway.receipt(requestId, c));
  s.transport.reply(receipt(), 201);
  await assert.rejects(s.gateway.submit(intent(), c));
  s.transport.reply(
    page({
      items: [item({ likes: 0 }), item({ id: replyId, likes: 1 })],
      totalCount: 2,
    }),
  );
  await assert.rejects(s.gateway.list(id, null, 'likes', null, c));
  s.transport.reply({ noticeId: replyId, readAt: recordedAt });
  await assert.rejects(s.gateway.read(requestId, c));
});
test('bad route IDs and parameters reject before any transport', async () => {
  const s = setup(),
    c = new Cancellation();
  await assert.rejects(s.gateway.list('bad', null, 'likes', null, c));
  await assert.rejects(s.gateway.list(id, null, 'likes', null, c, 51));
  assert.throws(() => s.gateway.own(id, 'bad', c));
  assert.throws(() => s.gateway.target('bad', c));
  assert.equal(s.transport.requests.length, 0);
});
