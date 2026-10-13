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
const commandPath = '/v1/community/admin-discussion-removal/commands';
const journalPrefix = 'whaleu.admin-discussion-removal.pending.v1:';
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
          const durable = app.community.pendingAdminDiscussionRemoval.load(
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
    function mount(name = 'admin-discussion-removal', query = {}) {
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
      h.tap('onRemoveDiscussion');
      await until(
        () => !h.page.data.busy && h.page.data.confirming === 'remove',
        'fresh confirmation',
        h,
      );
      const words = h
        .nodes()
        .filter((node) => typeof node === 'string')
        .join('');
      assert.match(
        words,
        input.kind === 'comment'
          ? /该根评论及其全部回复将不可访问/
          : /仅删除选中的这条回复/,
      );
      assert.match(words, /不会通知作者/);
      assert.match(words, /没有恢复此内容/);
      assert.doesNotMatch(words, /私有系统通知|已通知作者/);
      assert.doesNotMatch(words, /school_admin|super_admin|作者账号/);
    };
    const detail = async (target, located = true) => {
      const route = input.routes[target.id];
      const h = mount('community-detail', {
        postId: route.postId,
        ...(located
          ? target.kind === 'comment'
            ? { rootCommentId: target.id }
            : { replyId: target.id }
          : {}),
      });
      await until(
        () => !h.page.data.busy && h.page.data.post?.id === route.postId,
        'ordinary detail',
        h,
      );
      return h;
    };
    const thread = async (target) => {
      const route = input.routes[target.id];
      const h = mount('community-thread', {
        postId: route.postId,
        rootCommentId: route.rootId,
        ...(target.kind === 'reply' ? { replyId: target.id } : {}),
      });
      await until(
        () => !h.page.data.busy && h.page.data.root?.id === route.rootId,
        'ordinary thread',
        h,
      );
      return h;
    };
    const selected = (d, target) =>
      target.kind === 'comment'
        ? [
            ...(d.page.data.comments ?? []),
            d.page.data.locatedComment,
            d.page.data.root,
          ].find((row) => row?.id === target.id)
        : [
            ...(d.page.data.comments ?? []).flatMap(
              (row) => row.replyPreview.items,
            ),
            ...(d.page.data.replies ?? []),
            ...(d.page.data.contextReplies ?? []),
            d.page.data.locatedReply,
          ].find((row) => row?.id === target.id);
    const fromSource = async (target, authorMode, surface = 'detail') => {
      const d = await (surface === 'detail' ? detail(target) : thread(target));
      assert.equal(selected(d, target)?.author.kind, authorMode);
      assert.ok(
        d
          .nodes()
          .some(
            (node) =>
              typeof node !== 'string' &&
              node.attrs.bindtap === 'onAdminDiscussionRemoval' &&
              node.attrs['data-kind'] === target.kind &&
              node.attrs['data-id'] === target.id,
          ),
      );
      if (target.id === input.targets.image.id) {
        d.tap('onSelectGallery', target);
        await until(
          () =>
            d.page.data.mediaGallery.slots.some(
              (slot) => slot.status === 'ready' && slot.localSrc,
            ),
          'real discussion image bytes visible',
          d,
        );
        assert.ok(localFiles.size > 0);
      }
      d.tap('onAdminDiscussionRemoval', {
        ...target,
        ...(surface === 'detail'
          ? {
              surface:
                target.kind === 'comment' ? 'located-comment' : 'located-reply',
            }
          : {}),
      });
      assert.equal(
        d.page.data.mediaGallery.groupId,
        '',
        'Navigation revokes child gallery before callback',
      );
      assert.equal(
        d.page.data.mediaRead?.localSrc ?? '',
        '',
        'Navigation revokes parent image too',
      );
      await until(
        () => localFiles.size === 0,
        'retire current image handles',
        d,
      );
      const url = new URL(navigations.at(-1), nativeOrigin);
      assert.equal(
        url.pathname,
        '/pages/admin-discussion-removal/admin-discussion-removal',
      );
      assert.deepEqual(Object.fromEntries(url.searchParams), target);
      d.page.onHide();
      assert.equal(
        d.page.data.post,
        null,
        'Navigation clears the old post and discussion DTOs',
      );
      assert.equal(d.page.data.locatedReply ?? null, null);
      const h = mount(
        'admin-discussion-removal',
        Object.fromEntries(url.searchParams),
      );
      await loaded(h);
      return { d, h };
    };
    boot();
    login(input.admin);
    let { d, h } = await fromSource(input.targets.named, 'named');
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
    const lostHash = app.community.pendingAdminDiscussionRemoval.load(
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
    const reportPath = `/v1/me/safety/report-progress/${input.kind}/${input.targets.named.id}`;
    const lateReport = transport.holdNext(reportPath);
    const reportPage = mount('report-progress', input.targets.named);
    await lateReport.arrived;
    h = mount();
    await pending(h);
    const receiptPath = `/v1/community/admin-discussion-removal/requests/${lost.clientRequestId}`;
    const interruptedRead = transport.holdNext(receiptPath);
    h.tap('onRecover');
    await interruptedRead.arrived;
    const beforeDenial = commands.length;
    lateReport.release();
    await settled(h);
    interruptedRead.release();
    await delay(30);
    assert.match(h.page.data.receiptStatus, new RegExp('已确认删除评论/回复'));
    assert.equal(
      commands.length,
      beforeDenial,
      'Linked visibility denial resumes GET only',
    );
    assert.equal(
      commands.length,
      1,
      'Cold recovery never repeats an applied mutation',
    );
    assert.ok(
      calls
        .slice(recoveryStart)
        .filter((call) => call.path.includes('/admin-discussion-removal/'))
        .every((call) => call.path === receiptPath && call.method === 'GET'),
    );
    assert.equal(
      calls.slice(recoveryStart).filter((call) => call.path === receiptPath)
        .length,
      2,
    );
    close(reportPage);
    close(h);
    await checkpoint('restore-grant-after-recovery');
    d = await detail(input.targets.named, false);
    assert.ok(
      d.page.data.post,
      'The parent remains readable after child removal',
    );
    assert.ok(
      !d.page.data.comments.some((row) => row.id === input.targets.named.id),
    );
    close(d);
    d = mount('community-thread', {
      postId: input.routes[input.targets.named.id].postId,
      rootCommentId: input.routes[input.targets.named.id].rootId,
      ...(input.kind === 'reply' ? { replyId: input.targets.named.id } : {}),
    });
    await until(
      () => !d.page.data.busy && !!d.page.data.error,
      'Back to removed root or located reply',
      d,
    );
    assert.equal(d.page.data.root, null);
    assert.equal(d.page.data.locatedReply, null);
    assert.deepEqual(d.page.data.replies, []);
    close(d);

    ({ d, h } = await fromSource(
      input.targets.anonymous,
      'anonymous',
      'thread',
    ));
    await confirm(h);
    h.tap('onSubmit');
    await settled(h);
    assert.deepEqual(commands.at(-1).body.target, input.targets.anonymous);
    close(h);
    close(d);
    // Genuine reviewed image-only child goes through actual Thread and command.
    ({ d, h } = await fromSource(input.targets.image, 'named', 'thread'));
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
      /已确认删除评论\/回复/,
      'Apply won: cancellation returns the immutable applied receipt',
    );
    assert.deepEqual(commands.at(-1).body, imageCommand);
    close(h);
    close(d);

    d = await (input.kind === 'comment'
      ? detail(input.targets.own)
      : thread(input.targets.own));
    assert.equal(selected(d, input.targets.own).viewer.isSelf, true);
    assert.ok(
      !d
        .nodes()
        .some(
          (node) =>
            typeof node !== 'string' &&
            node.attrs.bindtap === 'onAdminDiscussionRemoval' &&
            node.attrs['data-id'] === input.targets.own.id,
        ),
    );
    assert.ok(
      d.button(
        'bindtap',
        input.kind === 'comment' ? 'onDeleteComment' : 'onDeleteReply',
      ),
    );
    const ownCalls = calls.length;
    d.page.onAdminDiscussionRemoval({
      currentTarget: { dataset: input.targets.own },
    });
    if (input.kind === 'comment')
      assert.deepEqual(d.page.data.deleteTarget, input.targets.own);
    else assert.equal(d.page.data.deleteReplyId, input.targets.own.id);
    assert.equal(
      calls.length,
      ownCalls,
      'Own selected child uses its existing owner confirmation only',
    );
    close(d);
    h = mount('admin-discussion-removal', input.targets.own);
    await until(
      () => !h.page.data.busy && !!h.page.data.error,
      'own selected child server denial',
      h,
    );
    assert.equal(h.page.data.ownContent, true);
    assert.match(h.page.data.error, /删除我的评论|删除我的回复/);
    close(h);

    h = mount('admin-discussion-removal', input.targets.cancelled);
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

    h = mount('admin-discussion-removal', input.targets.retry);
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

    h = mount('admin-discussion-removal', input.targets.stale);
    await loaded(h);
    await confirm(h);
    await checkpoint('readable-target-version-change', {
      target: input.targets.stale,
      version: h.page.data.management.targetVersion,
    });
    h.tap('onSubmit');
    await settled(h);
    const stale = commands.at(-1).body;
    assert.match(h.page.data.receiptStatus, /评论\/回复状态已变化/);
    assert.equal(h.page.data.confirming, null);
    close(h);

    h = mount('admin-discussion-removal', input.targets.late);
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
      app.community.pendingAdminDiscussionRemoval.load(input.admin.accountId),
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
      `/v1/community/admin-discussion-removal/requests/${late.clientRequestId}`,
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
      app.community.pendingAdminDiscussionRemoval.load(input.admin.accountId),
    );
    h.tap('onReload');
    await pending(h);
    h.tap('onRecover');
    await settled(h);
    close(h);

    // Failed first persistence never reaches HTTP; readback failure keeps a recoverable original.
    for (const mode of ['write', 'silent', 'readback']) {
      h = mount('admin-discussion-removal', input.targets.storage);
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
    h = mount('admin-discussion-removal', input.targets.storage);
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
    assert.match(h.page.data.receiptStatus, /已确认评论\/回复删除/);
    assert.equal(h.page.data.management, null);
    failJournal = '';
    h.tap('onRecover');
    await settled(h);
    close(h);

    let notices = [];
    for (const actor of [input.subject, input.admin, input.stranger]) {
      login(actor);
      h = mount('system-notices');
      await until(
        () => h.page.data.loaded && !h.page.data.busy,
        'unchanged system notices',
        h,
      );
      notices = h.page.data.items;
      assert.deepEqual(notices, []);
      assert.equal(h.page.data.unreadCount, 0);
      close(h);
    }
    assert.ok(!calls.some((call) => call.path.includes('/identity-view')));
    assert.ok(
      !calls.some((call) => call.path.startsWith('/v1/identity-privacy/')),
      'Ordinary discussion administration never opens private content identities',
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
        call.path.includes('/admin-discussion-removal/requests/'),
      ).length,
      mediaReads,
      noticeCount: notices.length,
      privateIdentityReads: calls.filter(
        (call) => call.path === '/v1/identity-privacy/content-identities',
      ).length,
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
