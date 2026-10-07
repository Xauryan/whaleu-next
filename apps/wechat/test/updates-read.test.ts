import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import type { CommunityGateway } from '../src/community/gateway';
import type {
  UpdateRead,
  UpdatesList,
  UpdatesUnread,
} from '../src/community/updates-contract';
import {
  UpdatesController,
  UpdatesBadgeController,
  type UpdatesView,
  type UpdatesBadgeView,
} from '../src/pages/community-updates/controller';
import {
  DetailController,
  type DetailView,
} from '../src/pages/community-detail/controller';
import {
  ThreadController,
  type ThreadView,
} from '../src/pages/community-thread/controller';
import {
  comment,
  commentId,
  createdAt,
  otherId,
  post,
  postId,
  reply,
  replyId,
  requestId,
  setup,
} from './community-helpers';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import { update, unavailable, updates } from './updates-helpers';
function harness(loggedIn = true) {
  const s = setup(loggedIn),
    views: UpdatesView[] = [],
    badges: UpdatesBadgeView[] = [],
    urls: string[] = [];
  s.gateway.updatesImpl = async () =>
    updates([update(), unavailable(otherId)], 'next_cursor', 9);
  s.gateway.updateTargetImpl = async (noticeId) => ({
    noticeId,
    status: 'available',
    target: update().target,
  });
  const controller = new UpdatesController(
    s.runtime,
    (view) => views.push(view),
    async (url) => {
      urls.push(url);
    },
  );
  const badge = new UpdatesBadgeController(s.runtime, (view) =>
    badges.push(view),
  );
  return {
    ...s,
    controller,
    badge,
    urls,
    view: () => views[views.length - 1]!,
    badgeView: () => badges[badges.length - 1]!,
  };
}

test('Updates list shows exact owner count including unavailable rows; no eager mark-read or contact/identity hydration', async () => {
  const s = harness();
  await s.controller.load();
  assert.equal(s.view().unreadCount, 9);
  assert.equal(s.view().items.length, 2);
  assert.equal(s.view().canLoadMore, true);
  assert.deepEqual(
    s.gateway.calls.map((call) => call.method),
    ['updates'],
  );
  assert.equal(s.storage.data.size, 0, 'No persistent private updates cache');
  s.gateway.updatesImpl = async () =>
    updates([unavailable(otherId), update('reply', replyId)], null, 10);
  await s.controller.more();
  assert.equal(s.view().items.length, 3);
  assert.equal(s.view().unreadCount, 10);
  assert.equal(s.view().canLoadMore, false);
  await s.controller.more();
  assert.equal(s.gateway.calls.length, 2);
});

test('guest and unconfigured Updates list/badge do not fetch or fabricate an authoritative zero', async () => {
  const s = harness(false);
  await s.controller.load();
  await s.badge.load();
  assert.equal(s.gateway.calls.length, 0);
  assert.equal(s.view().loaded, false);
  assert.equal(s.badgeView().loaded, false);
  const auth = setup(),
    views: UpdatesView[] = [];
  const controller = new UpdatesController(
    { ...auth.runtime, gateway: undefined },
    (view) => views.push(view),
    async () => undefined,
  );
  await controller.load();
  assert.equal(views[views.length - 1]!.loaded, false);
  assert.equal(views[views.length - 1]!.configured, false);
});

test('explicit acknowledgment marks only the chosen row after confirmed response and uses exact server total, never decremented guess', async () => {
  const s = harness();
  await s.controller.load();
  const pending = deferred<UpdateRead>();
  s.gateway.readUpdateImpl = () => pending.promise;
  const reading = s.controller.acknowledge(requestId);
  await flush();
  await s.controller.acknowledge(requestId);
  await s.controller.acknowledge(otherId);
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'readUpdate').length,
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
    s.gateway.calls.filter((call) => call.method === 'readUpdate').length,
    1,
  );
  s.gateway.readUpdateImpl = async (noticeId) => ({
    noticeId,
    readAt: createdAt,
    unreadCount: 16,
  });
  await s.controller.acknowledge(otherId);
  assert.equal(s.view().items[1]!.readAt, createdAt);
});

