import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { WhaleuApp } from '../src/app';
import type { ListPage } from '../src/messaging/contract';
import {
  initialListView,
  type ListView,
} from '../src/messaging/list-controller';
import { initialNoticeSenders } from '../src/notifications/senders';
import {
  conversationRows,
  filterConversationRows,
  conversationTime,
  type InboxRow,
} from '../src/pages/inbox/presentation';
import type { WxApi } from '../src/platform/wechat';
import { deferred, flush } from './helpers';
import {
  conversation,
  conversationId,
  harness,
  message,
} from './messaging-helpers';
import {
  systemNotice,
  systemNotices,
  systemNoticesSetup,
} from './system-notices-helpers';

const nativeGlobal = globalThis as typeof globalThis & { wx: WxApi };
interface InboxPage {
  data: {
    list: ListView;
    rows: InboxRow[];
    hasSession: boolean;
    navigationError: string;
    noticesBusy: boolean;
    searchOpen: boolean;
    searchQuery: string;
    filteredRows: InboxRow[];
    chatHelpOpen: boolean;
  };
  setData(patch: Record<string, unknown>): void;
  onShow(): Promise<void>;
  onSocial(event: { currentTarget: { dataset: { kind?: string } } }): void;
  onSearch(): void;
  onSearchInput(event: { detail: { value: string } }): void;
  onChatHelp(): void;
  onDismissChatHelp(): void;
  onHide(): void;
  onUnload(): void;
  onReload(): void;
  onMore(): void;
  onCancel(): void;
  onPullDownRefresh(): Promise<void>;
  onConversation(event: { currentTarget: { dataset: { key: string } } }): void;
}
let definition: InboxPage | undefined;
async function createPage(): Promise<InboxPage> {
  if (!definition) {
    const oldPage = globalThis.Page;
    globalThis.Page = ((value: object) => {
      definition = value as InboxPage;
    }) as typeof Page;
    try {
      await import('../src/pages/inbox/inbox.js');
    } finally {
      globalThis.Page = oldPage;
    }
  }
  assert.ok(definition);
  const page: InboxPage = {
    ...definition,
    data: { ...definition.data },
    setData(patch) {
      this.data = { ...this.data, ...patch };
    },
  };
  return page;
}

function fixture() {
  const dm = harness();
  const system = systemNoticesSetup();
  const privateViews = system.runtime.privateViews;
  assert.ok(privateViews);
  const runtime = {
    ...system.runtime,
    sessions: dm.sessions,
    messaging: { ...dm.runtime, privateViews },
  };
  const app: WhaleuApp = {
    identity: undefined,
    community: runtime,
    verification: undefined,
    identityCampus: undefined,
    experience: undefined,
    globalData: {
      implementationStage: 'synthetic-inbox-test',
      featureParityVerified: false,
    },
  };
  return { dm, system, runtime, privateViews, app };
}

test('conversation projection puts real DMs and notification senders in one timestamp-ordered list', () => {
  const rows = conversationRows(
    {
      ...initialListView(),
      loaded: true,
      items: [
        {
          id: conversationId,
          conversation: conversation({ unreadCount: 2 }),
          latest: message({ text: '真实读取的\n合成测试消息' }),
          updatedAt: '2026-10-20T09:00:00.000Z',
        },
      ],
    },
    [
      {
        kind: 'system',
        name: '系统消息',
        url: '/pages/system-notices/system-notices',
        loaded: true,
        busy: false,
        error: '',
        latest: {
          summary: '内容处理结果已更新',
          createdAt: '2026-10-19T09:00:00.000Z',
        },
        unreadCount: 3,
        hasUnread: true,
        partial: false,
      },
    ],
    Date.parse('2026-10-20T10:00:00.000Z'),
  );
  assert.equal(rows[0]?.key, `dm:${conversationId}`);
  assert.equal(rows[0]?.name, '对方');
  assert.equal(rows[0]?.initial, '对');
  assert.equal(rows[0]?.summary, '真实读取的 合成测试消息');
  assert.equal(rows[0]?.unreadLabel, '2');
  assert.equal(rows[1]?.name, '系统消息');
  assert.equal(rows[1]?.unreadLabel, '3');
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((row) => row.url)).size, rows.length);
  assert.deepEqual(
    rows.filter((row) => row.kind === 'sender').map((row) => row.key),
    ['sender:system'],
  );
  assert.equal(conversationTime('', Date.now()), '');
  assert.equal(conversationTime('invalid', Date.now()), '');
});

test('inbox never exposes business channels or placeholder summaries', () => {
  const rows = conversationRows(
    initialListView(),
    initialNoticeSenders(),
    Date.now(),
  );
  assert.deepEqual(rows, []);
  const source = readFileSync(
    path.join(__dirname, '../src/pages/inbox/presentation.ts'),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /打开查看消息|互动消息|跑腿通知|评分消息|食堂讨论|专业讨论|认证通知|serviceRows/,
  );
});

