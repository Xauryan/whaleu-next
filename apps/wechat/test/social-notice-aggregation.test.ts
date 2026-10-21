import assert from 'node:assert/strict';
import test from 'node:test';
import { WindowDiscussionNoticesController } from '../src/window-discussion/notices-controller';
import { MajorDiscussionNoticesController } from '../src/major-discussion/notices-controller';
import { ClientError } from '../src/api/errors';
import { SafetyChanges } from '../src/community/safety-changes';
import type { DiscussionNotices as WindowNotices } from '../src/window-discussion/contract';
import type { DiscussionNotices as MajorNotices } from '../src/major-discussion/contract';
import {
  SocialNoticesController,
  type SocialNoticeKind,
} from '../src/pages/social-notices/controller';
import { setup } from './community-helpers';
import { deferred, flush } from './helpers';
import {
  FakeRatingUpdatesGateway,
  notice as ratingNotice,
  updates as ratingUpdates,
} from './ratings-r2a-helpers';
import {
  FakeRatingLikeUpdatesGateway,
  likeNotice,
  likeUpdates,
} from './ratings-r2b-helpers';
import {
  FakeRatingSubscriptionUpdatesGateway,
  subscriptionNotice,
  subscriptionUpdates,
} from './ratings-r2c-helpers';
import {
  discussionHarness as windowHarness,
  notice as windowNotice,
} from './window-discussion-helpers';
import {
  discussionHarness as majorHarness,
  notice as majorNotice,
} from './major-discussion-helpers';
import { update, updates } from './updates-helpers';

const sharedId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const nextId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const oldTime = '2026-10-19T10:00:00.000Z';
const newTime = '2026-10-20T10:00:00.000Z';
function harness(kind: SocialNoticeKind = 'comments') {
  const s = setup();
  const window = windowHarness();
  const major = majorHarness();
  window.controller.dispose();
  major.controller.dispose();
  const rating = new FakeRatingUpdatesGateway();
  const likes = new FakeRatingLikeUpdatesGateway();
  const subscriptions = new FakeRatingSubscriptionUpdatesGateway();
  s.gateway.updatesImpl = async () =>
    updates([{ ...update(), noticeId: sharedId, createdAt: newTime }]);
  rating.listImpl = async () =>
    ratingUpdates({
      items: [ratingNotice({ noticeId: sharedId, createdAt: oldTime })],
    });
  likes.listImpl = async () =>
    likeUpdates({
      items: [likeNotice({ noticeId: sharedId, createdAt: oldTime })],
    });
  subscriptions.listImpl = async () =>
    subscriptionUpdates({
      items: [subscriptionNotice({ noticeId: sharedId, createdAt: oldTime })],
    });
  const windowRow = {
    ...windowNotice(),
    noticeId: sharedId,
    createdAt: oldTime,
  };
  const majorRow = { ...majorNotice(), noticeId: sharedId, createdAt: oldTime };
  window.impl.notices = async () => ({
    items: [windowRow],
    nextCursor: null,
    unreadCount: 19,
  });
  major.impl.notices = async () => ({
    items: [majorRow],
    nextCursor: null,
    unreadCount: 23,
  });
  const safetyChanges = new SafetyChanges(s.runtime.privateViews);
  assert.ok(window.runtime.windowDiscussion);
  assert.ok(major.runtime.majorDiscussion);
  const runtime = {
    ...s.runtime,
    safetyChanges,
    ratingUpdates: rating,
    ratingLikeUpdates: likes,
    ratingSubscriptionUpdates: subscriptions,
    windowDiscussion: window.runtime.windowDiscussion,
    majorDiscussion: major.runtime.majorDiscussion,
  };
  const urls: string[] = [];
  const controller = new SocialNoticesController(
    runtime,
    kind,
    () => undefined,
    async (url) => {
      urls.push(url);
    },
  );
  return {
    ...s,
    runtime,
    window,
    major,
    rating,
    likes,
    subscriptions,
    controller,
    urls,
    safetyChanges,
    windowRow,
    majorRow,
    view: () => controller.snapshot(),
  };
}

test('reply timeline merges all five owner sources with collision-proof IDs and stable real timestamp order, without totals or eager reads', async () => {
  const s = harness();
  await s.controller.load();
  assert.equal(s.view().rows.length, 5);
  assert.deepEqual(
    s.view().rows.map((row) => row.id),
    [
      `community:${sharedId}`,
      `major:${sharedId}`,
      `rating-reply:${sharedId}`,
      `rating-subscription:${sharedId}`,
      `window:${sharedId}`,
    ],
  );
  assert.equal(new Set(s.view().rows.map((row) => row.id)).size, 5);
  assert.equal(s.view().rows[0]?.createdAt, newTime);
  assert.ok(s.view().rows.every((row) => row.unread));
  assert.equal('unreadCount' in s.view(), false);
  assert.ok(s.view().sources.every((source) => !('unreadCount' in source)));
  assert.deepEqual(s.window.calls, ['notices']);
  assert.deepEqual(s.major.calls, ['notices']);
  assert.deepEqual(
    s.rating.calls.map((call) => call.method),
    ['list'],
  );
  assert.deepEqual(
    s.subscriptions.calls.map((call) => call.method),
    ['list'],
  );
  assert.equal(s.likes.calls.length, 0);
  assert.equal(s.view().title, '回复和@');
  s.controller.dispose();
});

