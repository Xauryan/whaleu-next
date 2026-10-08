import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
/** Emitted CommonJS/pages with synthetic native transport; not a physical-device rendering claim. */
export async function smokeAnnouncements({ app, dist, mountPage, flush }) {
  const { ApiClient } = require(path.join(dist, 'api/client.js'));
  const { HttpAnnouncementsGateway } = require(
    path.join(dist, 'announcements/gateway.js'),
  );
  const previous = {
    gateway: app.community.announcements,
    profiles: app.community.profiles,
    community: app.community.gateway,
    credentials: app.identity.sessions.snapshot().credentials,
    navigate: globalThis.wx.navigateTo,
  };
  const id = '11111111-1111-4111-8111-111111111111',
    revision = '22222222-2222-4222-8222-222222222222',
    campus = '33333333-3333-4333-8333-333333333333',
    other = '44444444-4444-4444-8444-444444444444';
  const bodyText = '第一段\n\n  缩进与 <b>纯文本</b>\n\t末段 👋\n',
    timestamp = '2026-10-08T01:02:03.123456Z',
    cursor = Buffer.alloc(32, 5).toString('base64url');
  const state = {
    page: true,
    status: 'unseen',
    loss: false,
    held: null,
    empty: false,
    fail: false,
  };
  const requests = [],
    navigation = [];
  const summary = (id, latest) => ({
    id,
    revision,
    versionLabel: '重复版本',
    title: '合成公告',
    announcementDate: null,
    createdAt: timestamp,
    highlight: true,
    isLatest: latest,
    popupEnabled: true,
  });
  const popup = () => ({
    id,
    revision,
    versionLabel: '重复版本',
    title: '合成提醒',
    announcementDate: null,
    bodyText,
    media: { status: 'unavailable', items: null },
  });
  const api = new ApiClient(
    'https://api.example',
    {
      send: async (request) => {
        requests.push(request);
        const url = new URL(request.url),
          context = { campusId: url.searchParams.get('campusId') },
          ok = (body) => ({ status: 200, headers: {}, body });
        if (state.held && url.pathname === '/v1/announcements')
          await state.held.promise;
        if (state.fail)
          return {
            status: 503,
            headers: {},
            body: { error: { code: 'ANNOUNCEMENTS_UNAVAILABLE' } },
          };
        if (request.method === 'PUT') {
          assert.ok(request.headers.Authorization);
          assert.equal(
            url.pathname,
            `/v1/me/announcements/${id}/popup-acknowledgement`,
          );
          assert.equal(request.body.expectedRevision, revision);
          if (state.loss) throw new Error('Synthetic lost reply');
          state.status = 'acknowledged';
          return ok({
            announcementId: id,
            acknowledgement: {
              status: 'acknowledged',
              acknowledgedAt: timestamp,
            },
          });
        }
        assert.equal(request.method, 'GET');
        assert.equal(request.body, undefined);
        if (url.pathname === '/v1/me/announcements/popup') {
          assert.ok(request.headers.Authorization);
          return ok({
            context,
            candidate: popup(),
            acknowledgement: {
              status: state.status,
              acknowledgedAt:
                state.status === 'acknowledged' ? timestamp : null,
            },
          });
        }
        if (url.pathname === '/v1/announcements/changes')
          return ok({
            context,
            since: timestamp,
            checkedAt: timestamp,
            newness: {
              status: 'available',
              hasNew: true,
              newCount: '9007199254740993',
            },
          });
        if (url.pathname === `/v1/announcements/${id}`)
          return ok({
            ...summary(id, true),
            bodyText,
            updatedAt: null,
            media: { status: 'unavailable', items: null },
          });
        assert.equal(url.pathname, '/v1/announcements');
        const later = url.searchParams.has('cursor');
        if (later) assert.equal(url.searchParams.get('cursor'), cursor);
        return ok({
          context,
          items: state.empty
            ? []
            : !later && state.page
              ? Array.from({ length: 20 }, (_, i) =>
                  summary(
                    i === 0
                      ? id
                      : `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
                    i === 0,
                  ),
                )
              : [summary(later ? other : id, !later)],
          continuation: !state.empty && !later && state.page ? 'more' : 'end',
          nextCursor: !state.empty && !later && state.page ? cursor : null,
        });
      },
    },
    app.identity.sessions,
    {
      refresh: async () => {
        throw new Error('No provider');
      },
    },
  );
  app.community.announcements = new HttpAnnouncementsGateway(api);
  globalThis.wx.navigateTo = (options) => navigation.push(options);
  const mount = (name, query = {}) =>
    mountPage(path.join(dist, `pages/${name}/${name}.js`), query);
  const mounted = [];
  try {
    app.identity.sessions.logout();
    const list = mount('announcements', { campusId: campus });
    mounted.push(list);
    await flush();
    assert.equal(list.data.loaded, true);
    assert.equal(list.data.hasSession, false);
    assert.equal(list.data.items.length, 20);
    assert.equal(list.data.changesNotice, '最近30天新公告 9007199254740993 条');
    list.onNext();
    await flush();
    assert.equal(list.data.pageNumber, 2);
    assert.equal(list.data.items[0].id, other);
    list.onPrevious();
    await flush();
    assert.equal(list.data.pageNumber, 1);
    list.onAnnouncement({ currentTarget: { dataset: { id } } });
    list.onAnnouncement({ currentTarget: { dataset: { id } } });
    assert.equal(navigation.length, 1);
    assert.equal(list.data.items.length, 0);
    assert.equal(
      navigation[0].url,
      `/pages/announcement-detail/announcement-detail?announcementId=${id}&campusId=${campus}`,
    );
    navigation[0].success();
    list.onHide();
    const detail = mount('announcement-detail', {
      campusId: campus,
      announcementId: id,
    });
    mounted.push(detail);
    await flush();
    assert.equal(detail.data.detail.bodyText, bodyText);
    assert.equal(detail.data.detail.media.status, 'unavailable');
    detail.onHide();
    assert.equal(detail.data.detail, null);
    assert.equal(
      requests.some((request) => request.method === 'PUT'),
      false,
    );
    assert.ok(requests.every((request) => !request.headers.Authorization));
    state.fail = true;
    detail.onShow();
    await flush();
    assert.equal(detail.data.detail, null);
    assert.match(detail.data.error, /不代表没有公告/);
    state.fail = false;
    state.held = deferred();
    list.onShow();
    await flush();
    app.identity.sessions.completeLogin(
      app.identity.sessions.beginLogin(),
      previous.credentials,
    );
    state.held.resolve();
    await flush();
    assert.equal(list.data.items.length, 0);
    state.held = null;
    list.onHide();
    list.onShow();
    await flush();
    assert.equal(
      list.data.campusId,
      null,
      'login replacement discards old browsing intent',
    );
    const baseProfile = await previous.profiles.profile({ isCancelled: false });
    const campusRow = (id) => ({
      id,
      institutionId: '10001',
      institutionName: '合成大学',
      fullName: `合成校区 ${id}`,
      shortName: null,
      district: '合成地区',
      isActive: true,
    });
    let profileFailure = false,
      spaceFailure = false;
    app.community.profiles = {
      ...previous.profiles,
      profile: async () => {
        if (profileFailure) throw new Error('Synthetic profile failure');
        return {
          ...baseProfile,
          accountId: app.identity.sessions.snapshot().credentials.accountId,
          selectedCampus: campusRow(campus),
        };
      },
      campuses: async () => ({
        items: [campusRow(campus), campusRow(other)],
        page: 1,
        pageSize: 100,
        total: 2,
      }),
    };
    app.community.gateway = {
      ...previous.community,
      spaces: async () => {
        if (spaceFailure) throw new Error('Synthetic region unavailable');
        return { regional: null, global: [] };
      },
    };
    const feed = mount('community-feed');
    mounted.push(feed);
    await flush();
    assert.equal(feed.data.announcementPopup.popup.id, id);
    assert.equal(feed.data.announcementPopup.campusId, campus);
    feed.onCampus({ currentTarget: { dataset: { id: other } } });
    await flush();
    assert.equal(feed.data.announcementPopup.campusId, other);
    feed.onReload();
    assert.equal(feed.data.announcementPopup.popup, null);
    await flush();
    assert.equal(
      feed.data.announcementPopup.campusId,
      campus,
      'reload shares current browsing profile scope',
    );
    spaceFailure = true;
    feed.onCampus({ currentTarget: { dataset: { id: other } } });
    await flush();
    feed.onReload();
    assert.equal(feed.data.campusId, '');
    await flush();
    assert.equal(feed.data.campusId, campus);
    assert.equal(feed.data.announcementPopup.campusId, campus);
    assert.ok(feed.data.announcementPopup.popup);
    spaceFailure = false;
    profileFailure = true;
    feed.onReload();
    assert.equal(feed.data.announcementPopup.popup, null);
    await flush();
    assert.equal(feed.data.announcementPopup.popup, null);
    profileFailure = false;
    feed.onReload();
    await flush();
    state.loss = true;
    feed.onCloseAnnouncement();
    feed.onCloseAnnouncement();
    assert.equal(feed.data.announcementPopup.popup, null);
    await flush();
    assert.equal(feed.data.announcementPopup.acknowledgement, 'unconfirmed');
    assert.equal(
      requests.filter((request) => request.method === 'PUT').length,
      1,
    );
    state.loss = false;
    feed.onHide();
    feed.onShow();
    await flush();
    assert.equal(feed.data.announcementPopup.popup.id, id);
    feed.onCloseAnnouncement();
    await flush();
    assert.equal(feed.data.announcementPopup.acknowledgement, 'confirmed');
    feed.onHide();
    feed.onShow();
    await flush();
    assert.equal(
      feed.data.announcementPopup.popup,
      null,
      'acknowledged latest suppresses popup',
    );
    state.status = 'unseen';
    feed.onHide();
    feed.onShow();
    await flush();
    assert.ok(feed.data.announcementPopup.popup);
    const count = requests.filter((request) => request.method === 'PUT').length;
    app.onHide();
    assert.equal(feed.data.announcementPopup.popup, null);
    assert.equal(list.data.items.length, 0);
    assert.equal(
      requests.filter((request) => request.method === 'PUT').length,
      count,
      'background never acknowledges',
    );
    for (const name of ['announcements', 'announcement-detail']) {
      const source = readFileSync(
        path.join(dist, `pages/${name}/${name}.wxml`),
        'utf8',
      );
      assert.match(source, /selectable="true"/);
      assert.doesNotMatch(
        source,
        /<image|rich-text|previewImage|https?:\/\/|未读/,
      );
      for (const match of source.matchAll(/bindtap="([^"]+)"/g))
        assert.equal(
          typeof (name === 'announcements' ? list : detail)[match[1]],
          'function',
        );
    }
    const detailTemplate = readFileSync(
      path.join(dist, 'pages/announcement-detail/announcement-detail.wxml'),
      'utf8',
    );
    assert.match(detailTemplate, /\{\{detail.bodyText\}\}/);
    assert.match(detailTemplate, /公告图片暂不可用/);
    const popupTemplate = readFileSync(
      path.join(dist, 'announcements/popup.wxml'),
      'utf8',
    );
    assert.match(popupTemplate, /bindtap="onCloseAnnouncement"/);
    assert.match(popupTemplate, /\{\{popup.bodyText\}\}/);
    assert.doesNotMatch(popupTemplate, /<image|rich-text|previewImage/);
    assert.match(
      readFileSync(path.join(dist, 'announcements/announcements.wxss'), 'utf8'),
      /white-space: pre-wrap/,
    );
  } finally {
    for (const page of mounted) page.onUnload?.();
    app.community.announcements = previous.gateway;
    app.community.profiles = previous.profiles;
    app.community.gateway = previous.community;
    globalThis.wx.navigateTo = previous.navigate;
    app.identity.sessions.completeLogin(
      app.identity.sessions.beginLogin(),
      previous.credentials,
    );
  }
  console.log(
    'Announcements emitted smoke passed: real guest list/detail and current-scope authenticated feed popup, strict optional-auth transport, fresh Next/Previous/Back, plain selectable paragraphs, unknown media, account/scope/background clearing, explicit ID/revision close, lost acknowledgement and latest suppression. No physical-device claim.',
  );
}