test('timeout and cancel cannot fabricate read success; same-notice retry safely reconciles unknown result', async () => {
  const s = harness();
  await s.controller.load();
  s.gateway.readUpdateImpl = async () => {
    throw new ClientError('timeout', 'safe');
  };
  await s.controller.acknowledge(requestId);
  assert.equal(s.view().items[0]!.readAt, null);
  assert.equal(s.view().unreadCount, 9);
  assert.match(s.view().status, /重试/);
  s.gateway.readUpdateImpl = async (noticeId) => ({
    noticeId,
    readAt: createdAt,
    unreadCount: 2,
  });
  await s.controller.acknowledge(requestId);
  assert.equal(s.view().unreadCount, 2);
  assert.deepEqual(
    s.gateway.calls
      .filter((call) => call.method === 'readUpdate')
      .map((call) => call.args[0]),
    [requestId, requestId],
  );
});

test('failed append preserves current window and retry cursor; stalled cursor or authority loss clears private previews/count', async () => {
  const s = harness();
  await s.controller.load();
  s.gateway.updatesImpl = async () => {
    throw new ClientError('network', 'safe');
  };
  await s.controller.more();
  assert.equal(s.view().items.length, 2);
  assert.equal(s.view().unreadCount, 9);
  assert.equal(s.view().canLoadMore, true);
  s.gateway.updatesImpl = async (after) => {
    assert.equal(after, 'next_cursor');
    return updates([update()], after, 9);
  };
  await s.controller.more();
  assert.equal(s.view().items.length, 0);
  assert.equal(s.view().unreadCount, 0);
  assert.equal(s.view().loaded, false);
  s.gateway.updatesImpl = async () => updates();
  await s.controller.load();
  s.gateway.readUpdateImpl = async () => {
    throw new ClientError('business', 'safe', {
      serverCode: 'NOTICE_NOT_FOUND',
      httpStatus: 404,
    });
  };
  await s.controller.acknowledge(requestId);
  assert.deepEqual(s.view().items, []);
  assert.equal(s.view().unreadCount, 0);
});