test('likes gather real rating/dining/major likes while replies and unknown event kinds are not duplicated', async () => {
  const s = harness('likes');
  const unknown = {
    noticeId: nextId,
    createdAt: newTime,
    readAt: null,
    status: 'unavailable' as const,
  };
  const w = s.windowRow;
  const m = s.majorRow;
  assert.equal(w.status, 'available');
  assert.equal(m.status, 'available');
  s.window.impl.notices = async () => ({
    items: [{ ...w, kind: 'like' }, unknown],
    nextCursor: null,
    unreadCount: 2,
  });
  s.major.impl.notices = async () => ({
    items: [{ ...m, kind: 'like' }, unknown],
    nextCursor: null,
    unreadCount: 2,
  });
  await s.controller.load();
  assert.deepEqual(
    s
      .view()
      .rows.map((row) => row.source)
      .sort(),
    ['major', 'rating-like', 'window'],
  );
  assert.equal(
    s.gateway.calls.length +
      s.rating.calls.length +
      s.subscriptions.calls.length,
    0,
  );
  assert.ok(s.view().rows.every((row) => row.available));
  s.controller.dispose();
  const comments = new SocialNoticesController(
    s.runtime,
    'comments',
    () => undefined,
    async () => undefined,
  );
  await comments.load();
  assert.deepEqual(
    comments
      .snapshot()
      .rows.filter((row) => row.source === 'window' || row.source === 'major')
      .map((row) => row.id)
      .sort(),
    [`major:${nextId}`, `window:${nextId}`],
  );
  assert.ok(
    comments
      .snapshot()
      .rows.filter((row) => row.noticeId === nextId)
      .every(
        (row) =>
          !row.available && row.title === '消息暂不可查看' && !row.action,
      ),
  );
  comments.dispose();
});

for (const source of ['window', 'major'] as const) {
  test(`${source} pagination retains earlier validated rows and advances only its own cursor`, async () => {
    const s = harness();
    const cursors: (string | null)[] = [];
    const page = <T extends { noticeId: string }>(
      first: T,
      cursor: string | null,
    ) => {
      cursors.push(cursor);
      return {
        items: cursor ? [{ ...first, noticeId: nextId }] : [first],
        nextCursor: cursor ? null : 'next-cursor',
        unreadCount: 2,
      };
    };
    if (source === 'window')
      s.window.impl.notices = async (cursor) => page(s.windowRow, cursor);
    else s.major.impl.notices = async (cursor) => page(s.majorRow, cursor);
    await s.controller.load();
    const otherCalls =
      source === 'window' ? s.major.calls.length : s.window.calls.length;
    await s.controller.more('not-a-source');
    assert.deepEqual(cursors, [null]);
    await s.controller.more(source);
    assert.deepEqual(cursors, [null, 'next-cursor']);
    assert.equal(
      source === 'window' ? s.major.calls.length : s.window.calls.length,
      otherCalls,
    );
    assert.deepEqual(
      s
        .view()
        .rows.filter((row) => row.source === source)
        .map((row) => row.noticeId)
        .sort(),
      [sharedId, nextId].sort(),
    );
    assert.equal(s.view().rows.length, 6);
    assert.equal(
      s.view().sources.find((item) => item.key === source)?.canMore,
      false,
    );
    s.controller.dispose();
  });
}

test('namespaced acknowledgments and target resolution dispatch only to the exact current owner', async () => {
  const s = harness();
  await s.controller.load();
  await s.controller.acknowledge(sharedId);
  await s.controller.open(`window:not-a-current-notice`);
  assert.deepEqual(s.window.calls, ['notices']);
  s.window.impl.read = async (noticeId) => {
    assert.equal(noticeId, sharedId);
    s.window.impl.notices = async () => ({
      items: [{ ...s.windowRow, readAt: newTime }],
      nextCursor: null,
      unreadCount: 0,
    });
    return { noticeId, readAt: newTime };
  };
  await s.controller.acknowledge(`window:${sharedId}`);
  assert.deepEqual(s.window.calls, ['notices', 'read', 'notices']);
  assert.equal(
    s.view().rows.find((row) => row.id === `window:${sharedId}`)?.unread,
    false,
  );
  assert.ok(
    s
      .view()
      .rows.filter((row) => row.source !== 'window')
      .every((row) => row.unread),
  );
  assert.deepEqual(s.major.calls, ['notices']);
  assert.ok(s.rating.calls.every((call) => call.method === 'list'));
  await s.controller.open(`major:${sharedId}`);
  assert.deepEqual(s.major.calls, ['notices', 'target']);
  assert.match(
    s.urls[0]!,
    /^\/pages\/major-discussion-thread\/major-discussion-thread\?/,
  );
  assert.match(s.urls[0]!, new RegExp(`noticeId=${sharedId}`));
  s.controller.dispose();
});

