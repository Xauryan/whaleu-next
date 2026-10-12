/** Actual emitted App, registered Page handlers and rendered WXML. The native
 * platform bridge is synthetic; category HTTP responses come from AppModule/PG. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { mountEmittedPage } from '../../../../wechat/test/text-review-emitted-harness.mjs';
const require = createRequire(import.meta.url);
const dist = fileURLToPath(
  new URL('../../../../wechat/dist/', import.meta.url),
);
const emitted = (name) => require(`${dist}${name}.js`);
const {
  NativeExperienceTransport,
  nativeOrigin,
  platformStorage,
} = require('../../support/experience-native-bridge.ts');
const commandPath = '/v1/community/category-commands';
const journalPrefix = 'whaleu.category-reclassification.pending.v1:';
const send = (value) =>
  new Promise((resolve, reject) =>
    process.send(value, (error) => (error ? reject(error) : resolve())),
  );
let checkpointId = 0;
let httpDiagnostics = () => ({});
async function checkpoint(name, extra = {}) {
  const id = ++checkpointId;
  const answer = new Promise((resolve) => {
    const listener = (value) => {
      if (value.event === 'continue' && value.checkpointId === id) {
        process.off('message', listener);
        resolve(value);
      }
    };
    process.on('message', listener);
  });
  await send({ event: 'checkpoint', name, checkpointId: id, ...extra });
  assert.equal((await answer).name, name);
}
async function until(check, label, h) {
  const deadline = Date.now() + 25000;
  while (!check()) {
    assert.ok(
      Date.now() < deadline,
      `${label}: ${JSON.stringify({ category: h?.page.data.categoryManagement, error: h?.page.data.error, loaded: h?.page.data.loaded, busy: h?.page.data.busy, ...httpDiagnostics() })}`,
    );
    await delay(10);
  }
}
process.once('message', async (input) => {
  let app;
  const pages = new Set();
  try {
    const transport = new NativeExperienceTransport(input.port),
      platform = platformStorage();
    const commands = [],
      calls = [];
    const startedAt = Date.now();
    httpDiagnostics = () => ({
      inFlight: calls.filter(
        (call) =>
          call.state === 'in_flight' || call.state === 'awaiting_review',
      ),
      recentHttp: calls.slice(-24),
      realExchanges: transport.exchanges.slice(-24),
    });
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
          throw Error('Synthetic category journal readback failure');
        }
        return platform.getStorageSync(key);
      },
      setStorageSync(key, value) {
        if (failWrite && key.startsWith(journalPrefix))
          throw Error('Synthetic category journal write failure');
        platform.setStorageSync(key, value);
        if (failReadback && key.startsWith(journalPrefix))
          readbackPending = true;
      },
      request(options) {
        const path = new URL(options.url).pathname;
        const call = {
          path,
          method: options.method,
          startedMs: Date.now() - startedAt,
          state: 'in_flight',
        };
        calls.push(call);
        const categoryCommand =
          options.method === 'POST' && path === commandPath;
        if (categoryCommand) {
          const durable = app.community.pendingCategoryReclassification.load(
            input.admin.accountId,
          );
          assert.deepEqual(
            durable.command,
            options.data,
            'Exact command is persisted and read back before native dispatch',
          );
          commands.push(structuredClone(options.data));
        }
        // Accepted synthetic Review is independently inserted by the PG fixture
        // before forwarding this exact native request. No response is fabricated.
        if (categoryCommand) call.state = 'awaiting_review';
        const ready = categoryCommand
          ? checkpoint('approve-command', { command: options.data })
          : Promise.resolve();
        ready
          .then(() => {
            call.state = 'in_flight';
            return transport.send({
              url: options.url,
              method: options.method,
              headers: options.header,
              body: options.data,
              timeoutMs: options.timeout,
            });
          })
          .then(
            (response) => {
              Object.assign(call, {
                state: 'received',
                completedMs: Date.now() - startedAt,
                status: response.status,
                code: response.body?.error?.code ?? null,
                requestId: response.headers['x-request-id'] ?? null,
              });
              options.success({
                statusCode: response.status,
                header: response.headers,
                data: response.body,
              });
            },
            (error) => {
              Object.assign(call, {
                state: 'transport_failed',
                completedMs: Date.now() - startedAt,
                kind: error?.kind ?? error?.name ?? 'unknown',
              });
              options.fail({ errMsg: 'request:fail synthetic' });
            },
          );
        return { abort() {} }; // Late callbacks must be fenced by the real controllers.
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
    const mount = () => {
      const h = mountEmittedPage('community-detail', app, wx);
      pages.add(h);
      h.page.onLoad?.({ postId: input.postId });
      h.page.onShow?.();
      return h;
    };
    const close = (h) => {
      h.page.onHide?.();
      h.page.onUnload?.();
      pages.delete(h);
    };
    const view = (h) => h.page.data.categoryManagement;
    const loaded = (h) =>
      until(
        () =>
          h.page.data.loaded &&
          !h.page.data.busy &&
          !view(h).busy &&
          !!view(h).management,
        'detail and exact scoped management',
        h,
      );
    const settled = (h) =>
      until(
        () => !view(h).busy && !view(h).frozen && !!view(h).receiptStatus,
        'terminal category receipt',
        h,
      );
    const pending = (h) =>
      until(
        () => !view(h).busy && view(h).frozen,
        'durable uncertain original category request',
        h,
      );
    const journal = () =>
      app.community.pendingCategoryReclassification.load(input.admin.accountId);
    const prepare = async (h, category) => {
      h.tap('onCategoryChoose', { id: input.postId, category });
      await until(
        () => !view(h).busy && view(h).confirming === 'change',
        'current-target confirmation',
        h,
      );
      assert.equal(view(h).desired, category);
    };
    boot();
    login(input.admin);
    let h = mount();
    await loaded(h);
    assert.equal(view(h).management.currentCategory, 'pets');
    assert.equal(view(h).management.revision, 0);
    assert.deepEqual(
      view(h).management.targets,
      ['scenery'],
      'Only explicitly accepted directed target is rendered',
    );
    await prepare(h, 'scenery');
    h.tap('onCategorySubmit');
    h.page.onCategorySubmit();
    await settled(h);
    assert.equal(
      commands.length,
      1,
      'Duplicate tap cannot dispatch another request or key',
    );
    assert.equal(journal(), null);
    close(h);
    await checkpoint('moved-to-scenery');
    h = mount();
    await loaded(h);
    assert.equal(h.page.data.post.category, 'scenery');
    assert.equal(view(h).management.revision, 1);
    assert.deepEqual(view(h).management.targets, ['pets']);
    await prepare(h, 'pets');
    transport.dropSuccess = { path: commandPath, method: 'POST' };
    h.tap('onCategorySubmit');
    await pending(h);
    const lost = structuredClone(journal().command);
    assert.equal(lost.expectedRevision, 1);
    assert.equal(lost.targetCategory, 'pets');
    assert.equal(commands.length, 2);
    close(h);
    app.onHide();
    await checkpoint('hide-before-recovery');
    boot();
    login(input.admin);
    h = mount();
    await pending(h);
    await until(
      () => !h.page.data.busy && !!h.page.data.error,
      'owner-hidden public detail remains absent',
      h,
    );
    assert.equal(h.page.data.post, null);
    assert.equal(view(h).pendingRequestId, lost.clientRequestId);
    await until(
      () => !h.page.data.reportProgress.busy,
      'current target invalidation is settled',
      h,
    );
    const lateReceipt = transport.holdNext(
      `/v1/community/category-requests/${lost.clientRequestId}`,
    );
    h.tap('onCategoryRecover');
    await lateReceipt.arrived;
    login(input.reader);
    lateReceipt.release();
    await until(
      () => !view(h).busy && !view(h).recovering,
      'late receipt is fenced after account switch',
      h,
    );
    assert.deepEqual(
      journal().command,
      lost,
      'A former-account callback cannot settle its durable journal',
    );
    close(h);
    login(input.admin);
    h = mount();
    await pending(h);
    h.tap('onCategoryRecover');
    await settled(h);
    assert.equal(journal(), null);
    assert.equal(
      commands.length,
      2,
      'Cold recovery uses original key without redispatch',
    );
    assert.equal(
      h.page.data.post,
      null,
      'Receipt never bypasses owner visibility',
    );
    close(h);
    await checkpoint('restore-after-recovery');
    h = mount();
    await loaded(h);
    assert.equal(h.page.data.post.category, 'pets');
    assert.equal(view(h).management.revision, 2);

    // A failed local write cannot reach the mutation endpoint.
    await prepare(h, 'scenery');
    failWrite = true;
    const beforeWrite = commands.length;
    h.tap('onCategorySubmit');
    await until(
      () => !view(h).busy && !!view(h).error,
      'journal write failure shown',
      h,
    );
    failWrite = false;
    assert.equal(commands.length, beforeWrite);
    close(h);

    // A successful write followed by failed readback retains its exact key.
    h = mount();
    await loaded(h);
    await prepare(h, 'scenery');
    failReadback = true;
    h.tap('onCategorySubmit');
    await until(
      () => !view(h).busy && !!view(h).error,
      'journal readback failure shown',
      h,
    );
    failReadback = false;
    readbackPending = false;
    assert.equal(
      commands.length,
      beforeWrite,
      'Unverified persistence never dispatches',
    );
    const unsent = structuredClone(journal().command);
    assert.ok(unsent.clientRequestId);
    const { PendingCategoryReclassificationStore } = emitted(
      'category-reclassification/pending',
    );
    const { WechatStorage } = emitted('platform/wechat');
    const otherOrigin = new PendingCategoryReclassificationStore(
      new WechatStorage(wx),
      'https://other-native.invalid',
    );
    assert.equal(
      otherOrigin.load(input.admin.accountId),
      null,
      'Another API origin cannot adopt the original journal',
    );
    assert.deepEqual(journal().command, unsent);
    close(h);
    app.onHide();
    boot();
    login(input.reader);
    h = mount();
    await loaded(h);
    assert.equal(
      view(h).pendingRequestId,
      '',
      'Another account never adopts the admin journal',
    );
    assert.equal(view(h).management.canChange, false);
    assert.equal(h.button('bindtap', 'onCategoryChoose'), undefined);
    close(h);
    login(input.admin);
    h = mount();
    await pending(h);
    assert.equal(view(h).pendingRequestId, unsent.clientRequestId);
    h.tap('onCategoryRecover');
    await pending(h);
    await until(
      () => !view(h).recovering,
      'not-recorded observation settles without replacing key',
      h,
    );
    assert.equal(view(h).pendingRequestId, unsent.clientRequestId);
    assert.deepEqual(journal().command, unsent);
    assert.equal(commands.length, beforeWrite);
    h.tap('onCategoryCancel');
    assert.equal(view(h).confirming, 'cancel');
    transport.failNext = `/v1/community/category-requests/${unsent.clientRequestId}/cancel`;
    h.tap('onCategoryConfirmCancel');
    await pending(h);
    assert.equal(journal().phase, 'cancel');
    assert.deepEqual(journal().command, unsent);
    h.tap('onCategoryRetry');
    await settled(h);
    assert.equal(journal(), null);
    assert.equal(
      commands.length,
      2,
      'Cancel fences original unsent command rather than creating a move',
    );
    close(h);
    assert.deepEqual(
      commands.map((command) => command.expectedRevision),
      [0, 1],
    );
    assert.deepEqual(
      commands.map((command) => command.targetCategory),
      ['scenery', 'pets'],
    );
    await send({
      event: 'done',
      appliedCommands: commands.length,
      receiptReads: calls.filter(
        (call) =>
          call.method === 'GET' &&
          call.path.startsWith('/v1/community/category-requests/'),
      ).length,
      httpCalls: calls.length,
      cancelledRequestId: unsent.clientRequestId,
      lostRequestId: lost.clientRequestId,
    });
  } catch (error) {
    await send({
      event: 'failure',
      message: `${error?.stack ?? String(error)}\nHTTP diagnostics: ${JSON.stringify(httpDiagnostics())}`,
    });
    process.exitCode = 1;
  } finally {
    for (const h of pages) {
      h.page.onHide?.();
      h.page.onUnload?.();
    }
    app?.onHide?.();
    if (process.connected) process.disconnect();
  }
});
