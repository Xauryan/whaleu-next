import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import { Cancellation } from '../src/platform/contracts';
import { HttpCourseRatingsGateway } from '../src/course-ratings/gateway';
import { ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  course,
  detail,
  id,
  otherId,
  page,
  payload,
  receipt,
  requestId,
} from './course-ratings-helpers';
function setup() {
  const sessions = new SessionStore(),
    transport = new ScriptedTransport();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const gateway = new HttpCourseRatingsGateway(
    new ApiClient('https://courses.example', transport, sessions, {
      refresh: async () =>
        sessions.rotate(sessions.snapshot(), wireCredentials('b')),
    }),
  );
  return { sessions, transport, gateway };
}
test('typed course routes carry session, exact independent frozen payload and percent encoded filters', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply(page());
  await s.gateway.list(
    { search: '合成 &课程', category: '合成类别', sort: 'time' },
    null,
    cancel,
  );
  const first = new URL(s.transport.requests[0]!.url);
  assert.equal(first.pathname, '/v1/ratings/courses');
  assert.equal(first.searchParams.get('search'), '合成 &课程');
  assert.equal(first.searchParams.get('category'), '合成类别');
  assert.equal(first.searchParams.has('department'), false);
  assert.equal(first.searchParams.has('regionId'), false);
  s.transport.reply(detail());
  await s.gateway.detail(id, cancel);
  s.transport.reply(receipt());
  await s.gateway.submit(id, payload(), cancel);
  s.transport.reply(receipt());
  await s.gateway.receipt(requestId, cancel);
  assert.deepEqual(s.transport.requests[2]!.body, payload());
  assert.equal(s.transport.requests[2]!.method, 'POST');
  assert.equal(
    new URL(s.transport.requests[3]!.url).pathname,
    `/v1/ratings/courses/requests/${requestId}`,
  );
  for (const request of s.transport.requests)
    assert.equal(
      request.headers.Authorization,
      `Bearer ${wireCredentials().accessToken}`,
    );
});
test('course gateways reject wrong target, unknown fields, mismatched receipts and filter leakage', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply(detail({ course: course({ id: otherId }) }));
  await assert.rejects(s.gateway.detail(id, cancel));
  s.transport.reply(receipt(payload({ overallScore: 5 })));
  await assert.rejects(s.gateway.submit(id, payload(), cancel));
  s.transport.reply(page({ items: [course({ department: 1 })] }));
  await assert.rejects(
    s.gateway.list({ sort: 'rating', department: 99 }, null, cancel),
  );
  s.transport.reply(page({ items: [course({ department: 95 })] }));
  assert.equal(
    (await s.gateway.list({ sort: 'rating', department: 99 }, null, cancel))
      .items.length,
    1,
  );
  s.transport.reply(page({ nextCursor: 'cursor', continuation: 'more' }));
  await assert.rejects(s.gateway.list({ sort: 'rating' }, 'cursor', cancel));
  assert.equal(s.transport.requests.length, 5);
});
test('auth refresh replays the same immutable first-score key and tuple once', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply(
    { error: { code: 'ACCESS_TOKEN_EXPIRED', message: 'Synthetic expired' } },
    401,
  );
  s.transport.reply(receipt());
  await s.gateway.submit(id, payload(), cancel);
  assert.equal(s.transport.requests.length, 2);
  assert.deepEqual(
    s.transport.requests[0]!.body,
    s.transport.requests[1]!.body,
  );
  assert.notEqual(
    s.transport.requests[0]!.headers.Authorization,
    s.transport.requests[1]!.headers.Authorization,
  );
});
test('strict course error status mismatches fail protocol validation and no-session requests never dispatch', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply(
    {
      error: {
        code: 'COURSE_CATALOG_UNAVAILABLE',
        message: 'Synthetic bad status',
      },
    },
    404,
  );
  await assert.rejects(
    s.gateway.list({ sort: 'rating' }, null, cancel),
    (error: unknown) => (error as { kind: string }).kind === 'protocol',
  );
  s.sessions.logout();
  await assert.rejects(s.gateway.receipt(requestId, cancel));
  assert.equal(s.transport.requests.length, 1);
});
