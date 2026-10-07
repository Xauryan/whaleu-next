import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import type {
  SystemNoticeRead,
  SystemNoticesList,
  SystemNoticesUnread,
} from '../src/community/system-notices-contract';
import {
  SystemNoticesController,
  SystemNoticesBadgeController,
  type SystemNoticesView,
  type SystemNoticesBadgeView,
} from '../src/pages/system-notices/controller';
import { createdAt, otherId, replyId, requestId } from './community-helpers';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  systemNotice,
  systemNotices,
  systemNoticesSetup,
} from './system-notices-helpers';

function harness(loggedIn = true) {
  const s = systemNoticesSetup(loggedIn),
    views: SystemNoticesView[] = [],
    badges: SystemNoticesBadgeView[] = [];
  s.notices.listImpl = async () =>
    systemNotices(
      [systemNotice(), systemNotice({ noticeId: otherId })],
      'next_cursor',
      9,
    );
  const controller = new SystemNoticesController(s.runtime, (view) =>
    views.push(view),
  );
  const badge = new SystemNoticesBadgeController(s.runtime, (view) =>
    badges.push(view),
  );
  return {
    ...s,
    controller,
    badge,
    view: () => views[views.length - 1]!,
    badgeView: () => badges[badges.length - 1]!,
  };
}

test('owner system notices paginate without content, verification, identity, writes or private storage', async () => {
  const s = harness();
  await s.controller.load();
  assert.equal(s.view().unreadCount, 9);
  assert.equal(s.view().items.length, 2);
  assert.equal(s.view().canLoadMore, true);
  assert.deepEqual(
    s.notices.calls.map((call) => call.method),
    ['list'],
  );
  assert.deepEqual(
    s.gateway.calls,
    [],
    'No community, content or verification dependency',
  );
  assert.equal(s.storage.data.size, 0);
  s.notices.listImpl = async () =>
    systemNotices(
      [
        systemNotice({ noticeId: otherId, readAt: createdAt }),
        systemNotice({ noticeId: replyId }),
      ],
      null,
      10,
    );
  await s.controller.more();
  assert.equal(s.view().items.length, 3);
  assert.equal(s.view().items[1]!.readAt, createdAt);
  assert.equal(s.view().unreadCount, 10);
  assert.equal(s.view().canLoadMore, false);
  await s.controller.more();
  assert.equal(s.notices.calls.length, 2);
});

test('guest and missing system-notice gateway keep unknown counts unloaded', async () => {
  const s = harness(false);
  await s.controller.load();
  await s.badge.load();
  assert.equal(s.notices.calls.length, 0);
  assert.equal(s.view().loaded, false);
  assert.equal(s.badgeView().loaded, false);
  const auth = systemNoticesSetup(),
    views: SystemNoticesView[] = [],
    badges: SystemNoticesBadgeView[] = [];
  const { systemNotices: notices, ...runtime } = auth.runtime;
  assert.equal(notices, auth.notices);
  const controller = new SystemNoticesController(runtime, (view) =>
    views.push(view),
  );
  const badge = new SystemNoticesBadgeController(runtime, (view) =>
    badges.push(view),
  );
  await controller.load();
  await badge.load();
  assert.equal(views[views.length - 1]!.configured, false);
  assert.equal(badges[badges.length - 1]!.configured, false);
  assert.equal(auth.notices.calls.length, 0);
});

test('explicit read acknowledges exactly one row after response with authoritative global count', async () => {
  const s = harness();
  await s.controller.load();
  const pending = deferred<SystemNoticeRead>();
  s.notices.readImpl = () => pending.promise;
  const reading = s.controller.acknowledge(requestId);
  await flush();
  await s.controller.acknowledge(requestId);
  await s.controller.acknowledge(otherId);
  assert.equal(
    s.notices.calls.filter((call) => call.method === 'read').length,
    1,
  );
  assert.equal(s.view().unreadCount, 9);
  assert.equal(s.view().items[0]!.readAt, null);
  pending.resolve({ noticeId: requestId, readAt: createdAt, unreadCount: 17 });
  await reading;
  assert.equal(s.view().items[0]!.readAt, createdAt);
  assert.equal(s.view().items[1]!.readAt, null);
  assert.equal(s.view().unreadCount, 17);
  await s.controller.acknowledge(requestId);
  await s.controller.acknowledge(replyId);
  assert.equal(
    s.notices.calls.filter((call) => call.method === 'read').length,
    1,
  );
});

