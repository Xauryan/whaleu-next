import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { WhaleuApp } from '../src/app';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import type { SavedList } from '../src/community/saved-contract';
import {
  MeContentController,
  type MeContentView,
} from '../src/pages/me/controller';
import type { ProfileView } from '../src/pages/profile/controller';
import type { WxApi } from '../src/platform/wechat';
import { createProfileAvatarRuntime } from '../src/profile/avatar-runtime';
import type { AvatarReadView } from '../src/profile/avatar-read-controller';
import type { CoverReadView } from '../src/profile/cover-read-controller';
import { createProfileCoverRuntime } from '../src/profile/cover-runtime';
import { FakeCoverGateway, coverIds } from './support/cover-fixtures';
import {
  decodeProfileList,
  decodePublicProfile,
} from '../src/profile/discovery-contract';
import {
  createdAt,
  otherId,
  post,
  postId,
  requestId,
} from './community-helpers';
import {
  discoverySetup,
  likedItem,
  likedList,
  namedPost,
  profileId,
  profileList,
  publicProfile,
} from './discovery-helpers';
import {
  deferred,
  FakeClock,
  flush,
  MemoryStorage,
  response,
  ScriptedTransport,
} from './helpers';
import { wireCredentials } from './identity-helpers';
import { ownProfile } from './profile-helpers';
import { avatarIds, FakeAvatarGateway } from './support/avatar-fixtures';

const source = (name: string) =>
  readFileSync(path.join(__dirname, '../src/pages/me', name), 'utf8');
const savedList = (): SavedList => ({
  items: [{ post: post(), saveEpochId: requestId, savedAt: createdAt }],
  nextCursor: null,
  visibleSavedCount: 1,
});
const setup = () => {
  const s = discoverySetup();
  s.behavior.profile = async () => publicProfile({ isOwn: true });
  const controller = new MeContentController(s.runtime, () => undefined);
  return { ...s, controller, view: () => controller.snapshot() };
};

test('Me is a profile and content surface with secondary settings, real icons and no invented social numbers', () => {
  const script = source('me.ts');
  const template = source('me.wxml');
  const styles = source('me.wxss');
  assert.match(template, /profile-bio/);
  assert.match(template, /content-tabs/);
  assert.match(template, /content-grid/);
  assert.match(template, /wx:if="{{showMenu}}" class="profile-menu"/);
  assert.match(template, /name="menu"/);
  assert.match(template, /src="{{avatarRead\.localSrc}}"/);
  assert.match(template, /name="lock"/);
  assert.match(script, /我的全部发布/);
  assert.match(template, /class="content-modes"/);
  assert.match(template, /\/pages\/compose-entry\/compose-entry/);
  assert.doesNotMatch(
    template,
    /\/pages\/community-compose\/community-compose/,
  );
  assert.match(script, /avatarBasicsTicket\(\)/);
  assert.match(script, /avatarReader\.load\(null\)/);
  assert.doesNotMatch(
    script + template,
    /followerCount|followingCount|wx\.previewImage|https:\/\//,
  );
  assert.doesNotMatch(
    template,
    /MADE FOR YOU|我的足迹|设置与帮助|profile\.avatar/,
  );
  assert.doesNotMatch(styles, /content:\s*['"][^'"]+['"]/);
  for (const destination of [
    'profile',
    'community-mine',
    'errand-mine',
    'verification',
    'identity-campus',
    'account-status',
    'community-blocks',
    'feedback',
    'experience',
    'login',
  ])
    assert.ok(
      (script + template).includes(`/pages/${destination}/${destination}`),
    );
});

