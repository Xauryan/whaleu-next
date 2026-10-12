/** Emitted App and real Page/WXML handlers; only native platform callbacks are synthetic. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { mountEmittedPage } from '../../../wechat/test/text-review-emitted-harness.mjs';
const require = createRequire(import.meta.url),
  dist = fileURLToPath(new URL('../../../wechat/dist/', import.meta.url));
const emitted = (name) => require(`${dist}${name}.js`);
const {
  NativeExperienceTransport,
  nativeOrigin,
  platformStorage,
} = require('./experience-native-bridge.ts');
const send = (value) =>
  new Promise((resolve, reject) =>
    process.send(value, (error) => (error ? reject(error) : resolve())),
  );
async function checkpoint(name) {
  const next = new Promise((resolve) => process.once('message', resolve));
  await send({ event: 'checkpoint', name });
  const response = await next;
  assert.equal(response.event, 'continue');
  assert.equal(response.name, name);
}
const slotFailures = [];
async function until(check, label, h) {
  const deadline = Date.now() + 20000;
  while (!check()) {
    assert.ok(
      Date.now() < deadline,
      `${label}: ${JSON.stringify({ pin: h?.page.data.postPin, management: h?.page.data.postPinManagement, slotFailures })}`,
    );
    await delay(10);
  }
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
    let failJournal = false;
    transport.checkResponse = (path, status, body) => {
      if (path === '/v1/community/post-pin-slot' && status !== 200)
        slotFailures.push({ status, code: body?.error?.code ?? body?.code });
    };
    const wx = {
      ...platform,
      nextTick: queueMicrotask,
      setStorageSync: (key, value) => {
        if (failJournal && key.includes('post-pins.pending'))
          throw Error('Synthetic journal failure');
        platform.setStorageSync(key, value);
      },
      navigateTo: (o) => {
        navigation.push(o.url);
        o.success?.();
      },
      request: (o) => {
        const path = new URL(o.url).pathname;
        requests.push({ path, method: o.method });
        if (o.method === 'POST' && path === '/v1/community/post-pin-commands')
          commands.push(structuredClone(o.data));
        transport
          .send({
            url: o.url,
            method: o.method,
            headers: o.header,
            body: o.data,
            timeoutMs: o.timeout,
          })
          .then(
            (r) =>
              o.success({
                statusCode: r.status,
                header: r.headers,
                data: r.body,
              }),
            () => o.fail({ errMsg: 'request:fail synthetic' }),
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
    }
    function login(actor) {
      app.identity.sessions.completeLogin(
        app.identity.sessions.beginLogin(),
        actor,
      );
    }
    function mount(name = 'community-detail', options = {}) {
      const h = mountEmittedPage(name, app, wx);
      const commit = h.page.setData;
      h.renderCallbacks = [];
      h.releaseRender = () => {
        for (const callback of h.renderCallbacks.splice(0)) callback();
      };
      h.page.setData = (patch, callback) => {
        const held =
          callback &&
          ((options.holdDetailRender && Object.keys(patch).length === 0) ||
            (options.holdPinRender && patch.postPin?.item));
        commit(patch, held ? undefined : callback);
        if (held) h.renderCallbacks.push(callback);
      };
      pages.add(h);
      h.page.onLoad?.(
        name === 'community-detail' ? { postId: input.postId } : {},
      );
      h.page.onShow?.();
      return h;
    }
    function close(h) {
      h.page.onHide?.();
      h.page.onUnload?.();
      pages.delete(h);
    }
    const loaded = (h) =>
      until(
        () =>
          !h.page.data.busy &&
          h.page.data.loaded &&
          !h.page.data.postPin.busy &&
          h.page.data.postPin.loaded,
        'detail and current pin',
        h,
      );
    const settled = (h) =>
      until(
        () => !h.page.data.postPin.busy && !h.page.data.postPin.frozen,
        'terminal pin receipt',
        h,
      );
    const pending = (h) =>
      until(
        () => !h.page.data.postPin.busy && h.page.data.postPin.frozen,
        'durable pin pending',
        h,
      );
    const feedLoaded = (h) =>
      until(
        () =>
          h.page.data.loaded &&
          !h.page.data.busy &&
          !h.page.data.postPin.busy &&
          h.page.data.postPin.loaded,
        'feed and scoped pin',
        h,
      );
    boot();
    login(input.admin);
    let h = mount();
    await loaded(h);
    assert.equal(h.page.data.postPin.detail.canPin, true);
    h.tap('onPinCreate');
    h.tap('onPinDuration', { hours: '6' });
    assert.equal(h.page.data.postPin.durationHours, 6);
    transport.dropSuccess = {
      path: '/v1/community/post-pin-commands',
      method: 'POST',
    };
    h.tap('onPinSubmit');
    await pending(h);
    const original = commands.at(-1);
    assert.equal(original.operation, 'pin');
    assert.equal(original.durationHours, 6);
    assert.equal(
      app.community.pendingPostPins.load(input.admin.accountId).command
        .clientRequestId,
      original.clientRequestId,
    );
    close(h);
    app.onHide();
    await checkpoint('hide-pending-target');
    boot();
    login(input.admin);
    h = mount();
    await until(
      () =>
        !h.page.data.busy &&
        !h.page.data.reportProgress.busy &&
        !!h.page.data.reportProgress.error &&
        h.page.data.postPin.frozen,
      'independent cold pending recovery after current visibility invalidation',
      h,
    );
    assert.equal(h.page.data.post, null);
    h.tap('onPinRecover');
    await settled(h);
    assert.match(
      h.page.data.postPin.receiptStatus,
      /确认/,
      JSON.stringify({
        view: h.page.data.postPin,
        exchanges: transport.exchanges.slice(-8),
        pending: !!app.community.pendingPostPins.load(input.admin.accountId),
      }),
    );
    assert.equal(h.page.data.postPin.detail, null);
    await checkpoint('restore-pending-target');
    h.page.onShow();
    await loaded(h);
    const firstPin = h.page.data.postPin.detail.pin.pinId;
    assert.equal(h.page.data.postPin.detail.pin.readState, 'read');
    assert.equal(
      commands.filter((c) => c.operation === 'pin').length,
      1,
      'receipt recovery never renews',
    );
    close(h);
    login(input.reader);
    let feed = mount('community-feed', { holdPinRender: true });
    await feedLoaded(feed);
    assert.ok(
      feed.page.data.posts.some((p) => p.id === input.postId),
      'ordinary content remains until the pin render commits',
    );
    feed.releaseRender();
    assert.equal(feed.page.data.postPin.item.pin.pinId, firstPin);
    assert.equal(feed.page.data.postPin.item.pin.readState, 'unread');
    assert.ok(!feed.page.data.posts.some((p) => p.id === input.postId));
    const readCount = commands.filter((c) => c.operation === 'read').length;
    feed.tap('onPinDismiss');
    assert.equal(feed.page.data.postPin.confirmDismiss, true);
    feed.tap('onPinConfirmDismiss');
    assert.equal(feed.page.data.postPin.item, null);
    assert.ok(feed.page.data.posts.some((p) => p.id === input.postId));
    assert.equal(
      commands.filter((c) => c.operation === 'read').length,
      readCount,
      'local dismissal is not acknowledgement',
    );
    close(feed);
    login(input.admin);
    h = mount();
    await loaded(h);
    h.tap('onPinCreate');
    h.tap('onPinSubmit');
    await settled(h);
    await loaded(h);
    const renewed = h.page.data.postPin.detail.pin.pinId;
    assert.notEqual(renewed, firstPin);
    close(h);
    login(input.reader);
    feed = mount('community-feed');
    await feedLoaded(feed);
    assert.equal(feed.page.data.postPin.item.pin.pinId, renewed);
    assert.equal(
      feed.page.data.postPin.collapsed,
      false,
      'new identity defeats old local dismissal',
    );
    feed.tap('onPinOpen');
    assert.equal(
      navigation.at(-1),
      `/pages/community-detail/community-detail?postId=${input.postId}`,
    );
    close(feed);
    const readsBeforePresentation = commands.filter(
      (c) => c.operation === 'read',
    ).length;
    h = mount('community-detail', { holdDetailRender: true });
    await until(
      () =>
        h.page.data.loaded && !h.page.data.busy && h.renderCallbacks.length > 0,
      'ordinary detail awaiting native render commit',
      h,
    );
    await delay(30);
    assert.equal(
      commands.filter((c) => c.operation === 'read').length,
      readsBeforePresentation,
      'network success alone does not acknowledge the pin',
    );
    assert.equal(h.page.data.postPin.loaded, false);
    h.releaseRender();
    await loaded(h);
    await until(
      () => h.page.data.postPin.detail?.pin?.readState === 'read',
      'detail automatically reads exact current pin',
      h,
    );
    close(h);
    feed = mount('community-feed');
    await feedLoaded(feed);
    assert.equal(feed.page.data.postPin.collapsed, true);
    feed.tap('onPinExpand');
    assert.equal(feed.page.data.postPin.collapsed, false);
    close(feed);
    // Fail before dispatch, then durable server cancellation of that exact key.
    login(input.admin);
    h = mount();
    await loaded(h);
    h.tap('onPinCreate');
    transport.failNext = '/v1/community/post-pin-commands';
    h.tap('onPinSubmit');
    await pending(h);
    const cancelled = commands.at(-1);
    h.tap('onPinCancel');
    h.tap('onPinConfirmCancel');
    await settled(h);
    assert.match(h.page.data.postPin.receiptStatus, /取消/);
    // A local persistence failure sends nothing and keeps recovery blocked.
    h.page.onShow();
    await loaded(h);
    h.tap('onPinCreate');
    const prior = commands.length;
    failJournal = true;
    h.tap('onPinSubmit');
    await until(() => !h.page.data.postPin.busy, 'storage blocker', h);
    assert.equal(commands.length, prior);
    failJournal = false;
    close(h);
    h = mount();
    await loaded(h);
    h.tap('onPinCreate');
    const held = transport.holdNext('/v1/community/post-pin-commands', 'POST');
    h.tap('onPinSubmit');
    await held.arrived;
    close(h);
    held.release();
    await delay(30);
    assert.ok(app.community.pendingPostPins.load(input.admin.accountId));
    h = mount();
    await loaded(h);
    h.tap('onPinRecover');
    await settled(h);
    await loaded(h);
    // Late projection belongs to old account and must never restore pin controls.
    const heldRead = transport.holdNext(
      `/v1/community/posts/${input.postId}/pin`,
    );
    h.page.onShow();
    await heldRead.arrived;
    login(input.reader);
    assert.equal(h.page.data.postPin.detail, null);
    heldRead.release();
    await delay(30);
    assert.equal(h.page.data.postPin.detail, null);
    close(h);
    login(input.admin);
    h = mount();
    await loaded(h);
    h.tap('onPinUnpin');
    h.tap('onPinSubmit');
    await settled(h);
    await loaded(h);
    assert.equal(h.page.data.postPin.detail.pin, null);
    assert.equal(h.page.data.postPin.detail.canUnpin, false);
    // A hidden occupied slot remains closable from the current feed, without
    // opening the hidden detail or returning any hidden presentation fields.
    h.tap('onPinCreate');
    h.tap('onPinSubmit');
    await settled(h);
    await loaded(h);
    const hiddenPinId = h.page.data.postPin.detail.pin.pinId;
    app.onHide();
    assert.equal(h.page.data.postPin.detail, null);
    close(h);
    await checkpoint('hide-pending-target');
    let manager = mount('community-feed');
    await feedLoaded(manager);
    const managed = () => manager.page.data.postPinManagement;
    await until(
      () => !managed().busy && (managed().loaded || managed().error),
      'minimal slot management',
      manager,
    );
    assert.equal(
      managed().loaded,
      true,
      JSON.stringify({ view: managed(), slotFailures }),
    );
    assert.equal(manager.page.data.postPin.item, null);
    assert.equal(managed().slot.pin.pinId, hiddenPinId);
    assert.deepEqual(Object.keys(managed().slot.pin).sort(), [
      'level',
      'pinId',
      'pinnedUntil',
      'postId',
    ]);
    assert.equal(
      manager.page.data.posts.some((post) => post.id === input.postId),
      false,
    );
    transport.dropSuccess = {
      path: '/v1/community/post-pin-commands',
      method: 'POST',
    };
    manager.tap('onSlotUnpin');
    manager.tap('onSlotSubmit');
    await until(
      () => !managed().busy && managed().frozen,
      'slot closure pending',
      manager,
    );
    assert.equal(commands.at(-1).pinId, hiddenPinId);
    assert.equal(commands.at(-1).operation, 'unpin');
    close(manager);
    manager = mount('community-feed');
    await feedLoaded(manager);
    await until(
      () => managed().loaded && !managed().busy && managed().frozen,
      'slot closure recovery',
      manager,
    );
    manager.tap('onSlotRecover');
    await until(
      () =>
        managed().loaded &&
        !managed().busy &&
        !managed().frozen &&
        managed().slot?.pin === null,
      'slot closed through original receipt',
      manager,
    );
    assert.equal(managed().slot.canUnpin, false);
    close(manager);
    await checkpoint('restore-pending-target');
    login(input.reader);
    const feedback = mount('feedback');
    await feedLoaded(feedback);
    assert.equal(
      feedback.page.data.postPin.item.pin.pinId,
      input.feedbackPinId,
    );
    assert.ok(
      !feedback.page.data.posts.some((p) => p.id === input.feedbackPostId),
    );
    feedback.tap('onPinDismiss');
    feedback.tap('onPinConfirmDismiss');
    assert.ok(
      feedback.page.data.posts.some((p) => p.id === input.feedbackPostId),
    );
    close(feedback);

    await send({
      event: 'done',
      firstRequestId: original.clientRequestId,
      cancelledRequestId: cancelled.clientRequestId,
      nativeCommands: commands.length,
      receiptReads: requests.filter(
        (r) => r.path.includes('/post-pin-requests/') && r.method === 'GET',
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
