/** Actual emitted App, registered Page handlers and rendered WXML. Only native
 * storage/request callbacks are synthetic; every HTTP reply is AppModule/PG. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { mountEmittedPage } from '../../../wechat/test/text-review-emitted-harness.mjs';
const require = createRequire(import.meta.url);
const dist = fileURLToPath(new URL('../../../wechat/dist/', import.meta.url));
const emitted = (name) => require(`${dist}${name}.js`);
const {
  NativeExperienceTransport,
  nativeOrigin,
  platformStorage,
} = require('../support/experience-native-bridge.ts');
const commandPath = '/v1/me/community/owner-visibility-commands';
const journalPrefix = 'whaleu.owner-post-visibility.pending.v1:';
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
async function until(check, label, h) {
  const deadline = Date.now() + 25000;
  while (!check()) {
    assert.ok(
      Date.now() < deadline,
      `${label}: ${JSON.stringify({ visibility: h?.page.data.ownerVisibility, error: h?.page.data.error, busy: h?.page.data.busy, loaded: h?.page.data.loaded })}`,
    );
    await delay(10);
  }
}

function openManagementMenu(h) {
  // My Publications already exposes its own row controls; detail has a menu.
  if ('uiExpandedMenu' in h.page.data) {
    if (h.page.data.uiExpandedMenu !== 'management')
      h.tap('onToggleMenu', { menu: 'management' });
    assert.equal(h.page.data.uiExpandedMenu, 'management');
  }
}
process.once('message', async (input) => {
  let app;
  const pages = new Set();
  try {
    const transport = new NativeExperienceTransport(input.port);
    const platform = platformStorage();
    const commands = [],
      calls = [];
    let failWrite = false,
      failReadback = false,
      readbackPending = false;
    const wx = {
      ...platform,
      nextTick: queueMicrotask,
      navigateTo: (options) => options.success?.(),
      getStorageSync(key) {
        if (readbackPending && key.startsWith(journalPrefix)) {
          readbackPending = false;
          throw Error('Synthetic persisted journal readback failure');
        }
        return platform.getStorageSync(key);
      },
      setStorageSync(key, value) {
        if (failWrite && key.startsWith(journalPrefix))
          throw Error('Synthetic journal write failure');
        platform.setStorageSync(key, value);
        if (failReadback && key.startsWith(journalPrefix))
          readbackPending = true;
      },
      request(options) {
        const path = new URL(options.url).pathname;
        calls.push({ path, method: options.method });
        if (options.method === 'POST' && path === commandPath)
          commands.push(structuredClone(options.data));
        transport
          .send({
            url: options.url,
            method: options.method,
            headers: options.header,
            body: options.data,
            timeoutMs: options.timeout,
          })
          .then(
            (response) =>
              options.success({
                statusCode: response.status,
                header: response.headers,
                data: response.body,
              }),
            () => options.fail({ errMsg: 'request:fail synthetic' }),
          );
        // Deliberately uncooperative cancellation: late real callbacks still
        // arrive, so session/generation fencing, rather than the stub, owns them.
        return { abort() {} };
      },
    };
    emitted('config').clientConfiguration = Object.freeze({
      apiOrigin: nativeOrigin,
      providerLoginEnabled: true,
    });
    const boot = () => {
      globalThis.wx = wx;
      globalThis.App = (value) => {
        app = value;
      };
      globalThis.getApp = () => app;
      delete require.cache[require.resolve(`${dist}app.js`)];
      emitted('app');
      app.onLaunch();
    };
    const login = (actor) =>
      app.identity.sessions.completeLogin(
        app.identity.sessions.beginLogin(),
        actor,
      );
    const mount = (name = 'community-detail') => {
      const h = mountEmittedPage(name, app, wx);
      pages.add(h);
      h.page.onLoad?.(
        name === 'community-detail' ? { postId: input.postId } : {},
      );
      h.page.onShow?.();
      return h;
    };
    const close = (h) => {
      h.page.onHide?.();
      h.page.onUnload?.();
      pages.delete(h);
    };
    const view = (h) => h.page.data.ownerVisibility;
    const pending = (h) =>
      until(
        () => !view(h).busy && view(h).frozen,
        'durable uncertain original request',
        h,
      );
    const settled = (h) =>
      until(
        () => !view(h).busy && !view(h).frozen && !!view(h).receiptStatus,
        'terminal original receipt',
        h,
      );
    const detailLoaded = (h) =>
      until(
        () =>
          h.page.data.loaded &&
          !h.page.data.busy &&
          !view(h).busy &&
          !!view(h).management,
        'private detail and minimal owner management',
        h,
      );
    const mineLoaded = (h) =>
      until(
        () => h.page.data.loaded && !h.page.data.busy && !view(h).busy,
        'minimal My Publications',
        h,
      );
    const prepare = async (h, hidden) => {
      openManagementMenu(h);
      h.tap(hidden ? 'onOwnerVisibilityHide' : 'onOwnerVisibilityUnhide', {
        id: input.postId,
      });
      await until(
        () => !view(h).busy && view(h).confirming === 'change',
        'desired-state confirmation',
        h,
      );
      assert.equal(view(h).desired, hidden);
    };
    const change = async (h, hidden) => {
      await prepare(h, hidden);
      h.tap('onOwnerVisibilitySubmit');
      await settled(h);
    };
    const journal = () =>
      app.community.pendingOwnerPostVisibility.load(input.owner.accountId);

    boot();
    login(input.owner);
    let h = mount('community-mine');
    await mineLoaded(h);
    assert.equal(
      h.page.data.publications.find((item) => item.id === input.postId)
        .ownerVisibility.ownerHidden,
      false,
    );
    assert.equal('text' in h.page.data.publications[0], false);
    await prepare(h, true);
    const firstDispatchCount = commands.length;
    h.tap('onOwnerVisibilitySubmit');
    h.page.onOwnerVisibilitySubmit(); // Synthetic double tap while the first handler is running.
    await settled(h);
    await until(
      () =>
        h.page.data.publications.find((item) => item.id === input.postId)
          ?.ownerVisibility.ownerHidden === true,
      'own minimal status refresh',
      h,
    );
    assert.equal(
      commands.length,
      firstDispatchCount + 1,
      'Double tap never creates a second request key',
    );
    assert.equal(journal(), null);
    close(h);

    login(input.reader);
    let feed = mount('community-feed');
    await until(
      () => feed.page.data.loaded && !feed.page.data.busy,
      'other-account feed refresh',
      feed,
    );
    assert.equal(
      feed.page.data.posts.some((post) => post.id === input.postId),
      false,
    );
    close(feed);
    h = mount();
    await until(
      () => !h.page.data.busy && !!h.page.data.error && !view(h).busy,
      'other-account hidden detail denial',
      h,
    );
    assert.equal(h.page.data.post, null);
    assert.equal(view(h).management, null);
    assert.equal(h.button('bindtap', 'onOwnerVisibilityHide'), undefined);
    close(h);

    login(input.owner);
    h = mount();
    await detailLoaded(h);
    assert.equal(
      h.page.data.post.id,
      input.postId,
      'Owner keeps gated private detail',
    );
    await prepare(h, false);
    transport.dropSuccess = { path: commandPath, method: 'POST' };
    h.tap('onOwnerVisibilitySubmit');
    await pending(h);
    const lost = commands.at(-1);
    assert.equal(lost.ownerHidden, false);
    assert.deepEqual(journal().command, lost);
    const commandsAfterLoss = commands.length;
    close(h);
    app.onHide();
    await checkpoint('moderation-hold');
    boot();
    login(input.owner);
    // Deterministically deliver late authoritative target loss while the user's
    // original receipt GET is in flight. Safety clears bodies, not recovery.
    const lateProgress = transport.holdNext(
      `/v1/me/safety/report-progress/post/${input.postId}`,
    );
    h = mount();
    await lateProgress.arrived;
    await until(
      () =>
        !h.page.data.busy &&
        !!h.page.data.error &&
        !view(h).busy &&
        view(h).frozen,
      'cold original journal despite unreadable current detail',
      h,
    );
    assert.equal(h.page.data.post, null);
    assert.equal(view(h).pendingPostId, input.postId);
    const interruptedReceipt = transport.holdNext(
      `/v1/me/community/owner-visibility-requests/${lost.clientRequestId}`,
    );
    h.tap('onOwnerVisibilityRecover');
    await interruptedReceipt.arrived;
    lateProgress.release();
    await settled(h);
    interruptedReceipt.release();
    assert.equal(
      commands.length,
      commandsAfterLoss,
      'Cold recovery reads the original receipt, never republishes or mints a key',
    );
    assert.equal(journal(), null);
    assert.equal(
      h.page.data.post,
      null,
      'Receipt recovery cannot restore moderator-hidden content',
    );
    await checkpoint('moderation-release');
    h.page.onShow();
    await detailLoaded(h);
    assert.equal(view(h).management.ownerHidden, false);

    // No server record is not a terminal result; an explicit retry uses the
    // original durable key, exact body and expected version.
    await prepare(h, true);
    transport.failNext = commandPath;
    h.tap('onOwnerVisibilitySubmit');
    await pending(h);
    const offline = structuredClone(journal().command);
    h.tap('onOwnerVisibilityRecover');
    await pending(h);
    assert.deepEqual(journal().command, offline);
    const beforeRetry = commands.length;
    h.tap('onOwnerVisibilityRetry');
    await settled(h);
    assert.equal(commands.length, beforeRetry + 1);
    assert.deepEqual(commands.at(-1), offline);
    await detailLoaded(h);
    await change(h, false);
    await detailLoaded(h);

    // Exact server cancellation seals a never-dispatched key.
    await prepare(h, true);
    transport.failNext = commandPath;
    h.tap('onOwnerVisibilitySubmit');
    await pending(h);
    const cancelled = structuredClone(journal().command);
    h.tap('onOwnerVisibilityCancel');
    assert.equal(view(h).confirming, 'cancel');
    h.tap('onOwnerVisibilityConfirmCancel');
    await settled(h);
    assert.match(view(h).receiptStatus, /取消/);
    assert.equal(journal(), null);
    await detailLoaded(h);
    assert.equal(view(h).management.ownerHidden, false);

    // Cancellation that loses to a committed command returns that immutable
    // success, not a fabricated cancellation or inverse state mutation.
    await prepare(h, true);
    transport.dropSuccess = { path: commandPath, method: 'POST' };
    h.tap('onOwnerVisibilitySubmit');
    await pending(h);
    const cancelRace = structuredClone(journal().command);
    h.tap('onOwnerVisibilityCancel');
    h.tap('onOwnerVisibilityConfirmCancel');
    await settled(h);
    assert.match(view(h).receiptStatus, /已确认作者隐藏/);
    await detailLoaded(h);
    assert.equal(view(h).management.ownerHidden, true);
    await change(h, false);
    await detailLoaded(h);

    // A failed durable write and a failed readback both stop before transport.
    await prepare(h, true);
    let count = commands.length;
    failWrite = true;
    h.tap('onOwnerVisibilitySubmit');
    await until(
      () => !view(h).busy && !!view(h).error,
      'journal write blocker',
      h,
    );
    assert.equal(commands.length, count);
    failWrite = false;
    assert.equal(journal(), null);
    close(h);
    h = mount();
    await detailLoaded(h);
    await prepare(h, true);
    count = commands.length;
    failReadback = true;
    h.tap('onOwnerVisibilitySubmit');
    await pending(h);
    assert.equal(commands.length, count);
    failReadback = false;
    assert.ok(
      journal(),
      'A persisted-but-unverified command is retained for recovery',
    );
    h.tap('onOwnerVisibilityRecover');
    await pending(h);
    h.tap('onOwnerVisibilityCancel');
    h.tap('onOwnerVisibilityConfirmCancel');
    await settled(h);
    await detailLoaded(h);

    // Hold a real successful callback after the response fully arrives. Account
    // replacement must clear private controls and preserve the original journal.
    await prepare(h, true);
    const held = transport.holdNext(commandPath, 'POST');
    h.tap('onOwnerVisibilitySubmit');
    await held.arrived;
    const switched = structuredClone(journal().command);
    login(input.reader);
    assert.equal(view(h).management, null);
    assert.equal(view(h).frozen, false);
    held.release();
    await delay(40);
    assert.equal(view(h).management, null);
    assert.equal(h.page.data.post, null);
    assert.deepEqual(journal().command, switched);
    assert.equal(
      app.community.pendingOwnerPostVisibility.load(input.reader.accountId),
      null,
    );
    close(h);
    login(input.owner);
    h = mount('community-mine');
    await mineLoaded(h);
    await pending(h);
    h.tap('onOwnerVisibilityRecover');
    await settled(h);
    await mineLoaded(h);
    await change(h, false);
    await mineLoaded(h);
    close(h);
    h = mount();
    await detailLoaded(h);

    // Each origin owns a separate durable namespace. Replacing the runtime store
    // while a controller is live fails closed before contacting a new gateway.
    await prepare(h, true);
    transport.failNext = commandPath;
    h.tap('onOwnerVisibilitySubmit');
    await pending(h);
    const originalStore = app.community.pendingOwnerPostVisibility;
    const originalPending = structuredClone(journal());
    const { PendingOwnerPostVisibilityStore } = emitted(
      'owner-post-visibility/pending',
    );
    const otherStore = new PendingOwnerPostVisibilityStore(
      platform.storage,
      'https://other-owner-origin.invalid',
    );
    assert.equal(otherStore.load(input.owner.accountId), null);
    app.community.pendingOwnerPostVisibility = otherStore;
    count = commands.length;
    h.tap('onOwnerVisibilityRetry');
    await until(
      () => !view(h).busy && !!view(h).error,
      'origin replacement blocker',
      h,
    );
    assert.equal(commands.length, count);
    assert.deepEqual(
      originalStore.load(input.owner.accountId),
      originalPending,
    );
    app.community.pendingOwnerPostVisibility = originalStore;
    close(h);
    h = mount('community-mine');
    await mineLoaded(h);
    await pending(h);
    h.tap('onOwnerVisibilityCancel');
    h.tap('onOwnerVisibilityConfirmCancel');
    await settled(h);
    await mineLoaded(h);
    assert.equal(journal(), null);
    assert.equal(
      h.page.data.publications.find((item) => item.id === input.postId)
        .ownerVisibility.ownerHidden,
      false,
    );
    close(h);
    login(input.reader);
    feed = mount('community-feed');
    await until(
      () => feed.page.data.loaded && !feed.page.data.busy,
      'restored other-account feed',
      feed,
    );
    assert.ok(feed.page.data.posts.some((post) => post.id === input.postId));
    close(feed);

    await send({
      event: 'done',
      cancelledRequestId: cancelled.clientRequestId,
      cancelRaceRequestId: cancelRace.clientRequestId,
      commands: commands.length,
      receiptReads: calls.filter(
        (call) =>
          call.method === 'GET' &&
          call.path.includes('/owner-visibility-requests/'),
      ).length,
      httpCalls: transport.exchanges.length,
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
