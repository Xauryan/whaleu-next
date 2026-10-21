/** Actual emitted App/Page/WXML over loopback; only native platform callbacks are synthetic. */
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
} = require('./experience-native-bridge.ts');
const commandPath = '/v1/community/profile-moderation/commands';
const journalPrefix = 'whaleu.profile-moderation.pending.v1:';
const send = (value) =>
  new Promise((resolve, reject) =>
    process.send(value, (error) => (error ? reject(error) : resolve())),
  );
let checkpointId = 0;
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
let diagnostics = () => ({});
async function until(check, label, h) {
  const deadline = Date.now() + 25000;
  while (!check()) {
    assert.ok(
      Date.now() < deadline,
      `${label}: ${JSON.stringify({ view: h?.page.data, ...diagnostics() })}`,
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
      calls = [],
      responses = [];
    let failJournal = false;
    diagnostics = () => ({
      calls: calls.slice(-12),
      exchanges: transport.exchanges.slice(-12),
    });
    transport.checkResponse = (path, status, body) => {
      if (path.startsWith(commandPath) && status === 200)
        responses.push(structuredClone(body));
    };
    const wx = {
      ...platform,
      nextTick: queueMicrotask,
      navigateTo: (options) => options.success?.(),
      setStorageSync(key, value) {
        if (failJournal && key.startsWith(journalPrefix))
          throw Error('Synthetic journal write failure');
        platform.setStorageSync(key, value);
      },
      request(options) {
        const path = new URL(options.url).pathname;
        calls.push({ path, method: options.method });
        if (options.method === 'POST' && path.startsWith(commandPath)) {
          const durable = app.community.pendingProfileModeration.load(
            input.admin.accountId,
          );
          assert.deepEqual(
            durable.command,
            options.data,
            'Exact command is persisted and read back before native dispatch',
          );
          assert.equal(
            durable.phase,
            path.endsWith('/cancel') ? 'cancel' : 'submit',
          );
          commands.push({ path, body: structuredClone(options.data) });
        }
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
        return { abort() {} };
      },
    };
    emitted('config').clientConfiguration = Object.freeze({
      apiOrigin: nativeOrigin,
      providerLoginEnabled: true,
    });
    function boot() {
      globalThis.wx = wx;
      globalThis.App = (value) => {
        app = value;
      };
      globalThis.getApp = () => app;
      delete require.cache[require.resolve(`${dist}app.js`)];
      emitted('app');
      app.onLaunch();
    }
    const login = (actor) =>
      app.identity.sessions.completeLogin(
        app.identity.sessions.beginLogin(),
        actor,
      );
    function mount(target) {
      const h = mountEmittedPage('profile-moderation', app, wx);
      pages.add(h);
      h.page.onLoad(target ?? {});
      h.page.onShow();
      return h;
    }
    function close(h) {
      h.page.onHide();
      h.page.onUnload();
      pages.delete(h);
    }
    const loaded = (h) =>
      until(
        () => !h.page.data.busy && h.page.data.management?.canReset === true,
        'current management',
        h,
      );
    const pending = (h) =>
      until(
        () =>
          !h.page.data.busy &&
          h.page.data.frozen &&
          !!h.page.data.pendingRequestId,
        'durable pending journal',
        h,
      );
    const settled = (h) =>
      until(
        () =>
          !h.page.data.busy &&
          !h.page.data.frozen &&
          !!h.page.data.receiptStatus,
        'terminal exact receipt',
        h,
      );
    const confirm = async (h) => {
      h.tap('onResetNickname');
      await until(
        () => !h.page.data.busy && h.page.data.confirming === 'reset',
        'fresh confirmation',
        h,
      );
      const words = h
        .nodes()
        .filter((node) => typeof node === 'string')
        .join('');
      assert.match(words, /其他地区/);
      assert.match(words, /私有系统通知/);
      assert.match(words, /分身保持不变/);
    };

    boot();
    login(input.admin);
    let h = mount(input.postTarget);
    await loaded(h);
    await confirm(h);
    h.tap('onClose');
    assert.equal(h.page.data.confirming, null);
    assert.equal(commands.length, 0, 'Closing confirmation makes no command');
    await confirm(h);
    transport.dropSuccess = { path: commandPath, method: 'POST' };
    h.tap('onSubmit');
    await pending(h);
    const lost = commands.at(-1).body;
    assert.deepEqual(lost.target, input.postTarget);
    close(h);
    app.onHide();
    await checkpoint('hide-after-committed-loss', { command: lost });

    boot();
    login(input.stranger);
    h = mount();
    assert.equal(
      h.page.data.frozen,
      false,
      'Other account cannot see the original journal',
    );
    assert.equal(h.page.data.pendingRequestId, '');
    close(h);
    login(input.admin);
    const recoveryStart = calls.length;
    h = mount();
    await pending(h);
    assert.equal(h.page.data.management, null);
    assert.equal(h.page.data.target, null);
    h.tap('onRecover');
    await settled(h);
    assert.match(h.page.data.receiptStatus, /已确认公开昵称重置/);
    assert.equal(
      commands.length,
      1,
      'Cold receipt recovery never resubmits a committed command',
    );
    assert.equal(
      app.community.pendingProfileModeration.load(input.admin.accountId),
      null,
    );
    assert.ok(
      calls
        .slice(recoveryStart)
        .every((call) =>
          call.path.startsWith('/v1/community/profile-moderation/requests/'),
        ),
      'Recovery-only Page does not require a management or content read',
    );
    close(h);
    await checkpoint('restore-after-cold-recovery', {
      requestId: lost.clientRequestId,
    });

    for (const target of [input.commentTarget, input.replyTarget]) {
      h = mount(target);
      await loaded(h);
      await confirm(h);
      h.tap('onSubmit');
      await settled(h);
      assert.match(h.page.data.receiptStatus, /已确认公开昵称重置/);
      assert.deepEqual(commands.at(-1).body.target, target);
      close(h);
    }
    await checkpoint('three-kinds-applied');

    h = mount(input.postTarget);
    await loaded(h);
    await confirm(h);
    transport.failNext = commandPath;
    h.tap('onSubmit');
    await pending(h);
    const cancelled = commands.at(-1).body;
    const commandsBeforeRead = commands.length;
    h.tap('onRecover');
    await until(
      () => !h.page.data.busy && !h.page.data.recovering,
      'not-recorded observation',
      h,
    );
    assert.equal(h.page.data.frozen, true);
    assert.equal(h.page.data.pendingRequestId, cancelled.clientRequestId);
    assert.equal(
      commands.length,
      commandsBeforeRead,
      'not_recorded never authorizes a replacement key',
    );
    h.tap('onCancelRequest');
    assert.equal(h.page.data.confirming, 'cancel');
    transport.dropSuccess = { path: `${commandPath}/cancel`, method: 'POST' };
    h.tap('onConfirmCancel');
    await pending(h);
    assert.equal(h.page.data.pendingPhase, 'cancel');
    assert.deepEqual(commands.at(-1).body, cancelled);
    close(h);
    app.onHide();
    boot();
    login(input.admin);
    h = mount();
    await pending(h);
    const beforeRetry = commands.length;
    h.tap('onRetry');
    await settled(h);
    assert.match(h.page.data.receiptStatus, /已取消/);
    assert.equal(
      commands.length,
      beforeRetry,
      'Recorded cancellation recovery does not recreate a request',
    );
    close(h);

    h = mount(input.postTarget);
    await loaded(h);
    await confirm(h);
    await checkpoint('owner-edit-before-native-submit', {
      expectedRevision: h.page.data.management.revision,
    });
    h.tap('onSubmit');
    await settled(h);
    assert.match(h.page.data.receiptStatus, /资料版本已变化/);
    const stale = commands.at(-1).body;
    assert.equal(
      app.community.pendingProfileModeration.load(input.admin.accountId),
      null,
    );
    assert.equal(
      h.page.data.confirming,
      null,
      'Stale management cannot authorize an automatic fresh reset',
    );
    close(h);

    h = mount(input.postTarget);
    await loaded(h);
    await confirm(h);
    const beforeStorageFailure = commands.length;
    failJournal = true;
    h.tap('onSubmit');
    await until(
      () => !h.page.data.busy && !!h.page.data.error,
      'storage failure',
      h,
    );
    failJournal = false;
    assert.equal(
      commands.length,
      beforeStorageFailure,
      'Failed durable journal never dispatches',
    );
    close(h);

    await send({
      event: 'done',
      firstRequestId: lost.clientRequestId,
      cancelledRequestId: cancelled.clientRequestId,
      staleRequestId: stale.clientRequestId,
      nativeCommands: commands.length,
      receiptReads: calls.filter((call) =>
        call.path.includes('/profile-moderation/requests/'),
      ).length,
      httpCalls: transport.exchanges.length,
      targetKinds: [
        ...new Set(commands.map((entry) => entry.body.target.kind)),
      ].sort(),
      outcomes: responses.map((response) => response.outcome),
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