test('lost read response retains uncertainty and retry reconciles the original notice without another decrement', async () => {
  const s = harness();
  await s.controller.load();
  let committed = false;
  const firstReadAt = '2026-10-07T00:01:00.000Z';
  s.notices.readImpl = async (noticeId) => {
    if (!committed) {
      committed = true;
      throw new ClientError('timeout', 'Synthetic committed response lost');
    }
    return { noticeId, readAt: firstReadAt, unreadCount: 8 };
  };
  await s.controller.acknowledge(requestId);
  assert.equal(s.view().items[0]!.readAt, null);
  assert.equal(s.view().unreadCount, 9);
  assert.match(s.view().status, /尚未确认.*重试/);
  await s.controller.acknowledge(requestId);
  assert.equal(s.view().items[0]!.readAt, firstReadAt);
  assert.equal(s.view().unreadCount, 8);
  assert.deepEqual(
    s.notices.calls
      .filter((call) => call.method === 'read')
      .map((call) => call.args[0]),
    [requestId, requestId],
  );
  assert.deepEqual(s.gateway.calls, []);
});

test('append network failure keeps retry cursor; cyclic cursors and authority/protocol failures clear all rows and count', async () => {
  const s = harness();
  await s.controller.load();
  s.notices.listImpl = async () => {
    throw new ClientError('network', 'Synthetic');
  };
  await s.controller.more();
  assert.equal(s.view().items.length, 2);
  assert.equal(s.view().canLoadMore, true);
  s.notices.listImpl = async (after) => {
    assert.equal(after, 'next_cursor');
    return systemNotices([systemNotice()], 'third_cursor', 9);
  };
  await s.controller.more();
  s.notices.listImpl = async () =>
    systemNotices([systemNotice()], 'next_cursor', 9);
  await s.controller.more();
  assert.deepEqual(s.view().items, []);
  assert.equal(s.view().unreadCount, 0);
  for (const failure of [
    new ClientError('business', 'Synthetic', {
      serverCode: 'NOTICE_NOT_FOUND',
      httpStatus: 404,
    }),
    new ClientError('forbidden', 'Synthetic', {
      serverCode: 'AUTHORIZATION_REQUIRED',
      httpStatus: 403,
    }),
    new ClientError('protocol', 'Synthetic'),
  ]) {
    s.notices.listImpl = async () => systemNotices();
    await s.controller.load();
    s.notices.readImpl = async () => {
      throw failure;
    };
    await s.controller.acknowledge(requestId);
    assert.deepEqual(s.view().items, []);
    assert.equal(s.view().unreadCount, 0);
    assert.equal(s.view().loaded, false);
  }
});

test('mismatched read target never marks another system notice and clears obsolete owner state', async () => {
  const s = harness();
  await s.controller.load();
  s.notices.readImpl = async () => ({
    noticeId: otherId,
    readAt: createdAt,
    unreadCount: 0,
  });
  await s.controller.acknowledge(requestId);
  assert.deepEqual(s.view().items, []);
  assert.equal(s.view().loaded, false);
});

test('fresh reload cancels old page/read work and clears the stale snapshot before dispatch', async () => {
  for (const action of ['append', 'read'] as const) {
    const s = harness();
    await s.controller.load();
    const pending = deferred<SystemNoticesList | SystemNoticeRead>();
    if (action === 'append')
      s.notices.listImpl = () => pending.promise as Promise<SystemNoticesList>;
    else
      s.notices.readImpl = () => pending.promise as Promise<SystemNoticeRead>;
    const old =
      action === 'append'
        ? s.controller.more()
        : s.controller.acknowledge(requestId);
    await flush();
    const fresh = deferred<SystemNoticesList>();
    s.notices.listImpl = () => fresh.promise;
    const reload = s.controller.load();
    assert.deepEqual(s.view().items, []);
    assert.equal(s.view().unreadCount, 0);
    assert.equal(s.view().loaded, false);
    fresh.resolve(
      systemNotices([systemNotice({ noticeId: otherId })], null, 1),
    );
    await reload;
    pending.resolve(
      action === 'append'
        ? systemNotices([systemNotice()], 'old_cursor', 99)
        : { noticeId: requestId, readAt: createdAt, unreadCount: 99 },
    );
    await old;
    assert.deepEqual(s.view().items, [systemNotice({ noticeId: otherId })]);
    assert.equal(s.view().unreadCount, 1);
  }
});

