import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import { SessionStore } from '../src/auth/session';
import { HttpCommunityGateway } from '../src/community/gateway';
import type { PostLikeIntent } from '../src/community/post-like-contract';
import { Cancellation } from '../src/platform/contracts';
import { deferred, flush, response, ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import { otherId, postId, requestId } from './community-helpers';
const intent = (overrides: Partial<PostLikeIntent> = {}): PostLikeIntent => ({
  requestId,
  operation: 'set_post_like',
  postId,
  liked: true,
  ...overrides,
});
const receipt = (value = intent()) => ({ ...value, outcome: 'applied' });
function setup(loggedIn = true) {
  const sessions = new SessionStore(),
    transport = new ScriptedTransport();
  if (loggedIn)
    sessions.completeLogin(sessions.beginLogin(), wireCredentials());
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
test('post-like routes carry exact desired-state PUT body and owner-only GET with canonical IDs', async () => {
  const s = setup(),
    cancel = new Cancellation();
  for (const liked of [true, false]) {
    const value = intent({ liked });
    s.transport.reply(receipt(value));
    assert.deepEqual(await s.gateway.like(value, cancel), receipt(value));
  }
  s.transport.reply(receipt());
  await s.gateway.postLikeReceipt(requestId, cancel);
  assert.deepEqual(
    s.transport.requests.map(({ method, body }) => ({ method, body })),
    [
      { method: 'PUT', body: { requestId, liked: true } },
      { method: 'PUT', body: { requestId, liked: false } },
      { method: 'GET', body: undefined },
    ],
  );
  assert.equal(
    s.transport.requests[2]!.url,
    `https://api.example/v1/me/community/post-like-requests/${requestId}`,
  );
  assert.ok(s.transport.requests.every((r) => r.headers.Authorization));
  const guest = setup(false);
  await assert.rejects(guest.gateway.like(intent(), cancel), {
    kind: 'auth-required',
  });
  await assert.rejects(guest.gateway.postLikeReceipt(requestId, cancel), {
    kind: 'auth-required',
  });
  assert.equal(guest.transport.requests.length, 0);
  const invalid = setup();
  for (const patch of [
    { liked: 'yes' },
    { postId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
    { requestId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
    { operation: 'set_reply_like' },
    { extra: true },
  ])
    await assert.rejects(
      invalid.gateway.like({ ...intent(), ...patch } as PostLikeIntent, cancel),
      { kind: 'protocol' },
    );
  await assert.rejects(
    invalid.gateway.postLikeReceipt(
      'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      cancel,
    ),
    { kind: 'protocol' },
  );
  assert.equal(invalid.transport.requests.length, 0);
});
test('post-like gateway checks exact receipt identity for both outcomes, status, and rejects live/private receipt enrichment', async () => {
  for (const outcome of ['applied', 'rejected']) {
    const base = {
      ...receipt(),
      outcome,
      ...(outcome === 'rejected' ? { code: 'POST_NOT_FOUND' } : {}),
    };
    for (const patch of [
      { requestId: otherId },
      { postId: otherId },
      { liked: false },
      { operation: 'set_reply_like' },
      { likeCount: 2 },
      { accountId: otherId },
    ]) {
      const s = setup();
      s.transport.reply({ ...base, ...patch });
      await assert.rejects(s.gateway.like(intent(), new Cancellation()), {
        kind: 'protocol',
      });
    }
  }
  for (const status of [201, 202, 204]) {
    const s = setup();
    s.transport.reply(receipt(), status);
    await assert.rejects(s.gateway.like(intent(), new Cancellation()), {
      kind: 'protocol',
    });
    s.transport.reply(receipt(), status);
    await assert.rejects(
      s.gateway.postLikeReceipt(requestId, new Cancellation()),
      { kind: 'protocol' },
    );
  }
  const s = setup();
  s.transport.reply(receipt(intent({ requestId: otherId })));
  await assert.rejects(
    s.gateway.postLikeReceipt(requestId, new Cancellation()),
    { kind: 'protocol' },
  );
});
test('mutations never auth-replay; receipt lookup may refresh once; failure/cancel never fabricates a mutation', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  await assert.rejects(s.gateway.like(intent(), cancel), {
    kind: 'auth-expired',
  });
  assert.equal(s.refreshes(), 0);
  assert.equal(s.transport.requests.length, 1);
  s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  s.transport.reply(receipt());
  await s.gateway.postLikeReceipt(requestId, cancel);
  assert.equal(s.refreshes(), 1);
  s.transport.reply({ error: { code: 'REQUEST_NOT_FOUND' } }, 404);
  await assert.rejects(s.gateway.postLikeReceipt(requestId, cancel), {
    details: { httpStatus: 404, serverCode: 'REQUEST_NOT_FOUND' },
  });
  s.transport.steps.push(async () => {
    throw new ClientError('timeout', 'safe');
  });
  await assert.rejects(s.gateway.like(intent(), cancel), { kind: 'timeout' });
  const before = s.transport.requests.length,
    stopped = new Cancellation();
  stopped.cancel();
  await assert.rejects(s.gateway.like(intent(), stopped), {
    kind: 'cancelled',
  });
  assert.equal(s.transport.requests.length, before);
});
test('dispatched snapshot is immutable and late receipts cannot cross same-account or different-account epochs', async () => {
  const s = setup(),
    gate = deferred<ReturnType<typeof response>>(),
    value = { ...intent() };
  s.transport.steps.push(() => gate.promise);
  const running = s.gateway.like(value, new Cancellation());
  await flush();
  value.liked = false;
  value.postId = otherId;
  gate.resolve(response(receipt()));
  assert.deepEqual(await running, receipt());
  assert.deepEqual(s.transport.requests[0]!.body, { requestId, liked: true });
  for (const same of [true, false])
    for (const query of [true, false]) {
      const h = setup();
      h.transport.steps.push(async () => {
        h.sessions.completeLogin(h.sessions.beginLogin(), {
          ...wireCredentials('c'),
          ...(!same ? { accountId: otherId } : {}),
        });
        return response(receipt());
      });
      await assert.rejects(
        query
          ? h.gateway.postLikeReceipt(requestId, new Cancellation())
          : h.gateway.like(intent(), new Cancellation()),
        { kind: 'stale-session' },
      );
    }
});