test('conversation markup has exactly three top social shortcuts above one uniform row loop, with no fake badges', () => {
  const template = readFileSync(
    path.join(__dirname, '../src/pages/inbox/inbox.wxml'),
    'utf8',
  );
  assert.equal((template.match(/wx:for=/g) ?? []).length, 1);
  assert.match(template, /wx:for="{{searchOpen \? filteredRows : rows}}"/);
  assert.equal((template.match(/bindtap="onSocial"/g) ?? []).length, 3);
  for (const label of ['赞和收藏', '新增关注', '回复和@'])
    assert.match(template, new RegExp(label));
  assert.ok(
    template.indexOf('social-shortcuts') <
      template.indexOf('conversation-list'),
  );
  assert.match(template, /wu-safe-top/);
  assert.match(template, /bindtap="onSearch"/);
  assert.match(template, /bindtap="onChatHelp"/);
  assert.match(template, /wx:if="{{item\.timeLabel}}"/);
  assert.match(template, /wx:if="{{item\.unreadLabel}}"/);
  assert.doesNotMatch(
    template,
    /channel-card|main-channels|hero|section-title|grid|我的私信/,
  );
  const source = readFileSync(
    path.join(__dirname, '../src/pages/inbox/inbox.ts'),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /acknowledge\(|confirmHide\(|dispatch\(|setStorage/,
  );
  assert.match(source, /new MessagingListController/);
  assert.match(source, /new NoticeSendersController/);
});

test('actual inbox reads real people and system summary, opens only current row destinations, and never acknowledges on show', async () => {
  const previous = { wx: nativeGlobal.wx, getApp: globalThis.getApp };
  const f = fixture();
  globalThis.getApp = (() => f.app) as typeof getApp;
  const navigations: Parameters<NonNullable<WxApi['navigateTo']>>[0][] = [];
  nativeGlobal.wx = {
    navigateTo(options) {
      navigations.push(options);
    },
  } as WxApi;
  const page = await createPage();
  try {
    await page.onShow();
    assert.equal(
      page.data.rows.filter((row) => row.kind === 'person').length,
      1,
    );
    assert.equal(
      page.data.rows.find((row) => row.key === 'sender:system')?.summary,
      '帖子陪审结果已更新',
    );
    assert.equal(
      page.data.rows.find((row) => row.key === 'sender:system')?.hasUnread,
      true,
    );
    assert.equal(
      page.data.rows.find((row) => row.key === 'sender:activity'),
      undefined,
    );
    assert.ok(f.system.notices.calls.every((call) => call.method === 'list'));
    assert.equal(f.dm.applied.length, 0);
    page.onConversation({
      currentTarget: { dataset: { key: 'dm:not-a-current-row' } },
    });
    assert.equal(navigations.length, 0);
    const tap = { currentTarget: { dataset: { key: `dm:${conversationId}` } } };
    page.onConversation(tap);
    page.onConversation(tap);
    assert.equal(navigations.length, 1);
    assert.equal(
      navigations[0]?.url,
      `/pages/private-message-detail/private-message-detail?conversationId=${conversationId}`,
    );
    navigations[0]!.success();
    page.onConversation({
      currentTarget: { dataset: { key: 'sender:system' } },
    });
    assert.equal(navigations[1]?.url, '/pages/system-notices/system-notices');
    page.onHide();
    navigations[1]!.fail(new Error('late native failure'));
    assert.equal(page.data.navigationError, '');
    assert.equal(
      page.data.rows.some((row) => row.kind === 'person'),
      false,
    );
    assert.equal(
      page.data.rows.find((row) => row.key === 'sender:system'),
      undefined,
    );
    assert.equal(f.dm.clock.timers, 0);
  } finally {
    page.onUnload();
    nativeGlobal.wx = previous.wx;
    globalThis.getApp = previous.getApp;
  }
});

test('late DM/system results cannot repopulate hidden or switched accounts; root app hide clears every sender', async () => {
  const previous = { wx: nativeGlobal.wx, getApp: globalThis.getApp };
  const f = fixture();
  globalThis.getApp = (() => f.app) as typeof getApp;
  nativeGlobal.wx = {} as WxApi;
  const page = await createPage();
  try {
    const lateDm = deferred<ListPage>();
    const lateSystem = deferred<ReturnType<typeof systemNotices>>();
    f.dm.gateway.list = () => lateDm.promise;
    f.system.notices.listImpl = () => lateSystem.promise;
    const pending = page.onShow();
    await flush();
    f.dm.sessions.logout();
    lateDm.resolve({
      items: [
        {
          conversation: conversation(),
          latest: message(),
          updatedAt: message().createdAt,
        },
      ],
      nextCursor: null,
      coverage: 'local',
    });
    lateSystem.resolve(systemNotices([systemNotice()], null, 88));
    await pending;
    assert.equal(page.data.hasSession, false);
    assert.equal(
      page.data.rows.some((row) => row.kind === 'person'),
      false,
    );
    assert.equal(
      page.data.rows.find((row) => row.key === 'sender:system'),
      undefined,
    );
    assert.equal(f.dm.clock.timers, 0);
    f.privateViews.clear();
    assert.equal(page.data.list.items.length, 0);
  } finally {
    page.onUnload();
    nativeGlobal.wx = previous.wx;
    globalThis.getApp = previous.getApp;
  }
});

test('cancel and refresh rebuild notification reader, private paging remains cursor-controlled, and no source writes occur', async () => {
  const previous = { wx: nativeGlobal.wx, getApp: globalThis.getApp };
  const f = fixture();
  globalThis.getApp = (() => f.app) as typeof getApp;
  let stopped = 0;
  nativeGlobal.wx = {
    stopPullDownRefresh() {
      stopped++;
    },
  } as WxApi;
  const page = await createPage();
  const cursors: (string | null)[] = [];
  f.dm.gateway.list = async (cursor) => {
    cursors.push(cursor);
    return {
      items: cursor
        ? []
        : [
            {
              conversation: conversation(),
              latest: message(),
              updatedAt: message().createdAt,
            },
          ],
      nextCursor: cursor ? null : 'older-cursor',
      coverage: 'local',
    };
  };
  try {
    await page.onShow();
    page.onMore();
    await flush();
    assert.deepEqual(cursors, [null, 'older-cursor']);
    assert.equal(page.data.list.browsingOlder, true);
    page.onCancel();
    assert.equal(
      page.data.rows.find((row) => row.key === 'sender:system'),
      undefined,
    );
    const before = f.system.notices.calls.length;
    await page.onPullDownRefresh();
    assert.equal(stopped, 1);
    assert.equal(f.system.notices.calls.length, before + 1);
    assert.equal(page.data.list.browsingOlder, false);
    assert.equal(
      page.data.rows.find((row) => row.key === 'sender:system')?.hasUnread,
      true,
    );
    assert.equal(f.dm.applied.length, 0);
    assert.ok(f.system.notices.calls.every((call) => call.method === 'list'));
    f.privateViews.clear();
    assert.equal(
      page.data.rows.some((row) => row.kind === 'person'),
      false,
    );
    assert.equal(
      page.data.rows.find((row) => row.key === 'sender:system'),
      undefined,
    );
  } finally {
    page.onUnload();
    nativeGlobal.wx = previous.wx;
    globalThis.getApp = previous.getApp;
  }
});

test('social shortcut routes are allowlisted, local search is scoped and help/search state clears with private rows', async () => {
  const previous = { wx: nativeGlobal.wx, getApp: globalThis.getApp };
  const f = fixture();
  globalThis.getApp = (() => f.app) as typeof getApp;
  const routes: string[] = [];
  nativeGlobal.wx = {
    navigateTo(options) {
      routes.push(options.url);
      options.success();
    },
  } as WxApi;
  const page = await createPage();
  try {
    await page.onShow();
    page.onSocial({ currentTarget: { dataset: { kind: 'system' } } });
    assert.deepEqual(routes, []);
    for (const kind of ['likes', 'followers', 'comments'])
      page.onSocial({ currentTarget: { dataset: { kind } } });
    assert.deepEqual(
      routes,
      ['likes', 'followers', 'comments'].map(
        (kind) => `/pages/social-notices/social-notices?kind=${kind}`,
      ),
    );
    page.onSearch();
    page.onSearchInput({ detail: { value: '对方' } });
    assert.equal(page.data.filteredRows.length, 1);
    assert.equal(page.data.filteredRows[0]?.kind, 'person');
    page.onSearchInput({ detail: { value: '不存在的合成会话' } });
    assert.deepEqual(page.data.filteredRows, []);
    assert.deepEqual(
      filterConversationRows(page.data.rows, '系统消息').map((row) => row.key),
      ['sender:system'],
    );
    page.onChatHelp();
    assert.equal(page.data.chatHelpOpen, true);
    page.onDismissChatHelp();
    assert.equal(page.data.chatHelpOpen, false);
    page.onChatHelp();
    page.onHide();
    assert.equal(page.data.searchQuery, '');
    assert.equal(page.data.searchOpen, false);
    assert.deepEqual(page.data.filteredRows, []);
    assert.equal(page.data.chatHelpOpen, false);
    page.onSocial({ currentTarget: { dataset: { kind: 'likes' } } });
    assert.equal(routes.length, 3);
    assert.equal(f.dm.applied.length, 0);
  } finally {
    page.onUnload();
    nativeGlobal.wx = previous.wx;
    globalThis.getApp = previous.getApp;
  }
});
