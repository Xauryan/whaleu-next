/** Real emitted App/Page/WXML, actual transport and AppModule. Only platform,
 * external image storage/Review and initial school facts are synthetic. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { mountEmittedPage } from '../../../wechat/test/text-review-emitted-harness.mjs';
const require = createRequire(import.meta.url),
  dist = fileURLToPath(new URL('../../../wechat/dist/', import.meta.url)),
  emitted = (name) => require(`${dist}${name}.js`);
const {
  NativeExperienceTransport,
  nativeOrigin,
  platformStorage,
} = require('./experience-native-bridge.ts');
const {
  NativeMediaUploadBridge,
} = require('../../../wechat/test/support/media-upload-bridge.ts');
const { NativeMediaReadBridge } = require('./media/native-read-bridge.ts');
const send = (value) =>
  new Promise((resolve, reject) =>
    process.send(value, (e) => (e ? reject(e) : resolve())),
  );
async function until(check, label, page) {
  const end = Date.now() + 20000;
  while (!check()) {
    assert.ok(
      Date.now() < end,
      `${label}: ${page?.data.error || page?.data.status || 'timeout'}; upload=${JSON.stringify(page?.data.upload)}; pending=${page?.data.pendingImages?.length}`,
    );
    await delay(10);
  }
}
async function rpc(name, fields = {}) {
  const next = new Promise((r) => process.once('message', r));
  await send({ event: 'checkpoint', name, ...fields });
  assert.deepEqual(await next, { event: 'continue', name });
}
process.once('message', async (input) => {
  let app, upload, read;
  const pages = new Set();
  try {
    const transport = new NativeExperienceTransport(input.port),
      platform = platformStorage();
    upload = await NativeMediaUploadBridge.create(
      input.port,
      nativeOrigin,
      'announcements',
    );
    read = await NativeMediaReadBridge.create(input.port, 'announcements');
    const fsFor = (p) =>
      p.includes('native-upload-')
        ? upload.wx.getFileSystemManager()
        : read.wx.getFileSystemManager();
    const wx = {
      ...platform,
      ...upload.wx,
      nextTick: queueMicrotask,
      getFileSystemManager: () =>
        Object.fromEntries(
          ['getFileInfo', 'readFile', 'unlink'].map((n) => [
            n,
            (o) => fsFor(o.filePath)[n](o),
          ]),
        ),
      getImageInfo: (o) =>
        (o.src.includes('native-upload-') ? upload.wx : read.wx).getImageInfo(
          o,
        ),
      downloadFile: (o) => read.wx.downloadFile(o),
      request: (o) => {
        void transport
          .send({
            url: o.url,
            method: o.method,
            headers: o.header,
            body: o.data,
            timeoutMs: o.timeout,
          })
          .then(
            async (r) => {
              if (
                r.status === 200 &&
                new URL(o.url).pathname.endsWith('/finalize')
              )
                await rpc('process-images');
              o.success({
                statusCode: r.status,
                header: r.headers,
                data: r.body,
              });
            },
            () => o.fail({ errMsg: 'request:fail synthetic response loss' }),
          );
        return { abort() {} };
      },
      navigateTo: (o) => o.success?.(),
      showModal: (o) => o.success({ confirm: true, cancel: false }),
    };
    emitted('config').clientConfiguration = Object.freeze({
      apiOrigin: nativeOrigin,
      providerLoginEnabled: true,
    });
    globalThis.wx = wx;
    globalThis.App = (v) => {
      app = v;
    };
    globalThis.getApp = () => app;
    emitted('app');
    app.onLaunch();
    const login = (name) =>
      app.identity.sessions.completeLogin(
        app.identity.sessions.beginLogin(),
        input.actors[name],
      );
    const mount = (name, route = {}) => {
      const h = mountEmittedPage(name, app, wx);
      pages.add(h);
      h.page.onLoad?.(route);
      h.page.onShow?.();
      return h;
    };
    const close = (h) => {
      h.page.onHide?.();
      h.page.onUnload?.();
      pages.delete(h);
    };
    const homePage = async () => {
      const h = mount('community-feed');
      await until(
        () =>
          h.page.data.campuses.some((c) => c.id === input.campusId) &&
          !h.page.data.busy,
        'browse campus choices',
        h.page,
      );
      h.tap('onCampus', { id: input.campusId });
      return h;
    };
    const tap = async (h, action, revision, enabled) => {
      h.tap('onCommand', {
        action,
        ...(enabled === undefined ? {} : { enabled }),
      });
      await until(
        () =>
          h.page.data.revision === revision &&
          !h.page.data.busy &&
          !h.page.data.pending,
        action,
        h.page,
      );
    };
    login('owner');
    let management = mount('announcement-manage');
    await until(
      () => management.page.data.loaded && !management.page.data.busy,
      'management',
      management.page,
    );
    assert.equal(management.page.data.management, 'fixed');
    assert.equal(management.page.data.regionName, input.regionName);
    management.tap('onNew');
    close(management);
    let edit = mount('announcement-edit');
    await until(
      () => edit.page.data.loaded && !edit.page.data.busy,
      'editor',
      edit.page,
    );
    edit.event(
      'bindinput',
      'onField',
      { value: '原生1' },
      { field: 'versionLabel' },
    );
    edit.event(
      'bindinput',
      'onField',
      { value: '第一行\n  第二行' },
      { field: 'bodyText' },
    );
    await tap(edit, 'create', 1);
    const id = edit.page.data.id;
    await upload.select(Buffer.from(input.png, 'base64'), 'image/png', {
      width: 40,
      height: 40,
      type: 'png',
    });
    edit.tap('onUpload', { slot: 'gallery0' });
    await until(
      () =>
        edit.page.data.upload.status === 'ready' &&
        edit.page.data.slots[0].changed,
      'upload',
      edit.page,
    );
    await tap(edit, 'save', 2);
    edit.tap('onPreview', { slot: 'gallery0' });
    await until(
      () => edit.page.data.image.status === 'ready',
      'draft image',
      edit.page,
    );
    transport.dropSuccess = {
      path: `/v1/announcement-management/${id}/commands`,
      method: 'POST',
    };
    edit.tap('onCommand', { action: 'publish' });
    await until(
      () =>
        edit.page.data.pending &&
        !edit.page.data.busy &&
        !!edit.page.data.error,
      'lost publication response',
      edit.page,
    );
    const requestId = edit.page.data.pendingId;
    close(edit);
    edit = mount('announcement-edit', { id });
    await until(
      () =>
        edit.page.data.state === 'active' &&
        !edit.page.data.pending &&
        !edit.page.data.busy,
      'same key recovery',
      edit.page,
    );
    assert.equal(edit.page.data.management, 'fixed');
    close(edit);
    // A different actual private draft must never replace this explicit A route.
    let otherDraftPage = mount('announcement-edit');
    await until(
      () => otherDraftPage.page.data.loaded && !otherDraftPage.page.data.busy,
      'other private draft form',
      otherDraftPage.page,
    );
    otherDraftPage.event(
      'bindinput',
      'onField',
      { value: '临时B' },
      { field: 'versionLabel' },
    );
    await tap(otherDraftPage, 'create', 1);
    const otherDraft = otherDraftPage.page.data.id;
    close(otherDraftPage);
    edit = mount('announcement-edit', { id });
    await until(
      () =>
        edit.page.data.id === id &&
        edit.page.data.state === 'active' &&
        !edit.page.data.busy,
      'A route ignores remembered B draft',
      edit.page,
    );
    edit.tap('onRefresh');
    await until(
      () =>
        edit.page.data.id === id &&
        edit.page.data.state === 'active' &&
        !edit.page.data.busy,
      'refresh retains active route',
      edit.page,
    );
    edit.page.onHide();
    edit.page.onShow();
    await until(
      () =>
        edit.page.data.id === id &&
        edit.page.data.state === 'active' &&
        !edit.page.data.busy,
      'hide/show retains active route',
      edit.page,
    );
    login('member');
    await until(
      () => edit.page.data.form.bodyText === '',
      'account switch discards private view',
      edit.page,
    );
    assert.equal(edit.page.target, id);
    login('owner');
    edit.page.onShow();
    await until(
      () =>
        edit.page.data.id === id &&
        edit.page.data.state === 'active' &&
        !edit.page.data.busy,
      'same route reauthorized after account switch',
      edit.page,
    );
    close(edit);
    otherDraftPage = mount('announcement-edit', { id: otherDraft });
    await until(
      () =>
        otherDraftPage.page.data.id === otherDraft &&
        !otherDraftPage.page.data.busy,
      'close unrelated B draft',
      otherDraftPage.page,
    );
    otherDraftPage.tap('onCommand', { action: 'cancel_draft' });
    await until(
      () =>
        otherDraftPage.page.data.status === '上传草稿已取消' &&
        !otherDraftPage.page.data.busy,
      'B draft cancelled explicitly',
      otherDraftPage.page,
    );
    close(otherDraftPage);
    let listing = mount('announcements', { campusId: input.campusId });
    await until(
      () => listing.page.data.loaded && !listing.page.data.busy,
      'native list',
      listing.page,
    );
    assert.equal(listing.page.data.source, 'native');
    assert.equal(listing.page.data.items[0].id, id);
    assert.match(
      listing
        .nodes()
        .filter((n) => typeof n === 'string')
        .join(' '),
      /新发布公告/,
    );
    listing.tap('onAnnouncement', { id });
    close(listing);
    let detail = mount('announcement-detail', {
      announcementId: id,
      campusId: input.campusId,
      source: 'native',
    });
    await until(
      () => detail.page.data.loaded && !detail.page.data.busy,
      'native detail',
      detail.page,
    );
    assert.equal(detail.page.data.detail.bodyText, '第一行\n  第二行');
    detail.tap('onImage', { slot: 'gallery0' });
    await until(
      () => detail.page.data.image.status === 'ready',
      'native image bytes',
      detail.page,
    );
    const src = detail.page.data.image.src;
    close(detail);
    await read.idle();
    await until(() => read.removed.includes(src), 'private local file release');
    login('member');
    let home = await homePage();
    await until(
      () => home.page.data.announcementPopup.popup?.id === id,
      'home popup',
      home.page,
    );
    await rpc('no-ack', { id });
    close(home);
    home = await homePage();
    await until(
      () => home.page.data.announcementPopup.popup?.id === id,
      'reopen no implicit ack',
      home.page,
    );
    home.tap('onAnnouncementImage', { slot: 'gallery0' });
    await until(
      () => home.page.data.announcementImageView.status === 'ready',
      'popup bytes',
      home.page,
    );
    home.tap('onCloseAnnouncement');
    await until(
      () => home.page.data.announcementPopup.acknowledgement === 'confirmed',
      'explicit popup ack',
      home.page,
    );
    close(home);
    login('owner');
    edit = mount('announcement-edit', { id });
    await until(
      () => edit.page.data.loaded && !edit.page.data.busy,
      'edit own',
      edit.page,
    );
    edit.event(
      'bindinput',
      'onField',
      { value: '修改后\n正文仍逐行' },
      { field: 'bodyText' },
    );
    await tap(edit, 'update', 4);
    await tap(edit, 'set_enabled', 5, false);
    await tap(edit, 'set_enabled', 6, true);
    close(edit);
    login('member');
    home = await homePage();
    await until(
      () =>
        !home.page.data.announcementPopup.busy &&
        home.page.data.announcementPopup.campusId === input.campusId,
      'ack after edit/enable',
      home.page,
    );
    assert.equal(home.page.data.announcementPopup.popup, null);
    close(home);
    // Explicitly choose the historical source. Missing coverage remains unavailable.
    listing = mount('announcements', { campusId: input.campusId });
    await until(
      () => listing.page.data.loaded && !listing.page.data.busy,
      'native list refresh',
      listing.page,
    );
    listing.tap('onSource', { source: 'accepted' });
    await until(
      () => !listing.page.data.busy && !!listing.page.data.error,
      'legacy unavailable remains visible',
      listing.page,
    );
    assert.match(listing.page.data.error, /不代表没有公告/);
    close(listing);
    app.identity.sessions.logout();
    detail = mount('announcement-detail', {
      announcementId: id,
      campusId: input.campusId,
      source: 'native',
    });
    await until(
      () => detail.page.data.loaded && !detail.page.data.busy,
      'guest native detail',
      detail.page,
    );
    detail.tap('onImage', { slot: 'gallery0' });
    await until(
      () => detail.page.data.image.status === 'ready',
      'guest optional image',
      detail.page,
    );
    close(detail);
    login('owner');
    edit = mount('announcement-edit');
    await until(
      () => edit.page.data.loaded && !edit.page.data.busy,
      'zero-image publication',
      edit.page,
    );
    edit.event(
      'bindinput',
      'onField',
      { value: '原生1' },
      { field: 'versionLabel' },
    );
    edit.event(
      'bindinput',
      'onField',
      { value: '同版本新ID，九图更新' },
      { field: 'bodyText' },
    );
    await tap(edit, 'create', 1);
    const newer = edit.page.data.id;
    await tap(edit, 'publish', 2);
    for (let i = 0; i < 9; i++) {
      const slot = 'gallery' + i;
      await upload.select(Buffer.from(input.png, 'base64'), 'image/png', {
        width: 40,
        height: 40,
        type: 'png',
      });
      edit.tap('onUpload', { slot });
      await until(
        () =>
          edit.page.data.upload.status === 'ready' &&
          edit.page.data.slots[i].changed,
        'nine image upload ' + slot,
        edit.page,
      );
    }
    const lastGalleryUploadAt = Date.now();
    await tap(edit, 'update', 3);
    close(edit);
    detail = mount('announcement-detail', {
      announcementId: newer,
      campusId: input.campusId,
      source: 'native',
    });
    await until(
      () => detail.page.data.loaded && !detail.page.data.busy,
      'nine image detail',
      detail.page,
    );
    assert.equal(detail.page.data.detail.media.items.length, 9);
    for (let i = 0; i < 9; i++) {
      detail.tap('onImage', { slot: 'gallery' + i });
      await until(
        () => detail.page.data.image.status === 'ready',
        'nine current image bytes ' + i,
        detail.page,
      );
    }
    close(detail);
    // Twelve actual uploads span two real shared 10/minute request windows.
    // Do not seed timestamps, alter quotas, or bypass the normal upload route.
    await delay(Math.max(0, lastGalleryUploadAt + 61000 - Date.now()));
    edit = mount('announcement-edit', { id: newer });
    await until(
      () => edit.page.data.id === newer && !edit.page.data.busy,
      'replace/remove editor',
      edit.page,
    );
    await upload.select(Buffer.from(input.png, 'base64'), 'image/png', {
      width: 40,
      height: 40,
      type: 'png',
    });
    edit.tap('onUpload', { slot: 'gallery0' });
    await until(
      () =>
        edit.page.data.upload.status === 'ready' &&
        edit.page.data.slots[0].changed,
      'replacement bytes',
      edit.page,
    );
    await tap(edit, 'update', 4);
    edit.tap('onRemove', { slot: 'gallery8' });
    await tap(edit, 'update', 5);
    close(edit);
    detail = mount('announcement-detail', {
      announcementId: newer,
      campusId: input.campusId,
      source: 'native',
    });
    await until(
      () => detail.page.data.loaded && !detail.page.data.busy,
      'replacement/removal public detail',
      detail.page,
    );
    assert.equal(detail.page.data.detail.media.items.length, 8);
    assert.ok(
      !detail.page.data.detail.media.items.some((i) => i.slot === 'gallery8'),
    );
    detail.tap('onImage', { slot: 'gallery0' });
    await until(
      () => detail.page.data.image.status === 'ready',
      'replacement current image bytes',
      detail.page,
    );
    close(detail);
    login('member');
    home = await homePage();
    await until(
      () => home.page.data.announcementPopup.popup?.id === newer,
      'new ID same version independently unseen',
      home.page,
    );
    home.tap('onCloseAnnouncement');
    await until(
      () => home.page.data.announcementPopup.acknowledgement === 'confirmed',
      'new popup explicit acknowledgement',
      home.page,
    );
    close(home);
    login('owner');
    edit = mount('announcement-edit');
    await until(
      () => edit.page.data.loaded && !edit.page.data.busy,
      'new draft',
      edit.page,
    );
    edit.event(
      'bindinput',
      'onField',
      { value: '原生1' },
      { field: 'versionLabel' },
    );
    edit.event(
      'bindinput',
      'onField',
      { value: '私有上传准备' },
      { field: 'bodyText' },
    );
    await tap(edit, 'create', 1);
    const draft = edit.page.data.id;
    await upload.select(Buffer.from(input.png, 'base64'), 'image/png', {
      width: 40,
      height: 40,
      type: 'png',
    });
    edit.tap('onUpload', { slot: 'gallery0' });
    await until(
      () =>
        edit.page.data.upload.status === 'ready' &&
        edit.page.data.pendingImages.length === 1,
      'unbound orphan prepared',
      edit.page,
    );
    close(edit);
    await rpc('move-grant', { draft });
    edit = mount('announcement-edit', { id: draft });
    await until(
      () =>
        edit.page.data.state === 'draft' &&
        edit.page.data.management === 'none' &&
        !edit.page.data.busy,
      'closure after grant moved',
      edit.page,
    );
    assert.equal(edit.page.data.form.bodyText, '');
    assert.doesNotMatch(
      edit
        .nodes()
        .filter((n) => typeof n === 'string')
        .join(' '),
      /全局超级管理员/,
    );
    edit.tap('onCommand', { action: 'cancel_draft' });
    await until(
      () => edit.page.data.status === '上传草稿已取消' && !edit.page.data.busy,
      'closure current owner only',
      edit.page,
    );
    close(edit);
    edit = mount('announcement-edit');
    await until(
      () => !edit.page.data.busy && edit.page.data.pendingImages.length === 1,
      'orphan survives reopen',
      edit.page,
    );
    edit.tap('onPendingImage', {
      target: draft,
      slot: 'gallery0',
      revision: 1,
      action: 'cancel',
    });
    await until(
      () => edit.page.data.pendingImages.length === 0,
      'orphan exact-key cancellation releases journal',
      edit.page,
    );
    close(edit);
    await rpc('verify-final', { id, requestId, draft });
    await send({
      event: 'done',
      requests: transport.exchanges.length,
      uploads: upload.exchanges.length,
      reads: read.exchanges.length,
    });
  } catch (error) {
    await send({ event: 'failure', message: error?.stack ?? String(error) });
  } finally {
    for (const h of pages) {
      h.page.onHide?.();
      h.page.onUnload?.();
    }
    app?.onHide?.();
    await upload?.close();
    await read?.close();
    process.disconnect();
  }
});
