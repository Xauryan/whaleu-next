import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import { Cancellation } from '../src/platform/contracts';
import { HttpCourseCommentsGateway } from '../src/course-comments/gateway';
import { ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  body,
  cancelled,
  commentId,
  id,
  like,
  otherId,
  page,
  publish,
  receipt,
  requestId,
} from './course-comments-helpers';
function setup() {
  const sessions = new SessionStore(),
    transport = new ScriptedTransport();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const gateway = new HttpCourseCommentsGateway(
    new ApiClient('https://comments.example', transport, sessions, {
      refresh: async () =>
        sessions.rotate(sessions.snapshot(), wireCredentials('b')),
    }),
  );
  return { sessions, transport, gateway };
}
test('comments list/publish/like/receipt/cancel use dedicated authenticated routes and exact bodies', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply(page());
  await s.gateway.list(id, 'time', null, cancel, 1);
  s.transport.reply(receipt());
  await s.gateway.submit(publish(), cancel);
  s.transport.reply(receipt(like()));
  await s.gateway.submit(like(), cancel);
  s.transport.reply(receipt());
  await s.gateway.receipt(requestId, cancel);
  s.transport.reply(cancelled());
  await s.gateway.cancel(publish(), cancel);
  const urls = s.transport.requests.map((request) => new URL(request.url));
  assert.equal(urls[0]!.pathname, `/v1/ratings/courses/${id}/comments`);
  assert.equal(urls[0]!.searchParams.get('sort'), 'time');
  assert.equal(urls[0]!.searchParams.get('limit'), '1');
  assert.equal(
    urls[2]!.pathname,
    `/v1/ratings/courses/${id}/comments/${commentId}/like`,
  );
  assert.equal(
    urls[3]!.pathname,
    `/v1/ratings/courses/comment-requests/${requestId}`,
  );
  assert.equal(
    urls[4]!.pathname,
    `/v1/ratings/courses/comment-requests/${requestId}/cancel`,
  );
  assert.deepEqual(s.transport.requests[1]!.body, publish().payload);
  assert.equal((s.transport.requests[1]!.body as { body: string }).body, body);
  assert.deepEqual(s.transport.requests[4]!.body, {
    operation: publish().operation,
    courseId: id,
    command: publish().payload,
  });
  assert.ok(
    s.transport.requests.every(
      (request) =>
        request.headers.Authorization ===
        `Bearer ${wireCredentials().accessToken}`,
    ),
  );
});
test('comments gateway rejects repeated cursor, wrong resource, mixed receipt and public author leakage', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply(page({ nextCursor: 'cursor', continuation: 'more' }));
  await assert.rejects(s.gateway.list(id, 'likes', 'cursor', cancel));
  s.transport.reply(page({ courseId: otherId }));
  await assert.rejects(s.gateway.list(id, 'likes', null, cancel));
  s.transport.reply(receipt(like()));
  await assert.rejects(s.gateway.submit(publish(), cancel));
  s.transport.reply(
    page({ items: [{ ...page().items[0]!, author: { id } } as never] }),
  );
  await assert.rejects(s.gateway.list(id, 'likes', null, cancel));
  s.transport.reply({ ...receipt(), requestId: otherId });
  await assert.rejects(s.gateway.receipt(requestId, cancel));
  assert.equal(s.transport.requests.length, 5);
  await assert.rejects(s.gateway.list(id, 'likes', null, cancel, 0));
  await assert.rejects(s.gateway.list(id, 'likes', null, cancel, 51));
  assert.equal(s.transport.requests.length, 5);
});
test('auth refresh replays the exact comment request once and signed-out recovery does not dispatch', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply(
    { error: { code: 'ACCESS_TOKEN_EXPIRED', message: 'Synthetic expired' } },
    401,
  );
  s.transport.reply(receipt());
  await s.gateway.submit(publish(), cancel);
  assert.equal(s.transport.requests.length, 2);
  assert.deepEqual(
    s.transport.requests[0]!.body,
    s.transport.requests[1]!.body,
  );
  assert.notEqual(
    s.transport.requests[0]!.headers.Authorization,
    s.transport.requests[1]!.headers.Authorization,
  );
  s.sessions.logout();
  await assert.rejects(s.gateway.receipt(requestId, cancel));
  assert.equal(s.transport.requests.length, 2);
});
test('mismatched transport statuses cannot masquerade as history-unavailable or known receipt absence', async () => {
  const s = setup(),
    cancel = new Cancellation();
  for (const code of [
    'COURSE_COMMENT_HISTORY_UNAVAILABLE',
    'REQUEST_NOT_FOUND',
  ]) {
    s.transport.reply(
      { error: { code, message: 'Synthetic wrong status' } },
      403,
    );
    await assert.rejects(
      s.gateway.receipt(requestId, cancel),
      (error: unknown) => (error as { kind: string }).kind === 'protocol',
    );
  }
});
