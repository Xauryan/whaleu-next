/** Emitted App/Page/WXML -> production gateways -> loopback AppModule/PostgreSQL.
 * Only native callbacks/storage/transport and explicitly synthetic fixture review are replaced. */
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
const send = (value) =>
  new Promise((resolve, reject) =>
    process.send(value, (error) => (error ? reject(error) : resolve())),
  );
async function checkpoint(name, fields = {}) {
  const next = new Promise((resolve) => process.once('message', resolve));
  await send({ event: 'checkpoint', name, ...fields });
  const reply = await next;
  assert.equal(reply.event, 'continue');
  assert.equal(reply.name, name);
  return reply;
}
async function until(check, label, h) {
  const deadline = Date.now() + 20000;
  while (!check()) {
    assert.ok(
      Date.now() < deadline,
      `${label}: ${h?.page.data.error || h?.page.data.status || 'condition not reached'}`,
    );
    await delay(10);
  }
}
const text = (h) =>
  h
    .nodes()
    .filter((node) => typeof node === 'string')
    .join(' ');
process.once('message', async (input) => {
  let app;
  const pages = new Set();
  try {
    const transport = new NativeExperienceTransport(input.port),
      platform = platformStorage(),
      commands = [];
    let review = 'allow';
    const wx = {
      ...platform,
      nextTick: queueMicrotask,
      navigateTo: (options) => options.success?.(),
      request: (options) => {
        const path = new URL(options.url).pathname;
        const writing =
          options.method === 'POST' &&
          (path.endsWith('/comments') || path.endsWith('/like'));
        if (writing)
          commands.push({ path, payload: structuredClone(options.data) });
        void (async () => {
          if (review && options.method === 'POST' && path.endsWith('/comments'))
            await checkpoint('review-publish', {
              command: options.data,
              verdict: review,
            });
          return transport.send({
            url: options.url,
            method: options.method,
            headers: options.header,
            body: options.data,
            timeoutMs: options.timeout,
          });
        })().then(
          (result) =>
            options.success({
              statusCode: result.status,
              header: result.headers,
              data: result.body,
            }),
          () =>
            options.fail({ errMsg: 'request:fail synthetic response loss' }),
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
    function mount(name, route = {}) {
      const h = mountEmittedPage(name, app, wx);
      pages.add(h);
      h.page.onLoad?.(route);
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
        () => !h.page.data.busy && h.page.data.loaded,
        'fresh comments load',
        h,
      );
    const settled = (h) =>
      until(
        () => !h.page.data.busy && !h.page.data.frozen,
        'matching terminal receipt',
        h,
      );
    const uncertain = (h) =>
      until(
        () => !h.page.data.busy && h.page.data.frozen,
        'original request retained',
        h,
      );
    const ensureComposeOpen = (h) => {
      if (h.page.data.uiPanel !== 'compose')
        h.tap('onTogglePanel', { panel: 'compose' });
    };
    const listPath = `/v1/ratings/courses/${input.courseId}/comments`;
    const exactBody = '  Native exact comment\r\n第二行 😀 e\u0301  ';
    transport.checkResponse = (path, status, data) => {
      if (path === listPath && status === 200 && Array.isArray(data.items))
        for (const item of data.items)
          assert.deepEqual(Object.keys(item).sort(), [
            'body',
            'createdAt',
            'id',
            'likes',
          ]);
    };
    boot();
    login(input.actor);
    let detail = mount('course-rating-detail', { courseId: input.courseId });
    await loaded(detail);
    assert.ok(
      detail
        .nodes()
        .some(
          (node) =>
            typeof node !== 'string' &&
            node.tag === 'navigator' &&
            node.attrs.url ===
              `/pages/course-comments/course-comments?courseId=${input.courseId}`,
        ),
    );
    close(detail);
    let h = mount('course-comments', { courseId: input.courseId });
    await loaded(h);
    assert.deepEqual(h.page.data.items, []);
    assert.match(text(h), /还没有课程回复/);
    ensureComposeOpen(h);
    h.event('bindinput', 'onBody', { value: exactBody });
    h.tap('onConfirmPublish');
    assert.equal(h.page.data.confirming, 'publish');
    assert.ok(text(h).includes(exactBody));
    transport.dropSuccess = { path: listPath, method: 'POST' };
    h.tap('onSubmit');
    h.page.onSubmit();
    await uncertain(h);
    const original = app.community.pendingCourseComments.load(
      input.actor.accountId,
    );
    assert.equal(original.intent.payload.body, exactBody);
    assert.equal(commands.length, 1);
    await checkpoint('comment-committed', {
      requestId: original.intent.payload.clientRequestId,
      body: exactBody,
    });
    close(h);
    app.onHide();
    boot();
    login(input.actor);
    h = mount('course-comments', { courseId: input.courseId });
    await uncertain(h);
    assert.equal(h.page.data.loaded, false);
    assert.ok(text(h).includes(exactBody));
    h.tap('onRecover');
    await settled(h);
    assert.equal(h.page.data.loaded, false);
    assert.deepEqual(h.page.data.items, []);
    assert.match(h.page.data.receiptStatus, /确认发布/);
    assert.equal(commands.length, 1);
    await checkpoint('comment-recovered', {
      requestId: original.intent.payload.clientRequestId,
    });
    h.tap('onRefresh');
    await loaded(h);
    const first = h.page.data.items[0];
    assert.equal(first.body, exactBody);
    assert.equal(first.likes, 0);
    h.tap('onConfirmLike', { id: first.id });
    assert.match(text(h), /不能取消/);
    transport.dropSuccess = {
      path: `${listPath}/${first.id}/like`,
      method: 'POST',
    };
    h.tap('onSubmit');
    h.page.onSubmit();
    await uncertain(h);
    const originalLike = app.community.pendingCourseComments.load(
      input.actor.accountId,
    );
    assert.equal(commands.length, 2);
    await checkpoint('like-committed', {
      requestId: originalLike.intent.payload.clientRequestId,
      commentId: first.id,
    });
    h.tap('onRecover');
    await settled(h);
    assert.equal(h.page.data.loaded, false);
    await checkpoint('like-recovered', {
      requestId: originalLike.intent.payload.clientRequestId,
    });
    h.tap('onRefresh');
    await loaded(h);
    assert.equal(h.page.data.items[0].likes, 1);
    h.tap('onConfirmLike', { id: first.id });
    h.tap('onSubmit');
    await settled(h);
    assert.match(h.page.data.receiptStatus, /已经赞过/);
    assert.equal(h.page.data.items[0].likes, 1);
    ensureComposeOpen(h);
    h.event('bindinput', 'onBody', { value: 'Second distinct native comment' });
    h.tap('onConfirmPublish');
    h.tap('onSubmit');
    await settled(h);
    assert.equal(h.page.data.items.length, 2);
    h.tap('onSort', { sort: 'time' });
    await loaded(h);
    assert.equal(h.page.data.sort, 'time');
    assert.equal(h.page.data.items[0].body, 'Second distinct native comment');
    h.tap('onSort', { sort: 'likes' });
    await loaded(h);
    assert.equal(h.page.data.items[0].id, first.id);
    review = false;
    ensureComposeOpen(h);
    h.event('bindinput', 'onBody', {
      value: 'Unreviewed cancellable native comment',
    });
    h.tap('onConfirmPublish');
    h.tap('onSubmit');
    await uncertain(h);
    const cancellation = app.community.pendingCourseComments.load(
      input.actor.accountId,
    );
    h.tap('onRequestCancellation');
    await until(
      () => !h.page.data.busy && h.page.data.confirming === 'cancel',
      'absence then explicit cancellation preview',
      h,
    );
    assert.equal(
      app.community.pendingCourseComments.load(input.actor.accountId).intent
        .payload.clientRequestId,
      cancellation.intent.payload.clientRequestId,
    );
    h.tap('onConfirmCancellation');
    await settled(h);
    assert.match(h.page.data.receiptStatus, /已确认取消/);
    assert.equal(h.page.data.items.length, 2);
    const replay = await transport.send({
      url: `${nativeOrigin}${listPath}`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.actor.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: cancellation.intent.payload,
      timeoutMs: 10000,
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.code, 'COURSE_COMMENT_CANCELLED');
    review = 'reject';
    ensureComposeOpen(h);
    h.event('bindinput', 'onBody', { value: 'Rejected native exact comment' });
    h.tap('onConfirmPublish');
    h.tap('onSubmit');
    await settled(h);
    assert.match(h.page.data.receiptStatus, /原文未通过审核/);
    assert.equal(h.page.data.items.length, 2);
    review = 'allow';
    const revokedBody = 'Reviewed native body revoked before receipt recovery';
    ensureComposeOpen(h);
    h.event('bindinput', 'onBody', { value: revokedBody });
    h.tap('onConfirmPublish');
    transport.dropSuccess = { path: listPath, method: 'POST' };
    h.tap('onSubmit');
    await uncertain(h);
    const revoked = app.community.pendingCourseComments.load(
      input.actor.accountId,
    );
    await checkpoint('revoke-pending-comment', {
      requestId: revoked.intent.payload.clientRequestId,
    });
    h.tap('onRecover');
    await settled(h);
    assert.match(h.page.data.receiptStatus, /确认发布/);
    assert.equal(h.page.data.items.length, 2);
    assert.equal(text(h).includes(revokedBody), false);
    const held = transport.holdNext(listPath);
    h.tap('onRefresh');
    await held.arrived;
    login(input.other);
    assert.equal(h.page.data.loaded, false);
    assert.deepEqual(h.page.data.items, []);
    assert.equal(h.page.data.recoveryBody, '');
    held.release();
    await delay(30);
    assert.equal(h.page.data.loaded, false);
    assert.deepEqual(h.page.data.items, []);
    h.page.onShow();
    await loaded(h);
    assert.equal(h.page.data.items.length, 2);
    assert.ok(
      h.page.data.items.every((item) => Object.keys(item).length === 4),
    );
    h.tap('onConfirmLike', { id: first.id });
    h.tap('onSubmit');
    await settled(h);
    assert.match(h.page.data.receiptStatus, /点赞已确认成功/);
    assert.equal(
      h.page.data.items.find((item) => item.id === first.id).likes,
      2,
    );
    await checkpoint('phone-only-like', { commentId: first.id });
    app.onHide();
    assert.deepEqual(h.page.data.items, []);
    assert.equal(h.page.data.body, '');
    close(h);
    const unknown = mount('course-comments', { courseId: input.unknownId });
    await until(
      () => !unknown.page.data.busy,
      'unknown comment history',
      unknown,
    );
    assert.equal(unknown.page.data.loaded, false);
    assert.match(text(unknown), /历史尚未确认/);
    assert.doesNotMatch(text(unknown), /当前已确认没有课程评论/);
    assert.doesNotMatch(text(unknown), /还没有课程回复/);
    close(unknown);
    const paged = mount('course-comments', { courseId: input.paginationId });
    await loaded(paged);
    assert.equal(paged.page.data.items.length, 20);
    assert.equal(paged.page.data.canNext, true);
    const firstPageIds = new Set(paged.page.data.items.map((item) => item.id));
    paged.tap('onNext');
    await loaded(paged);
    assert.equal(paged.page.data.pageNumber, 2);
    assert.equal(paged.page.data.items.length, 1);
    assert.equal(firstPageIds.has(paged.page.data.items[0].id), false);
    assert.equal(paged.page.data.canNext, false);
    paged.tap('onSort', { sort: 'time' });
    await loaded(paged);
    assert.equal(paged.page.data.pageNumber, 1);
    assert.equal(paged.page.data.items.length, 20);
    close(paged);
    await send({
      event: 'done',
      firstCommentId: first.id,
      publishRequestId: original.intent.payload.clientRequestId,
      likeRequestId: originalLike.intent.payload.clientRequestId,
      cancelledRequestId: cancellation.intent.payload.clientRequestId,
      commands: commands.length,
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
