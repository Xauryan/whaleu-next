import assert from 'node:assert/strict';
import test from 'node:test';
import { Cancellation } from '../src/platform/contracts';
import { HttpSocialUpdatesGateway } from '../src/notifications/social-updates/gateway';
import type { SocialUpdateCategory } from '../src/notifications/social-updates/contract';
import { wireCredentials } from './identity-helpers';
import {
  noticeId,
  otherId,
  socialApi,
  socialCursor,
  socialPage,
  socialRead,
  socialResolution,
} from './social-updates-helpers';

for (const category of ['likes', 'saves', 'followers'] as const) {
  test(`social ${category} gateway sends exact authenticated category-bound routes and explicit empty read body`, async () => {
    const s = socialApi();
    const gateway = new HttpSocialUpdatesGateway(s.api, category);
    const cancel = new Cancellation();
    s.transport.reply(socialPage(category));
    await gateway.list(socialCursor, cancel, 1);
    s.transport.reply({ unreadCount: null, unreadCountStatus: 'unavailable' });
    await gateway.unread(cancel);
    s.transport.reply(socialResolution(category));
    await gateway.target(noticeId, cancel);
    s.transport.reply(socialRead());
    await gateway.markRead(noticeId, cancel);
    assert.deepEqual(
      s.transport.requests.map((r) => [r.method, new URL(r.url).pathname]),
      [
        ['GET', '/v1/me/social-updates'],
        ['GET', '/v1/me/social-updates/unread-count'],
        ['GET', `/v1/me/social-updates/${noticeId}/target`],
        ['PUT', `/v1/me/social-updates/${noticeId}/read`],
      ],
    );
    for (const [i, request] of s.transport.requests.entries()) {
      assert.deepEqual(
        Object.fromEntries(new URL(request.url).searchParams),
        i === 0 ? { limit: '1', cursor: socialCursor, category } : { category },
      );
      assert.equal(
        request.headers.Authorization,
        `Bearer ${wireCredentials().accessToken}`,
      );
      assert.equal(request.cancellation, cancel);
      assert.deepEqual(request.body, i === 3 ? {} : undefined);
    }
  });
}
test('social gateway rejects guests, bad inputs and pre-dispatch cancellation without network', async () => {
  const s = socialApi(false);
  const gateway = new HttpSocialUpdatesGateway(s.api, 'likes');
  const cancel = new Cancellation();
  for (const run of [
    () => gateway.list(null, cancel),
    () => gateway.unread(cancel),
    () => gateway.target(noticeId, cancel),
    () => gateway.markRead(noticeId, cancel),
  ])
    await assert.rejects(run, { kind: 'auth-required' });
  assert.equal(s.transport.requests.length, 0);
  const valid = socialApi();
  const own = new HttpSocialUpdatesGateway(valid.api, 'likes');
  assert.throws(
    () =>
      new HttpSocialUpdatesGateway(
        valid.api,
        'comments' as SocialUpdateCategory,
      ),
    { kind: 'protocol' },
  );
  for (const run of [
    () => own.list('bad', cancel),
    () => own.list(null, cancel, 21),
    () => own.list(null, cancel, 0),
    () => own.target('bad', cancel),
    () => own.markRead(`${noticeId}?category=saves`, cancel),
  ])
    await assert.rejects(run, { kind: 'protocol' });
  cancel.cancel();
  await assert.rejects(own.list(null, cancel), { kind: 'cancelled' });
  assert.equal(valid.transport.requests.length, 0);
});
test('social gateway binds successful response identity, category, requested limit and advancing cursor', async () => {
  const s = socialApi();
  const gateway = new HttpSocialUpdatesGateway(s.api, 'likes');
  const c = new Cancellation();
  s.transport.reply(socialResolution('likes', otherId));
  await assert.rejects(gateway.target(noticeId, c), { kind: 'protocol' });
  s.transport.reply(socialRead(otherId));
  await assert.rejects(gateway.markRead(noticeId, c), { kind: 'protocol' });
  s.transport.reply(socialPage('followers'));
  await assert.rejects(gateway.list(null, c), { kind: 'protocol' });
  s.transport.reply(socialPage('likes', { nextCursor: socialCursor }));
  await assert.rejects(gateway.list(socialCursor, c), { kind: 'protocol' });
  s.transport.reply(socialPage('likes'), 201);
  await assert.rejects(gateway.list(null, c), { kind: 'protocol' });
  const first = socialPage();
  s.transport.reply({
    ...first,
    items: [...first.items, { ...first.items[0], noticeId: otherId }],
  });
  await assert.rejects(gateway.list(null, c, 1), { kind: 'protocol' });
});
for (const operation of ['list', 'read'] as const) {
  test(`social ${operation} supports one authenticated token rotation with exact category/body and no session substitution`, async () => {
    const s = socialApi();
    const gateway = new HttpSocialUpdatesGateway(s.api, 'followers');
    const c = new Cancellation();
    s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
    s.transport.reply(
      operation === 'list' ? socialPage('followers') : socialRead(),
    );
    if (operation === 'list') await gateway.list(null, c);
    else await gateway.markRead(noticeId, c);
    assert.equal(s.transport.requests.length, 2);
    assert.equal(s.transport.requests[0]?.url, s.transport.requests[1]?.url);
    assert.deepEqual(
      s.transport.requests[0]?.body,
      s.transport.requests[1]?.body,
    );
    assert.equal(
      s.transport.requests[1]?.headers.Authorization,
      `Bearer ${wireCredentials('b').accessToken}`,
    );
    assert.equal(
      s.sessions.snapshot().credentials?.sessionId,
      wireCredentials().sessionId,
    );
  });
}
