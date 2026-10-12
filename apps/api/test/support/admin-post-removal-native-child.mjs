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
const commandPath = '/v1/community/admin-post-removal/commands';
const journalPrefix = 'whaleu.admin-post-removal.pending.v1:';
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
      navigations = [];
    const localFiles = new Map();
    let mediaReads = 0;
    let failJournal = '';
    let written = false;
    diagnostics = () => ({
      calls: calls.slice(-10),
      exchanges: transport.exchanges.slice(-10),
    });
    const wx = {
      ...platform,
      nextTick: queueMicrotask,
      navigateTo(options) {
        navigations.push(options.url);
        options.success?.();
      },
      getStorageSync(key) {
        if (
          failJournal === 'readback' &&
          written &&
          key.startsWith(journalPrefix)
        )
          throw Error('Synthetic readback failure');
        return platform.getStorageSync(key);
      },
      setStorageSync(key, value) {
        if (key.startsWith(journalPrefix)) {
          if (failJournal === 'write') throw Error('Synthetic write failure');
          if (failJournal === 'silent') return;
          written = true;
        }
        platform.setStorageSync(key, value);
      },
      removeStorageSync(key) {
        if (failJournal === 'remove' && key.startsWith(journalPrefix))
          throw Error('Synthetic remove failure');
        platform.removeStorageSync(key);
      },
      request(options) {
        const path = new URL(options.url).pathname;
        calls.push({ path, method: options.method });
        if (options.method === 'POST' && path.startsWith(commandPath)) {
          const durable = app.community.pendingAdminPostRemoval.load(
            input.admin.accountId,
          );
          assert.deepEqual(
            durable.command,
            options.data,
            'Exact intent persisted and read back before native dispatch',
          );
          assert.equal(
            durable.phase,
            path.endsWith('/cancel') ? 'cancel' : 'submit',
          );
          assert.deepEqual(Object.keys(options.data).sort(), [
            'action',
            'clientRequestId',
            'expectedTargetVersion',
            'target',
          ]);
          assert.deepEqual(Object.keys(options.data.target).sort(), [
            'id',
            'kind',
          ]);
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
        // Deliberately uncooperative I/O: stale callbacks must still be rejected.
        return { abort() {} };
      },
    };
    function boot(origin = nativeOrigin) {
      emitted('config').clientConfiguration = Object.freeze({
        apiOrigin: origin,
        providerLoginEnabled: true,
      });
      globalThis.wx = wx;
      globalThis.App = (value) => {
        app = value;
      };
      globalThis.getApp = () => app;
      delete require.cache[require.resolve(`${dist}app.js`)];
      emitted('app');
      app.onLaunch();
      // Test-only native file bridge: real authorized server bytes, synthetic
      // local handles. It does not enable the normal device download gate.
      const { MediaReadController } = emitted('media/read-controller');
      const { MediaGalleryController } = emitted('media/gallery-controller');
      const transfer = {
        async download(attachment, variant, _owner, principal, cancel) {
          const ticket = principal.current();
          assert.equal(cancel.isCancelled, false);
          const response = await fetch(
            `http://127.0.0.1:${input.mediaPort}/v1/media/bindings/${attachment.bindingId}/${variant}`,
            {
              headers: {
                Authorization: `Bearer ${ticket.credentials.accessToken}`,
              },
            },
          );
          assert.equal(
            response.status,
            200,
            'Real server authorizes bytes before display',
          );
          const bytes = new Uint8Array(await response.arrayBuffer());
          assert.ok(bytes.length > 0);
          principal.current();
          const file = { localId: `admin-removal-native-${++mediaReads}` };
          localFiles.set(file.localId, bytes);
          return file;
        },
        async resolve(file, _owner, ticket) {
          app.identity.sessions.assertCurrent(ticket);
          assert.ok(localFiles.has(file.localId));
          return `wxfile://${file.localId}`;
        },
        async release(file) {
          localFiles.delete(file.localId);
        },
      };
      app.mediaRead = {
        create: (render) =>
          new MediaReadController(
            app.identity.sessions,
            transfer,
            render,
            app.community.privateViews,
          ),
        createGallery: (render) =>
          new MediaGalleryController(
            app.identity.sessions,
            transfer,
            render,
            app.community.privateViews,
          ),
      };
    }
    const login = (actor) =>
      app.identity.sessions.completeLogin(
        app.identity.sessions.beginLogin(),
        actor,
      );
    function mount(name = 'admin-post-removal', query = {}) {
      const h = mountEmittedPage(name, app, wx);
      pages.add(h);
      h.page.onLoad?.(query);
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
        () => !h.page.data.busy && h.page.data.management?.canRemove === true,
        'current management',
        h,
      );
    const pending = (h) =>
      until(
        () =>
          !h.page.data.busy &&
          h.page.data.frozen &&
          !!h.page.data.pendingRequestId,
        'durable pending',
        h,
      );
    const settled = (h) =>
      until(
        () =>
          !h.page.data.busy &&
          !h.page.data.frozen &&
          !!h.page.data.receiptStatus,
        'exact terminal receipt',
        h,
      );
    const confirm = async (h) => {
      h.tap('onRemovePost');
      await until(
        () => !h.page.data.busy && h.page.data.confirming === 'remove',
        'fresh confirmation',
        h,
      );
      const words = h
        .nodes()
        .filter((node) => typeof node === 'string')
        .join('');
      assert.match(words, /评论、回复将不可访问/);
      assert.match(words, /私有系统通知/);
      assert.match(words, /没有恢复此帖/);
      assert.doesNotMatch(words, /school_admin|super_admin|作者账号/);
    };
    const detail = async (target) => {
      const h = mount('community-detail', { postId: target.id });
      await until(
        () => !h.page.data.busy && h.page.data.post?.id === target.id,
        'ordinary detail',
        h,
      );
      return h;
    };
    const fromDetail = async (target, authorMode) => {
      const d = await detail(target);
      assert.equal(d.page.data.post.author.kind, authorMode);
      assert.ok(d.button('bindtap', 'onAdminPostRemoval'));
      if (target.id === input.targets.image.id) {
        await until(
          () =>
            d.page.data.mediaRead.status === 'ready' &&
            !!d.page.data.mediaRead.localSrc,
          'real image bytes visible',
          d,
        );
        assert.ok(localFiles.size > 0);
      }
      d.tap('onAdminPostRemoval');
      assert.equal(
        d.page.data.mediaRead.localSrc,
        '',
        'Entering removal immediately revokes local media lease',
      );
      await until(
        () => localFiles.size === 0,
        'retire current local image handle',
        d,
      );
      const url = new URL(navigations.at(-1), nativeOrigin);
      assert.equal(
        url.pathname,
        '/pages/admin-post-removal/admin-post-removal',
      );
      assert.deepEqual(Object.fromEntries(url.searchParams), target);
      d.page.onHide();
      assert.equal(
        d.page.data.post,
        null,
        'Navigating away clears old post and discussion',
      );
      assert.deepEqual(d.page.data.comments, []);
      const h = mount(
        'admin-post-removal',
        Object.fromEntries(url.searchParams),
      );
      await loaded(h);
      return { d, h };
    };
    boot();
    login(input.admin);
    let { d, h } = await fromDetail(input.targets.named, 'named');
    await confirm(h);
    h.tap('onClose');
    h.page.onSubmit();
    await delay(20);
    assert.equal(commands.length, 0, 'Closing confirmation writes nothing');
    await confirm(h);
    transport.dropSuccess = { path: commandPath, method: 'POST' };
    h.tap('onSubmit');
    h.page.onSubmit();
    await pending(h);
    assert.equal(commands.length, 1, 'Double click has one original command');
    const lost = commands.at(-1).body;
    const lostHash = app.community.pendingAdminPostRemoval.load(
      input.admin.accountId,
    ).requestHash;
    close(h);
    close(d);
    app.onHide();
    await checkpoint('committed-loss-revoke-grant', {
      command: lost,
      requestHash: lostHash,
    });

    boot();
    login(input.stranger);
    h = mount();
    assert.equal(h.page.data.pendingRequestId, '');
    assert.equal(h.page.data.frozen, false);
    close(h);
    login(input.admin);
    const recoveryStart = calls.length;
    h = mount();
    await pending(h);
    h.tap('onRecover');
    await settled(h);
    assert.match(h.page.data.receiptStatus, /已确认删除帖子/);
    assert.equal(
      commands.length,
      1,
      'Cold recovery never repeats an applied mutation',
    );
    assert.ok(
      calls
        .slice(recoveryStart)
        .every((call) => call.path.includes('/requests/')),
    );
    close(h);
    await checkpoint('restore-grant-after-recovery');
    d = mount('community-detail', { postId: input.targets.named.id });
    await until(
      () => !d.page.data.busy && !!d.page.data.error,
      'Back to removed post',
      d,
    );
    assert.equal(d.page.data.post, null);
    assert.deepEqual(d.page.data.comments, []);
    assert.equal(d.page.data.mediaRead.localSrc ?? '', '');
    close(d);

    ({ d, h } = await fromDetail(input.targets.anonymous, 'anonymous'));
    await confirm(h);
    h.tap('onSubmit');
    await settled(h);
    assert.deepEqual(commands.at(-1).body.target, input.targets.anonymous);
    close(h);
    close(d);
    // Genuine reviewed image post goes through the same actual detail and command.
    ({ d, h } = await fromDetail(input.targets.image, 'named'));
    assert.ok(input.imageAssetId);
    await confirm(h);
    transport.dropSuccess = { path: commandPath, method: 'POST' };
    h.tap('onSubmit');
    await pending(h);
    const imageCommand = commands.at(-1).body;
    h.tap('onCancelRequest');
    h.tap('onConfirmCancel');
    await settled(h);
    assert.match(
      h.page.data.receiptStatus,
      /已确认删除帖子/,
      'Apply won: cancellation returns the immutable applied receipt',
    );
    assert.deepEqual(commands.at(-1).body, imageCommand);
    close(h);
    close(d);

    d = await detail(input.targets.own);
    assert.equal(d.page.data.post.viewer.isSelf, true);
    assert.equal(d.button('bindtap', 'onAdminPostRemoval'), undefined);
    assert.ok(d.button('bindtap', 'onDeletePost'));
    const ownCalls = calls.length;
    d.page.onAdminPostRemoval();
    assert.deepEqual(d.page.data.deleteTarget, {
      kind: 'post',
      id: input.targets.own.id,
    });
    assert.equal(
      calls.length,
      ownCalls,
      'Own target uses established owner confirmation, no management request',
    );
    close(d);
    h = mount('admin-post-removal', input.targets.own);
    await until(
      () => !h.page.data.busy && !!h.page.data.error,
      'own target server denial',
      h,
    );
    assert.equal(h.page.data.ownPost, true);
    assert.match(h.page.data.error, /删除我的帖子/);
    close(h);

    h = mount('admin-post-removal', input.targets.cancelled);
    await loaded(h);
    await confirm(h);
    transport.failNext = commandPath;
    h.tap('onSubmit');
    await pending(h);
    const cancelled = commands.at(-1).body,
      beforeRead = commands.length;
    h.tap('onRecover');
    await until(
      () => !h.page.data.busy && !h.page.data.recovering,
      'not recorded',
      h,
    );
    assert.equal(commands.length, beforeRead);
    assert.equal(h.page.data.pendingRequestId, cancelled.clientRequestId);
    h.tap('onCancelRequest');
    transport.dropSuccess = { path: `${commandPath}/cancel`, method: 'POST' };
    h.tap('onConfirmCancel');
    await pending(h);
    assert.equal(h.page.data.pendingPhase, 'cancel');
    close(h);
    app.onHide();
    boot();
    login(input.admin);
    h = mount();
    await pending(h);
    const beforeCancelRecovery = commands.length;
    h.tap('onRetry');
    await settled(h);
    assert.match(h.page.data.receiptStatus, /已取消/);
    assert.equal(commands.length, beforeCancelRecovery);
    close(h);
    await checkpoint('cancelled-late-original', { command: cancelled });

    h = mount('admin-post-removal', input.targets.retry);
    await loaded(h);
    await confirm(h);
    transport.failNext = commandPath;
    h.tap('onSubmit');
    await pending(h);
    const retry = commands.at(-1).body;
    h.tap('onRetry');
    await settled(h);
    assert.deepEqual(
      commands.at(-1).body,
      retry,
      'Explicit not-recorded retry preserves every original byte',
    );
    close(h);

    h = mount('admin-post-removal', input.targets.stale);
    await loaded(h);
    await confirm(h);
    await checkpoint('readable-target-version-change', {
      target: input.targets.stale,
      version: h.page.data.management.targetVersion,
    });
    h.tap('onSubmit');
    await settled(h);
    const stale = commands.at(-1).body;
    assert.match(h.page.data.receiptStatus, /帖子状态已变化/);
    assert.equal(h.page.data.confirming, null);
    close(h);

    h = mount('admin-post-removal', input.targets.late);
    await loaded(h);
    await confirm(h);
    const lateResponse = transport.holdNext(commandPath, 'POST');
    h.tap('onSubmit');
    await lateResponse.arrived;
    const late = commands.at(-1).body;
    login(input.stranger);
    lateResponse.release();
    await delay(30);
    assert.equal(h.page.data.receiptStatus, '');
    assert.equal(h.page.data.management, null);
    assert.ok(
      app.community.pendingAdminPostRemoval.load(input.admin.accountId),
    );
    close(h);
    app.onHide();
    const beforeOrigin = calls.length;
    boot('https://other-native-environment.invalid');
    login(input.admin);
    h = mount();
    await delay(20);
    assert.equal(h.page.data.pendingRequestId, '');
    assert.equal(calls.length, beforeOrigin);
    close(h);
    app.onHide();
    boot();
    login(input.admin);
    h = mount();
    await pending(h);
    const lateRead = transport.holdNext(
      `/v1/community/admin-post-removal/requests/${late.clientRequestId}`,
    );
    h.tap('onRecover');
    await lateRead.arrived;
    login(input.admin);
    lateRead.release();
    await delay(30);
    assert.equal(
      h.page.data.receiptStatus,
      '',
      'Same-account replacement generation rejects old callback',
    );
    assert.ok(
      app.community.pendingAdminPostRemoval.load(input.admin.accountId),
    );
    h.tap('onReload');
    await pending(h);
    h.tap('onRecover');
    await settled(h);
    close(h);

    // Failed first persistence never reaches HTTP; readback failure keeps a recoverable original.
    for (const mode of ['write', 'silent', 'readback']) {
      h = mount('admin-post-removal', input.targets.storage);
      await loaded(h);
      await confirm(h);
      written = false;
      failJournal = mode;
      const beforeFailure = commands.length;
      h.tap('onSubmit');
      await until(
        () => !h.page.data.busy && !!h.page.data.error,
        `${mode} storage failure`,
        h,
      );
      failJournal = '';
      assert.equal(commands.length, beforeFailure);
      h.tap('onReload');
      await until(() => !h.page.data.busy, 'reconcile storage failure', h);
      if (h.page.data.frozen) {
        h.tap('onCancelRequest');
        h.tap('onConfirmCancel');
        await settled(h);
      }
      close(h);
    }
    h = mount('admin-post-removal', input.targets.storage);
    await loaded(h);
    await confirm(h);
    failJournal = 'remove';
    h.tap('onSubmit');
    await until(
      () =>
        !h.page.data.busy && h.page.data.frozen && !!h.page.data.receiptStatus,
      'known applied with local remove failure',
      h,
    );
    assert.match(h.page.data.receiptStatus, /已确认帖子删除/);
    assert.equal(h.page.data.management, null);
    failJournal = '';
    h.tap('onRecover');
    await settled(h);
    close(h);

    login(input.subject);
    h = mount('system-notices');
    await until(
      () => h.page.data.loaded && !h.page.data.busy,
      'owner system notices',
      h,
    );
    const notices = h.page.data.items;
    assert.equal(notices.length, 6);
    for (const notice of notices) {
      assert.equal(notice.kind, 'admin_post_removed');
      assert.deepEqual(Object.keys(notice).sort(), [
        'createdAt',
        'kind',
        'noticeId',
        'readAt',
      ]);
    }
    const nodes = h.nodes();
    assert.match(
      nodes.filter((n) => typeof n === 'string').join(''),
      /你的帖子已被管理员删除/,
    );
    assert.ok(
      !nodes.some((n) => typeof n !== 'string' && n.tag === 'navigator'),
      'No deleted-content or author link in own notice',
    );
    h.tap('onRead', { id: notices[0].noticeId });
    await until(
      () => !h.page.data.busy && h.page.data.items[0].readAt !== null,
      'mark only original notice',
      h,
    );
    const readAt = h.page.data.items[0].readAt;
    h.page.onRead({ currentTarget: { dataset: { id: notices[0].noticeId } } });
    await until(() => !h.page.data.busy, 'stable repeated read', h);
    assert.equal(h.page.data.items[0].readAt, readAt);
    assert.equal(h.page.data.unreadCount, 5);
    close(h);
    login(input.stranger);
    h = mount('system-notices');
    await until(
      () => h.page.data.loaded && !h.page.data.busy,
      'non-owner notices',
      h,
    );
    assert.equal(h.page.data.items.length, 0);
    close(h);
    assert.ok(!calls.some((call) => call.path.includes('/identity-view')));
    assert.ok(
      !calls.some((call) => call.path.startsWith('/v1/identity-privacy/')),
      'Ordinary post administration never opens private content identities',
    );
    await send({
      event: 'done',
      firstRequestId: lost.clientRequestId,
      cancelledRequestId: cancelled.clientRequestId,
      staleRequestId: stale.clientRequestId,
      retryRequestId: retry.clientRequestId,
      lateRequestId: late.clientRequestId,
      commands: commands.length,
      httpCalls: transport.exchanges.length,
      receiptReads: calls.filter((call) =>
        call.path.includes('/admin-post-removal/requests/'),
      ).length,
      mediaReads,
      noticeCount: notices.length,
      readNoticeId: notices[0].noticeId,
      readAt,
    });
  } catch (error) {
    await send({ event: 'failure', message: error?.stack ?? String(error) });
  } finally {
    for (const h of pages) {
      h.page.onHide?.();
      h.page.onUnload?.();
    }
    app?.onHide?.();
    process.disconnect();
  }
});
