/** Actual emitted App/Page/WXML and production v2 gateways against HTTP AppModule.
 * Only native platform/file IO and explicitly injected network loss are synthetic.
 * Run `publish`, then a separate `recover` subprocess with its metadata-only journal. */
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
async function checkpoint(name, fields = {}) {
  const answer = new Promise((resolve) => process.once('message', resolve));
  await send({ event: 'checkpoint', name, ...fields });
  const value = await answer;
  assert.equal(value.event, 'continue', JSON.stringify(value));
  assert.equal(value.name, name);
  return value;
}
async function until(check, label, h) {
  const deadline = Date.now() + 30000;
  while (!check()) {
    assert.ok(
      Date.now() < deadline,
      `${label}: ${JSON.stringify(h?.page.data)}`,
    );
    await delay(10);
  }
}
process.once('message', async (input) => {
  let app,
    upload,
    read,
    pickerPage,
    currentActor = input.actor,
    losePrepare = false;
  const pages = new Set(),
    commands = [],
    requests = [];
  try {
    assert.ok(['legacy', 'publish', 'recover'].includes(input.mode));
    assert.equal(input.imageInfo?.type, 'png');
    assert.ok(
      Number.isSafeInteger(input.imageInfo.width) && input.imageInfo.width > 0,
    );
    assert.ok(
      Number.isSafeInteger(input.imageInfo.height) &&
        input.imageInfo.height > 0,
    );
    const transport = new NativeExperienceTransport(input.port),
      platform = platformStorage();
    for (const [key, value] of input.journal ?? []) {
      assert.match(key, /^whaleu\.window-discussion\.pending\.v2:/);
      platform.setStorageSync(key, value);
    }
    for (const [key, value] of input.legacyJournal ?? []) {
      assert.match(key, /^whaleu\.window-discussion\.pending\.v1:/);
      platform.setStorageSync(key, value);
    }
    upload = await NativeMediaUploadBridge.create(
      input.port,
      nativeOrigin,
      'window-discussions',
    );
    read = await NativeMediaReadBridge.create(input.port, 'window-discussions');
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
          ['getFileInfo', 'readFile', 'unlink'].map((name) => [
            name,
            (options) => fsFor(options.filePath)[name](options),
          ]),
        ),
      getImageInfo: (options) =>
        (options.src.includes('native-upload-')
          ? upload.wx
          : read.wx
        ).getImageInfo(options),
      downloadFile: (options) => read.wx.downloadFile(options),
      chooseMedia: (options) => {
        assert.deepEqual(options.sourceType, ['album']);
        const h = pickerPage;
        assert.ok(h);
        app.onHide();
        h.page.onHide();
        upload.wx.chooseMedia({
          ...options,
          success: (value) => {
            options.success(value);
            app.onShow();
            h.page.onShow();
          },
        });
      },
      navigateTo: (options) => options.success?.(),
      request: (options) => {
        const path = new URL(options.url).pathname;
        requests.push({ path, method: options.method });
        const publication =
          options.method === 'POST' &&
          /^\/v[12]\/ratings\/windows\//.test(path) &&
          (/\/discussion$/.test(path) || /\/replies$/.test(path));
        if (publication)
          commands.push({
            actorId: currentActor.accountId,
            path,
            command: structuredClone(options.data),
          });
        void (async () => {
          if (publication)
            await checkpoint(path.startsWith('/v1/') ? 'review-v1' : 'review', {
              actorId: currentActor.accountId,
              windowId: input.windowId,
              rootId: path.endsWith('/replies') ? path.split('/')[6] : null,
              command: options.data,
            });
          const response = await transport.send({
            url: options.url,
            method: options.method,
            headers: options.header,
            body: options.data,
            timeoutMs: options.timeout,
          });
          if (response.status === 200 && path.endsWith('/finalize'))
            await checkpoint('process-images');
          if (
            response.status === 200 &&
            path === '/v3/media/window-discussions/upload-intents' &&
            losePrepare
          ) {
            losePrepare = false;
            options.fail({
              errMsg: 'request:fail synthetic committed prepare response loss',
            });
            return;
          }
          options.success({
            statusCode: response.status,
            header: response.headers,
            data: response.body,
          });
        })().catch((error) => options.fail({ errMsg: String(error) }));
        return { abort() {} };
      },
    };
    emitted('config').clientConfiguration = Object.freeze({
      apiOrigin: nativeOrigin,
      providerLoginEnabled: true,
    });
    globalThis.wx = wx;
    globalThis.App = (value) => (app = value);
    globalThis.getApp = () => app;
    function boot() {
      delete require.cache[require.resolve(`${dist}app.js`)];
      emitted('app');
      app.onLaunch();
    }
    function login(actor) {
      currentActor = actor;
      app.identity.sessions.completeLogin(
        app.identity.sessions.beginLogin(),
        actor,
      );
    }
    function mount(
      name = 'window-discussion',
      query = { windowId: input.windowId },
    ) {
      const h = mountEmittedPage(name, app, wx);
      pages.add(h);
      h.page.onLoad?.(query);
      h.page.onShow?.();
      return h;
    }
    function close(h) {
      h.page.onUnload?.();
      pages.delete(h);
    }
    const loaded = (h) =>
      until(
        () => h.page.data.loaded && !h.page.data.busy,
        'current v2 discussion',
        h,
      );
    const idle = (h) =>
      until(
        () => !h.page.data.busy && !h.page.data.imageBusy,
        'native operation idle',
        h,
      );
    async function pick(h, number = 1, loss = false) {
      const before = h.page.data.imageCount;
      pickerPage = h;
      losePrepare = loss;
      for (let n = 0; n < number; n++) {
        await upload.select(
          Buffer.from(input.png, 'base64'),
          'image/png',
          input.imageInfo,
        );
        h.tap('onPickImage', { source: 'album' });
        await until(
          () =>
            !h.page.data.imageBusy &&
            (loss
              ? h.page.data.imageFrozen
              : h.page.data.imageCount === before + n + 1),
          'ordered native image upload',
          h,
        );
        await upload.idle();
        await until(
          () => upload.removed.length >= upload.exchanges.length,
          'quiet picker cleanup',
          h,
        );
      }
    }
    async function publish(h, body = '', loss = false) {
      if (body) h.event('bindinput', 'onBody', { value: body });
      assert.equal(h.page.data.canPublish, true);
      h.tap('onConfirmPublish');
      assert.equal(h.page.data.confirming, 'publish');
      if (loss)
        transport.dropSuccess = {
          path: `/v2/ratings/windows/${input.windowId}/discussion`,
          method: 'POST',
        };
      h.tap('onSubmit');
      h.page.onSubmit();
      await until(
        () =>
          !h.page.data.imageBusy &&
          !h.page.data.busy &&
          (loss ? h.page.data.imageFrozen : !h.page.data.imagePending),
        'published or recoverable original key',
        h,
      );
    }
    boot();
    login(input.actor);
    if (input.mode === 'legacy') {
      // This subprocess runs the real emitted legacy Page/gateway/store path.
      // The following publish subprocess boots the untouched default App.
      delete app.community.windowDiscussionV2;
      delete app.community.windowDiscussionImages;
      const h = mount();
      await loaded(h);
      const body =
        '  Legacy W3 exact Unicode 😀\nold journal stays unchanged  ';
      h.event('bindinput', 'onBody', { value: body });
      h.tap('onConfirmPublish');
      transport.dropSuccess = {
        path: `/v1/ratings/windows/${input.windowId}/discussion`,
        method: 'POST',
      };
      h.tap('onSubmit');
      await until(
        () => h.page.data.frozen && !h.page.data.busy,
        'legacy committed response loss',
        h,
      );
      const pending = app.community.pendingWindowDiscussion.load(
        input.actor.accountId,
      );
      assert.ok(pending);
      assert.equal(pending.intent.command.body, body);
      assert.equal(pending.intent.operation, 'window.discussion.root.v1');
      const legacyJournal = [...platform.storage.values.entries()].filter(
        ([key]) => key.startsWith('whaleu.window-discussion.pending.v1:'),
      );
      await checkpoint('verify-legacy', {
        requestId: pending.intent.command.clientRequestId,
      });
      close(h);
      await send({
        event: 'done',
        mode: input.mode,
        legacyJournal,
        legacyRequestId: pending.intent.command.clientRequestId,
      });
      return;
    }
    if (input.mode === 'publish' && input.legacyJournal?.length) {
      const old = mount('window-discussion-recovery', {});
      await idle(old);
      assert.equal(
        old.page.data.imageEnabled,
        true,
        'Unmodified default upgraded App owns this recovery',
      );
      assert.equal(old.page.data.frozen, true);
      const original = app.community.pendingWindowDiscussion.load(
        input.actor.accountId,
      );
      assert.equal(
        original.intent.command.clientRequestId,
        input.legacyRequestId,
      );
      assert.equal(
        app.community.windowDiscussionImages.pending.load(
          input.actor.accountId,
        ),
        null,
      );
      old.tap('onRecover');
      await until(
        () => !old.page.data.frozen && !old.page.data.busy,
        'default App recovered original legacy key',
        old,
      );
      assert.equal(
        commands.length,
        0,
        'Legacy receipt recovery creates no replacement command',
      );
      assert.ok(
        requests.some(
          (value) =>
            value.path ===
              `/v1/ratings/windows/discussion-requests/${input.legacyRequestId}` &&
            value.method === 'GET',
        ),
      );
      assert.equal(
        app.community.pendingWindowDiscussion.load(input.actor.accountId),
        null,
      );
      await checkpoint('verify-legacy', { requestId: input.legacyRequestId });
      close(old);
    }
    if (input.mode === 'publish') {
      const h = mount();
      await loaded(h);
      assert.equal(h.page.data.imageEnabled, true);
      await pick(h, 3);
      assert.equal(h.page.data.imageCount, 3);
      await publish(h, '', true);
      const pending = app.community.windowDiscussionImages.pending.load(
        input.actor.accountId,
      );
      assert.ok(pending);
      assert.equal(pending.phase, 'submit');
      assert.equal(pending.uploadRecoveryKeys.length, 3);
      assert.equal(commands.length, 1);
      assert.equal(commands[0].command.body, '');
      assert.equal(commands[0].command.images.length, 3);
      const journal = [...platform.storage.values.entries()].filter(([key]) =>
        key.startsWith('whaleu.window-discussion.pending.v2:'),
      );
      const serialized = JSON.stringify(journal);
      for (const disallowed of [
        'wxfile:',
        'accessToken',
        'refreshToken',
        'manifestDigest',
        '"body"',
        'image/png',
      ])
        assert.equal(serialized.includes(disallowed), false);
      await checkpoint('verify-root', {
        requestId: pending.target.clientRequestId,
      });
      close(h);
      app.onHide();
      await upload.idle();
      await until(
        () => upload.removed.length === 3,
        'all three input files revoked',
      );
      assert.equal(await upload.fileCount(), 0);
      await send({
        event: 'done',
        mode: input.mode,
        requestId: pending.target.clientRequestId,
        journal,
        uploads: upload.exchanges.length,
        reads: read.exchanges.length,
      });
      return;
    }
    let h = mount('window-discussion-recovery', {});
    await idle(h);
    assert.equal(h.page.data.imagePending, true);
    assert.equal(h.page.data.imageFrozen, true);
    h.tap('onRecoverImages');
    await until(
      () => !h.page.data.imagePending && !h.page.data.imageBusy,
      'cold subprocess original receipt',
      h,
    );
    assert.equal(commands.length, 0);
    await checkpoint('verify-root', { requestId: input.requestId });
    close(h);
    h = mount();
    await loaded(h);
    const root = h.page.data.items.find(
      (value) => value.body === '' && value.images.length === 3,
    );
    assert.ok(root);
    const rootId = root.id;
    h.tap('onImage', { id: rootId, index: 0 });
    await until(
      () => !!h.page.data.gallerySrc,
      'controlled first root image',
      h,
    );
    assert.ok((await read.bytes(h.page.data.gallerySrc)).length > 0);
    assert.ok(
      h
        .nodes()
        .some(
          (node) =>
            typeof node !== 'string' &&
            node.tag === 'image' &&
            node.attrs.src === h.page.data.gallerySrc,
        ),
    );
    h.tap('onImageNext');
    await until(
      () => h.page.data.galleryIndex === 1 && !!h.page.data.gallerySrc,
      'ordered gallery second image',
      h,
    );
    h.tap('onCloseGallery');
    assert.equal(h.page.data.gallerySrc, '');
    close(h);
    login(input.other);
    h = mount('window-discussion-thread', { windowId: input.windowId, rootId });
    await loaded(h);
    await pick(h);
    await publish(h);
    await loaded(h);
    const reply = h.page.data.items.find(
      (value) => value.body === '' && value.images.length === 1,
    );
    assert.ok(reply);
    const replyId = reply.id;
    close(h);
    login(input.actor);
    h = mount('window-discussion-notices', {});
    await loaded(h);
    const replyNotice = h.page.data.items.find(
      (value) =>
        value.status === 'available' &&
        value.kind === 'reply' &&
        value.preview.thumbnail?.commentId === replyId,
    );
    assert.ok(replyNotice);
    assert.equal(replyNotice.preview.thumbnail.ordinal, 0);
    h.tap('onNoticeImage', { id: replyNotice.noticeId });
    await until(
      () => !!h.page.data.gallerySrc,
      'causal reply first image notice',
      h,
    );
    h.tap('onCloseGallery');
    close(h);
    h = mount('window-discussion-thread', { windowId: input.windowId, rootId });
    await loaded(h);
    h.tap('onLike', { id: replyId });
    h.tap('onSubmit');
    await until(
      () => !h.page.data.busy && !h.page.data.frozen,
      'unchanged v1 reversible like',
      h,
    );
    close(h);
    login(input.other);
    h = mount('window-discussion-notices', {});
    await loaded(h);
    const like = h.page.data.items.find(
      (value) =>
        value.status === 'available' &&
        value.kind === 'like' &&
        value.target.commentId === replyId,
    );
    assert.ok(like);
    assert.equal(like.preview.thumbnail, null);
    close(h);
    login(input.actor);
    h = mount();
    await loaded(h);
    await pick(h, 1, true);
    const unfinished = app.community.windowDiscussionImages.pending.load(
      input.actor.accountId,
    );
    assert.ok(unfinished);
    assert.equal(unfinished.phase, 'draft');
    close(h);
    h = mount('window-discussion-recovery', {});
    await idle(h);
    const before = commands.length;
    h.tap('onRecoverImages');
    await idle(h);
    assert.equal(h.page.data.imagePending, true);
    assert.equal(
      commands.length,
      before,
      'not_recorded must never replace original publication',
    );
    h.tap('onRequestImageCancel');
    h.tap('onConfirmImageCancel');
    await until(
      () => !h.page.data.imagePending && !h.page.data.imageBusy,
      'publication fence and original upload cancellation',
      h,
    );
    await checkpoint('verify-cancel', {
      requestId: unfinished.target.clientRequestId,
      uploadKeys: unfinished.uploadRecoveryKeys,
    });
    close(h);
    // A late authenticated download cannot reinstall an image after a same-account login epoch.
    h = mount();
    await loaded(h);
    const hold = read.holdNext();
    h.tap('onImage', { id: rootId, index: 0 });
    await hold.arrived;
    login(input.actor);
    assert.equal(h.page.data.gallerySrc, '');
    hold.release();
    await read.idle();
    await delay(30);
    assert.equal(h.page.data.gallerySrc, '');
    close(h);
    app.onHide();
    await upload.idle();
    await read.idle();
    await until(
      () => read.removed.length === read.generated.length,
      'all native download files revoked',
    );
    assert.equal(await upload.fileCount(), 0);
    assert.equal(await read.fileCount(), 0);
    assert.ok(upload.exchanges.every((value) => value.authorized));
    assert.ok(read.exchanges.every((value) => value.authorized));
    await send({
      event: 'done',
      mode: input.mode,
      rootId,
      replyId,
      requestId: input.requestId,
      cancelledRequestId: unfinished.target.clientRequestId,
      uploads: upload.exchanges.length,
      reads: read.exchanges.length,
      nativeCommands: commands.length,
      receiptReads: requests.filter(
        (value) =>
          value.method === 'GET' &&
          value.path.includes('/discussion-requests/'),
      ).length,
    });
  } catch (error) {
    await send({ event: 'failure', message: error.stack ?? String(error) });
    process.exitCode = 1;
  } finally {
    for (const h of pages) h.page.onUnload?.();
    app?.onHide?.();
    await upload?.dispose();
    await read?.dispose();
    process.disconnect?.();
  }
});
