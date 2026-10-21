import assert from 'node:assert/strict';
import test from 'node:test';
import type { WhaleuApp } from '../src/app';
import type { UpdatesList } from '../src/community/updates-contract';
import {
  initialSocialNoticesView,
  socialNoticeKind,
  SocialNoticesController,
  type SocialNoticeKind,
  type SocialNoticesView,
} from '../src/pages/social-notices/controller';
import type { WxApi } from '../src/platform/wechat';
import { createdAt, otherId, requestId, setup } from './community-helpers';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  FakeRatingLikeUpdatesGateway,
  likeNotice,
  likeUpdates,
} from './ratings-r2b-helpers';
import { FakeRatingUpdatesGateway } from './ratings-r2a-helpers';
import { update, unavailable, updates } from './updates-helpers';

function harness(kind: SocialNoticeKind, loggedIn = true) {
  const s = setup(loggedIn);
  const likes = new FakeRatingLikeUpdatesGateway();
  const replies = new FakeRatingUpdatesGateway();
  replies.listImpl = async () => ({
    items: [],
    nextCursor: null,
    unreadCount: 0,
  });
  const runtime = {
    ...s.runtime,
    ratingLikeUpdates: likes,
    ratingUpdates: replies,
  };
  const views: SocialNoticesView[] = [];
  const urls: string[] = [];
  const controller = new SocialNoticesController(
    runtime,
    kind,
    (view) => views.push(view),
    async (url) => {
      urls.push(url);
    },
  );
  return {
    ...s,
    runtime,
    likes,
    replies,
    views,
    urls,
    controller,
    view: () => controller.snapshot(),
  };
}

test('social routes accept only the three exact owner categories', () => {
  for (const kind of ['likes', 'followers', 'comments'] as const)
    assert.equal(socialNoticeKind({ kind }), kind);
  for (const query of [
    undefined,
    null,
    {},
    [],
    { kind: 'activity' },
    { kind: 'likes', accountId: otherId },
    { kind: ['likes'] },
  ])
    assert.equal(socialNoticeKind(query), null);
});

test('unconfigured followers stay unavailable without fake empty counts, requests, or navigation', async () => {
  const s = harness('followers');
  await s.controller.load();
  await s.controller.more();
  await s.controller.open(`community:${requestId}`);
  await s.controller.acknowledge(`community:${requestId}`);
  assert.equal(s.view().unavailable, true);
  assert.equal(s.view().loaded, false);
  assert.equal(s.view().configured, false);
  assert.deepEqual(s.view().rows, []);
  assert.match(s.view().coverage, /尚未接入/);
  assert.equal('unreadCount' in s.view(), false);
  assert.deepEqual(s.gateway.calls, []);
  assert.deepEqual(s.likes.calls, []);
  assert.deepEqual(s.urls, []);
  s.controller.dispose();
});

test('likes reads only actual received rating likes with no eager receipts and discloses partial coverage', async () => {
  const s = harness('likes');
  await s.controller.load();
  assert.equal(s.view().loaded, true);
  assert.equal(s.view().rows[0]?.title, likeNotice().actor.displayName);
  assert.equal(s.view().rows[0]?.preview, likeNotice().preview.text);
  assert.equal(s.view().rows[0]?.unread, true);
  assert.match(s.view().coverage, /主题获赞与被收藏通知尚未接入/);
  assert.deepEqual(
    s.likes.calls.map((call) => call.method),
    ['list'],
  );
  assert.equal(s.replies.calls.length, 0);
  assert.equal(s.gateway.calls.length, 0);
  assert.equal(s.storage.data.size, 0);
  s.controller.dispose();
});

test('comments retain real preview/read state, preserve unavailable rows and never label saved-post replies as incoming saves', async () => {
  const s = harness('comments');
  s.gateway.updatesImpl = async () =>
    updates([update(), unavailable(otherId)], 'next_cursor', 9);
  await s.controller.load();
  assert.equal(s.view().loaded, true);
  assert.equal(s.view().rows.length, 2);
  assert.equal(s.view().rows[0]?.preview, update().preview.text);
  assert.equal(s.view().rows[0]?.action, '收藏的主题有新回复');
  assert.equal(
    s.view().rows[0]?.title,
    '社区回复',
    'Do not bypass full owner identity privacy overlay',
  );
  assert.equal(s.view().rows[1]?.available, false);
  assert.equal(s.view().canMore, true);
  assert.match(s.view().coverage, /@ 提醒尚未接入/);
  assert.deepEqual(
    s.gateway.calls.map((call) => call.method),
    ['updates'],
  );
  s.gateway.updatesImpl = async () =>
    updates([update('reply', otherId)], null, 4);
  await s.controller.more();
  assert.equal(
    s.gateway.calls[s.gateway.calls.length - 1]?.args[0],
    'next_cursor',
  );
  assert.equal(s.view().rows[1]?.action, '回复有新回复');
  assert.equal(s.view().canMore, false);
  s.controller.dispose();
});

test('only explicit current-row acknowledgment writes a receipt; real target validation precedes navigation', async () => {
  const s = harness('comments');
  s.gateway.updatesImpl = async () => updates();
  s.gateway.updateTargetImpl = async (noticeId) => ({
    noticeId,
    status: 'available',
    target: update().target,
  });
  await s.controller.load();
  await s.controller.open(otherId);
  await s.controller.acknowledge(otherId);
  assert.equal(s.gateway.calls.length, 1);
  await s.controller.open(`community:${requestId}`);
  assert.equal(s.urls.length, 1);
  assert.match(
    s.urls[0]!,
    /^\/pages\/community-detail\/community-detail\?postId=/,
  );
  assert.deepEqual(
    s.gateway.calls.map((call) => call.method),
    ['updates', 'updateTarget', 'post', 'discussionContext'],
  );
  assert.equal(s.view().rows[0]?.unread, true);
  s.gateway.readUpdateImpl = async (noticeId) => ({
    noticeId,
    readAt: createdAt,
    unreadCount: 0,
  });
  await s.controller.acknowledge(`community:${requestId}`);
  await s.controller.acknowledge(`community:${requestId}`);
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'readUpdate').length,
    1,
  );
  assert.equal(s.view().rows[0]?.unread, false);
  s.controller.dispose();
});