test('Me social-stat row uses only verified values, has honest unavailable fallbacks, and is not a dead navigation control', () => {
  const template = source('me.wxml');
  const summary = template.slice(
    template.indexOf('class="profile-social-summary"'),
    template.indexOf('class="profile-bio"'),
  );
  assert.match(
    template,
    /wx:if="{{profile\.hasSession}}" class="profile-social-summary"/,
  );
  for (const label of ['关注', '粉丝', '获赞与收藏']) {
    assert.ok(summary.includes(`${label}数量暂不可用`));
    assert.ok(summary.includes(`class="profile-stat-label">${label}</view>`));
  }
  for (const field of ['following', 'followers'])
    assert.ok(
      summary.includes(
        `stats.${field}.status === 'known' ? stats.${field}.value : '—'`,
      ),
    );
  assert.match(
    summary,
    /aria-label="获赞与收藏数量暂不可用"><view class="profile-stat-value">—<\/view>/,
  );
  assert.doesNotMatch(summary, /仅统计当前可见关系|— 表示暂不可用/);
  assert.doesNotMatch(summary, /<navigator|url=|profile-stat-value">\d/);
  assert.match(summary, /bindtap="onStatsReload"/);
  const row = summary.slice(0, summary.indexOf('class="profile-stat-error"'));
  assert.doesNotMatch(row, /<button|bindtap/);
});

test('Me default posts use only own public profile discovery and never owner anonymous history', async () => {
  const s = setup();
  s.behavior.list = async () =>
    profileList({ items: [namedPost(), post({ id: requestId })], total: 2 });
  await s.controller.load();
  assert.equal(s.view().tab, 'posts');
  assert.equal(s.view().loaded, true);
  assert.equal(s.view().items.length, 1);
  assert.equal(s.view().items[0]!.id, postId);
  assert.equal(
    s.view().items[0]!.url,
    `/pages/community-detail/community-detail?postId=${postId}`,
  );
  assert.deepEqual(
    s.calls.map((call) => call.method),
    ['ownProfileRef', 'profile', 'list'],
  );
  assert.equal(s.calls[1]!.args[0], profileId);
  assert.equal(s.calls[2]!.args[1], 'posts');
  assert.equal(s.gateway.calls.length, 0);
  await s.controller.setTab('unknown');
  assert.equal(s.view().tab, 'posts');
  s.controller.dispose();
});

test('Me preserves genuine unavailable and hidden discovery outcomes instead of claiming an empty profile', async () => {
  const template = source('me.wxml');
  assert.match(
    template,
    /content\.availability === 'unavailable' \|\| content\.availability === 'hidden'/,
  );
  assert.match(
    template,
    /content\.loaded &amp;&amp; content\.availability === 'available' &amp;&amp; !content\.items\.length &amp;&amp; content\.continuation === 'end'/,
  );
  assert.match(template, /content\.total !== 0 \? '本页暂无可查看内容'/);
  assert.ok(
    template.indexOf("content.availability === 'unavailable'") <
      template.indexOf('分享你的第一个校园瞬间'),
  );
  for (const responseKind of [
    'profile-unavailable',
    'list-unavailable',
    'list-hidden',
    'no-profile',
    'verified-empty',
  ] as const) {
    const s = setup();
    if (responseKind === 'profile-unavailable')
      s.behavior.profile = async () =>
        decodePublicProfile({ status: 'unavailable', profileId });
    else if (responseKind === 'list-unavailable')
      s.behavior.list = async () =>
        decodeProfileList({ status: 'unavailable', profileId });
    else if (responseKind === 'list-hidden')
      s.behavior.list = async () =>
        decodeProfileList({
          status: 'hidden',
          profileId,
          items: [],
          total: 0,
          totalStatus: 'known',
          nextCursor: null,
          continuation: 'end',
        });
    else if (responseKind === 'no-profile')
      s.behavior.ownProfileRef = async () => ({ profileId: null });
    else
      s.behavior.list = async () =>
        decodeProfileList(profileList({ items: [], total: 0 }));
    await s.controller.load();
    const view = s.view();
    assert.equal(view.loaded, true, responseKind);
    assert.deepEqual(view.items, [], responseKind);
    assert.equal(
      view.availability,
      responseKind === 'verified-empty'
        ? 'available'
        : responseKind === 'list-hidden'
          ? 'hidden'
          : responseKind === 'no-profile'
            ? 'no_profile'
            : 'unavailable',
      responseKind,
    );
    assert.equal(
      view.availability === 'available' &&
        view.continuation === 'end' &&
        view.total === 0,
      responseKind === 'verified-empty',
      responseKind,
    );
    if (responseKind !== 'verified-empty') {
      assert.equal(view.total, null);
      assert.equal(view.continuation, null);
      s.behavior.ownProfileRef = async () => ({ profileId });
      s.behavior.profile = async () => publicProfile({ isOwn: true });
      s.behavior.list = async () => profileList();
      await s.controller.load();
      assert.equal(s.view().availability, 'available');
      assert.equal(s.view().items.length, 1);
    }
    s.controller.dispose();
  }
});

test('private tabs load real saves and liked reply destinations, revoke previous windows and retain unknown totals', async () => {
  const s = setup();
  s.gateway.savedImpl = async () => savedList();
  await s.controller.setTab('saved');
  assert.equal(s.view().tab, 'saved');
  assert.equal(s.view().total, 1);
  assert.equal(s.view().items[0]!.author, post().author.displayName);
  const pending = deferred<SavedList>();
  s.gateway.savedImpl = async () => pending.promise;
  const refreshing = s.controller.load();
  await flush();
  s.behavior.liked = async () =>
    likedList({
      items: [
        likedItem({
          kind: 'reply',
          rootCommentId: otherId,
          targetId: requestId,
        }),
      ],
      visibleLikedCount: null,
      visibleLikedCountStatus: 'unavailable',
    });
  await s.controller.setTab('liked');
  assert.equal(s.view().tab, 'liked');
  assert.equal(s.view().total, null);
  assert.equal(s.view().totalStatus, 'unavailable');
  assert.equal(s.view().items[0]!.kind, 'reply');
  assert.equal(
    s.view().items[0]!.url,
    `/pages/community-thread/community-thread?postId=${postId}&rootCommentId=${otherId}&replyId=${requestId}`,
  );
  pending.resolve(savedList());
  await refreshing;
  assert.equal(s.view().tab, 'liked');
  assert.equal(s.view().items[0]!.kind, 'reply');
  await s.controller.setTab('posts');
  assert.equal(s.view().items[0]!.kind, 'post');
  assert.equal(s.view().items[0]!.text, namedPost().text);
  s.controller.dispose();
});

test('Me content preserves authoritative scan continuation and revalidated previous-page navigation', async () => {
  const s = setup();
  s.behavior.liked = async (after) =>
    after
      ? likedList()
      : likedList({
          items: [],
          visibleLikedCount: null,
          visibleLikedCountStatus: 'unavailable',
          nextCursor: 'next',
          continuation: 'scan_pending',
        });
  await s.controller.setTab('liked');
  assert.equal(s.view().continuation, 'scan_pending');
  assert.equal(s.view().items.length, 0);
  assert.equal(s.view().canLoadMore, true);
  await s.controller.more();
  assert.equal(s.view().items.length, 1);
  assert.equal(s.view().canPrevious, true);
  assert.equal(s.view().pageNumber, 2);
  await s.controller.previous();
  assert.equal(s.view().items.length, 0);
  assert.equal(s.view().continuation, 'scan_pending');
  assert.equal(s.view().pageNumber, 1);
  assert.deepEqual(
    s.calls
      .filter((call) => call.method === 'liked')
      .map((call) => call.args[0]),
    [null, 'next', null],
  );
  s.controller.dispose();
});

test('Me private content clears on account, same-account login, app hide and disposal without late resurrection', async () => {
  for (const boundary of [
    'account',
    'same-login',
    'app-hide',
    'dispose',
  ] as const) {
    const s = setup();
    s.gateway.savedImpl = async () => savedList();
    await s.controller.setTab('saved');
    assert.equal(s.view().items.length, 1);
    const pending = deferred<SavedList>();
    s.gateway.savedImpl = async () => pending.promise;
    const refreshing = s.controller.load();
    await flush();
    if (boundary === 'dispose') s.controller.dispose();
    else if (boundary === 'app-hide') s.runtime.privateViews!.clear();
    else
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('next'),
        ...(boundary === 'account' ? { accountId: otherId } : {}),
      });
    assert.equal(s.view().items.length, 0);
    assert.equal(s.view().total, null);
    pending.resolve(savedList());
    await refreshing;
    assert.equal(s.view().items.length, 0);
    assert.equal(s.view().loaded, false);
    s.controller.dispose();
  }
});