test('one unavailable source cannot erase successful sibling events or fabricate its own empty history', async () => {
  const s = harness();
  s.window.impl.notices = async () => {
    throw new ClientError('network', 'synthetic unavailable');
  };
  await s.controller.load();
  assert.equal(s.view().rows.length, 4);
  assert.equal(
    s.view().sources.find((item) => item.key === 'window')?.loaded,
    false,
  );
  assert.ok(s.view().sources.find((item) => item.key === 'window')?.error);
  assert.equal(s.view().partial, true);
  assert.match(s.view().error, /部分消息/);
  assert.ok(s.view().rows.every((row) => row.source !== 'window'));
  s.controller.dispose();
});

for (const source of ['window', 'major'] as const) {
  for (const reason of ['safety', 'logout', 'hide', 'cancel'] as const) {
    test(`${source} append-page ${reason} invalidation clears all prior owner events and rejects late completion`, async () => {
      const s = harness();
      const owner = s[source];
      if (source === 'window')
        s.window.impl.notices = async () => ({
          items: [s.windowRow],
          nextCursor: 'next-cursor',
          unreadCount: 2,
        });
      else
        s.major.impl.notices = async () => ({
          items: [s.majorRow],
          nextCursor: 'next-cursor',
          unreadCount: 2,
        });
      await s.controller.load();
      const lateWindow = deferred<WindowNotices>();
      const lateMajor = deferred<MajorNotices>();
      if (source === 'window') s.window.impl.notices = () => lateWindow.promise;
      else s.major.impl.notices = () => lateMajor.promise;
      const more = s.controller.more(source);
      await flush();
      if (reason === 'safety') s.safetyChanges.invalidate(s.accountId);
      else if (reason === 'logout') s.sessions.logout();
      else if (reason === 'hide') s.runtime.privateViews!.clear();
      else s.controller.cancel();
      if (source === 'window')
        lateWindow.resolve({
          items: [{ ...s.windowRow, noticeId: nextId }],
          nextCursor: null,
          unreadCount: 9,
        });
      else
        lateMajor.resolve({
          items: [{ ...s.majorRow, noticeId: nextId }],
          nextCursor: null,
          unreadCount: 9,
        });
      await more;
      assert.deepEqual(s.view().rows, []);
      assert.deepEqual(s.view().sources, []);
      assert.equal(s.view().loaded, false);
      await s.controller.open(`${source}:${sharedId}`);
      await s.controller.acknowledge(`${source}:${sharedId}`);
      assert.equal(
        owner.calls.includes('target') || owner.calls.includes('read'),
        false,
      );
      assert.deepEqual(s.urls, []);
      s.controller.dispose();
    });
  }
}

test('fractional server timestamps have chronological order rather than locale string order', async () => {
  const s = harness();
  s.gateway.updatesImpl = async () =>
    updates([
      {
        ...update(),
        noticeId: sharedId,
        createdAt: '2026-10-20T10:00:00.123Z',
      },
    ]);
  s.rating.listImpl = async () =>
    ratingUpdates({
      items: [
        ratingNotice({
          noticeId: sharedId,
          createdAt: '2026-10-20T10:00:00.123456Z',
        }),
      ],
    });
  await s.controller.load();
  assert.equal(s.view().rows[0]?.source, 'rating-reply');
  assert.equal(s.view().rows[1]?.source, 'community');
  s.controller.dispose();
});

for (const source of ['window', 'major'] as const) {
  test(`${source} owner append mode clears retained pages on safety changes without relying on the social wrapper`, async () => {
    const s = harness();
    s.controller.dispose();
    if (source === 'window')
      s.window.impl.notices = async (cursor) => ({
        items: [{ ...s.windowRow, noticeId: cursor ? nextId : sharedId }],
        nextCursor: cursor ? null : 'next-cursor',
        unreadCount: 2,
      });
    else
      s.major.impl.notices = async (cursor) => ({
        items: [{ ...s.majorRow, noticeId: cursor ? nextId : sharedId }],
        nextCursor: cursor ? null : 'next-cursor',
        unreadCount: 2,
      });
    let state: { loaded: boolean; items: readonly { noticeId: string }[] } = {
      loaded: false,
      items: [],
    };
    const render = (view: typeof state) => {
      state = view;
    };
    const owner =
      source === 'window'
        ? new WindowDiscussionNoticesController(s.runtime, render, true)
        : new MajorDiscussionNoticesController(s.runtime, render, true);
    await owner.reload();
    await owner.next();
    assert.equal(state.items.length, 2);
    s.safetyChanges.invalidate(s.accountId);
    assert.equal(state.loaded, false);
    assert.deepEqual(state.items, []);
    await owner.open(sharedId, () => {
      assert.fail('stale owner must not navigate');
    });
    await owner.read(sharedId);
    assert.equal(
      s[source].calls.includes('target') || s[source].calls.includes('read'),
      false,
    );
    owner.dispose();
  });
}