for (const kind of ['likes', 'comments'] as const) {
  test(`${kind} guest and missing source remain unknown, never an authoritative empty list`, async () => {
    const guest = harness(kind, false);
    await guest.controller.load();
    assert.equal(guest.view().loaded, false);
    assert.equal(guest.view().hasSession, false);
    assert.equal(guest.likes.calls.length + guest.gateway.calls.length, 0);
    guest.controller.dispose();
    const s = setup();
    const controller = new SocialNoticesController(
      { ...s.runtime, gateway: undefined },
      kind,
      () => undefined,
      async () => undefined,
    );
    await controller.load();
    assert.equal(controller.snapshot().loaded, false);
    assert.ok(controller.snapshot().error);
    assert.deepEqual(controller.snapshot().rows, []);
    controller.dispose();
  });
}

for (const lifecycle of [
  'cancel',
  'dispose',
  'logout',
  'replace',
  'app-hide',
] as const) {
  test(`social ${lifecycle} clears private rows and fences delayed reads without receipts`, async () => {
    const s = harness('comments');
    const late = deferred<UpdatesList>();
    s.gateway.updatesImpl = () => late.promise;
    const work = s.controller.load();
    await flush();
    if (lifecycle === 'cancel') s.controller.cancel();
    else if (lifecycle === 'dispose') s.controller.dispose();
    else if (lifecycle === 'logout') s.sessions.logout();
    else if (lifecycle === 'replace')
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('b'),
        accountId: otherId,
      });
    else s.runtime.privateViews!.clear();
    late.resolve(updates());
    await work;
    assert.deepEqual(s.view().rows, []);
    assert.equal(s.view().loaded, false);
    assert.deepEqual(
      s.gateway.calls.map((call) => call.method),
      ['updates'],
    );
    assert.deepEqual(s.urls, []);
    if (lifecycle === 'cancel') {
      s.gateway.updatesImpl = async () => updates();
      await s.controller.load();
      assert.equal(s.view().loaded, true);
    } else {
      await s.controller.load();
      assert.equal(s.view().loaded, false);
    }
    s.controller.dispose();
  });
}

test('loaded likes are cleared on root hide and a cancelled like response cannot restore them', async () => {
  const s = harness('likes');
  await s.controller.load();
  assert.equal(s.view().rows.length, 1);
  const late = deferred<ReturnType<typeof likeUpdates>>();
  s.likes.listImpl = () => late.promise;
  const work = s.controller.load();
  await flush();
  s.runtime.privateViews!.clear();
  late.resolve(likeUpdates());
  await work;
  assert.equal(s.view().loaded, false);
  assert.deepEqual(s.view().rows, []);
  assert.ok(s.likes.calls.every((call) => call.method === 'list'));
  s.controller.dispose();
});

interface SocialPage {
  data: SocialNoticesView;
  controller: SocialNoticesController | undefined;
  setData(patch: Record<string, unknown>): void;
  onLoad(query: unknown): void;
  onShow(): Promise<void>;
  onHide(): void;
  onUnload(): void;
  onPullDownRefresh(): Promise<void>;
}
test('native social page rejects invalid deep links, refreshes the actual owner source, and clears on hide', async () => {
  const native = globalThis as typeof globalThis & { wx: WxApi };
  const previous = {
    Page: globalThis.Page,
    getApp: globalThis.getApp,
    wx: native.wx,
  };
  const s = harness('comments');
  s.controller.dispose();
  s.gateway.updatesImpl = async () => updates();
  let definition: SocialPage | undefined;
  globalThis.Page = ((value: object) => {
    definition = value as SocialPage;
  }) as typeof Page;
  const app: WhaleuApp = {
    identity: undefined,
    community: s.runtime,
    verification: undefined,
    identityCampus: undefined,
    experience: undefined,
    globalData: {
      implementationStage: 'synthetic-social-test',
      featureParityVerified: false,
    },
  };
  globalThis.getApp = (() => app) as typeof getApp;
  let refreshes = 0;
  native.wx = {
    stopPullDownRefresh: () => {
      refreshes++;
    },
  } as WxApi;
  try {
    await import('../src/pages/social-notices/social-notices.js');
    assert.ok(definition);
    const page: SocialPage = {
      ...definition,
      data: initialSocialNoticesView(null),
      setData(patch) {
        this.data = { ...this.data, ...patch };
      },
    };
    page.onLoad({ kind: 'comments', accountId: otherId });
    await page.onShow();
    assert.equal(page.controller, undefined);
    assert.match(page.data.error, /链接无效/);
    assert.equal(s.gateway.calls.length, 0);
    page.onLoad({ kind: 'comments' });
    await page.onShow();
    assert.equal(page.data.rows.length, 1);
    await page.onPullDownRefresh();
    assert.equal(refreshes, 1);
    assert.equal(
      s.gateway.calls.filter((call) => call.method === 'updates').length,
      2,
    );
    page.onHide();
    assert.deepEqual(page.data.rows, []);
    assert.equal(page.controller, undefined);
    page.onUnload();
  } finally {
    globalThis.Page = previous.Page;
    globalThis.getApp = previous.getApp;
    native.wx = previous.wx;
  }
});
