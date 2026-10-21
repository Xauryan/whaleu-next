/** Actual emitted App/Page/WXML with simulated native callbacks, no mocked business owner. */
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
const send = (v) =>
  new Promise((resolve, reject) =>
    process.send(v, (e) => (e ? reject(e) : resolve())),
  );
async function rpc(name, fields = {}) {
  const next = new Promise((r) => process.once('message', r));
  await send({ event: 'checkpoint', name, ...fields });
  assert.deepEqual(await next, { event: 'continue', name });
}
async function until(check, label, page) {
  const end = Date.now() + 25000;
  while (!check()) {
    assert.ok(Date.now() < end, `${label}: ${JSON.stringify(page?.data)}`);
    await delay(10);
  }
}
// Disclosures are actual native presses, never injected presentation state.
function openComposePanel(h, field) {
  if (!h.page.data.uiPanels[field]) h.tap('onTogglePanel', { field });
  assert.equal(h.page.data.uiPanels[field], true);
}
process.once('message', async (input) => {
  let app,
    upload,
    read,
    losePublish = false,
    losePrepare = false,
    dropDraft = false,
    lostDraftId;
  const pages = new Set();
  try {
    const transport = new NativeExperienceTransport(input.port),
      platform = platformStorage();
    upload = await NativeMediaUploadBridge.create(
      input.port,
      nativeOrigin,
      'errands',
    );
    read = await NativeMediaReadBridge.create(input.port, 'errands');
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
        if (dropDraft && new URL(o.url).pathname === '/v2/errand-drafts') {
          dropDraft = false;
          lostDraftId = o.data.draftId;
          queueMicrotask(() =>
            o.fail({ errMsg: 'request:fail synthetic before draft arrival' }),
          );
          return { abort() {} };
        }
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
              const path = new URL(o.url).pathname;
              if (
                r.status === 200 &&
                path === '/v3/media/errands/upload-intents' &&
                losePrepare
              ) {
                losePrepare = false;
                o.fail({
                  errMsg:
                    'request:fail synthetic lost original prepare response',
                });
                return;
              }
              if (r.status === 200 && path.endsWith('/finalize'))
                await rpc('process-images');
              if (
                r.status === 200 &&
                path === '/v2/errand-publications/prepare'
              )
                await rpc('review-exact', { requestId: r.body.requestId });
              if (
                r.status === 200 &&
                /\/v2\/errand-publications\/[^/]+\/publish$/.test(path) &&
                losePublish
              ) {
                losePublish = false;
                o.fail({
                  errMsg:
                    'request:fail synthetic lost original publish response',
                });
                return;
              }
              o.success({
                statusCode: r.status,
                header: r.headers,
                data: r.body,
              });
            },
            () => o.fail({ errMsg: 'request:fail synthetic loopback' }),
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
    globalThis.App = (v) => (app = v);
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
    const tap = (h) => h.tap.bind(h);
    const pick = async (h, slot, loss) => {
      openComposePanel(h, 'images');
      losePrepare = loss === 'prepare';
      upload.dropUploadResponse = loss === 'upload';
      await upload.select(Buffer.from(input.png, 'base64'), 'image/png', {
        width: 48,
        height: 48,
        type: 'png',
      });
      tap(h)('onChooseOrderImage', { value: slot });
      if (loss) {
        await until(
          () =>
            !h.page.data.imagePublication.busy &&
            !!h.page.data.imagePublication.message &&
            !h.page.data.imagePublication.images.find((x) => x.slot === slot)
              ?.ready,
          'original upload response loss',
          h.page,
        );
        await upload.idle();
        if (loss === 'prepare')
          await upload.select(Buffer.from(input.png, 'base64'), 'image/png', {
            width: 48,
            height: 48,
            type: 'png',
          });
        tap(h)('onRecoverOrderImage', { value: slot });
      }
      await until(
        () =>
          h.page.data.imagePublication.images.find((x) => x.slot === slot)
            ?.ready && !h.page.data.imagePublication.busy,
        'chooser→multipart→processed',
        h.page,
      );
      await upload.idle();
    };
    login('publisherFence');
    let pendingDraft = mount('errand-compose', { regionId: input.regionId });
    await until(
      () => pendingDraft.page.data.loaded && !pendingDraft.page.data.busy,
      'initial draft page',
      pendingDraft.page,
    );
    dropDraft = true;
    openComposePanel(pendingDraft, 'images');
    tap(pendingDraft)('onChooseOrderImage', { value: 'public0' });
    await until(
      () =>
        !!lostDraftId &&
        !pendingDraft.page.data.imagePublication.busy &&
        pendingDraft.page.data.imagePublication.hasDraft,
      'lost before draft creation',
      pendingDraft.page,
    );
    await rpc('lose-draft-scope', { draftId: lostDraftId });
    tap(pendingDraft)('onCancelImageDraft');
    await until(
      () =>
        !pendingDraft.page.data.imagePublication.busy &&
        !pendingDraft.page.data.imagePublication.hasDraft,
      'durable absent-draft cancellation',
      pendingDraft.page,
    );
    await rpc('restore-draft-scope', { draftId: lostDraftId });
    close(pendingDraft);
    pendingDraft = mount('errand-compose', { regionId: input.relatedRegionId });
    await until(
      () => pendingDraft.page.data.loaded && !pendingDraft.page.data.busy,
      'new explicit target',
      pendingDraft.page,
    );
    openComposePanel(pendingDraft, 'images');
    tap(pendingDraft)('onChooseOrderImage', { value: 'public0' });
    await until(
      () =>
        !pendingDraft.page.data.imagePublication.busy &&
        pendingDraft.page.data.imagePublication.hasDraft,
      'new target draft after original cancellation',
      pendingDraft.page,
    );
    await rpc('verify-new-draft-target');
    tap(pendingDraft)('onCancelImageDraft');
    await until(
      () => !pendingDraft.page.data.imagePublication.hasDraft,
      'close new target draft',
      pendingDraft.page,
    );
    close(pendingDraft);
    const orders = [];
    for (const count of [0, 1, 3]) {
      login(`publisher${count}`);
      let h = mount('errand-compose', { regionId: input.regionId });
      await until(
        () => h.page.data.loaded && !h.page.data.busy,
        'compose loaded',
        h.page,
      );
      openComposePanel(h, 'private');
      for (const [field, value] of Object.entries({
        title: `Native ${count} image errand`,
        publicText: 'Synthetic public instructions',
        privateText: 'Synthetic private instructions',
        expectedTimeText: 'Today',
        reward: '12.50',
        wechat: 'synthetic_contact',
        phone: '12345678901',
      }))
        h.event('bindinput', 'onForm', { value }, { field });
      if (count === 0) {
        await pick(h, 'public0');
        tap(h)('onRemoveOrderImage', { value: 'public0' });
        await until(
          () =>
            !h.page.data.imagePublication.busy &&
            !h.page.data.imagePublication.images[0].ready,
          'zero images after exact removal',
          h.page,
        );
      }
      for (const audience of ['public', 'private'])
        for (let i = 0; i < count; i++)
          await pick(
            h,
            audience + i,
            count === 1
              ? audience === 'public'
                ? 'prepare'
                : 'upload'
              : undefined,
          );
      if (count === 1) await pick(h, 'public0');
      assert.equal(
        h.page.data.imagePublication.images.filter((x) => x.ready).length,
        count * 2,
      );
      losePublish = count === 3;
      tap(h)('onPublish');
      if (count === 3) {
        await until(
          () =>
            h.page.data.imagePublication.frozen &&
            !h.page.data.imagePublication.busy &&
            h.page.data.imagePublication.message,
          'lost original publish response',
          h.page,
        );
        close(h);
        h = mount('errand-compose', { regionId: input.regionId });
        await until(
          () => h.page.data.loaded && !h.page.data.busy,
          'native restart',
          h.page,
        );
        assert.equal(h.page.data.imagePublication.frozen, true);
        tap(h)('onRecoverImagePublication');
      }
      await until(
        () => !!h.page.data.imagePublication.confirmedOrderId,
        'original exact published result',
        h.page,
      );
      const orderId = h.page.data.imagePublication.confirmedOrderId;
      orders.push(orderId);
      await rpc('verify-publication', { orderId, count });
      close(h);
      h = mount('errand-detail', { orderId });
      await until(() => h.page.data.loaded, 'publisher current detail', h.page);
      assert.equal(h.page.data.detail.publicMedia.length, count);
      assert.equal(h.page.data.detail.privateMedia.length, count);
      if (count) {
        tap(h)('onPreviewOrderImage', { value: 'private0' });
        await until(
          () => h.page.data.orderImage.status === 'ready',
          'private inline file',
          h.page,
        );
        assert.ok(
          h
            .nodes()
            .some(
              (n) =>
                typeof n !== 'string' &&
                n.tag === 'image' &&
                n.attrs.src === h.page.data.orderImage.src,
            ),
        );
        await rpc('verify-bytes', {
          orderId,
          bytes: (await read.bytes(h.page.data.orderImage.src)).toString(
            'base64',
          ),
        });
        app.onHide();
        assert.equal(h.page.data.orderImage.src, '');
        await read.idle();
        assert.equal(await read.fileCount(), 0);
        h.page.onShow();
        await until(() => h.page.data.loaded, 'after hide', h.page);
        const held = read.holdNext();
        tap(h)('onPreviewOrderImage', { value: 'private0' });
        await held.arrived;
        login('stranger');
        held.release();
        await read.idle();
        assert.equal(h.page.data.orderImage.src, '');
      }
      close(h);
      login('stranger');
      h = mount('errand-detail', { orderId });
      await until(() => h.page.data.loaded, 'stranger public detail', h.page);
      assert.equal('privateMedia' in h.page.data.detail, false);
      assert.equal('privateText' in h.page.data.detail, false);
      assert.equal(
        h
          .nodes()
          .some(
            (n) =>
              typeof n !== 'string' && n.attrs?.['data-value'] === 'private0',
          ),
        false,
      );
      close(h);
    }
    login('publisher3');
    let h = mount('errand-detail', { orderId: orders[2] });
    await until(
      () => h.page.data.loaded,
      'participant history before accept',
      h.page,
    );
    close(h);
    await rpc('accept-complete', { orderId: orders[2] });
    login('runner');
    h = mount('errand-detail', { orderId: orders[2] });
    await until(() => h.page.data.loaded, 'completed stored accepter', h.page);
    assert.equal(h.page.data.detail.state, 'completed');
    assert.equal(h.page.data.detail.privateMedia.length, 3);
    assert.equal('oppositeContact' in h.page.data.detail, false);
    tap(h)('onPreviewOrderImage', { value: 'private2' });
    await until(
      () => h.page.data.orderImage.status === 'ready',
      'completed private bytes',
      h.page,
    );
    close(h);
    await read.idle();
    assert.equal(await read.fileCount(), 0);
    await send({
      event: 'done',
      uploads: upload.exchanges.length,
      reads: read.exchanges.length,
      orders,
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
