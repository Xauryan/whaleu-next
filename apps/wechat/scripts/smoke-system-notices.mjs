import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

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
    credentials: app.identity.sessions.snapshot().credentials,
  };
  assert.ok(
    original.credentials,
    'System notice smoke needs the synthetic login',
  );
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
  try {
    current = mountPage(module, {});
    await flush();
    assert.equal(current.data.loaded, true);
    assert.equal(current.data.items.length, 1);
    assert.equal(current.data.unreadCount, 9);
    assert.equal(
      requests.filter((request) => request.method === 'PUT').length,
      0,
    );
    assert.equal(
      current.onOpen,
      undefined,
      'No source navigation handler exists',
    );
    assert.equal(
      current.identityOverlay,
      undefined,
      'No identity overlay exists',
    );
    for (const row of current.data.items)
      assert.deepEqual(Object.keys(row).sort(), [
        'createdAt',
        'keepVotes',
        'kind',
        'noticeId',
        'readAt',
        'removeVotes',
      ]);
    current.onMore();
    await flush();
    assert.equal(current.data.items.length, 2);
    assert.equal(current.data.canLoadMore, false);
    current.onRead({ currentTarget: { dataset: { id: noticeId } } });
    current.onRead({ currentTarget: { dataset: { id: noticeId } } });
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
    assert.equal(current.data.unreadCount, 9);
    assert.match(current.data.status, /尚未确认/);
    current.onRead({ currentTarget: { dataset: { id: noticeId } } });
    await flush();
    assert.equal(current.data.items[0].readAt, readAt);
    assert.equal(current.data.items[1].readAt, null);
    assert.equal(current.data.unreadCount, 8);
    assert.equal(records.size, 1, 'Retry does not decrement twice');
    const writes = requests.filter((request) => request.method === 'PUT');
    assert.equal(writes[0].url, writes[1].url);
    current.onRead({ currentTarget: { dataset: { id: noticeId } } });
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
    current.onRead({ currentTarget: { dataset: { id: secondNoticeId } } });
    await flush();
    app.onHide();
    assert.equal(readCancellation.isCancelled, true);
    assert.deepEqual(current.data.items, []);
    assert.equal(current.data.unreadCount, 0);
    assert.equal(badgeView.loaded, false);
    assert.equal(badgeView.unreadCount, 0);
    finishRead();
    await flush();
    assert.deepEqual(current.data.items, []);
    assert.equal(current.data.unreadCount, 0);
    waitForRead = false;
    current.onShow();
    await flush();
    current.onMore();
    await flush();
    assert.equal(current.data.items[1].readAt, readAt);
    assert.equal(current.data.unreadCount, 7);

    waitForList = true;
    current.onReload();
    assert.deepEqual(current.data.items, []);
    assert.equal(current.data.unreadCount, 0);
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
    assert.equal(current.data.unreadCount, 4);
    oldFinish();
    await flush();
    assert.equal(
      current.data.unreadCount,
      4,
      'Old owner callback cannot replace current count',
    );
    current.onHide();
    assert.equal(current.controller, undefined);
    assert.deepEqual(current.data.items, []);
    assert.equal(current.data.unreadCount, 0);
    current.onShow();
    await flush();
    assert.equal(current.data.loaded, true);
    leakSource = true;
    current.onReload();
    await flush();
    assert.equal(current.data.loaded, false);
    assert.deepEqual(current.data.items, []);
    assert.equal(current.data.unreadCount, 0);
    assert.match(current.data.error, /格式异常/);
    assert.equal(sourceRequests, 0);
    const template = readFileSync(
      path.join(dist, 'pages/system-notices/system-notices.wxml'),
      'utf8',
    );
    assert.match(template, /标记此条已读/);
    assert.match(template, /陪审团移除结果/);
    assert.match(template, /独立于社区更新/);
    assert.match(template, /外部推送尚未接入/);
    assert.equal(
      /postId|preview|target|authorId|jurorId|reporterId|identityOverlay|bindtap="onOpen"|requestSubscribeMessage/.test(
        template,
      ),
      false,
    );
    for (const match of template.matchAll(/(?:bindtap|catchtap)="([^"]+)"/g))
      assert.equal(typeof current[match[1]], 'function');
  } finally {
    current?.onUnload();
    badge?.dispose();
    app.community.gateway = original.gateway;
    app.community.systemNotices = original.notices;
    app.community.identityPrivacy = original.privacy;
    app.identity.sessions.completeLogin(
      app.identity.sessions.beginLogin(),
      original.credentials,
    );
  }
}
