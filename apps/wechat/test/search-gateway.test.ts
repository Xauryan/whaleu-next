import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import { Cancellation } from '../src/platform/contracts';
import { HttpSearchGateway } from '../src/community/search-gateway';
import {
  post,
  spaceId,
  otherId,
  tradingPost,
  tradingView,
} from './community-helpers';
import { deferred, flush, response, ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import { searchPage, searchToken } from './search-helpers';
function setup(loggedIn = true) {
  const sessions = new SessionStore();
  if (loggedIn)
    sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const transport = new ScriptedTransport();
  let refreshes = 0;
  const gateway = new HttpSearchGateway(
    new ApiClient('https://api.example', transport, sessions, {
      refresh: async () => {
        refreshes++;
        return sessions.rotate(sessions.snapshot(), wireCredentials('b'));
      },
    }),
  );
  return { sessions, transport, gateway, refreshes: () => refreshes };
}
test('search is optional-auth GET with canonical query encoding, no body and no client Unicode matching', async () => {
  const s = setup(false),
    q = '"%_\\ &?#İ校园\r\n😀',
    cancel = new Cancellation();
  // Deliberately unrelated body: the server owns Unicode matching; the client must not rematch.
  s.transport.reply(searchPage());
  await s.gateway.search({ spaceId, q }, null, cancel);
  const sent = s.transport.requests[0]!;
  const url = new URL(sent.url);
  assert.equal(url.pathname, '/v1/community/search');
  assert.equal(url.searchParams.get('q'), q.replace(/\r\n/g, '\n'));
  assert.equal(url.searchParams.get('limit'), '10');
  assert.equal(sent.method, 'GET');
  assert.equal(sent.body, undefined);
  assert.equal(sent.headers.Authorization, undefined);
});
test('gateway enforces cardinality, requested scope/category/subtype and aggregate urgency without excluding resolved trades', async () => {
  const s = setup(),
    cancel = new Cancellation();
  for (const [intent, page, limit] of [
    [
      { spaceId, q: 'x' },
      searchPage({ items: [post(), post({ id: otherId })] }),
      1,
    ],
    [
      { spaceId, q: 'x' },
      searchPage({ continuation: 'more', nextCursor: searchToken() }),
      2,
    ],
    [
      { spaceId, q: 'x' },
      searchPage({ continuation: 'scan_pending', nextCursor: searchToken() }),
      1,
    ],
    [
      { spaceId, q: 'x' },
      searchPage({
        items: [
          post({ space: { id: otherId, kind: 'regional', name: '其他' } }),
        ],
      }),
      10,
    ],
    [{ spaceId, q: 'x', category: 'pets' }, searchPage(), 10],
    [
      { spaceId, q: 'x' },
      searchPage({
        items: [tradingPost({ trading: tradingView({ urgency: 'urgent' }) })],
      }),
      10,
    ],
    [
      { spaceId, q: 'x', category: 'trading', tradingSubtype: 'shuma' },
      searchPage({
        items: [
          tradingPost({
            trading: tradingView({
              subtype: { kind: 'known', key: 'qiugou', legacyText: null },
            }),
          }),
        ],
      }),
      10,
    ],
  ] as const) {
    s.transport.reply(page);
    await assert.rejects(s.gateway.search(intent, null, cancel, limit), {
      kind: 'protocol',
    });
  }
  const urgent = tradingPost({
    trading: tradingView({
      urgency: 'urgent',
      resolution: 'resolved',
      subtype: { kind: 'known', key: 'shuma', legacyText: null },
    }),
  });
  s.transport.reply(searchPage({ items: [urgent] }));
  assert.deepEqual(
    (
      await s.gateway.search(
        { spaceId, q: 'x', category: 'trading', tradingSubtype: 'shuma' },
        null,
        cancel,
      )
    ).items,
    [urgent],
  );
  s.transport.reply(
    searchPage({
      items: [],
      continuation: 'scan_pending',
      nextCursor: searchToken(2),
    }),
  );
  await s.gateway.search({ spaceId, q: 'x' }, searchToken(), cancel);
  s.transport.reply(
    searchPage({
      items: [],
      continuation: 'scan_pending',
      nextCursor: searchToken(),
    }),
  );
  await assert.rejects(
    s.gateway.search({ spaceId, q: 'x' }, searchToken(), cancel),
    { kind: 'protocol' },
  );
});
test('invalid local requests and unexpected HTTP status never render', async () => {
  const s = setup(),
    cancel = new Cancellation();
  for (const [intent, after, limit] of [
    [{ spaceId, q: '' }, null, 10],
    [{ spaceId, q: 'x', unknown: 'bad' } as never, null, 10],
    [{ spaceId, q: 'x' }, 'bad', 10],
    [{ spaceId, q: 'x' }, null, 0],
    [{ spaceId, q: 'x' }, null, 11],
    [{ spaceId, q: 'x' }, null, 1.5],
  ] as const)
    await assert.rejects(s.gateway.search(intent, after, cancel, limit), {
      kind: 'protocol',
    });
  assert.equal(s.transport.requests.length, 0);
  for (const status of [201, 202, 204]) {
    s.transport.reply(searchPage(), status);
    await assert.rejects(s.gateway.search({ spaceId, q: 'x' }, null, cancel), {
      kind: 'protocol',
    });
  }
});
test('invalid supplied credentials never downgrade to guest; known expiry replays the frozen query once', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply({ error: { code: 'SESSION_REVOKED' } }, 401);
  await assert.rejects(s.gateway.search({ spaceId, q: 'x' }, null, cancel), {
    kind: 'auth-required',
  });
  assert.equal(s.transport.requests.length, 1);
  assert.ok(s.transport.requests[0]!.headers.Authorization);
  s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  s.transport.reply(searchPage());
  await s.gateway.search({ spaceId, q: 'x' }, null, cancel);
  assert.equal(s.refreshes(), 1);
  assert.equal(s.transport.requests[1]!.url, s.transport.requests[2]!.url);
});
test('gateway cancellation and changed account epochs reject stale success or error', async () => {
  for (const end of ['cancel', 'same-login', 'other-login'] as const) {
    const s = setup(),
      pending = deferred<ReturnType<typeof response>>(),
      cancel = new Cancellation();
    s.transport.steps.push(() => pending.promise);
    const waiting = s.gateway.search({ spaceId, q: 'x' }, null, cancel);
    await flush();
    if (end === 'cancel') cancel.cancel();
    else
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('b'),
        ...(end === 'other-login' ? { accountId: otherId } : {}),
      });
    pending.resolve(response(searchPage()));
    await assert.rejects(waiting, {
      kind: end === 'cancel' ? 'cancelled' : 'stale-session',
    });
  }
});
