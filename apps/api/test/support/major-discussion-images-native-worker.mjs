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
// Follow the visible disclosure before interacting with the original controls.
function openComposer(h) {
  if (h.page.data.uiPanel !== 'compose')
    h.tap('onTogglePanel', { panel: 'compose' });
  assert.equal(h.page.data.uiPanel, 'compose');
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
    assert.ok(
      ['legacy', 'publish', 'recover', 'withdraw'].includes(input.mode),
    );
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
      assert.match(key, /^whaleu\.major-discussion\.pending\.v2:/);
      platform.setStorageSync(key, value);
    }
    for (const [key, value] of input.legacyJournal ?? []) {
      assert.match(key, /^whaleu\.major-discussion\.pending\.v1:/);
      platform.setStorageSync(key, value);
    }
    for (const [key, value] of input.ownerJournal ?? []) {
      assert.match(
        key,
        /^whaleu\.major-discussion\.own-deletion-locators\.v1:/,
      );
      platform.setStorageSync(key, value);
    }
    upload = await NativeMediaUploadBridge.create(
      input.port,
      nativeOrigin,
      'major-discussions',
    );
    read = await NativeMediaReadBridge.create(input.port, 'major-discussions');
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
          /^\/v[12]\/majors\//.test(path) &&
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
              majorId: input.majorId,
              rootId: path.endsWith('/replies') ? path.split('/')[5] : null,
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
            path === '/v3/media/major-discussions/upload-intents' &&
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
      name = 'major-discussion',
      query = { majorId: input.majorId },
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
      openComposer(h);
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
    async function publish(h, body = ' Reply text 😀 ', loss = false) {
      openComposer(h);
      if (body) h.event('bindinput', 'onBody', { value: body });
      assert.equal(h.page.data.canPublish, true);
      h.tap('onConfirmPublish');
      assert.equal(h.page.data.confirming, 'publish');
      if (loss)
        transport.dropSuccess = {
          path: `/v2/majors/${input.majorId}/discussion`,
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
    if (input.mode === 'withdraw') {
      const h = mount('major-discussion-recovery', {});
      await idle(h);
      assert.equal(h.page.data.loaded, false);
      assert.ok(
        h.page.data.deletionLocators.some(
          (value) => value.commentId === input.rootId,
        ),
      );
      h.tap('onOwnDelete', { id: input.rootId });
      await until(
        () => h.page.data.confirming === 'delete' && !h.page.data.busy,
        'same-owner first v2 withdrawal capability',
        h,
      );
      h.tap('onSubmit');
      await until(
        () =>
          !!h.page.data.receiptStatus &&
          !h.page.data.busy &&
          !h.page.data.frozen,
        'v2 content withdrawn with signed v1 delete protocol',
        h,
      );
      assert.match(h.page.data.receiptStatus, /历史回执/);
      assert.equal(
        h.page.data.deletionLocators.some(
          (value) => value.commentId === input.rootId,
        ),
        false,
      );
      assert.equal(
        requests.filter(
          (value) => value.method === 'POST' && value.path.endsWith('/delete'),
        ).length,
        1,
      );
      assert.equal(
        requests.some((value) => value.path.startsWith('/v2/')),
        false,
        'Owner locator deletion needs no public source snapshot',
      );
      await checkpoint('verify-withdraw', { rootId: input.rootId });
      close(h);
      await send({
        event: 'done',
        mode: input.mode,
        rootId: input.rootId,
        deleted: true,
      });
      return;
    }
    if (input.mode === 'legacy') {
      // This subprocess runs the real emitted legacy Page/gateway/store path.
      // The following publish subprocess boots the untouched default App.
      delete app.community.majorDiscussionV2;
      delete app.community.majorDiscussionImages;
      const h = mount();
      await loaded(h);
      const body =
        '  Legacy Major exact Unicode 😀\nold journal stays unchanged  ';
      openComposer(h);
      h.event('bindinput', 'onBody', { value: body });
      h.tap('onConfirmPublish');
      transport.dropSuccess = {
        path: `/v1/majors/${input.majorId}/discussion`,
        method: 'POST',
      };
      h.tap('onSubmit');
      await until(
        () => h.page.data.frozen && !h.page.data.busy,
        'legacy committed response loss',
        h,
      );
      const pending = app.community.pendingMajorDiscussion.load(
        input.actor.accountId,
      );
      assert.ok(pending);
      assert.equal(pending.intent.command.body, body);
      assert.equal(pending.intent.operation, 'major.discussion.root.v1');
      const legacyJournal = [...platform.storage.values.entries()].filter(
        ([key]) => key.startsWith('whaleu.major-discussion.pending.v1:'),
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
      const corruptV2Key = `whaleu.major-discussion.pending.v2:${nativeOrigin}:${input.actor.accountId}`;
      const corruptLocatorKey = `whaleu.major-discussion.own-deletion-locators.v1:${nativeOrigin}:${input.actor.accountId}`;
      const corruptV2 = { invalid: 'new metadata journal' };
      const corruptLocator = [{ invalid: 'optional owner locator' }];
      platform.setStorageSync(corruptV2Key, corruptV2);
      platform.setStorageSync(corruptLocatorKey, corruptLocator);
      const old = mount('major-discussion-recovery', {});
      await idle(old);
      assert.equal(
        old.page.data.imageEnabled,
        true,
        'Unmodified default upgraded App owns this recovery',
      );
      assert.equal(old.page.data.frozen, true);
      const original = app.community.pendingMajorDiscussion.load(
        input.actor.accountId,
      );
      assert.equal(
        original.intent.command.clientRequestId,
        input.legacyRequestId,
      );
      assert.equal(old.page.data.imageRecoverable, false);
      assert.deepEqual(platform.getStorageSync(corruptV2Key), corruptV2);
      old.tap('onRecover');
      await until(
        () => !!old.page.data.receiptStatus && !old.page.data.busy,
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
              `/v1/majors/discussion-requests/${input.legacyRequestId}` &&
            value.method === 'GET',
        ),
      );
      assert.equal(
        app.community.pendingMajorDiscussion.load(input.actor.accountId),
        null,
      );
      assert.match(old.page.data.receiptStatus, /历史回执/);
      assert.deepEqual(platform.getStorageSync(corruptV2Key), corruptV2);
      assert.deepEqual(
        platform.getStorageSync(corruptLocatorKey),
        corruptLocator,
      );
      assert.equal(
        old.page.data.frozen,
        true,
        'Corrupt cache blocks new admission, never the original receipt',
      );
      const attempts = upload.exchanges.length;
      old.page.onPickImage({ currentTarget: { dataset: { source: 'album' } } });
      await delay(20);
      assert.equal(upload.exchanges.length, attempts);
      await checkpoint('verify-legacy', { requestId: input.legacyRequestId });
      close(old);
      // Explicit fixture repair, outside the product flow. Verify the product
      // retained corrupt bytes above; then reboot a fresh default App to proceed.
      platform.removeStorageSync(corruptV2Key);
      platform.removeStorageSync(corruptLocatorKey);
      boot();
      login(input.actor);
    }
    if (input.mode === 'publish') {
      const h = mount();
      await loaded(h);
      assert.equal(h.page.data.imageEnabled, true);
      await pick(h, 3);
      assert.equal(h.page.data.imageCount, 3);
      await publish(h, ' Root text 😀 ', true);
      const pending = app.community.majorDiscussionImages.pending.load(
        input.actor.accountId,
      );
      assert.ok(pending);
      assert.equal(pending.phase, 'submit');
      assert.equal(pending.uploadRecoveryKeys.length, 3);
      assert.equal(commands.length, 1);
      assert.equal(commands[0].command.body, ' Root text 😀 ');
      assert.equal(commands[0].command.images.length, 3);
      const journal = [...platform.storage.values.entries()].filter(([key]) =>
        key.startsWith('whaleu.major-discussion.pending.v2:'),
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
    let h = mount('major-discussion-recovery', {});
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
      (value) => value.body === ' Root text 😀 ' && value.images.length === 3,
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
    h = mount('major-discussion-thread', { majorId: input.majorId, rootId });
    await loaded(h);
    await pick(h);
    await publish(h);
    await loaded(h);
    const reply = h.page.data.items.find(
      (value) => value.body === ' Reply text 😀 ' && value.images.length === 1,
    );
    assert.ok(reply);
    const replyId = reply.id;
    close(h);
    login(input.actor);
    h = mount('major-discussion-notices', {});
    await loaded(h);
    const replyNotice = h.page.data.items.find(
      (value) =>
        value.status === 'available' &&
        value.kind === 'reply' &&
        value.preview.thumbnail?.commentId === replyId,
    );
    assert.ok(replyNotice);
    assert.equal(replyNotice.preview.thumbnail.ordinal, 0);
    assert.equal(
      replyNotice.target.commentId,
      rootId,
      'Root-author navigation remains root while preview belongs to causal reply',
    );
    h.tap('onNoticeImage', { id: replyNotice.noticeId });
    await until(
      () => !!h.page.data.gallerySrc,
      'causal reply first image notice',
      h,
    );
    h.tap('onCloseGallery');
    close(h);
    h = mount('major-discussion-thread', { majorId: input.majorId, rootId });
    await loaded(h);
    h.tap('onReply', { id: replyId });
    await pick(h);
    await publish(h, ' Addressed reply text ');
    await loaded(h);
    const addressed = h.page.data.items.find(
      (value) => value.body === ' Addressed reply text ',
    );
    assert.ok(addressed);
    assert.equal(addressed.replyToReplyId, replyId);
    const addressedId = addressed.id;
    h.tap('onLike', { id: replyId });
    h.tap('onSubmit');
    await until(
      () => !h.page.data.busy && !h.page.data.frozen,
      'unchanged v1 reversible like',
      h,
    );
    close(h);
    login(input.other);
    h = mount('major-discussion-notices', {});
    await loaded(h);
    const like = h.page.data.items.find(
      (value) =>
        value.status === 'available' &&
        value.kind === 'like' &&
        value.target.commentId === replyId,
    );
    assert.ok(like);
    assert.equal(like.preview.thumbnail, null);
    const addressedNotice = h.page.data.items.find(
      (value) =>
        value.status === 'available' &&
        value.kind === 'reply' &&
        value.preview.thumbnail?.commentId === addressedId,
    );
    assert.ok(addressedNotice);
    assert.equal(addressedNotice.target.commentId, addressedId);
    assert.equal(addressedNotice.target.rootId, rootId);
    close(h);
    login(input.actor);
    h = mount();
    await loaded(h);
    await pick(h, 1, true);
    const unfinished = app.community.majorDiscussionImages.pending.load(
      input.actor.accountId,
    );
    assert.ok(unfinished);
    assert.equal(unfinished.phase, 'draft');
    close(h);
    h = mount('major-discussion-recovery', {});
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
      ownerJournal: [...platform.storage.values.entries()].filter(
        ([key]) =>
          key ===
          `whaleu.major-discussion.own-deletion-locators.v1:${nativeOrigin}:${input.actor.accountId}`,
      ),
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