test('Me own avatar and cover require current basics and clears safely on refresh failure, logout and hide', async () => {
  type MePage = {
    data: {
      profile: ProfileView;
      content: MeContentView;
      avatarRead: AvatarReadView;
      coverRead: CoverReadView;
      showMenu: boolean;
    };
    avatarReader: unknown;
    coverReader: unknown;
    onShow(): void;
    onHide(): void;
    onReload(): void;
    onOpenMenu(): void;
    setData(patch: Record<string, unknown>): void;
  };
  const native = globalThis as typeof globalThis & { wx: WxApi };
  const previous = {
    Page: globalThis.Page,
    getApp: globalThis.getApp,
    wx: native.wx,
  };
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const transport = new ScriptedTransport();
  const api = new ApiClient('https://api.example.test', transport, sessions, {
    refresh: async () => sessions.snapshot(),
  });
  const avatar = new FakeAvatarGateway();
  const profileAvatar = createProfileAvatarRuntime({
    sessions,
    storage: new MemoryStorage(),
    origin: 'https://api.example.test',
    clock: new FakeClock(),
    newRequestId: async () => avatarIds.request,
    gateway: avatar,
    download: {
      async download(_current, _variant, _owner, principal) {
        principal.current();
        return { localId: 'me-avatar' };
      },
      async resolve() {
        return 'wxfile://tmp/me-avatar.png';
      },
      async release() {},
    },
  });
  const cover = new FakeCoverGateway();
  const profileCover = createProfileCoverRuntime({
    sessions,
    storage: new MemoryStorage(),
    origin: 'https://api.example.test',
    clock: new FakeClock(),
    newRequestId: async () => coverIds.request,
    gateway: cover,
    download: {
      async download(_current, _variant, _owner, principal) {
        principal.current();
        return { localId: 'me-cover' };
      },
      async resolve() {
        return 'wxfile://tmp/me-cover.png';
      },
      async release() {},
    },
  });
  let definition: MePage | undefined;
  globalThis.Page = ((value: object) => {
    definition = value as MePage;
  }) as typeof Page;
  globalThis.getApp = (() =>
    ({
      identity: { sessions, api },
      profileAvatar,
      profileCover,
    }) as unknown as WhaleuApp) as typeof getApp;
  native.wx = {} as WxApi;
  let page: MePage | undefined;
  try {
    await import('../src/pages/me/me.js');
    assert.ok(definition);
    page = {
      ...definition,
      data: { ...definition.data },
      setData(patch) {
        this.data = { ...this.data, ...patch };
      },
    };
    const first = deferred<ReturnType<typeof response>>();
    transport.steps.push(async () => first.promise);
    page.onShow();
    await flush();
    assert.equal(avatar.currentReads.length, 0);
    assert.equal(cover.currentReads.length, 0);
    first.resolve(response(ownProfile({ nickname: '本人', bio: '真实简介' })));
    await flush();
    await flush();
    assert.equal(page.data.profile.bio, '真实简介');
    assert.equal(page.data.avatarRead.localSrc, 'wxfile://tmp/me-avatar.png');
    assert.equal(page.data.coverRead.localSrc, 'wxfile://tmp/me-cover.png');
    const coverCount = cover.currentReads.length;
    const count = avatar.currentReads.length;
    transport.steps.push(async () => {
      throw new Error('Offline');
    });
    page.onReload();
    assert.equal(page.data.avatarRead.localSrc, '');
    assert.equal(page.data.coverRead.localSrc, '');
    await flush();
    assert.equal(avatar.currentReads.length, count);
    assert.equal(cover.currentReads.length, coverCount);
    assert.equal(page.avatarReader, undefined);
    assert.equal(page.coverReader, undefined);
    transport.reply(ownProfile());
    page.onReload();
    await flush();
    await flush();
    page.onOpenMenu();
    sessions.logout();
    assert.equal(page.data.avatarRead.localSrc, '');
    assert.equal(page.data.coverRead.localSrc, '');
    assert.equal(page.data.showMenu, false);
    page.onHide();
    assert.equal(page.data.profile.nickname, '');
    assert.equal(page.avatarReader, undefined);
    assert.equal(page.coverReader, undefined);
  } finally {
    page?.onHide();
    globalThis.Page = previous.Page;
    globalThis.getApp = previous.getApp;
    native.wx = previous.wx;
  }
});
