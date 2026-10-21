import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { SocialUpdatesController } from '../src/notifications/social-updates/controller';
import type {
  SocialUpdateRead,
  SocialUpdateResolution,
  SocialUpdatesPage,
} from '../src/notifications/social-updates/contract';
import { commentId, replyId, setup } from './community-helpers';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  noticeId,
  otherId,
  postId,
  socialCreatedAt,
  socialCursor,
  socialHarness,
  socialNotice,
  socialPage,
  socialRead,
  socialReadAt,
  socialResolution,
} from './social-updates-helpers';

for (const category of ['likes', 'saves', 'followers'] as const) {
  test(`social ${category} list/open never acknowledge; only explicit current-row read changes that notice`, async () => {
    const s = socialHarness(category);
    await s.controller.load();
    assert.equal(s.view().unreadCount, 7, 'Use owner total, never page length');
    await s.controller.open('bad');
    await s.controller.acknowledge(otherId);
    assert.equal(s.gateway.calls.length, 1);
    await s.controller.open(noticeId);
    assert.deepEqual(
      s.gateway.calls.map((c) => c.method),
      ['list', 'target'],
    );
    assert.equal(s.view().items[0]?.readAt, null);
    assert.equal(s.urls.length, 1);
    assert.ok(
      !s.urls[0]?.includes('noticeId'),
      'Destination cannot implicitly acknowledge this source',
    );
    assert.match(
      s.urls[0]!,
      category === 'followers'
        ? /^\/pages\/public-profile\/public-profile\?profileId=/
        : /^\/pages\/community-detail\/community-detail\?postId=/,
    );
    await Promise.all([
      s.controller.acknowledge(noticeId),
      s.controller.acknowledge(noticeId),
    ]);
    await s.controller.acknowledge(noticeId);
    assert.equal(s.gateway.calls.filter((c) => c.method === 'read').length, 1);
    assert.equal(s.view().items[0]?.readAt, socialReadAt);
    assert.equal(s.view().unreadCount, 6);
    assert.equal(s.storage.data.size, 0);
    s.controller.dispose();
  });
}
test('social reply/root targets route precisely without attaching an implicit-read notice ID', async () => {
  for (const target of [
    { type: 'community' as const, postId, commentId, replyId: null },
    { type: 'community' as const, postId, commentId, replyId },
  ]) {
    const s = socialHarness();
    const item = { ...socialNotice(), target };
    s.gateway.listImpl = async () => socialPage('likes', { items: [item] });
    s.gateway.targetImpl = async () => ({
      noticeId,
      status: 'available',
      target,
    });
    await s.controller.load();
    await s.controller.open(noticeId);
    assert.equal(
      s.urls[0],
      target.replyId
        ? `/pages/community-thread/community-thread?postId=${postId}&rootCommentId=${commentId}&replyId=${replyId}`
        : `/pages/community-detail/community-detail?postId=${postId}&rootCommentId=${commentId}`,
    );
    assert.equal(
      s.gateway.calls.some((c) => c.method === 'read'),
      false,
    );
    s.controller.dispose();
  }
});
test('social unavailable resolution removes every actor/target field but permits separate explicit acknowledgment', async () => {
  const s = socialHarness('followers');
  await s.controller.load();
  s.gateway.targetImpl = async () => ({ noticeId, status: 'unavailable' });
  await s.controller.open(noticeId);
  assert.deepEqual(s.view().items, [
    {
      noticeId,
      createdAt: socialCreatedAt,
      readAt: null,
      status: 'unavailable',
    },
  ]);
  assert.deepEqual(s.urls, []);
  await s.controller.open(noticeId);
  assert.equal(s.gateway.calls.filter((c) => c.method === 'target').length, 1);
  await s.controller.acknowledge(noticeId);
  assert.equal(s.view().items[0]?.readAt, socialReadAt);
  s.controller.dispose();
});
test('social source unknown coverage stays nullable after list and read, and does not synthesize zero', async () => {
  const s = socialHarness();
  s.gateway.listImpl = async () =>
    socialPage('likes', {
      unreadCount: null,
      unreadCountStatus: 'unavailable',
    });
  s.gateway.readImpl = async () => ({
    ...socialRead(),
    unreadCount: null,
    unreadCountStatus: 'unavailable',
  });
  await s.controller.load();
  assert.equal(s.view().loaded, true);
  assert.equal(s.view().unreadCount, null);
  assert.equal(s.view().unreadCountStatus, 'unavailable');
  await s.controller.acknowledge(noticeId);
  assert.equal(s.view().items[0]?.readAt, socialReadAt);
  assert.equal(s.view().unreadCount, null);
  s.controller.dispose();
});
test('social pages append independently, reject cursor cycles and immutable receipt rewrites', async () => {
  for (const failure of ['cycle', 'createdAt', 'readAt', 'target'] as const) {
    const s = socialHarness();
    s.gateway.listImpl = async () =>
      socialPage('likes', { nextCursor: socialCursor });
    await s.controller.load();
    await s.controller.acknowledge(noticeId);
    if (failure === 'cycle')
      s.gateway.listImpl = async () =>
        socialPage('likes', { nextCursor: socialCursor });
    else {
      const item = {
        ...socialNotice(),
        readAt: socialReadAt,
        ...(failure === 'createdAt'
          ? { createdAt: '2026-10-20T10:01:00.000000Z' }
          : {}),
        ...(failure === 'readAt' ? { readAt: null } : {}),
        ...(failure === 'target'
          ? {
              target: {
                type: 'community' as const,
                postId: otherId,
                commentId: null,
                replyId: null,
              },
            }
          : {}),
      };
      s.gateway.listImpl = async () => socialPage('likes', { items: [item] });
    }
    await s.controller.more();
    assert.equal(s.view().loaded, false);
    assert.deepEqual(s.view().items, []);
    assert.equal(s.view().unreadCount, null);
    assert.match(s.view().error, /社区点赞/);
    s.controller.dispose();
  }
  const s = socialHarness();
  s.gateway.listImpl = async (cursor) =>
    socialPage('likes', {
      items: [socialNotice('likes', cursor ? otherId : noticeId)],
      nextCursor: cursor ? null : socialCursor,
      unreadCount: 81,
    });
  await s.controller.load();
  await Promise.all([s.controller.more(), s.controller.more()]);
  assert.deepEqual(
    s.gateway.calls.map((c) => c.id),
    [null, socialCursor],
  );
  assert.equal(s.view().items.length, 2);
  assert.equal(s.view().unreadCount, 81);
  s.controller.dispose();
});
test('social target identity and ancestry mismatches fail closed rather than navigating', async () => {
  for (const result of [
    { ...socialResolution(), noticeId: otherId },
    {
      noticeId,
      status: 'available' as const,
      target: {
        type: 'community' as const,
        postId: otherId,
        commentId: null,
        replyId: null,
      },
    },
  ]) {
    const s = socialHarness();
    await s.controller.load();
    s.gateway.targetImpl = async () => result;
    await s.controller.open(noticeId);
    assert.deepEqual(s.urls, []);
    assert.deepEqual(s.view().items, []);
    s.controller.dispose();
  }
});
test('social uncertain read can retry original ID; malformed or pre-occurrence acknowledgments cannot settle', async () => {
  const s = socialHarness();
  await s.controller.load();
  s.gateway.readImpl = async () => {
    throw new ClientError('network', 'fictional raw private server text');
  };
  await s.controller.acknowledge(noticeId);
  assert.equal(s.view().items[0]?.readAt, null);
  assert.equal(s.view().unreadCount, null);
  assert.ok(!s.view().error.includes('private'));
  s.gateway.readImpl = async (id) => socialRead(id);
  await s.controller.acknowledge(noticeId);
  assert.equal(s.view().items[0]?.readAt, socialReadAt);
  assert.deepEqual(
    s.gateway.calls.filter((c) => c.method === 'read').map((c) => c.id),
    [noticeId, noticeId],
  );
  s.controller.dispose();
  for (const receipt of [
    { ...socialRead(), noticeId: otherId },
    { ...socialRead(), readAt: '2026-10-20T10:00:00.000000Z' },
  ]) {
    const broken = socialHarness();
    await broken.controller.load();
    broken.gateway.readImpl = async () => receipt;
    await broken.controller.acknowledge(noticeId);
    assert.deepEqual(broken.view().items, []);
    assert.equal(broken.view().unreadCount, null);
    broken.controller.dispose();
  }
});
for (const operation of ['list', 'more', 'open', 'read'] as const) {
  for (const reason of [
    'cancel',
    'dispose',
    'logout',
    'replace',
    'same-account-login',
    'hide',
    'safety',
  ] as const) {
    test(`social late ${operation} response is cancelled and scrubbed on ${reason}`, async () => {
      const s = socialHarness('followers');
      s.gateway.listImpl = async () =>
        socialPage('followers', { nextCursor: socialCursor });
      if (operation !== 'list') await s.controller.load();
      const page = deferred<SocialUpdatesPage>();
      const target = deferred<SocialUpdateResolution>();
      const read = deferred<SocialUpdateRead>();
      s.gateway.listImpl = () => page.promise;
      s.gateway.targetImpl = () => target.promise;
      s.gateway.readImpl = () => read.promise;
      const work =
        operation === 'list'
          ? s.controller.load()
          : operation === 'more'
            ? s.controller.more()
            : operation === 'open'
              ? s.controller.open(noticeId)
              : s.controller.acknowledge(noticeId);
      await flush();
      const sent = s.gateway.calls[s.gateway.calls.length - 1]!;
      if (reason === 'cancel') s.controller.cancel();
      else if (reason === 'dispose') s.controller.dispose();
      else if (reason === 'logout') s.sessions.logout();
      else if (reason === 'replace' || reason === 'same-account-login')
        s.sessions.completeLogin(s.sessions.beginLogin(), {
          ...wireCredentials('b'),
          accountId:
            reason === 'replace' ? otherId : wireCredentials().accountId,
        });
      else if (reason === 'hide') s.runtime.privateViews!.clear();
      else s.safetyChanges.invalidate(s.accountId);
      assert.equal(sent.cancel.isCancelled, true);
      assert.deepEqual(s.view().items, []);
      assert.equal(s.view().unreadCount, null);
      page.resolve(socialPage('followers'));
      target.resolve(socialResolution('followers'));
      read.resolve(socialRead());
      await work;
      await flush();
      assert.deepEqual(s.view().items, []);
      assert.deepEqual(s.urls, []);
      assert.equal(s.view().loaded, false);
      assert.equal(s.view().canMore, false);
      if (reason !== 'cancel') {
        await s.controller.load();
        assert.equal(s.view().loaded, false);
      }
      s.controller.dispose();
    });
  }
}
test('same-account token rotation preserves owned work while unrelated invalidations do not clear it', async () => {
  const s = socialHarness();
  const late = deferred<SocialUpdatesPage>();
  s.gateway.listImpl = () => late.promise;
  const work = s.controller.load();
  await flush();
  s.sessions.rotate(s.sessions.snapshot(), wireCredentials('b'));
  s.safetyChanges.invalidate(otherId);
  s.runtime.privateViews!.clear(otherId);
  late.resolve(socialPage());
  await work;
  assert.equal(s.view().loaded, true);
  assert.equal(s.view().items.length, 1);
  assert.equal(s.gateway.calls[0]?.cancel.isCancelled, false);
  s.controller.dispose();
});
test('guest/missing source and same-tick cancellation never dispatch, load failure remains unknown', async () => {
  const guest = socialHarness('followers', false);
  await guest.controller.load();
  assert.equal(guest.gateway.calls.length, 0);
  assert.equal(guest.view().unreadCount, null);
  guest.controller.dispose();
  const runtime = setup().runtime;
  const missing = new SocialUpdatesController(
    runtime,
    undefined,
    'followers',
    () => undefined,
    async () => undefined,
  );
  await missing.load();
  assert.equal(missing.snapshot().loaded, false);
  assert.equal(missing.snapshot().configured, false);
  missing.dispose();
  const s = socialHarness();
  const work = s.controller.load();
  s.controller.cancel();
  await work;
  assert.equal(s.gateway.calls.length, 0);
  s.gateway.listImpl = async () => {
    throw new ClientError('network', 'fictional private text');
  };
  await s.controller.load();
  assert.equal(s.view().loaded, false);
  assert.equal(s.view().unreadCount, null);
  assert.match(s.view().error, /社区点赞/);
  s.controller.dispose();
});

