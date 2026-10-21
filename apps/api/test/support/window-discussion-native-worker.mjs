/** Actual emitted App/Page/WXML + production gateways against ordinary HTTP AppModule.
 * Only the native platform and explicitly injected transport interruptions are simulated. */
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
const send = (value) =>
  new Promise((resolve, reject) =>
    process.send(value, (error) => (error ? reject(error) : resolve())),
  );
async function checkpoint(name, fields = {}) {
  const next = new Promise((resolve) => process.once('message', resolve));
  await send({ event: 'checkpoint', name, ...fields });
  const result = await next;
  assert.equal(result.event, 'continue');
  assert.equal(result.name, name);
  return result;
}
async function until(check, label, h) {
  const deadline = Date.now() + 20000;
  while (!check()) {
    assert.ok(
      Date.now() < deadline,
      `${label}: ${h?.page.data.error || h?.page.data.status || 'not reached'}`,
    );
    await delay(10);
  }
}
const text = (h) =>
  h
    .nodes()
    .filter((n) => typeof n === 'string')
    .join(' ');
// Follow the visible disclosure before interacting with the original controls.
function openComposer(h) {
  if (h.page.data.uiPanel !== 'compose') h.tap('onOpenComposer');
  assert.equal(h.page.data.uiPanel, 'compose');
}
process.once('message', async (input) => {
  let app;
  const pages = new Set();
  try {
    const transport = new NativeExperienceTransport(input.port),
      platform = platformStorage(),
      commands = [],
      requests = [],
      navigation = [];
    let currentActor = input.actor,
      failJournal = false;
    const wx = {
      ...platform,
      nextTick: queueMicrotask,
      setStorageSync: (key, value) => {
        if (failJournal && key.includes('window-discussion.pending'))
          throw Error('Synthetic local persistence failure');
        platform.setStorageSync(key, value);
      },
      navigateTo: (options) => {
        navigation.push(options.url);
        options.success?.();
      },
      request: (options) => {
        const path = new URL(options.url).pathname;
        requests.push({ path, method: options.method });
        const publication =
            options.method === 'POST' &&
            (/\/discussion$/.test(path) ||
              /\/discussion\/[a-f0-9-]+\/replies$/.test(path)),
          mutation =
            options.method === 'POST' &&
            (publication || /\/discussion\/[a-f0-9-]+\/like$/.test(path));
        if (mutation)
          commands.push({
            actorId: currentActor.accountId,
            path,
            command: structuredClone(options.data),
          });
        void (async () => {
          if (publication)
            await checkpoint('review', {
              actorId: currentActor.accountId,
              windowId: path.split('/')[4],
              rootId: path.endsWith('/replies') ? path.split('/')[6] : null,
              command: options.data,
            });
          return transport.send({
            url: options.url,
            method: options.method,
            headers: options.header,
            body: options.data,
            timeoutMs: options.timeout,
          });
        })().then(
          (r) =>
            options.success({
              statusCode: r.status,
              header: r.headers,
              data: r.body,
            }),
          () => options.fail({ errMsg: 'request:fail synthetic interruption' }),
        );
        return { abort() {} };
      },
    };
    emitted('config').clientConfiguration = Object.freeze({
      apiOrigin: nativeOrigin,
      providerLoginEnabled: true,
    });
    function boot() {
      globalThis.wx = wx;
      globalThis.App = (value) => (app = value);
      globalThis.getApp = () => app;
      delete require.cache[require.resolve(`${dist}app.js`)];
      emitted('app');
      app.onLaunch();
      // Deliberate legacy-client compatibility harness: preserve every existing
      // v1 command/journal/receipt assertion. Default upgraded App/Page assembly
      // is exercised separately by window-discussion-images-native-worker.mjs.
      delete app.community.windowDiscussionV2;
      delete app.community.windowDiscussionImages;
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
      h.page.onHide?.();
      h.page.onUnload?.();
      pages.delete(h);
    }
    function restart(actor) {
      for (const h of [...pages]) close(h);
      app.onHide();
      boot();
      login(actor);
    }
    const idle = (h) => until(() => !h.page.data.busy, 'idle', h),
      loaded = (h) =>
        until(
          () => !h.page.data.busy && h.page.data.loaded,
          'loaded current data',
          h,
        ),
      settled = (h) =>
        until(
          () => !h.page.data.busy && !h.page.data.frozen,
          'settled original intent',
          h,
        ),
      uncertain = (h) =>
        until(
          () => !h.page.data.busy && h.page.data.frozen,
          'durable unknown intent',
          h,
        );
    async function publish(h, body) {
      openComposer(h);
      h.event('bindinput', 'onBody', { value: body });
      h.tap('onConfirmPublish');
      assert.equal(h.page.data.confirming, 'publish');
      h.tap('onSubmit');
      await settled(h);
    }
    async function toggle(h, id) {
      h.tap('onLike', { id });
      assert.equal(h.page.data.confirming, 'like');
      h.tap('onSubmit');
      await settled(h);
    }
    function recovery() {
      return mount('window-discussion-recovery', {});
    }
    const path = `/v1/ratings/windows/${input.windowId}/discussion`,
      exact = '  Native 😀 窗口原文\n第二行  ';
    boot();
    login(input.actor);
    const windowDetail = mount('window-rating-detail', {
      windowId: input.windowId,
    });
    await loaded(windowDetail);
    assert.equal(windowDetail.page.data.detail.window.id, input.windowId);
    windowDetail.tap('onOpenDiscussion');
    assert.equal(
      navigation.pop(),
      `/pages/window-discussion/window-discussion?windowId=${input.windowId}`,
    );
    close(windowDetail);
    let h = mount();
    await loaded(h);
    assert.equal(h.page.data.items.length, 0);
    openComposer(h);
    h.event('bindinput', 'onBody', { value: '😀'.repeat(2001) });
    assert.equal(h.page.data.canPublish, false);
    openComposer(h);
    h.event('bindinput', 'onBody', { value: exact });
    h.tap('onConfirmPublish');
    h.tap('onCloseConfirmation');
    assert.equal(commands.length, 0);
    h.tap('onConfirmPublish');
    transport.dropSuccess = { path, method: 'POST' };
    h.tap('onSubmit');
    h.page.onSubmit();
    await uncertain(h);
    const rootAttempt = app.community.pendingWindowDiscussion.load(
      input.actor.accountId,
    );
    assert.equal(rootAttempt.intent.command.body, exact);
    assert.equal(commands.length, 1);
    await checkpoint('first-root-committed', {
      command: rootAttempt.intent.command,
    });
    restart(input.actor);
    h = recovery();
    await idle(h);
    assert.equal(h.page.data.frozen, true);
    h.tap('onRecover');
    await settled(h);
    assert.equal(h.page.data.loaded, false);
    assert.match(text(h), /历史回执/);
    await checkpoint('restore');
    close(h);
    h = mount();
    await loaded(h);
    const rootId = h.page.data.items.find((i) => i.body === exact).id;
    assert.equal(h.page.data.items[0].author.mode, 'named');
    assert.equal(
      JSON.stringify(h.page.data.items).includes(input.actor.accountId),
      false,
    );
    h.tap('onThread', { id: rootId });
    assert.equal(
      navigation.pop(),
      `/pages/window-discussion-thread/window-discussion-thread?windowId=${input.windowId}&rootId=${rootId}`,
    );
    close(h);
    login(input.other);
    h = mount('window-discussion-thread', { windowId: input.windowId, rootId });
    await loaded(h);
    await publish(h, 'Native direct root reply');
    await loaded(h);
    const otherReply = h.page.data.items.find(
      (i) => i.body === 'Native direct root reply',
    ).id;
    assert.equal(h.page.data.items[0].rootId, rootId);
    close(h);
    login(input.actor);
    h = mount('window-discussion-thread', { windowId: input.windowId, rootId });
    await loaded(h);
    h.tap('onReply', { id: otherReply });
    await publish(h, 'Native reply to another reply');
    await loaded(h);
    const addressed = h.page.data.items.find(
      (i) => i.body === 'Native reply to another reply',
    );
    assert.equal(addressed.replyToReplyId, otherReply);
    assert.ok(addressed.addressedAuthor.profileId);
    close(h);
    h = mount('window-discussion-notices', {});
    await loaded(h);
    assert.ok(h.page.data.unreadCount >= 1);
    const replyNotice = h.page.data.items.find(
      (i) => i.status === 'available' && i.kind === 'reply',
    );
    assert.ok(replyNotice);
    const beforeReads = requests.filter((r) => r.method === 'PUT').length;
    h.tap('onOpen', { id: replyNotice.noticeId });
    await idle(h);
    const targetPath = navigation.pop();
    assert.ok(targetPath.includes(`noticeId=${replyNotice.noticeId}`));
    assert.equal(
      requests.filter((r) => r.method === 'PUT').length,
      beforeReads,
    );
    const targetQuery = Object.fromEntries(
      new URL(`https://native.invalid${targetPath}`).searchParams,
    );
    const targetPage = mount('window-discussion-thread', targetQuery);
    await loaded(targetPage);
    assert.equal(targetPage.page.data.focusCommentId, otherReply);
    close(targetPage);
    h.tap('onRead', { id: replyNotice.noticeId });
    await idle(h);
    assert.ok(
      h.page.data.items.find((i) => i.noticeId === replyNotice.noticeId).readAt,
    );
    close(h);
    login(input.other);
    h = mount();
    await loaded(h);
    transport.dropSuccess = { path: `${path}/${rootId}/like`, method: 'POST' };
    h.tap('onLike', { id: rootId });
    h.tap('onSubmit');
    await uncertain(h);
    const likeAttempt = app.community.pendingWindowDiscussion.load(
      input.other.accountId,
    );
    await checkpoint('historical-like', {
      commentId: rootId,
      command: likeAttempt.intent.command,
    });
    restart(input.other);
    h = recovery();
    await idle(h);
    h.tap('onRecover');
    await settled(h);
    assert.equal(h.page.data.own, null);
    assert.equal(h.page.data.ownReferences.length, 1);
    h.tap('onOwnReference', { id: rootId });
    await idle(h);
    assert.equal(h.page.data.own.active, false);
    assert.equal(h.page.data.canUnlike, false);
    await checkpoint('restore');
    close(h);
    h = mount();
    await loaded(h);
    await toggle(h, rootId);
    await loaded(h);
    assert.equal(h.page.data.items.find((i) => i.id === rootId).isLiked, true);
    for (const loss of ['source', 'phone', 'safety']) {
      await checkpoint('loss', { loss });
      close(h);
      h = recovery();
      await idle(h);
      h.tap('onOwnReference', { id: rootId });
      await idle(h);
      assert.equal(h.page.data.canUnlike, true);
      h.tap('onUnlike');
      h.tap('onSubmit');
      await settled(h);
      assert.equal(h.page.data.own.active, false);
      await checkpoint('restore');
      close(h);
      h = mount();
      await loaded(h);
      await toggle(h, rootId);
      await loaded(h);
    }
    await checkpoint('like-notice-count', { commentId: rootId });
    close(h);
    login(input.actor);
    h = mount();
    await loaded(h);
    const beforeCommands = commands.length;
    openComposer(h);
    h.event('bindinput', 'onBody', { value: 'Storage failure' });
    h.tap('onConfirmPublish');
    failJournal = true;
    h.tap('onSubmit');
    await idle(h);
    failJournal = false;
    assert.equal(commands.length, beforeCommands);
    assert.equal(
      app.community.pendingWindowDiscussion.load(input.actor.accountId),
      null,
    );
    h.tap('onRefresh');
    await loaded(h);
    openComposer(h);
    h.event('bindinput', 'onBody', { value: 'PENDING native original' });
    h.tap('onConfirmPublish');
    h.tap('onSubmit');
    await uncertain(h);
    const cancelAttempt = app.community.pendingWindowDiscussion.load(
      input.actor.accountId,
    );
    h.tap('onRequestCancellation');
    await idle(h);
    assert.equal(h.page.data.confirming, 'cancel');
    transport.dropSuccess = {
      path: `/v1/ratings/windows/discussion-requests/${cancelAttempt.intent.command.clientRequestId}/cancel`,
      method: 'POST',
    };
    h.tap('onConfirmCancellation');
    await uncertain(h);
    assert.equal(
      app.community.pendingWindowDiscussion.load(input.actor.accountId).phase,
      'cancel',
    );
    await checkpoint('loss', { loss: 'source' });
    restart(input.actor);
    h = recovery();
    await idle(h);
    const writesBefore = commands.length;
    h.tap('onRetry');
    await settled(h);
    assert.equal(commands.length, writesBefore);
    assert.match(text(h), /确认取消/);
    await checkpoint('restore');
    close(h);
    h = mount('window-discussion', { windowId: input.pagingId });
    await loaded(h);
    assert.equal(h.page.data.items.length, 20);
    assert.equal(h.page.data.canNext, true);
    await checkpoint('paging-change');
    h.tap('onNext');
    await idle(h);
    assert.equal(h.page.data.loaded, false);
    assert.equal(h.page.data.restartRequired, true);
    h.tap('onSort', { sort: 'time' });
    await loaded(h);
    assert.equal(h.page.data.sort, 'time');
    close(h);
    h = mount('window-discussion-notices', {});
    await loaded(h);
    await checkpoint('loss', { loss: 'source' });
    h.tap('onRefresh');
    await loaded(h);
    assert.ok(h.page.data.items.every((i) => i.status === 'unavailable'));
    const unread = h.page.data.items.find((i) => i.readAt === null);
    if (unread) {
      h.tap('onRead', { id: unread.noticeId });
      await idle(h);
      assert.ok(
        h.page.data.items.find((i) => i.noticeId === unread.noticeId).readAt,
      );
    }
    await checkpoint('restore');
    h.tap('onRefresh');
    await loaded(h);
    const available = h.page.data.items.find((i) => i.status === 'available');
    assert.ok(available);
    const held = transport.holdNext(
      `/v1/me/window-discussion/notices/${available.noticeId}/target`,
    );
    const navigationBefore = navigation.length;
    h.tap('onOpen', { id: available.noticeId });
    await held.arrived;
    login(input.other);
    assert.equal(h.page.data.items.length, 0);
    held.release();
    await delay(30);
    assert.equal(navigation.length, navigationBefore);
    close(h);
    h = mount();
    await loaded(h);
    const heldRead = transport.holdNext(path);
    h.tap('onToggleTools');
    h.tap('onRefresh');
    await heldRead.arrived;
    app.onHide();
    assert.equal(h.page.data.items.length, 0);
    heldRead.release();
    await delay(30);
    assert.equal(h.page.data.items.length, 0);
    await send({
      event: 'done',
      rootId,
      otherReply,
      rootRequestId: rootAttempt.intent.command.clientRequestId,
      cancelledRequestId: cancelAttempt.intent.command.clientRequestId,
      nativeCommands: commands.length,
      receiptReads: requests.filter(
        (r) => r.method === 'GET' && r.path.includes('/discussion-requests/'),
      ).length,
    });
  } catch (error) {
    await send({
      event: 'failure',
      message: error instanceof Error ? error.stack : String(error),
    });
    process.exitCode = 1;
  } finally {
    for (const h of pages) {
      h.page.onHide?.();
      h.page.onUnload?.();
    }
    app?.onHide?.();
    process.disconnect?.();
  }
});
