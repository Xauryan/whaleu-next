/** E4a simulated native boundary: emitted App/Page/WXML + ordinary API/PG.
 * This does not certify WeChat DevTools, devices or live group delivery. */
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
async function rpc(name, fields = {}) {
  const next = new Promise((r) => process.once('message', r));
  await send({ event: 'checkpoint', name, ...fields });
  assert.deepEqual(await next, { event: 'continue', name });
}
async function until(check, label, page) {
  const end = Date.now() + 20000;
  while (!check()) {
    assert.ok(Date.now() < end, `${label}: ${JSON.stringify(page?.data)}`);
    await delay(10);
  }
}
function openQrPanel(h) {
  if (h.page.data.uiPanel !== 'qr') h.tap('onToggleUiPanel', { panel: 'qr' });
  assert.equal(h.page.data.uiPanel, 'qr');
}
process.once('message', async (input) => {
  let app,
    upload,
    read,
    losePreferenceResult = false;
  const pages = new Set();
  try {
    const transport = new NativeExperienceTransport(input.port),
      platform = platformStorage();
    upload = await NativeMediaUploadBridge.create(
      input.port,
      nativeOrigin,
      'school-configuration',
    );
    read = await NativeMediaReadBridge.create(
      input.port,
      'school-configuration',
    );
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
              if (
                losePreferenceResult &&
                o.method === 'PATCH' &&
                new URL(o.url).pathname === '/v1/me/preferences' &&
                r.status === 200
              ) {
                losePreferenceResult = false;
                transport.failNext = '/v1/me/profile';
                o.fail({
                  errMsg: 'request:fail synthetic lost preference response',
                });
                return;
              }
              o.success({
                statusCode: r.status,
                header: r.headers,
                data: r.body,
              });
            },
            () => o.fail({ errMsg: 'request:fail synthetic loss' }),
          );
        // Deliberately non-cooperative cancellation proves late callback isolation.
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
    const manage = async () => {
      login('owner');
      const h = mount('school-configuration');
      await until(
        () => h.page.data.loaded && !h.page.data.busy,
        'school management',
        h.page,
      );
      assert.equal(h.page.data.regionId, input.regionId);
      h.tap('onChooseEntry', { key: 'errand' });
      return h;
    };
    const save = async (h, revision) => {
      h.tap('onSave');
      await until(
        () =>
          h.page.data.entries.find((e) => e.entryKey === 'errand')?.revision ===
            revision &&
          !h.page.data.busy &&
          !h.page.data.pending,
        'school save',
        h.page,
      );
    };
    const selectQr = async (h, data) => {
      openQrPanel(h);
      await upload.select(Buffer.from(data, 'base64'), 'image/png', {
        width: 48,
        height: 48,
        type: 'png',
      });
      h.tap('onPickQr');
      await until(
        () => h.page.data.qrUpload.status === 'ready',
        'QR uploaded/reviewed',
        h.page,
      );
    };
    const detail = async (name = 'publisher') => {
      login(name);
      const h = mount('errand-detail', { orderId: input.orderId });
      await until(
        () =>
          h.page.data.loaded &&
          !h.page.data.targetServices.busy &&
          h.page.data.targetServices.regionName,
        'errand detail target',
        h.page,
      );
      assert.equal(h.page.data.detail.targetRegion.id, input.regionId);
      assert.equal(h.page.data.targetServices.regionName, input.target);
      return h;
    };
    const preview = async (h) => {
      h.tap('onPreviewTargetQr');
      await until(
        () => h.page.data.targetQr.status === 'ready',
        'inline target QR',
        h.page,
      );
      assert.ok(
        h
          .nodes()
          .some(
            (n) =>
              typeof n !== 'string' &&
              n.tag === 'image' &&
              n.attrs.src === h.page.data.targetQr.src,
          ),
      );
      return read.bytes(h.page.data.targetQr.src);
    };
    let admin = await manage();
    admin.event(
      'bindinput',
      'onField',
      { value: 'Synthetic target errand group' },
      { field: 'name' },
    );
    admin.event(
      'bindinput',
      'onField',
      { value: '3' },
      { field: 'maxGroupNumber' },
    );
    admin.event('bindchange', 'onField', { value: true }, { field: 'enabled' });
    await selectQr(admin, input.png);
    await save(admin, 1);
    close(admin);
    login('reader');
    transport.failNext = `/v1/school-services/errands/${input.orderId}`;
    let h = mount('errand-detail', { orderId: input.orderId });
    await until(
      () => h.page.data.loaded && h.page.data.targetServices.error,
      'first group network failure',
      h.page,
    );
    const unchangedRevision = h.page.data.detail.revision;
    h.tap('onRefresh');
    await until(
      () =>
        h.page.data.targetServices.visible && !h.page.data.targetServices.busy,
      'explicit unchanged-order refresh recovers group',
      h.page,
    );
    assert.equal(h.page.data.detail.revision, unchangedRevision);

    assert.equal(h.page.data.targetServices.visible, true);
    const bytes = await preview(h);
    await rpc('verify-initial', { bytes: bytes.toString('base64') });
    assert.ok(
      read.exchanges.at(-1).path.includes(`/errands/${input.orderId}/`),
    );
    h.tap('onCloseTargetQr');
    await until(() => !h.page.data.targetQr.src, 'QR close');
    await read.idle();
    assert.equal(await read.fileCount(), 0);
    const held = read.holdNext();
    h.tap('onPreviewTargetQr');
    await held.arrived;
    h.tap('onCloseTargetQr');
    held.release();
    await read.idle();
    assert.equal(h.page.data.targetQr.src, '');
    assert.equal(await read.fileCount(), 0);
    await preview(h);
    app.onHide();
    assert.equal(h.page.data.targetQr.src, '');
    assert.equal(h.page.data.targetServices.visible, false);
    h.page.onShow();
    await until(
      () =>
        h.page.data.targetServices.visible && !h.page.data.targetServices.busy,
      'return after app hide',
      h.page,
    );
    // Shared profile revision changes elsewhere; dismissal must retain that change.
    await rpc('profile-conflict');
    h.tap('onDismissTargetNotice');
    await until(
      () =>
        !h.page.data.targetServices.visible && !h.page.data.targetServices.busy,
      'dismiss with CAS recovery',
      h.page,
    );
    assert.equal(
      transport.exchanges.filter(
        (e) => e.path === '/v1/me/preferences' && e.status === 409,
      ).length,
      1,
    );
    await rpc('verify-dismiss');
    h.tap('onRefresh');
    await until(
      () =>
        h.page.data.loaded &&
        h.page.data.targetServices.regionName &&
        !h.page.data.targetServices.busy,
      'dismiss reload',
      h.page,
    );
    assert.equal(h.page.data.targetServices.visible, false);
    close(h);
    h = await detail('other');
    assert.equal(h.page.data.targetServices.visible, true);
    losePreferenceResult = true;
    h.tap('onDismissTargetNotice');
    await until(
      () =>
        h.page.data.targetServices.error && !h.page.data.targetServices.busy,
      'lost preference result and failed recovery read',
      h.page,
    );
    assert.equal(h.page.data.targetServices.visible, true);
    h.tap('onRefresh');
    await until(
      () =>
        h.page.data.loaded &&
        h.page.data.targetServices.regionName &&
        !h.page.data.targetServices.busy,
      'explicit refresh after uncertain preference',
      h.page,
    );
    assert.equal(h.page.data.targetServices.visible, false);
    close(h);
    h = await detail();
    const accountHold = read.holdNext();
    h.tap('onPreviewTargetQr');
    await accountHold.arrived;
    login('reader');
    accountHold.release();
    await read.idle();
    assert.equal(h.page.data.targetQr.src, '');
    assert.equal(h.page.data.targetServices.visible, false);
    close(h);
    h = await detail();
    // A late descriptor after page hide cannot download or redisplay a file.
    const descriptorHold = transport.holdNext(
      `/v3/media/school-configuration/errands/${input.orderId}/descriptor`,
    );
    h.tap('onPreviewTargetQr');
    await descriptorHold.arrived;
    h.page.onHide();
    descriptorHold.release();
    await delay(30);
    await read.idle();
    assert.equal(h.page.data.targetQr.src, '');
    assert.equal(h.page.data.targetServices.visible, false);
    close(h);
    admin = await manage();
    admin.event(
      'bindchange',
      'onField',
      { value: false },
      { field: 'enabled' },
    );
    await save(admin, 2);
    close(admin);
    h = await detail();
    assert.equal(h.page.data.targetServices.visible, true);
    assert.equal(h.page.data.targetServices.canPreview, false);
    assert.equal(h.button('bindtap', 'onPreviewTargetQr'), undefined);
    await rpc('verify-disabled');
    close(h);
    admin = await manage();
    admin.event('bindchange', 'onField', { value: true }, { field: 'enabled' });
    await selectQr(admin, input.replacement);
    await save(admin, 3);
    close(admin);
    h = await detail();
    const nextBytes = await preview(h);
    assert.notDeepEqual(nextBytes, bytes);
    await rpc('verify-replacement', { bytes: nextBytes.toString('base64') });
    close(h);
    await read.idle();
    assert.equal(await read.fileCount(), 0);
    // A delayed group projection after account replacement never revives the old card.
    login('publisher');
    const serviceHold = transport.holdNext(
      `/v1/school-services/errands/${input.orderId}`,
    );
    h = mount('errand-detail', { orderId: input.orderId });
    await serviceHold.arrived;
    login('reader');
    serviceHold.release();
    await delay(40);
    assert.equal(h.page.data.targetServices.visible, false);
    close(h);
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
    await upload?.dispose();
    await read?.dispose();
    process.disconnect();
  }
});