test('refresh cancels older pagination and read responses rather than resurrecting rows or stale unread counts', async () => {
  for (const action of ['append', 'read'] as const) {
    const s = harness();
    await s.controller.load();
    const pending = deferred<UpdatesList | UpdateRead>();
    if (action === 'append')
      s.gateway.updatesImpl = () => pending.promise as Promise<UpdatesList>;
    else
      s.gateway.readUpdateImpl = () => pending.promise as Promise<UpdateRead>;
    const old =
      action === 'append'
        ? s.controller.more()
        : s.controller.acknowledge(requestId);
    await flush();
    s.gateway.updatesImpl = async () =>
      updates([unavailable(otherId)], null, 1);
    await s.controller.load();
    pending.resolve(
      action === 'append'
        ? updates([update()], 'old_cursor', 98)
        : { noticeId: requestId, readAt: createdAt, unreadCount: 98 },
    );
    await old;
    assert.deepEqual(s.view().items, [unavailable(otherId)]);
    assert.equal(s.view().unreadCount, 1);
    assert.equal(s.view().canLoadMore, false);
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
    test(`Updates ${action} ${lifecycle} cancels and suppresses old account list/read/badge`, async () => {
      const s = harness();
      if (action === 'read') await s.controller.load();
      const pending = deferred<UpdatesList | UpdateRead | UpdatesUnread>();
      if (action === 'list')
        s.gateway.updatesImpl = () => pending.promise as Promise<UpdatesList>;
      else if (action === 'read')
        s.gateway.readUpdateImpl = () => pending.promise as Promise<UpdateRead>;
      else
        s.gateway.updatesUnreadImpl = () =>
          pending.promise as Promise<UpdatesUnread>;
      const running =
        action === 'list'
          ? s.controller.load()
          : action === 'read'
            ? s.controller.acknowledge(requestId)
            : s.badge.load();
      await flush();
      const cancel = s.gateway.calls[s.gateway.calls.length - 1]!.args[
        action === 'list' || action === 'read' ? 1 : 0
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
      pending.resolve(
        action === 'list'
          ? updates([update()], 'late', 99)
          : action === 'read'
            ? { noticeId: requestId, readAt: createdAt, unreadCount: 99 }
            : { unreadCount: 99 },
      );
      await running;
      assert.deepEqual(s.view().items, []);
      assert.equal(s.view().unreadCount, 0);
      assert.equal(s.view().loaded, false);
      assert.equal(s.badgeView().unreadCount, 0);
      assert.equal(s.badgeView().loaded, false);
    });
  }
}

test('new-account responses win over old badge and list completions; same-session token refresh preserves current owner reads', async () => {
  const s = harness(),
    old = deferred<UpdatesUnread>();
  s.gateway.updatesUnreadImpl = () => old.promise;
  const running = s.badge.load();
  await flush();
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: otherId,
  });
  s.gateway.updatesUnreadImpl = async () => ({ unreadCount: 4 });
  await s.badge.load();
  old.resolve({ unreadCount: 80 });
  await running;
  assert.equal(s.badgeView().unreadCount, 4);
  const current = deferred<UpdatesList>();
  s.gateway.updatesImpl = () => current.promise;
  const reading = s.controller.load();
  await flush();
  s.sessions.rotate(s.sessions.snapshot(), {
    ...wireCredentials('c'),
    accountId: otherId,
  });
  current.resolve(updates());
  await reading;
  assert.equal(s.view().items.length, 1);
});

test('available root and reply resolve current authorized locator before exact off-page navigation; opening never marks read', async () => {
  for (const kind of ['root', 'reply'] as const) {
    const s = harness(),
      row = update(kind);
    s.gateway.updatesImpl = async () => updates([row]);
    s.gateway.updateTargetImpl = async (noticeId) => ({
      noticeId,
      status: 'available',
      target: row.target,
    });
    await s.controller.load();
    await s.controller.open(requestId);
    assert.deepEqual(
      s.gateway.calls.map((call) => call.method),
      ['updates', 'updateTarget', 'post', 'discussionContext'],
    );
    assert.deepEqual(
      s.gateway.calls[s.gateway.calls.length - 1]!.args[1],
      kind === 'reply' ? { replyId } : { commentId },
    );
    assert.deepEqual(s.urls, [
      kind === 'reply'
        ? `/pages/community-thread/community-thread?postId=${postId}&rootCommentId=${commentId}&replyId=${replyId}`
        : `/pages/community-detail/community-detail?postId=${postId}&rootCommentId=${commentId}`,
    ]);
    assert.equal(s.view().items[0]!.readAt, null);
    assert.equal(s.view().unreadCount, 1);
    s.gateway.commentsImpl = async () => ({
      items: [comment({ id: otherId })],
      nextCursor: 'older',
    });
    s.gateway.repliesImpl = async () => ({
      items: [reply({ id: otherId })],
      nextCursor: 'older',
    });
    if (kind === 'root') {
      const views: DetailView[] = [];
      const detail = new DetailController(
        s.runtime,
        postId,
        (view) => views.push(view),
        undefined,
        { commentId },
      );
      await detail.load();
      assert.equal(views[views.length - 1]!.locatedComment?.id, commentId);
      assert.equal(views[views.length - 1]!.comments[0]!.id, otherId);
    } else {
      const views: ThreadView[] = [];
      const thread = new ThreadController(
        s.runtime,
        postId,
        commentId,
        replyId,
        (view) => views.push(view),
      );
      await thread.load();
      assert.equal(views[views.length - 1]!.locatedReply?.id, replyId);
      assert.equal(views[views.length - 1]!.replies[0]!.id, otherId);
    }
  }
});

