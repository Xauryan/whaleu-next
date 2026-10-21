import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parse, render } from './smoke-ratings.mjs';

const require = createRequire(import.meta.url);

/** Compiled owner-only native handlers against real gateway/transport validation. */
export async function smokeSystemNotices({ app, dist, mountPage, flush }) {
  const { ApiClient } = require(path.join(dist, 'api/client.js'));
  const { ClientError } = require(path.join(dist, 'api/errors.js'));
  const { HttpSystemNoticesGateway } = require(
    path.join(dist, 'community/system-notices-gateway.js'),
  );
  const { SystemNoticesBadgeController } = require(
    path.join(dist, 'pages/system-notices/controller.js'),
  );
  const original = {
    gateway: app.community.gateway,
    notices: app.community.systemNotices,
    privacy: app.community.identityPrivacy,
    errands: app.community.errandNotices,
    feedback: app.community.feedbackNotices,
    api: app.identity.api,
    navigateTo: globalThis.wx.navigateTo,
    credentials: app.identity.sessions.snapshot().credentials,
  };
  assert.ok(
    original.credentials,
    'System notice smoke needs the synthetic login',
  );
  // Isolate this source's real transport assertions from other timeline owners.
  app.community.errandNotices = undefined;
  app.community.feedbackNotices = undefined;
  app.identity.api = undefined;
  const navigation = [];
  globalThis.wx.navigateTo = (options) => {
    navigation.push(options.url);
    options.success?.();
  };
  const accountId = original.credentials.accountId;
  const noticeId = 'abababab-abab-4bab-8bab-abababababab';
  const secondNoticeId = 'acacacac-acac-4cac-8cac-acacacacacac';
  const replacementAccount = 'aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeae';
  const createdAt = '2026-10-07T05:00:00.000Z';
  const readAt = '2026-10-07T05:01:00.000Z';
  const records = new Map();
  const requests = [];
  let loseReadResponse = true;
  let waitForList = false;
  let finishList;
  let listCancellation;
  let waitForRead = false;
  let finishRead;
  let readCancellation;
  let sourceRequests = 0;
  let leakSource = false;
  const notice = (id) => ({
    noticeId: id,
    kind: 'post_jury_removed',
    createdAt,
    readAt: records.get(id) ?? null,
    keepVotes: 5,
    removeVotes: 6,
  });
  const activeOwner = () =>
    app.identity.sessions.snapshot().credentials?.accountId === accountId;
  const unreadCount = () => (activeOwner() ? 9 - records.size : 4);
  const response = (body) => ({ status: 200, headers: {}, body });
  app.community.gateway = new Proxy(
    {},
    {
      get() {
        sourceRequests++;
        throw new Error(
          'System notices cannot query community content or capabilities',
        );
      },
    },
  );
  app.community.identityPrivacy = new Proxy(
    {},
    {
      get() {
        sourceRequests++;
        throw new Error('System notices cannot request identity overlays');
      },
    },
  );
  app.community.systemNotices = new HttpSystemNoticesGateway(
    new ApiClient(
      'https://api.example',
      {
        async send(request) {
          requests.push(request);
          assert.ok(request.headers.Authorization);
          const url = new URL(request.url);
          assert.equal(url.origin, 'https://api.example');
          if (
            request.method === 'GET' &&
            url.pathname === '/v1/me/system-notices/unread-count'
          ) {
            assert.equal(url.search, '');
            return response({ unreadCount: unreadCount() });
          }
          if (
            request.method === 'GET' &&
            url.pathname === '/v1/me/system-notices'
          ) {
            const after = url.searchParams.get('cursor');
            assert.equal(url.searchParams.get('limit'), '20');
            assert.deepEqual(
              [...url.searchParams.keys()].sort(),
              after ? ['cursor', 'limit'] : ['limit'],
            );
            let page = {
              items: [notice(after ? secondNoticeId : noticeId)],
              nextCursor: after ? null : 'synthetic_cursor',
              unreadCount: unreadCount(),
            };
            if (leakSource)
              page = {
                ...page,
                items: [{ ...page.items[0], postId: secondNoticeId }],
              };
            if (waitForList) {
              listCancellation = request.cancellation;
              return new Promise((resolve) => {
                finishList = () => resolve(response(page));
              });
            }
            return response(page);
          }
          assert.equal(request.method, 'PUT');
          assert.equal(url.search, '');
          assert.deepEqual(request.body, {});
          const id = url.pathname.match(
            /^\/v1\/me\/system-notices\/([a-f0-9-]+)\/read$/,
          )?.[1];
          assert.ok([noticeId, secondNoticeId].includes(id));
          assert.equal(activeOwner(), true);
          if (waitForRead) {
            readCancellation = request.cancellation;
            return new Promise((resolve) => {
              finishRead = () => {
                records.set(id, records.get(id) ?? readAt);
                resolve(
                  response({
                    noticeId: id,
                    readAt: records.get(id),
                    unreadCount: 9 - records.size,
                  }),
                );
              };
            });
          }
          records.set(id, records.get(id) ?? readAt);
          if (loseReadResponse) {
            loseReadResponse = false;
            throw new ClientError(
              'timeout',
              'Synthetic read committed; response lost',
            );
          }
          return response({
            noticeId: id,
            readAt: records.get(id),
            unreadCount: unreadCount(),
          });
        },
      },
      app.identity.sessions,
      {
        refresh: async () => {
          throw new Error('No provider in synthetic smoke');
        },
      },
    ),
  );
  const module = path.join(dist, 'pages/system-notices/system-notices.js');
  let current;
  let badge;
  let badgeView;
  const systemState = () =>
    current.data.sources.find((source) => source.source === 'system');
  const assertCount = (expected) => {
    assert.equal(
      current.data.unreadCount,
      null,
      'Partial sources never manufacture an aggregate total',
    );
    assert.equal(
      systemState()?.unreadCount,
      expected,
      'The system owner retains its exact server count',
    );
  };
  const assertCleared = () => {
    assert.deepEqual(current.data.items, []);
    assert.equal(current.data.unreadCount, null);
    assert.equal(current.data.hasUnread, false);
    assert.ok(systemState() === undefined || systemState().unreadCount === 0);
  };
  try {
    current = mountPage(module, {});
    await flush();
    assert.equal(current.data.loaded, true);
    assert.equal(current.data.items.length, 1);
    assertCount(9);
    assert.equal(
      requests.filter((request) => request.method === 'PUT').length,
      0,
    );
    assert.equal(typeof current.onOpen, 'function');
    const beforeOpen = requests.length;
    current.onOpen({
      currentTarget: { dataset: { id: `system:${noticeId}` } },
    });
    current.onOpen({ currentTarget: { dataset: { id: noticeId } } });
    current.onRead({ currentTarget: { dataset: { id: noticeId } } });
    await flush();
    assert.equal(
      requests.length,
      beforeOpen,
      'System moderation rows and raw IDs cannot resolve an arbitrary source',
    );
    assert.deepEqual(navigation, []);
    assert.equal(
      current.identityOverlay,
      undefined,
      'No identity overlay exists',
    );
    for (const row of current.data.items) {
      assert.match(
        row.observationId,
        new RegExp(`^notice-[0-9]+-system-${row.noticeId}$`),
        'Only the exact row-scoped local observation selector is added',
      );
      for (const key of [
        'timeLabel',
        'startTimeLabel',
        'endTimeLabel',
        'releaseTimeLabel',
        'punishmentStartTimeLabel',
        'punishmentEndTimeLabel',
      ])
        assert.equal(typeof row[key], 'string');
      assert.deepEqual(
        Object.keys(row)
          .filter(
            (key) =>
              ![
                'timeLabel',
                'startTimeLabel',
                'endTimeLabel',
                'releaseTimeLabel',
                'punishmentStartTimeLabel',
                'punishmentEndTimeLabel',
              ].includes(key),
          )
          .sort(),
        [
          'createdAt',
          'keepVotes',
          'key',
          'kind',
          'noticeId',
          'observationId',
          'readAt',
          'removeVotes',
          'source',
          'summary',
        ],
      );
    }
    const loadedData = structuredClone(current.data);
    current.onMore();
    await flush();
    assert.equal(current.data.items.length, 2);
    assert.equal(current.data.canLoadMore, false);
    current.onRead({
      currentTarget: { dataset: { id: `system:${noticeId}` } },
    });
    current.onRead({
      currentTarget: { dataset: { id: `system:${noticeId}` } },
    });
    await flush();
    assert.equal(
      requests.filter((request) => request.method === 'PUT').length,
      1,
    );
    assert.equal(
      records.get(noticeId),
      readAt,
      'Server committed despite lost response',
    );
    assert.equal(
      current.data.items[0].readAt,
      null,
      'No invented local read success',
    );
    assertCount(9);
    assert.match(systemState().status, /尚未确认/);
    assert.ok(
      current.data.error,
      'A lost read response remains visible after a duplicate tap',
    );
    current.onRead({
      currentTarget: { dataset: { id: `system:${noticeId}` } },
    });
    await flush();
    assert.equal(current.data.items[0].readAt, readAt);
    assert.equal(current.data.items[1].readAt, null);
    assertCount(8);
    assert.equal(records.size, 1, 'Retry does not decrement twice');
    const writes = requests.filter((request) => request.method === 'PUT');
    assert.equal(writes[0].url, writes[1].url);
    current.onRead({
      currentTarget: { dataset: { id: `system:${noticeId}` } },
    });
    await flush();
    assert.equal(
      requests.filter((request) => request.method === 'PUT').length,
      2,
    );

    badge = new SystemNoticesBadgeController(app.community, (view) => {
      badgeView = view;
    });
    await badge.load();
    assert.equal(badgeView.unreadCount, 8);
    waitForRead = true;
    current.onRead({
      currentTarget: { dataset: { id: `system:${secondNoticeId}` } },
    });
    await flush();
    app.onHide();
    assert.equal(readCancellation.isCancelled, true);
    assert.deepEqual(current.data.items, []);
    assertCleared();
    assert.equal(badgeView.loaded, false);
    assert.equal(badgeView.unreadCount, 0);
    finishRead();
    await flush();
    assert.deepEqual(current.data.items, []);
    assertCleared();
    waitForRead = false;
    current.onShow();
    await flush();
    current.onMore();
    await flush();
    assert.equal(current.data.items[1].readAt, readAt);
    assertCount(7);

    waitForList = true;
    current.onReload();
    assert.deepEqual(current.data.items, []);
    assertCleared();
    await flush();
    current.onCancel();
    assert.equal(listCancellation.isCancelled, true);
    finishList();
    await flush();
    assert.deepEqual(current.data.items, []);
    assert.equal(current.data.loaded, false);

    current.onReload();
    await flush();
    const oldFinish = finishList;
    const oldCancel = listCancellation;
    app.identity.sessions.completeLogin(app.identity.sessions.beginLogin(), {
      ...original.credentials,
      accountId: replacementAccount,
      accessToken: `wu_a_${'x'.repeat(43)}`,
      refreshToken: `wu_r_${'x'.repeat(43)}`,
    });
    assert.equal(oldCancel.isCancelled, true);
    assert.deepEqual(current.data.items, []);
    waitForList = false;
    current.onReload();
    await flush();
    assertCount(4);
    oldFinish();
    await flush();
    assert.equal(
      systemState().unreadCount,
      4,
      'Old owner callback cannot replace current count',
    );
    current.onHide();
    assert.equal(current.controller, undefined);
    assert.deepEqual(current.data.items, []);
    assertCleared();
    current.onShow();
    await flush();
    assert.equal(current.data.loaded, true);
    leakSource = true;
    current.onReload();
    await flush();
    assert.equal(current.data.loaded, false);
    assert.deepEqual(current.data.items, []);
    assertCleared();
    assert.match(systemState().error, /格式异常/);
    current.onSources();
    assert.equal(current.data.showSources, true);
    assert.equal(sourceRequests, 0);
    const template = readFileSync(
      path.join(dist, 'pages/system-notices/system-notices.wxml'),
      'utf8',
    );
    assert.match(template, /标为已读/);
    assert.match(template, /item.kind === 'post_jury_removed'/);
    assert.match(template, /帖子已被陪审团移除/);
    assert.match(template, /仅加载列表或打开详情不会确认已读/);
    assert.match(template, /消息在屏幕内持续显示后会确认已读，也可手动标记/);
    assert.match(template, /id="{{item\.observationId}}"/);
    assert.equal(
      /postId|preview|target|authorId|jurorId|reporterId|identityOverlay|requestSubscribeMessage/.test(
        template,
      ),
      false,
    );
    const visibleSystem = JSON.stringify(
      render(parse(template).children, loadedData, {}),
    );
    assert.equal(
      visibleSystem.includes('onOpen'),
      false,
      'The rendered moderation notice exposes no content-navigation control',
    );
    assert.ok(
      visibleSystem.includes(`system:${noticeId}`),
      'Rendered receipts carry their source namespace',
    );
    assert.equal(visibleSystem.includes('postId'), false);
    for (const match of template.matchAll(
      /(?:bind|catch):?(?:tap|press)="([^"]+)"/g,
    ))
      assert.equal(typeof current[match[1]], 'function');
  } finally {
    current?.onUnload();
    badge?.dispose();
    app.community.gateway = original.gateway;
    app.community.systemNotices = original.notices;
    app.community.identityPrivacy = original.privacy;
    app.community.errandNotices = original.errands;
    app.community.feedbackNotices = original.feedback;
    app.identity.api = original.api;
    globalThis.wx.navigateTo = original.navigateTo;
    app.identity.sessions.completeLogin(
      app.identity.sessions.beginLogin(),
      original.credentials,
    );
  }
}
