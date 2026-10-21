/** Emitted App/Page/WXML only. Native chooser, HTTP and temporary filesystem are synthetic. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { mountEmittedPage } from '../../../wechat/test/text-review-emitted-harness.mjs';
const require = createRequire(import.meta.url),
  dist = fileURLToPath(new URL('../../../wechat/dist/', import.meta.url)),
  emitted = (n) => require(`${dist}${n}.js`);
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
  const answer = new Promise((r) => process.once('message', r));
  await send({ event: 'checkpoint', name, ...fields });
  const v = await answer;
  assert.equal(v.event, 'continue', JSON.stringify(v));
  assert.equal(v.name, name);
  return v;
}
async function until(check, label, page) {
  const end = Date.now() + 25000;
  while (!check()) {
    assert.ok(Date.now() < end, `${label}: ${JSON.stringify(page?.data)}`);
    await delay(10);
  }
}
function openMediaPanel(h) {
  if (h.page.data.uiPanel !== 'media')
    h.tap('onTogglePanel', { panel: 'media' });
  assert.equal(h.page.data.uiPanel, 'media');
}
function openConversationPanel(h) {
  if (h.page.data.uiPanel !== 'conversation')
    h.tap('onTogglePanel', { panel: 'conversation' });
  assert.equal(h.page.data.uiPanel, 'conversation');
}
function openRecoveryActions(h) {
  if (!h.page.data.uiActions) h.tap('onToggleActions');
  assert.equal(h.page.data.uiActions, true);
}
function openMessageMenu(h, id) {
  if (h.page.data.uiMessageMenu !== id)
    h.event('bindlongpress', 'onMessageMenu', {}, { id });
  assert.equal(h.page.data.uiMessageMenu, id);
}
process.once('message', async (input) => {
  let app,
    upload,
    read,
    loseSend = true,
    pickerPage;
  const observers = new Set();
  const pages = new Set();
  try {
    const transport = new NativeExperienceTransport(input.port),
      platform = platformStorage();
    upload = await NativeMediaUploadBridge.create(
      input.port,
      nativeOrigin,
      'private-messages',
    );
    read = await NativeMediaReadBridge.create(input.port, 'private-messages');
    const fsFor = (p) =>
      p.includes('native-upload-')
        ? upload.wx.getFileSystemManager()
        : read.wx.getFileSystemManager();
    const wx = {
      ...platform,
      ...upload.wx,
      nextTick: queueMicrotask,
      createIntersectionObserver: () => {
        const value = {
          callback: null,
          relativeToViewport() {
            return this;
          },
          observe(_selector, callback) {
            this.callback = callback;
            observers.add(this);
          },
          disconnect() {
            observers.delete(this);
            this.callback = null;
          },
        };
        return value;
      },
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
      chooseMedia: (o) => {
        assert.deepEqual(o.sourceType, ['album']);
        const selected = pickerPage;
        app.onHide();
        selected.page.onHide();
        upload.wx.chooseMedia({
          ...o,
          success: (v) => {
            o.success(v);
            app.onShow();
            selected.page.onShow();
          },
        });
      },
      request: (o) => {
        void (async () => {
          const path = new URL(o.url).pathname;
          if (
            o.method === 'POST' &&
            /\/conversations\/[^/]+\/images$/.test(path)
          )
            await rpc('review-image', {
              conversationId: input.conversationId,
              body: o.data,
            });
          const r = await transport.send({
            url: o.url,
            method: o.method,
            headers: o.header,
            body: o.data,
            timeoutMs: o.timeout,
          });
          if (r.status === 200 && path.endsWith('/finalize'))
            await rpc('process-image');
          if (
            r.status === 200 &&
            /\/conversations\/[^/]+\/images$/.test(path) &&
            loseSend
          ) {
            loseSend = false;
            o.fail({ errMsg: 'request:fail dropped committed image response' });
            return;
          }
          o.success({ statusCode: r.status, header: r.headers, data: r.body });
        })().catch((e) => o.fail({ errMsg: String(e) }));
        return { abort() {} };
      },
      navigateTo: (o) => o.success?.(),
    };
    emitted('config').clientConfiguration = Object.freeze({
      apiOrigin: nativeOrigin,
      providerLoginEnabled: true,
    });
    globalThis.wx = wx;
    globalThis.App = (v) => (app = v);
    globalThis.getApp = () => app;
    const boot = () => {
      delete require.cache[require.resolve(`${dist}app.js`)];
      emitted('app');
      app.onLaunch();
    };
    boot();
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
    const detail = async () => {
      const h = mount('private-message-detail', {
        conversationId: input.conversationId,
      });
      await until(
        () => h.page.data.loaded && !h.page.data.busy,
        'detail current',
        h.page,
      );
      return h;
    };
    login('sender');
    let h = await detail();
    assert.equal(h.page.data.canSend, true);
    pickerPage = h;
    upload.dropUploadResponse = true;
    await upload.select(Buffer.from(input.png, 'base64'), 'image/png', {
      width: 48,
      height: 48,
      type: 'png',
    });
    openMediaPanel(h);
    h.tap('onImageAlbum');
    await until(
      () => h.page.data.pending && !h.page.data.busy,
      'real native private upload pending',
      h.page,
    );
    await upload.idle();
    assert.equal(await upload.fileCount(), 0);
    close(h);
    let recovery = mount('private-message-recovery');
    assert.equal(recovery.page.data.pending, true);
    openRecoveryActions(recovery);
    recovery.tap('onRetry');
    await until(
      () => !recovery.page.data.busy,
      'recover uploaded original without file',
      recovery.page,
    );
    if (!recovery.page.data.error && recovery.page.data.pending) {
      openRecoveryActions(recovery);
      recovery.tap('onRetry');
    }
    await until(
      () => !recovery.page.data.busy && !!recovery.page.data.error,
      'dropped send response',
      recovery.page,
    );
    const original = app.community.messaging.images.pending.load(
      input.actors.sender.accountId,
    );
    assert.ok(original);
    await rpc('verify-one', { requestId: original.messageRequestId });
    close(recovery);
    app.onHide();
    boot();
    login('sender');
    assert.equal(
      app.community.messaging.pending.load(input.actors.sender.accountId)
        ?.intent,
      null,
      'OS restart does not retain image manifest or pixels',
    );
    recovery = mount('private-message-recovery');
    recovery.tap('onReceipt');
    await until(
      () => !recovery.page.data.pending && !recovery.page.data.busy,
      'same-key response recovery',
      recovery.page,
    );
    close(recovery);
    await rpc('verify-one', { requestId: original.messageRequestId });
    h = await detail();
    const message = h.page.data.messages.find((m) => m.state === 'image');
    assert.ok(message);
    assert.equal(message.text, null);
    h.tap('onShowImage', { id: message.id });
    await until(
      () => !!h.page.data.imagePath && !h.page.data.busy,
      'sender authenticated image',
      h.page,
    );
    assert.ok((await read.bytes(h.page.data.imagePath)).length > 0);
    close(h);
    await read.idle();
    assert.equal(await read.fileCount(), 0);
    login('peer');
    h = await detail();
    const late = read.holdNext();
    h.tap('onShowImage', { id: message.id });
    await late.arrived;
    login('stranger');
    assert.equal(h.page.data.imagePath, '');
    late.release();
    await read.idle();
    await until(
      () => !h.page.data.imagePath,
      'late bytes cannot revive another account',
      h.page,
    );
    close(h);
    await delay(100);
    assert.equal(await read.fileCount(), 0);
    login('peer');
    h = await detail();
    h.tap('onShowImage', { id: message.id });
    await until(
      () => !!h.page.data.imagePath && !h.page.data.busy,
      'peer authenticated image',
      h.page,
    );
    await rpc('deny-stranger-admin', {
      messageId: message.id,
      bindingId: message.image.bindingId,
    });
    // A rendered observation acknowledges only its watermark, not the later arrival.
    for (const observer of observers)
      observer.callback?.({ intersectionRatio: 1 });
    openConversationPanel(h);
    h.tap('onReload');
    await until(() => !h.page.data.busy, 'acknowledge observed image', h.page);
    await rpc('later-unread');
    close(h);
    login('sender');
    h = await detail();
    openMessageMenu(h, message.id);
    h.tap('onAction', { kind: 'recall', id: message.id });
    h.tap('onConfirm');
    await until(
      () =>
        !h.page.data.busy &&
        h.page.data.messages.find((m) => m.id === message.id)?.state ===
          'recalled',
      'recall image projection',
      h.page,
    );
    assert.equal(h.page.data.canReedit, false);
    close(h);
    login('peer');
    h = await detail();
    assert.equal(
      h.page.data.messages.find((m) => m.id === message.id)?.state,
      'recalled',
    );
    assert.equal(h.page.data.imagePath, '');
    await rpc('verify-retired', {
      messageId: message.id,
      bindingId: message.image.bindingId,
    });
    openConversationPanel(h);
    h.tap('onAction', { kind: 'hide' });
    h.tap('onConfirm');
    await until(
      () => !h.page.data.busy && h.page.data.conversation?.hidden,
      'hide watermark',
      h.page,
    );
    openConversationPanel(h);
    h.tap('onAction', { kind: 'reopen' });
    h.tap('onConfirm');
    await until(
      () => !h.page.data.busy && !h.page.data.conversation?.hidden,
      'reopen retained history',
      h.page,
    );
    assert.ok(h.page.data.messages.length);
    openConversationPanel(h);
    h.tap('onAction', { kind: 'block' });
    h.tap('onConfirm');
    await until(
      () => !h.page.data.busy && h.page.data.conversation?.blockedByYou,
      'block window',
      h.page,
    );
    await rpc('verify-block', { messageId: message.id });
    close(h);
    app.onHide();
    await upload.idle();
    await read.idle();
    assert.equal(await upload.fileCount(), 0);
    assert.equal(await read.fileCount(), 0);
    assert.ok(read.exchanges.filter((x) => x.status === 200).length >= 2);
    assert.ok(read.exchanges.every((x) => x.authorized));
    assert.equal(upload.exchanges.length, 1);
    await send({
      event: 'done',
      uploads: upload.exchanges.length,
      reads: read.exchanges.length,
    });
  } catch (error) {
    await send({ event: 'failure', message: error.stack ?? String(error) });
    process.exitCode = 1;
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
