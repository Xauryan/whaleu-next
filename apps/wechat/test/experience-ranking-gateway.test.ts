import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import { SessionStore } from '../src/auth/session';
import { HttpExperienceRankingGateway } from '../src/experience/ranking-gateway';
import { Cancellation } from '../src/platform/contracts';
import { deferred, flush, response, ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import { rankingPage } from './experience-ranking-helpers';
function setup(loggedIn = false) {
  const sessions = new SessionStore();
  if (loggedIn)
    sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const transport = new ScriptedTransport();
  let refreshes = 0;
  const gateway = new HttpExperienceRankingGateway(
    new ApiClient('https://api.example', transport, sessions, {
      refresh: async () => {
        refreshes++;
        throw new ClientError('auth-expired', 'Synthetic expired session');
      },
    }),
  );
  return { sessions, transport, gateway, refreshes: () => refreshes };
}
test('list makes exactly one optional-auth GET, fixed limit and no private/writing endpoint', async () => {
  for (const signedIn of [false, true]) {
    const s = setup(signedIn);
    s.transport.reply(rankingPage());
    assert.deepEqual(
      await s.gateway.ranking(new Cancellation()),
      rankingPage(),
    );
    assert.equal(s.transport.requests.length, 1);
    const req = s.transport.requests[0]!;
    assert.equal(req.url, 'https://api.example/v1/experience/ranking?limit=50');
    assert.equal(req.method, 'GET');
    assert.equal(req.body, undefined);
    assert.equal(
      req.headers.Authorization,
      signedIn ? `Bearer ${wireCredentials().accessToken}` : undefined,
    );
  }
});
test('invalid bearer never falls back to guest; HTTP errors and malformed success reject', async () => {
  const s = setup(true);
  s.transport.reply(
    { error: { code: 'AUTHENTICATION_REQUIRED', message: 'Synthetic' } },
    401,
  );
  await assert.rejects(s.gateway.ranking(new Cancellation()));
  assert.equal(s.transport.requests.length, 1);
  assert.ok(s.transport.requests[0]!.headers.Authorization);
  for (const status of [403, 503]) {
    s.transport.reply(
      {
        error: { code: 'EXPERIENCE_RANKING_UNAVAILABLE', message: 'Synthetic' },
      },
      status,
    );
    await assert.rejects(s.gateway.ranking(new Cancellation()));
  }
  s.transport.reply({ ...rankingPage(), balance: '123' });
  await assert.rejects(s.gateway.ranking(new Cancellation()), {
    kind: 'protocol',
  });
  s.transport.reply(rankingPage(), 201);
  await assert.rejects(s.gateway.ranking(new Cancellation()), {
    kind: 'protocol',
  });
});
test('cancellation fences a delayed transport response', async () => {
  const s = setup(),
    cancel = new Cancellation(),
    delayed = deferred<ReturnType<typeof response>>();
  s.transport.steps.push(() => delayed.promise);
  const read = s.gateway.ranking(cancel);
  await flush();
  cancel.cancel();
  delayed.resolve(response(rankingPage()));
  await assert.rejects(read, { kind: 'cancelled' });
});

test('same-session token expiry rotates and replays the exact authenticated GET once; failed refresh never reads as guest', async () => {
  for (const succeeds of [true, false]) {
    const sessions = new SessionStore(),
      transport = new ScriptedTransport();
    sessions.completeLogin(sessions.beginLogin(), wireCredentials());
    let refreshes = 0;
    const gateway = new HttpExperienceRankingGateway(
      new ApiClient('https://api.example', transport, sessions, {
        refresh: async () => {
          refreshes++;
          if (!succeeds)
            throw new ClientError(
              'auth-required',
              'Synthetic rejected refresh',
            );
          return sessions.rotate(sessions.snapshot(), wireCredentials('b'));
        },
      }),
    );
    transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
    if (succeeds) {
      transport.reply(rankingPage());
      await gateway.ranking(new Cancellation());
      assert.equal(transport.requests.length, 2);
      assert.equal(transport.requests[0]!.url, transport.requests[1]!.url);
      assert.equal(
        transport.requests[1]!.headers.Authorization,
        `Bearer ${wireCredentials('b').accessToken}`,
      );
    } else {
      await assert.rejects(gateway.ranking(new Cancellation()), {
        kind: 'auth-required',
      });
      assert.equal(transport.requests.length, 1);
    }
    assert.equal(refreshes, 1);
    assert.ok(
      transport.requests.every((request) => !!request.headers.Authorization),
    );
  }
});