test('unavailable target removes stale snapshot, never navigates, and remains explicitly acknowledgeable', async () => {
  const s = harness();
  await s.controller.load();
  s.gateway.updateTargetImpl = async (noticeId) => ({
    noticeId,
    status: 'unavailable',
  });
  await s.controller.open(requestId);
  assert.deepEqual(s.view().items[0], unavailable());
  assert.deepEqual(s.urls, []);
  await s.controller.open(requestId);
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'updateTarget').length,
    1,
  );
  await s.controller.acknowledge(requestId);
  assert.equal(s.view().items[0]!.readAt, createdAt);
});

test('notice target is never a visibility grant: parent denial, wrong current ancestry and post-author privacy fail closed', async () => {
  const faults: Array<(s: ReturnType<typeof harness>) => void> = [
    (s) => {
      s.gateway.postImpl = async () =>
        post({
          author: {
            kind: 'named',
            profileId: otherId,
            displayName: '合成具名作者',
            avatar: null,
          },
        });
    },
    (s) => {
      s.gateway.postImpl = async () => {
        throw new ClientError('business', 'safe', {
          serverCode: 'POST_NOT_FOUND',
          httpStatus: 404,
        });
      };
    },
    (s) => {
      s.gateway.updateTargetImpl = async (noticeId) => ({
        noticeId,
        status: 'available',
        target: { ...update().target, commentId: otherId },
      });
    },
    (s) => {
      s.gateway.discussionContextImpl = async () => ({
        comment: comment({ id: otherId }),
        reply: null,
        replies: { items: [], nextCursor: null },
      });
    },
  ];
  for (const fault of faults) {
    const s = harness();
    await s.controller.load();
    fault(s);
    await s.controller.open(requestId);
    assert.deepEqual(s.urls, []);
    assert.equal(
      s.gateway.calls.some((call) => call.method === 'readUpdate'),
      false,
    );
    assert.equal(
      s.view().items.some((item) => item.status === 'available'),
      false,
    );
  }
});

test('account switch/cancel while resolving locator cannot trigger delayed native navigation', async () => {
  for (const change of ['account', 'hide', 'cancel'] as const) {
    const s = harness();
    await s.controller.load();
    const pending =
      deferred<Awaited<ReturnType<CommunityGateway['discussionContext']>>>();
    s.gateway.discussionContextImpl = () => pending.promise;
    const opening = s.controller.open(requestId);
    await flush();
    if (change === 'account')
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('b'),
        accountId: otherId,
      });
    else if (change === 'hide') s.runtime.privateViews!.clear();
    else s.controller.cancel();
    pending.resolve({
      comment: comment(),
      reply: null,
      replies: { items: [], nextCursor: null },
    });
    await opening;
    await flush();
    assert.deepEqual(s.urls, []);
    assert.deepEqual(s.view().items, []);
    assert.equal(s.view().unreadCount, 0);
  }
});

test('late target response cannot initiate later locator requests under a replacement account', async () => {
  const s = harness();
  await s.controller.load();
  const pending =
    deferred<Awaited<ReturnType<CommunityGateway['updateTarget']>>>();
  s.gateway.updateTargetImpl = () => pending.promise;
  const opening = s.controller.open(requestId);
  await flush();
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: otherId,
  });
  pending.resolve({
    noticeId: requestId,
    status: 'available',
    target: update().target,
  });
  await opening;
  await flush();
  assert.deepEqual(
    s.gateway.calls.map((call) => call.method),
    ['updates', 'updateTarget'],
  );
  assert.deepEqual(s.urls, []);
  assert.deepEqual(s.view().items, []);
});