test('social token-bound cursor rejection clears continuation but preserves rotated credentials for fresh reload', async () => {
  const s = socialHarness();
  s.gateway.listImpl = async () =>
    socialPage('likes', { nextCursor: socialCursor });
  await s.controller.load();
  s.sessions.rotate(s.sessions.snapshot(), wireCredentials('b'));
  assert.equal(s.view().loaded, true);
  s.gateway.listImpl = async () => {
    throw new ClientError('business', 'Fictional token-bound cursor restart', {
      serverCode: 'DISCOVERY_RESTART_REQUIRED',
    });
  };
  await s.controller.more();
  assert.equal(s.view().loaded, false);
  assert.equal(s.view().canMore, false);
  assert.deepEqual(s.view().items, []);
  assert.equal(s.view().unreadCount, null);
  assert.equal(
    s.sessions.snapshot().credentials?.accessToken,
    wireCredentials('b').accessToken,
  );
  s.gateway.listImpl = async () => socialPage();
  await s.controller.load();
  assert.equal(s.view().loaded, true);
  assert.equal(s.gateway.calls[s.gateway.calls.length - 1]?.id, null);
  s.controller.dispose();
});
test('social late old-token rejection cannot log out a newer same-session rotation', async () => {
  const s = socialHarness();
  const late = deferred<SocialUpdatesPage>();
  s.gateway.listImpl = () => late.promise;
  const work = s.controller.load();
  await flush();
  s.sessions.rotate(s.sessions.snapshot(), wireCredentials('b'));
  late.reject(
    new ClientError('auth-required', 'Fictional old-token rejection'),
  );
  await work;
  assert.equal(
    s.sessions.snapshot().credentials?.accessToken,
    wireCredentials('b').accessToken,
  );
  assert.deepEqual(s.view().items, []);
  s.controller.dispose();
});
