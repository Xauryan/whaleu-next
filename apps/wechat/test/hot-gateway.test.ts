import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import { Cancellation } from '../src/platform/contracts';
import { HttpHotGateway } from '../src/community/hot-gateway';
import type { HotIntent } from '../src/community/hot-contract';
import {
  post,
  spaceId,
  otherId,
  tradingPost,
  tradingView,
} from './community-helpers';
import { deferred, flush, response, ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import { hotPage, hotToken } from './hot-helpers';
const intent: HotIntent = { spaceId, range: 'day' };
function setup(loggedIn = true) {
  const sessions = new SessionStore();
  if (loggedIn)
    sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const transport = new ScriptedTransport();
  let refreshes = 0;
  const gateway = new HttpHotGateway(
    new ApiClient('https://api.example', transport, sessions, {
      refresh: async () => {
        refreshes++;
        return sessions.rotate(sessions.snapshot(), wireCredentials('b'));
      },
    }),
  );
  return { sessions, transport, gateway, refreshes: () => refreshes };
}
test('hot GET is optional auth, ten items and explicit space/range only, with no request body', async () => {
  const s = setup(false),
    cancel = new Cancellation();
  s.transport.reply(hotPage());
  await s.gateway.hot({ spaceId } as HotIntent, null, cancel);
  const sent = s.transport.requests[0]!,
    url = new URL(sent.url);
  assert.equal(url.pathname, '/v1/community/hot');
  assert.deepEqual(
    [...url.searchParams],
    [
      ['spaceId', spaceId],
      ['range', 'day'],
      ['limit', '10'],
    ],
  );
  assert.equal(sent.method, 'GET');
  assert.equal(sent.body, undefined);
  assert.equal(sent.headers.Authorization, undefined);
});
test('gateway enforces size, exact scope, urgent/resolved exclusions and cursor advance', async () => {
  const s = setup(),
    cancel = new Cancellation();
  for (const [page, limit] of [
    [hotPage({ items: [post(), post({ id: otherId })] }), 1],
    [hotPage({ continuation: 'more', nextCursor: hotToken() }), 2],
    [hotPage({ continuation: 'scan_pending', nextCursor: hotToken() }), 1],
    [
      hotPage({
        items: [
          post({ space: { id: otherId, kind: 'regional', name: '其他' } }),
        ],
      }),
      10,
    ],
    [
      hotPage({
        items: [tradingPost({ trading: tradingView({ urgency: 'urgent' }) })],
      }),
      10,
    ],
    [
      hotPage({
        items: [
          tradingPost({ trading: tradingView({ resolution: 'resolved' }) }),
        ],
      }),
      10,
    ],
  ] as const) {
    s.transport.reply(page);
    await assert.rejects(s.gateway.hot(intent, null, cancel, limit), {
      kind: 'protocol',
    });
  }
  s.transport.reply(hotPage({ items: [tradingPost()] }));
  assert.equal((await s.gateway.hot(intent, null, cancel)).items.length, 1);
  s.transport.reply(
    hotPage({
      items: [],
      continuation: 'scan_pending',
      nextCursor: hotToken(2),
    }),
  );
  await s.gateway.hot(intent, hotToken(), cancel);
  s.transport.reply(
    hotPage({
      items: [],
      continuation: 'scan_pending',
      nextCursor: hotToken(),
    }),
  );
  await assert.rejects(s.gateway.hot(intent, hotToken(), cancel), {
    kind: 'protocol',
  });
});
test('invalid local requests never dispatch; unexpected HTTP status and unavailable code never become an empty board', async () => {
  const s = setup(),
    cancel = new Cancellation();
  for (const [raw, after, limit] of [
    [{ ...intent, category: 'pets' } as never, null, 10],
    [{ ...intent, range: 'ALL' } as never, null, 10],
    [intent, 'bad', 10],
    [intent, null, 0],
    [intent, null, 11],
    [intent, null, 1.5],
  ] as const)
    await assert.rejects(s.gateway.hot(raw, after, cancel, limit), {
      kind: 'protocol',
    });
  assert.equal(s.transport.requests.length, 0);
  for (const status of [201, 202, 204]) {
    s.transport.reply(hotPage(), status);
    await assert.rejects(s.gateway.hot(intent, null, cancel), {
      kind: 'protocol',
    });
  }
  s.transport.reply({ error: { code: 'HOT_FEED_UNAVAILABLE' } }, 503);
  await assert.rejects(s.gateway.hot(intent, null, cancel), {
    details: { httpStatus: 503, serverCode: 'HOT_FEED_UNAVAILABLE' },
  });
});
test('supplied invalid credentials never downgrade; known token expiry replays the same immutable intent once', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply({ error: { code: 'SESSION_REVOKED' } }, 401);
  await assert.rejects(s.gateway.hot(intent, null, cancel), {
    kind: 'auth-required',
  });
  assert.equal(s.transport.requests.length, 1);
  assert.ok(s.transport.requests[0]!.headers.Authorization);
  s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  s.transport.reply(hotPage());
  await s.gateway.hot(intent, null, cancel);
  assert.equal(s.refreshes(), 1);
  assert.equal(s.transport.requests[1]!.url, s.transport.requests[2]!.url);
});
test('gateway cancellation and replaced session epochs reject stale success', async () => {
  for (const end of ['cancel', 'same-login', 'other-login'] as const) {
    const s = setup(),
      pending = deferred<ReturnType<typeof response>>(),
      cancel = new Cancellation();
    s.transport.steps.push(() => pending.promise);
    const waiting = s.gateway.hot(intent, null, cancel);
    await flush();
    if (end === 'cancel') cancel.cancel();
    else
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('b'),
        ...(end === 'other-login' ? { accountId: otherId } : {}),
      });
    pending.resolve(response(hotPage()));
    await assert.rejects(waiting, {
      kind: end === 'cancel' ? 'cancelled' : 'stale-session',
    });
  }
});
