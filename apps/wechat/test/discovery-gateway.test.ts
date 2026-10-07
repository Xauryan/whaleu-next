import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import { Cancellation } from '../src/platform/contracts';
import { HttpDiscoveryGateway } from '../src/profile/discovery-gateway';
import { deferred, flush, response, ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  otherId,
  requestId,
  tradingPost,
  tradingView,
} from './community-helpers';
import {
  likedList,
  namedAuthor,
  profileId,
  profileList,
  publicProfile,
} from './discovery-helpers';
function setup(loggedIn = true) {
  const sessions = new SessionStore();
  if (loggedIn)
    sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const transport = new ScriptedTransport();
  let refreshes = 0;
  const gateway = new HttpDiscoveryGateway(
    new ApiClient('https://api.example', transport, sessions, {
      refresh: async () => {
        refreshes++;
        return sessions.rotate(sessions.snapshot(), wireCredentials('b'));
      },
    }),
  );
  return { sessions, transport, gateway, refreshes: () => refreshes };
}
test('public GETs support guests and optional auth; own GETs require a session with no identity selector', async () => {
  const s = setup(false),
    cancel = new Cancellation();
  s.transport.reply(publicProfile());
  await s.gateway.profile(profileId, cancel);
  s.transport.reply(profileList());
  await s.gateway.list(profileId, 'posts', null, cancel);
  assert.equal(
    s.transport.requests.every(
      (r) => r.method === 'GET' && !r.headers.Authorization,
    ),
    true,
  );
  await assert.rejects(s.gateway.ownProfileRef(cancel), {
    kind: 'auth-required',
  });
  await assert.rejects(s.gateway.liked(null, cancel), {
    kind: 'auth-required',
  });
  assert.equal(s.transport.requests.length, 2);
  const own = setup();
  own.transport.reply({ profileId: null });
  assert.deepEqual(await own.gateway.ownProfileRef(cancel), {
    profileId: null,
  });
  own.transport.reply(likedList());
  await own.gateway.liked('opaque_cursor', cancel, 2);
  assert.match(own.transport.requests[0]!.url, /\/v1\/me\/public-profile-ref$/);
  assert.match(
    own.transport.requests[1]!.url,
    /\/v1\/me\/community\/liked\?limit=2&cursor=opaque_cursor$/,
  );
  assert.equal(
    own.transport.requests.every((r) => r.body === undefined),
    true,
  );
});
test('invalid/expired credentials never downgrade public requests to guest, known refresh replays once', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply(
    { error: { code: 'SESSION_REVOKED', message: 'private contact' } },
    401,
  );
  await assert.rejects(s.gateway.profile(profileId, cancel), {
    kind: 'auth-required',
  });
  assert.equal(s.transport.requests.length, 1);
  assert.ok(s.transport.requests[0]!.headers.Authorization);
  s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  s.transport.reply(publicProfile());
  await s.gateway.profile(profileId, cancel);
  assert.equal(s.refreshes(), 1);
  assert.equal(s.transport.requests[1]!.url, s.transport.requests[2]!.url);
});
test('exact target/status/query/limit checks reject drift before rendering or sending malformed input', async () => {
  const s = setup(),
    cancel = new Cancellation();
  for (const status of [201, 202, 204]) {
    s.transport.reply(publicProfile(), status);
    await assert.rejects(s.gateway.profile(profileId, cancel), {
      kind: 'protocol',
    });
    s.transport.reply(likedList(), status);
    await assert.rejects(s.gateway.liked(null, cancel), { kind: 'protocol' });
  }
  s.transport.reply(publicProfile({ profileId: requestId }));
  await assert.rejects(s.gateway.profile(profileId, cancel), {
    kind: 'protocol',
  });
  s.transport.reply(profileList({ profileId: requestId, items: [] }));
  await assert.rejects(s.gateway.list(profileId, 'posts', null, cancel), {
    kind: 'protocol',
  });
  const sent = s.transport.requests.length;
  for (const run of [
    () => s.gateway.profile('1', cancel),
    () => s.gateway.profile('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', cancel),
    () => s.gateway.list(profileId, 'posts', null, cancel, 'qiugou'),
    () => s.gateway.list(profileId, 'trading', null, cancel, 'bad' as never),
    () => s.gateway.list(profileId, 'posts', 'x&accountId=other', cancel),
    () => s.gateway.liked('x'.repeat(1025), cancel),
    () => s.gateway.liked(null, cancel, 0),
    () => s.gateway.liked(null, cancel, 51),
    () => s.gateway.liked(null, cancel, 1.5),
  ])
    await assert.rejects(run(), { kind: 'protocol' });
  assert.equal(s.transport.requests.length, sent);
});
test('trading discovery enforces open named trade and known requested subtype; general posts exclude trading', async () => {
  const s = setup(),
    cancel = new Cancellation();
  const value = tradingPost({
    author: namedAuthor(),
    trading: tradingView({
      subtype: { kind: 'known', key: 'qiugou', legacyText: null },
    }),
  });
  s.transport.reply(profileList({ items: [value] }));
  await s.gateway.list(profileId, 'trading', null, cancel, 'qiugou');
  assert.match(s.transport.requests[0]!.url, /tradingSubtype=qiugou/);
  for (const [kind, subtype, listing] of [
    ['posts', undefined, value],
    ['trading', 'shuma', value],
    [
      'trading',
      undefined,
      { ...value, trading: { ...value.trading!, resolution: 'resolved' } },
    ],
  ] as const) {
    s.transport.reply(profileList({ items: [listing as never] }));
    await assert.rejects(
      s.gateway.list(profileId, kind, null, cancel, subtype),
      { kind: 'protocol' },
    );
  }
});
for (const login of ['same', 'other'] as const)
  test(`late public/own gateway replies are rejected after ${login} account login epoch`, async () => {
    for (const method of [
      'profile',
      'list',
      'ownProfileRef',
      'liked',
    ] as const) {
      const s = setup(),
        pending = deferred<ReturnType<typeof response>>(),
        cancel = new Cancellation();
      s.transport.steps.push(() => pending.promise);
      const running =
        method === 'profile'
          ? s.gateway.profile(profileId, cancel)
          : method === 'list'
            ? s.gateway.list(profileId, 'posts', null, cancel)
            : method === 'liked'
              ? s.gateway.liked(null, cancel)
              : s.gateway.ownProfileRef(cancel);
      await flush();
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('c'),
        ...(login === 'other' ? { accountId: otherId } : {}),
      });
      pending.resolve(
        response(
          method === 'profile'
            ? publicProfile()
            : method === 'list'
              ? profileList()
              : method === 'liked'
                ? likedList()
                : { profileId },
        ),
      );
      await assert.rejects(running, { kind: 'stale-session' });
    }
  });
