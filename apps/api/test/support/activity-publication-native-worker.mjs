/** Actual emitted App/Page/WXML. Only wx transport/provider and disposable
 * immutable Media adapters are synthetic; no business controller is replaced. */
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
    process.send(value, (error) => (error ? reject(error) : resolve())),
  );
async function until(check, label, page) {
  const end = Date.now() + 25000;
  while (!check()) {
    assert.ok(
      Date.now() < end,
      `${label}: ${page?.data.error || page?.data.status || JSON.stringify(page?.data.upload) || 'timeout'}`,
    );
    await delay(10);
  }
}
async function rpc(name, fields = {}) {
  const response = new Promise((resolve) => process.once('message', resolve));
  await send({ event: 'checkpoint', name, ...fields });
  assert.deepEqual(await response, { event: 'continue', name });
}
process.once('message', async (input) => {
  const pages = new Set();
  let app, upload, read, orgRead;
  try {
    const transport = new NativeExperienceTransport(input.port),
      platform = platformStorage();
    upload = await NativeMediaUploadBridge.create(
      input.port,
      nativeOrigin,
      'activities',
    );
    read = await NativeMediaReadBridge.create(input.port, 'activities');
    orgRead = await NativeMediaReadBridge.create(input.port, 'organizations');
    const readOwners = new Map();
    const fsFor = (path) =>
      path.includes('native-upload-')
        ? upload.wx.getFileSystemManager()
        : (readOwners.get(path) === 'org'
            ? orgRead
            : read
          ).wx.getFileSystemManager();
    const wx = {
      ...platform,
      ...upload.wx,
      nextTick: queueMicrotask,
      getFileSystemManager: () =>
        Object.fromEntries(
          ['getFileInfo', 'readFile', 'unlink'].map((name) => [
            name,
            (options) => fsFor(options.filePath)[name](options),
          ]),
        ),
      getImageInfo: (options) =>
        (options.src.includes('native-upload-')
          ? upload.wx
          : (readOwners.get(options.src) === 'org' ? orgRead : read).wx
        ).getImageInfo(options),
      downloadFile: (options) => {
        const owner = options.url.includes('/organizations/') ? orgRead : read;
        return owner.wx.downloadFile({
          ...options,
          success: (value) => {
            readOwners.set(
              value.tempFilePath,
              owner === orgRead ? 'org' : 'activity',
            );
            options.success(value);
          },
        });
      },
      request: (options) => {
        void transport
          .send({
            url: options.url,
            method: options.method,
            headers: options.header,
            body: options.data,
            timeoutMs: options.timeout,
          })
          .then(
            async (response) => {
              if (
                response.status === 200 &&
                new URL(options.url).pathname.endsWith('/finalize')
              )
                await rpc('process-images');
              options.success({
                statusCode: response.status,
                header: response.headers,
                data: response.body,
              });
            },
            () =>
              options.fail({ errMsg: 'request:fail synthetic response loss' }),
          );
        return { abort() {} };
      },
      navigateTo: (options) => options.success?.(),
    };
    emitted('config').clientConfiguration = Object.freeze({
      apiOrigin: nativeOrigin,
      providerLoginEnabled: true,
    });
    globalThis.wx = wx;
    globalThis.App = (value) => {
      app = value;
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
      },
      close = (h) => {
        h.page.onHide?.();
        h.page.onUnload?.();
        pages.delete(h);
      };
    login('owner');
    let editor = mount('activity-publish');
    await until(
      () => editor.page.data.loaded && !editor.page.data.busy,
      'organizers',
      editor.page,
    );
    assert.equal(editor.page.data.organizers.length, 1);
    editor.tap('onOrganizer', { id: input.organizationId });
    editor.event(
      'bindinput',
      'onField',
      { value: '原生活动发布' },
      { field: 'title' },
    );
    editor.event(
      'bindinput',
      'onField',
      { value: '实际Page到AppModule与PostgreSQL' },
      { field: 'description' },
    );
    editor.tap('onType', { type: 'online' });
    editor.tap('onType', { type: 'reward' });
    editor.event('bindchange', 'onQr', { value: true });
    editor.tap('onCreate');
    await until(
      () => editor.page.data.draft?.state === 'draft' && !editor.page.data.busy,
      'create',
      editor.page,
    );
    const id = editor.page.data.id;
    for (const slot of ['cover', 'gallery0']) {
      await upload.select(Buffer.from(input.png, 'base64'), 'image/png', {
        width: 40,
        height: 40,
        type: 'png',
      });
      editor.tap('onUpload', { slot });
      await until(
        () =>
          editor.page.data.upload.status === 'ready' &&
          editor.page.data.slots.find((s) => s.slot === slot).changed,
        'uploaded reviewed ' + slot,
        editor.page,
      );
    }
    editor.tap('onSave');
    await until(
      () =>
        editor.page.data.revision === 2 &&
        !editor.page.data.busy &&
        !editor.page.data.pending,
      'saved exact media',
      editor.page,
    );
    assert.ok(editor.page.data.draft.mediaBindings.cover);
    assert.ok(editor.page.data.draft.mediaBindings.gallery0);
    editor.tap('onPreview', { slot: 'cover' });
    await until(
      () => editor.page.data.image.status === 'ready',
      'draft cover decoded',
      editor.page,
    );
    editor.tap('onPublish');
    await until(
      () =>
        editor.page.data.pending &&
        editor.page.data.review === 'pending' &&
        !editor.page.data.busy,
      'real review queue',
      editor.page,
    );
    const key = editor.page.data.pendingId;
    assert.ok(key);
    await rpc('review-activity', { activityId: id });
    transport.dropSuccess = {
      path: `/v1/activity-publication/drafts/${id}/commands`,
      method: 'POST',
    };
    editor.tap('onRecover');
    await until(
      () =>
        editor.page.data.pending &&
        !editor.page.data.busy &&
        !!editor.page.data.error,
      'lost committed publication response',
      editor.page,
    );
    close(editor);
    editor = mount('activity-publish', { id });
    await until(
      () =>
        editor.page.data.draft?.state === 'published' &&
        !editor.page.data.busy &&
        !editor.page.data.pending,
      'same-key receipt recovery',
      editor.page,
    );
    assert.equal(editor.page.data.id, id);
    assert.equal(editor.page.data.pendingId, '');
    close(editor);
    let detail = mount('activity-native-detail', { id });
    await until(
      () => detail.page.data.image.status === 'ready' && !detail.page.data.busy,
      'public cover exact decode',
      detail.page,
    );
    assert.deepEqual(detail.page.data.activity.content.types, [
      'online',
      'reward',
    ]);
    assert.equal(detail.page.data.activity.content.endAt, null);
    assert.equal(detail.page.data.activity.organizerQr.status, 'available');
    assert.match(
      detail
        .nodes()
        .filter((n) => typeof n === 'string')
        .join(' '),
      /原生活动发布/,
    );
    detail.tap('onImage', { slot: 'gallery0' });
    await until(
      () => detail.page.data.image.status === 'ready',
      'gallery decoded',
      detail.page,
    );
    detail.tap('onQr');
    await until(
      () => detail.page.data.qr.status === 'ready',
      'public organizer QR decode',
      detail.page,
    );
    const imageSrc = detail.page.data.image.src;
    close(detail);
    assert.equal(detail.page.data.image.src, '');
    assert.equal(detail.page.data.qr.src, '');
    await read.idle();
    await until(
      () => read.removed.includes(imageSrc),
      'hidden image files are actually removed',
    );
    let list = mount('activity-native', { mode: 'mine' });
    await until(
      () => list.page.data.items.length === 1 && !list.page.data.busy,
      'immutable own history',
      list.page,
    );
    assert.equal(list.page.data.items[0].id, id);
    login('other');
    await until(
      () => list.page.data.items.length === 0,
      'account switch clears activity history',
      list.page,
    );
    close(list);
    list = mount('activity-native', { mode: 'mine' });
    await until(() => !list.page.data.busy, 'other history', list.page);
    assert.deepEqual(list.page.data.items, []);
    close(list);
    login('owner');
    editor = mount('activity-publish');
    await until(
      () => editor.page.data.loaded && !editor.page.data.busy,
      'second organizers',
      editor.page,
    );
    editor.tap('onOrganizer', { id: input.organizationId });
    editor.event(
      'bindinput',
      'onField',
      { value: '线下原生活动' },
      { field: 'title' },
    );
    editor.tap('onType', { type: 'offline' });
    editor.event(
      'bindinput',
      'onField',
      { value: '周日下午' },
      { field: 'activityTime' },
    );
    editor.event(
      'bindinput',
      'onField',
      { value: '图书馆' },
      { field: 'activityLocation' },
    );
    editor.tap('onCreate');
    await until(
      () => editor.page.data.draft && !editor.page.data.busy,
      'second draft',
      editor.page,
    );
    await upload.select(Buffer.from(input.png, 'base64'), 'image/png', {
      width: 40,
      height: 40,
      type: 'png',
    });
    editor.tap('onUpload', { slot: 'cover' });
    await until(
      () => editor.page.data.upload.status === 'ready',
      'second cover',
      editor.page,
    );
    editor.tap('onSave');
    await until(
      () => editor.page.data.revision === 2 && !editor.page.data.busy,
      'second saved',
      editor.page,
    );
    editor.tap('onPublish');
    await until(
      () => editor.page.data.pending && !editor.page.data.busy,
      'second pending',
      editor.page,
    );
    editor.tap('onCancelOriginal');
    await until(
      () => !editor.page.data.pending && !editor.page.data.busy,
      'cancel original queued',
      editor.page,
    );
    assert.match(editor.page.data.status, /取消/);
    assert.equal(editor.page.data.form.showOrganizerQr, false);
    const offlineId = editor.page.data.id;
    editor.tap('onPublish');
    await until(
      () => editor.page.data.pending && !editor.page.data.busy,
      'explicit new submission after original cancellation',
      editor.page,
    );
    await rpc('review-activity', { activityId: offlineId });
    editor.tap('onRecover');
    await until(
      () =>
        editor.page.data.draft?.state === 'published' &&
        !editor.page.data.busy &&
        !editor.page.data.pending,
      'offline published with QR disabled',
      editor.page,
    );
    close(editor);
    detail = mount('activity-native-detail', { id: offlineId });
    await until(
      () => detail.page.data.image.status === 'ready' && !detail.page.data.busy,
      'offline public cover',
      detail.page,
    );
    assert.deepEqual(detail.page.data.activity.content.types, ['offline']);
    assert.equal(detail.page.data.activity.content.activityTime, '周日下午');
    assert.equal(detail.page.data.activity.content.activityLocation, '图书馆');
    assert.equal(detail.page.data.activity.organizerQr.status, 'disabled');
    const text = detail
      .nodes()
      .filter((n) => typeof n === 'string')
      .join(' ');
    assert.match(text, /周日下午/);
    assert.match(text, /图书馆/);
    assert.match(text, /发布者未开启主办方二维码展示/);
    assert.equal(
      detail
        .nodes()
        .filter((n) => typeof n !== 'string')
        .some((n) => n.attrs?.bindtap === 'onQr'),
      false,
    );
    close(detail);
    editor = mount('activity-publish');
    await until(
      () => editor.page.data.loaded && !editor.page.data.busy,
      'unfinished draft chooser',
      editor.page,
    );
    editor.tap('onOrganizer', { id: input.organizationId });
    editor.tap('onCreate');
    await until(
      () => editor.page.data.draft?.state === 'draft' && !editor.page.data.busy,
      'unfinished draft created',
      editor.page,
    );
    editor.tap('onDiscardDraft');
    await until(
      () =>
        !editor.page.data.id &&
        !editor.page.data.draft &&
        !editor.page.data.busy,
      'explicit native unfinished draft closure',
      editor.page,
    );
    assert.match(editor.page.data.status, /放弃/);
    close(editor);
    await rpc('verify-final', { activityId: id, requestId: key });
    await send({
      event: 'done',
      uploads: upload.exchanges.length,
      reads: read.exchanges.length + orgRead.exchanges.length,
      requests: transport.exchanges.length,
    });
  } catch (error) {
    await send({ event: 'failure', message: error?.stack ?? String(error) });
  } finally {
    for (const h of pages) h.page.onUnload?.();
    app?.onHide?.();
    await upload?.dispose();
    await read?.dispose();
    await orgRead?.dispose();
    process.exit(0);
  }
});