for (const lifecycle of [
  'cancel',
  'dispose',
  'app-hide',
  'logout',
  'same-account',
  'switch-account',
] as const) {
  for (const action of ['list', 'read', 'badge'] as const) {
    test(`system notices ${action} ${lifecycle} synchronously clears and suppresses late callbacks`, async () => {
      const s = harness();
      if (action === 'read') await s.controller.load();
      const pending = deferred<
        SystemNoticesList | SystemNoticeRead | SystemNoticesUnread
      >();
      if (action === 'list')
        s.notices.listImpl = () =>
          pending.promise as Promise<SystemNoticesList>;
      else if (action === 'read')
        s.notices.readImpl = () => pending.promise as Promise<SystemNoticeRead>;
      else
        s.notices.unreadImpl = () =>
          pending.promise as Promise<SystemNoticesUnread>;
      const running =
        action === 'list'
          ? s.controller.load()
          : action === 'read'
            ? s.controller.acknowledge(requestId)
            : s.badge.load();
      await flush();
      const cancel = s.notices.calls[s.notices.calls.length - 1]!.args[
        action === 'badge' ? 0 : 1
      ] as { isCancelled: boolean };
      if (lifecycle === 'cancel') {
        s.controller.cancel();
        s.badge.cancel();
      } else if (lifecycle === 'dispose') {
        s.controller.dispose();
        s.badge.dispose();
      } else if (lifecycle === 'app-hide') s.runtime.privateViews!.clear();
      else if (lifecycle === 'logout') s.sessions.logout();
      else
        s.sessions.completeLogin(s.sessions.beginLogin(), {
          ...wireCredentials('b'),
          accountId: lifecycle === 'same-account' ? s.accountId : otherId,
        });
      assert.equal(cancel.isCancelled, true);
      assert.deepEqual(s.view().items, []);
      assert.equal(s.view().unreadCount, 0);
      assert.equal(s.badgeView().unreadCount, 0);
      pending.resolve(
        action === 'list'
          ? systemNotices([systemNotice()], 'late', 99)
          : action === 'read'
            ? { noticeId: requestId, readAt: createdAt, unreadCount: 99 }
            : { unreadCount: 99 },
      );
      await running;
      assert.deepEqual(s.view().items, []);
      assert.equal(s.view().loaded, false);
      assert.equal(s.view().unreadCount, 0);
      assert.equal(s.badgeView().loaded, false);
      assert.equal(s.badgeView().unreadCount, 0);
      if (lifecycle === 'dispose' || lifecycle === 'app-hide') {
        const count = s.notices.calls.length;
        await s.controller.load();
        await s.badge.load();
        assert.equal(
          s.notices.calls.length,
          count,
          'Hidden/disposed controllers cannot dispatch again',
        );
      }
    });
  }
}

test('replacement login reads win over old completions while same-session token rotation preserves active owner', async () => {
  const s = harness(),
    old = deferred<SystemNoticesUnread>();
  s.notices.unreadImpl = () => old.promise;
  const running = s.badge.load();
  await flush();
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: otherId,
  });
  s.notices.unreadImpl = async () => ({ unreadCount: 4 });
  await s.badge.load();
  old.resolve({ unreadCount: 80 });
  await running;
  assert.equal(s.badgeView().unreadCount, 4);
  const current = deferred<SystemNoticesList>();
  s.notices.listImpl = () => current.promise;
  const reading = s.controller.load();
  await flush();
  s.sessions.rotate(s.sessions.snapshot(), {
    ...wireCredentials('c'),
    accountId: otherId,
  });
  current.resolve(systemNotices());
  await reading;
  assert.equal(s.view().items.length, 1);
});

test('same-tick cancel prevents dispatch; failed fresh badge read never leaves an authoritative stale count', async () => {
  const s = harness();
  const pending = s.controller.load();
  s.controller.cancel();
  await pending;
  assert.equal(s.notices.calls.length, 0);
  await s.badge.load();
  assert.equal(s.badgeView().loaded, true);
  s.notices.unreadImpl = async () => {
    throw new ClientError('network', 'Synthetic');
  };
  await s.badge.load();
  assert.equal(s.badgeView().unreadCount, 0);
  assert.equal(s.badgeView().loaded, false);
});

test('terminal owner authentication rejection clears notice list and badge and invalidates only the active session', async () => {
  for (const failure of [
    new ClientError('auth-required', 'Synthetic revoked session', {
      httpStatus: 401,
      serverCode: 'SESSION_REVOKED',
    }),
    new ClientError('forbidden', 'Synthetic blocked account', {
      httpStatus: 403,
      serverCode: 'ACCOUNT_BLOCKED',
    }),
  ]) {
    const s = harness();
    await s.controller.load();
    await s.badge.load();
    s.notices.readImpl = async () => {
      throw failure;
    };
    await s.controller.acknowledge(requestId);
    assert.equal(s.sessions.snapshot().credentials, null);
    assert.deepEqual(s.view().items, []);
    assert.equal(s.view().loaded, false);
    assert.equal(s.view().unreadCount, 0);
    assert.equal(s.badgeView().loaded, false);
    assert.equal(s.badgeView().unreadCount, 0);
  }
});
