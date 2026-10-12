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
const commandPath = '/v1/community/profile-avatar-moderation/commands';
const journalPrefix = 'whaleu.profile-avatar-moderation.pending.v1:';
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
          const durable = app.community.pendingProfileAvatarModeration.load(
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
      const h = mountEmittedPage('profile-avatar-moderation', app, wx);
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
        () =>
          !h.page.data.busy &&
          h.page.data.management?.canClearCustomAvatar === true,
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
      h.tap('onClearCustomAvatar');
      await until(
        () => !h.page.data.busy && h.page.data.confirming === 'clear',
        'fresh confirmation',
        h,
      );
      const words = h
        .nodes()
        .filter((node) => typeof node === 'string')
        .join('');
      assert.match(words, /其他地区/);
      assert.match(words, /私有系统通知/);
      assert.match(words, /匿名分身保持不变/);
      assert.match(words, /清除后显示未选择头像/);
      assert.doesNotMatch(words, /随机默认|91 项/);
    };

    boot();
    login(input.admin);
    // The source is a real synthetic upload/Review and real HTTP bytes. Only
    // the local file handle and native display are bounded platform simulation.
    const { ApiClient } = emitted('api/client');
    const { HttpAvatarGateway } = emitted('profile/avatar-gateway');
    const { createProfileAvatarRuntime } = emitted('profile/avatar-runtime');
    const { NamedAvatarController } = emitted('profile/named-avatar');
    const { systemClock } = emitted('platform/clock');
    const avatarTransport = new NativeExperienceTransport(input.customPort);
    const avatarApi = new ApiClient(
      nativeOrigin,
      avatarTransport,
      app.identity.sessions,
      {
        refresh: async () => {
          throw Error('No test auth replay');
        },
      },
    );
    const localFiles = new Map();
    let localCounter = 0,
      namedView;
    app.profileAvatar.hide();
    app.profileAvatar = createProfileAvatarRuntime({
      sessions: app.identity.sessions,
      storage: {
        get: platform.getStorageSync,
        set: platform.setStorageSync,
        remove: platform.removeStorageSync,
      },
      origin: nativeOrigin,
      clock: systemClock,
      newRequestId: app.community.newRequestId,
      privateViews: app.community.privateViews,
      gateway: new HttpAvatarGateway(avatarApi),
      download: {
        async download(current, variant, _owner, principal, cancel) {
          principal.current();
          assert.equal(cancel.isCancelled, false);
          const response = await fetch(
            `http://127.0.0.1:${input.customPort}/v1/profiles/${current.profileId}/avatar/${current.avatar.appearanceId}/${variant}`,
            { headers: { Authorization: `Bearer ${input.admin.accessToken}` } },
          );
          assert.equal(response.status, 200);
          const bytes = new Uint8Array(await response.arrayBuffer());
          assert.ok(bytes.length > 0);
          principal.current();
          const file = { localId: `avatar-clear-native-${++localCounter}` };
          localFiles.set(file.localId, bytes);
          return file;
        },
        async resolve(file) {
          assert.ok(localFiles.has(file.localId));
          return `wxfile://${file.localId}`;
        },
        async release(file) {
          localFiles.delete(file.localId);
        },
      },
    });
    const named = new NamedAvatarController(app.profileAvatar, (view) => {
      namedView = view;
    });
    await named.open(input.subjectAuthor);
    assert.equal(namedView.status, 'ready');
    assert.ok(namedView.localSrc);
    let h = mount(input.postTarget);
    assert.equal(
      namedView.localSrc,
      '',
      'Entering management clears the old local avatar lease',
    );
    assert.equal(localFiles.size, 0);
    await loaded(h);
    await confirm(h);
    await named.open(input.subjectAuthor);
    assert.ok(namedView.localSrc);
    h.tap('onClose');
    assert.equal(
      namedView.localSrc,
      '',
      'Close also clears the local avatar lease',
    );
    assert.equal(h.page.data.confirming, null);
    assert.equal(commands.length, 0, 'Closing confirmation makes no command');
    await confirm(h);
    await named.open(input.subjectAuthor);
    assert.ok(namedView.localSrc);
    transport.dropSuccess = { path: commandPath, method: 'POST' };
    h.tap('onSubmit');
    assert.equal(
      namedView.localSrc,
      '',
      'Submission synchronously revokes any old local display',
    );
    assert.equal(localFiles.size, 0);
    // A queued native second tap must be rejected even after WXML disables it.
    h.page.onSubmit();
    await pending(h);
    assert.equal(
      commands.length,
      1,
      'Double tap dispatches one durable command',
    );
    const lost = commands.at(-1).body;
    const lostHash = app.community.pendingProfileAvatarModeration.load(
      input.admin.accountId,
    ).requestHash;
    assert.deepEqual(lost.target, input.postTarget);
    close(h);
    app.onHide();
    await named.open(input.subjectAuthor);
    assert.equal(
      namedView.status,
      'none',
      'Fresh named read sees cleared avatar',
    );
    assert.equal(namedView.localSrc, '');
    named.dispose();
    await checkpoint('hide-after-committed-loss', {
      command: lost,
      requestHash: lostHash,
    });

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
    assert.match(h.page.data.receiptStatus, /已确认清除当前自定义头像/);
    assert.equal(
      commands.length,
      1,
      'Cold receipt recovery never resubmits a committed command',
    );
    assert.equal(
      app.community.pendingProfileAvatarModeration.load(input.admin.accountId),
      null,
    );
    assert.ok(
      calls
        .slice(recoveryStart)
        .every((call) =>
          call.path.startsWith(
            '/v1/community/profile-avatar-moderation/requests/',
          ),
        ),
      'Recovery-only Page does not require a management or content read',
    );
    close(h);
    await checkpoint('restore-after-cold-recovery', {
      requestId: lost.clientRequestId,
    });

    for (const target of [input.commentTarget, input.replyTarget]) {
      await checkpoint('owner-selects-fresh-custom', { target });
      h = mount(target);
      await loaded(h);
      await confirm(h);
      h.tap('onSubmit');
      await settled(h);
      assert.match(h.page.data.receiptStatus, /已确认清除当前自定义头像/);
      assert.deepEqual(commands.at(-1).body.target, target);
      close(h);
    }
    await checkpoint('three-kinds-applied');
    h = mount(input.postTarget);
    await until(
      () => !h.page.data.busy && h.page.data.loaded,
      'none management',
      h,
    );
    assert.equal(h.page.data.management.canClearCustomAvatar, false);
    assert.equal(h.page.data.management.expectedAppearanceId, null);
    h.page.onClearCustomAvatar();
    await until(() => !h.page.data.busy, 'none action cannot confirm', h);
    assert.equal(h.page.data.confirming, null);
    close(h);
    await checkpoint('owner-selects-fresh-custom');

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
      app.community.pendingProfileAvatarModeration.load(input.admin.accountId),
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

    // Owner-only notice rendering uses the emitted Page and real HTTP.
    login(input.subject);
    const notice = mountEmittedPage('system-notices', app, wx);
    pages.add(notice);
    notice.page.onLoad?.({});
    notice.page.onShow();
    await until(
      () => !notice.page.data.busy && notice.page.data.items.length === 3,
      'owner private notices',
      notice,
    );
    assert.ok(
      notice.page.data.items.every(
        (item) => item.kind === 'profile_custom_avatar_cleared',
      ),
    );
    const noticeWords = notice
      .nodes()
      .filter((node) => typeof node === 'string')
      .join('');
    assert.match(noticeWords, /自定义头像已被管理员清除/);
    assert.doesNotMatch(noticeWords, /违规昵称|保留 .*票/);
    close(notice);

    await send({
      event: 'done',
      firstRequestId: lost.clientRequestId,
      cancelledRequestId: cancelled.clientRequestId,
      staleRequestId: stale.clientRequestId,
      nativeCommands: commands.length,
      receiptReads: calls.filter((call) =>
        call.path.includes('/profile-avatar-moderation/requests/'),
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
