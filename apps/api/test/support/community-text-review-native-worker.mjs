/** Emitted App + Pages/WXML → production WechatTransport/gateways → loopback API.
 * Only wx platform callbacks/storage/network are simulated here. Never real WeChat. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { renderedReferenceText } from './native-reference-text-render.mjs';
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
async function until(check, label, page) {
  const expires = Date.now() + 15000;
  while (!check()) {
    assert.ok(
      Date.now() < expires,
      `${label}: ${page?.data.error || page?.data.message || page?.data.status || 'condition not reached'}`,
    );
    await delay(10);
  }
}
process.once('message', async (input) => {
  const pages = new Set();
  let app;
  try {
    const transport = new NativeExperienceTransport(input.port);
    const platform = platformStorage();
    let loginActor = 'owner';
    let loginCalls = 0;
    let requestCalls = 0;
    const wx = {
      ...platform,
      login: (options) => {
        loginCalls++;
        queueMicrotask(() =>
          options.success({ code: `synthetic-journey-login-${loginActor}` }),
        );
      },
      request: (options) => {
        requestCalls++;
        // Model an uncooperative platform: abort cannot prevent an already received
        // response arriving late. The real WechatTransport must fence its callback.
        void transport
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
            () =>
              options.fail({ errMsg: 'request:fail synthetic response loss' }),
          );
        return { abort() {} };
      },
      nextTick: queueMicrotask,
    };
    // Test-process-only deployment configuration. No emitted file is rewritten,
    // production defaults stay disabled, and both network boundaries are closed.
    emitted('config').clientConfiguration = Object.freeze({
      apiOrigin: nativeOrigin,
      providerLoginEnabled: true,
    });
    globalThis.wx = wx;
    globalThis.App = (value) => {
      app = value;
    };
    globalThis.getApp = () => app;
    emitted('app');
    app.onLaunch();
    assert.equal(loginCalls, 0, 'Launching never requests consent or logs in');
    assert.equal(requestCalls, 0, 'Launching sends no API request');
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
    async function checkpoint(name, fields = {}) {
      const response = new Promise((resolve) =>
        process.once('message', resolve),
      );
      await send({ event: 'checkpoint', name, ...fields });
      assert.deepEqual(await response, { event: 'continue', name });
    }
    async function loggedIn(login) {
      login.tap('onLogin');
      await until(() => !login.page.data.busy, 'login completion', login.page);
      assert.equal(login.page.data.verified, true, login.page.data.error);
      return app.identity.sessions.snapshot().credentials.accountId;
    }
    async function logout(login) {
      login.tap('onLogout');
      await until(() => !login.page.data.busy, 'logout completion', login.page);
      assert.equal(app.identity.sessions.snapshot().credentials, null);
    }
    const login = mount('login');
    const accountId = await loggedIn(login);
    const verification = mount('verification');
    await until(
      () => verification.page.data.loaded,
      'fresh account verification',
      verification.page,
    );
    assert.deepEqual(
      verification.page.data.rows.slice(0, 3).map((row) => row.value),
      ['未验证', '未验证', '未验证'],
    );
    close(verification);
    const campus = mount('campus');
    await until(() => campus.page.data.loaded, 'campus catalog', campus.page);
    campus.tap('onChoose', { id: input.home.campusId });
    campus.tap('onSave');
    await until(
      () => !campus.page.data.saving,
      'save browsing campus',
      campus.page,
    );
    assert.equal(campus.page.data.selectedId, input.home.campusId);
    close(campus);
    await checkpoint('fresh-login', { accountId });

    let phone = mount('phone-binding');
    await until(() => !phone.page.data.busy, 'phone restore', phone.page);
    phone.tap('onPrepare');
    await until(
      () => phone.page.data.phase === 'reserved' && !phone.page.data.busy,
      'phone reservation',
      phone.page,
    );
    const phoneRequestId = phone.page.data.requestId;
    assert.equal(
      phone.button('bindgetphonenumber', 'onPhone').attrs['open-type'],
      'getPhoneNumber',
    );
    const beforeDenial = requestCalls;
    phone.event('bindgetphonenumber', 'onPhone', {
      errMsg: 'getPhoneNumber:fail user deny',
    });
    await delay(20);
    assert.equal(
      requestCalls,
      beforeDenial,
      'Denial sends no API or provider code',
    );
    const code = 'synthetic-journey-explicit-phone-code';
    transport.dropSuccess = {
      path: `/v1/me/phone-binding/requests/${phoneRequestId}/authorize`,
      method: 'POST',
    };
    phone.event('bindgetphonenumber', 'onPhone', {
      errMsg: 'getPhoneNumber:ok',
      code,
    });
    await until(
      () => !phone.page.data.busy,
      'lost phone completion response',
      phone.page,
    );
    assert.notEqual(
      phone.page.data.phase,
      'verified',
      'Lost response must not fabricate success',
    );
    assert.equal(
      JSON.stringify([...platform.storage.values]).includes(code),
      false,
    );
    assert.equal(JSON.stringify(phone.page.patches).includes(code), false);
    close(phone);
    phone = mount('phone-binding');
    await until(
      () => !phone.page.data.busy,
      'recover original phone request',
      phone.page,
    );
    assert.equal(phone.page.data.requestId, phoneRequestId);
    assert.equal(phone.page.data.phase, 'verified', phone.page.data.message);
    assert.equal(
      transport.exchanges.filter((call) => call.path.endsWith('/authorize'))
        .length,
      1,
    );
    close(phone);
    const afterPhone = mount('verification');
    await until(
      () => afterPhone.page.data.loaded,
      'phone-only verification',
      afterPhone.page,
    );
    assert.deepEqual(
      afterPhone.page.data.rows.slice(0, 3).map((row) => row.value),
      ['未验证', '未验证', '已验证'],
    );
    close(afterPhone);
    let compose = mount('community-compose', {
      spaceId: input.home.spaceId,
      category: 'discussion',
    });
    await until(() => !compose.page.data.busy, 'policy absent', compose.page);
    compose.event('bindinput', 'onText', {
      value: 'Synthetic journey policy is not consent',
    });
    assert.equal(
      compose.page.data.canSubmit,
      false,
      'Phone verification does not enable a missing regional policy',
    );
    close(compose);
    await checkpoint('phone-consent', { accountId, requestId: phoneRequestId });
    const foreign = mount('community-compose', {
      spaceId: input.foreign.spaceId,
      category: 'discussion',
    });
    await until(
      () => !foreign.page.data.busy,
      'foreign policy boundary',
      foreign.page,
    );
    assert.equal(
      foreign.page.data.canSubmit,
      false,
      'Single-region policy cannot authorize another region',
    );
    close(foreign);

    const phrase = 'Synthetic journey exact text';
    const created = [];
    async function publish(name, route, text, loseResponse = false) {
      compose = mount('community-compose', route);
      await until(
        () => compose.page.data.loaded && !compose.page.data.busy,
        `${name} composer`,
        compose.page,
      );
      compose.event('bindinput', 'onText', { value: text });
      assert.equal(compose.page.data.authorMode, 'named');
      assert.equal(compose.page.data.allowAnonymousDm, false);
      assert.equal(
        compose.page.data.canSubmit,
        true,
        compose.page.data.blocker,
      );
      if (loseResponse)
        transport.dropSuccess = {
          path: '/v1/community/reviews/posts',
          method: 'POST',
        };
      compose.tap('onSubmit');
      await until(
        () => !compose.page.data.busy,
        `${name} review submission`,
        compose.page,
      );
      const original = app.community.pending.load(accountId);
      assert.ok(original);
      assert.equal(compose.page.data.frozen, true);
      if (loseResponse) {
        assert.notEqual(compose.page.data.reviewStatus, 'pending');
        close(compose);
        compose = mount('community-compose');
        compose.tap('onReceipt');
        await until(
          () => !compose.page.data.busy,
          'recover lost queue response',
          compose.page,
        );
      }
      assert.equal(
        compose.page.data.reviewStatus,
        'pending',
        compose.page.data.error,
      );
      await checkpoint(name, {
        accountId,
        requestId: original.payload.clientRequestId,
      });
      compose.tap('onReceipt');
      await until(
        () => !compose.page.data.busy,
        'approved review status',
        compose.page,
      );
      assert.equal(
        compose.page.data.reviewStatus,
        'approved',
        compose.page.data.error,
      );
      assert.deepEqual(app.community.pending.load(accountId), original);
      const publicationPath =
        name === 'post-review'
          ? '/v1/community/posts'
          : name === 'comment-review'
            ? `/v1/community/posts/${route.postId}/comments`
            : `/v1/community/comments/${route.rootCommentId}/replies`;
      assert.equal(
        transport.exchanges.filter(
          (call) => call.path === publicationPath && call.method === 'POST',
        ).length,
        0,
        'Approval never auto-publishes',
      );
      if (loseResponse)
        transport.dropSuccess = { path: publicationPath, method: 'POST' };
      compose.tap('onRetry');
      await until(
        () => !compose.page.data.busy,
        'explicit original publication',
        compose.page,
      );
      if (loseResponse) {
        assert.equal(compose.page.data.frozen, true);
        assert.deepEqual(app.community.pending.load(accountId), original);
        close(compose);
        compose = mount('community-compose');
        compose.tap('onReceipt');
        await until(
          () => !compose.page.data.busy,
          'recover lost publication receipt',
          compose.page,
        );
      }
      assert.equal(
        compose.page.data.receiptStatus,
        '发布已确认',
        compose.page.data.error,
      );
      assert.equal(app.community.pending.load(accountId), null);
      const result = {
        requestId: original.payload.clientRequestId,
        resourceId: compose.page.data.resourceId,
      };
      created.push(result);
      close(compose);
      return result.resourceId;
    }
    const postId = await publish(
      'post-review',
      { spaceId: input.home.spaceId, category: 'discussion' },
      `${phrase} post`,
      true,
    );
    const rootCommentId = await publish(
      'comment-review',
      { postId },
      `${phrase} comment`,
    );
    const replyId = await publish(
      'reply-review',
      { postId, rootCommentId },
      `${phrase} reply`,
    );

    const feed = mount('community-feed');
    await until(
      () => feed.page.data.loaded && !feed.page.data.busy,
      'feed visibility',
      feed.page,
    );
    assert.equal(feed.page.data.space.id, input.home.spaceId);
    assert.deepEqual(
      feed.page.data.posts.map((post) => post.id),
      [postId],
    );
    assert.ok(
      feed
        .nodes()
        .some(
          (node) => typeof node === 'string' && node.includes(`${phrase} post`),
        ),
    );
    close(feed);
    const detail = mount('community-detail', { postId });
    await until(
      () => detail.page.data.loaded && !detail.page.data.busy,
      'post comments',
      detail.page,
    );
    assert.ok(
      renderedReferenceText(
        detail.nodes(),
        `${dist}pages/community-detail/community-detail`,
        dist,
      ).some(
        (node) =>
          typeof node === 'string' && node.includes(`${phrase} comment`),
      ),
    );
    close(detail);
    const thread = mount('community-thread', { postId, rootCommentId });
    await until(
      () => thread.page.data.loaded && !thread.page.data.busy,
      'thread replies',
      thread.page,
    );
    assert.deepEqual(
      thread.page.data.replies.map((reply) => reply.id),
      [replyId],
    );
    assert.ok(
      thread
        .nodes()
        .some(
          (node) =>
            typeof node === 'string' && node.includes(`${phrase} reply`),
        ),
    );
    close(thread);
    const search = mount('community-search', {
      campusId: input.home.campusId,
      spaceId: input.home.spaceId,
    });
    await until(
      () => search.page.data.scopeLoaded && !search.page.data.busy,
      'search scope',
      search.page,
    );
    search.event('bindinput', 'onInput', { value: phrase });
    search.tap('onSubmit');
    await until(
      () => search.page.data.loaded && !search.page.data.busy,
      'keyword search',
      search.page,
    );
    assert.deepEqual(
      search.page.data.hits.map((hit) => hit.contentId).sort(),
      [postId, rootCommentId, replyId].sort(),
    );
    assert.ok(
      search
        .nodes()
        .filter((node) => typeof node === 'string')
        .join('')
        .includes(`${phrase} reply`),
    );
    await checkpoint('visible-discussion', { accountId, created });

    async function pendingDraft(text) {
      compose = mount('community-compose', {
        spaceId: input.home.spaceId,
        category: 'discussion',
      });
      await until(
        () => compose.page.data.loaded && !compose.page.data.busy,
        'cancellation composer',
        compose.page,
      );
      compose.event('bindinput', 'onText', { value: text });
      compose.tap('onSubmit');
      await until(
        () => !compose.page.data.busy,
        'cancellable review',
        compose.page,
      );
      assert.equal(
        compose.page.data.reviewStatus,
        'pending',
        compose.page.data.error,
      );
      return app.community.pending.load(accountId);
    }
    const cancelled = await pendingDraft(
      'Synthetic journey keep this cancelled draft',
    );
    transport.dropSuccess = {
      path: `/v1/community/reviews/requests/${cancelled.payload.clientRequestId}/cancel`,
      method: 'POST',
    };
    compose.tap('onCancelReview');
    await until(
      () => !compose.page.data.busy,
      'lost cancellation result',
      compose.page,
    );
    assert.equal(compose.page.data.frozen, true);
    assert.deepEqual(app.community.pending.load(accountId), cancelled);
    close(compose);
    compose = mount('community-compose');
    compose.tap('onReceipt');
    await until(
      () => !compose.page.data.busy,
      'recover cancellation fence',
      compose.page,
    );
    assert.equal(
      compose.page.data.receiptStatus,
      '服务器已确认取消，原请求不能再发布',
    );
    assert.equal(
      compose.page.data.text,
      'Synthetic journey keep this cancelled draft',
    );
    assert.equal(app.community.pending.load(accountId), null);
    assert.equal(compose.page.data.canSubmit, false);
    close(compose);
    const switched = await pendingDraft(
      'Synthetic journey actor-isolated pending draft',
    );
    const held = transport.holdNext(
      `/v1/community/reviews/requests/${switched.payload.clientRequestId}`,
    );
    compose.tap('onReceipt');
    await held.arrived;
    await logout(login);
    loginActor = 'other';
    const otherAccountId = await loggedIn(login);
    assert.notEqual(otherAccountId, accountId);
    held.release();
    await delay(30);
    assert.equal(
      compose.page.data.text,
      '',
      'Old account late response cannot repopulate text',
    );
    assert.equal(compose.page.data.reviewStatus, '');
    assert.equal(
      search.page.data.inputDraft,
      '',
      'Account switch clears private query',
    );
    assert.deepEqual(search.page.data.hits, []);
    close(search);
    close(compose);
    compose = mount('community-compose');
    await until(
      () => !compose.page.data.busy,
      'other account recovery',
      compose.page,
    );
    assert.equal(compose.page.data.frozen, false);
    assert.equal(compose.page.data.text, '');
    assert.equal(app.community.pending.load(otherAccountId), null);
    assert.deepEqual(app.community.pending.load(accountId), switched);
    close(compose);
    const deniedComment = mount('community-compose', { postId });
    await until(
      () => !deniedComment.page.data.busy,
      'other account phone-required comment boundary',
      deniedComment.page,
    );
    assert.equal(
      deniedComment.page.data.canSubmit,
      false,
      'New account cannot borrow the original owner phone fact',
    );
    assert.equal(app.community.pending.load(otherAccountId), null);
    close(deniedComment);
    await logout(login);
    loginActor = 'owner';
    assert.equal(await loggedIn(login), accountId);
    compose = mount('community-compose');
    assert.deepEqual(app.community.pending.load(accountId), switched);
    compose.tap('onReceipt');
    await until(
      () => !compose.page.data.busy,
      'returning owner same request',
      compose.page,
    );
    assert.equal(compose.page.data.reviewStatus, 'pending');
    compose.tap('onCancelReview');
    await until(
      () => !compose.page.data.busy,
      'returning owner cancels original',
      compose.page,
    );
    assert.equal(app.community.pending.load(accountId), null);
    assert.equal(
      compose.page.data.text,
      'Synthetic journey actor-isolated pending draft',
    );
    close(compose);
    await checkpoint('cancel-switch-recovery', {
      accountId,
      otherAccountId,
      cancelledRequestIds: [
        cancelled.payload.clientRequestId,
        switched.payload.clientRequestId,
      ],
      created,
    });
    await send({ event: 'done', loginCalls, requests: requestCalls });
  } catch (error) {
    await send({
      event: 'failure',
      message: error instanceof Error ? error.stack : String(error),
    });
    process.exitCode = 1;
  } finally {
    for (const h of pages) h.page.onUnload?.();
    app?.onHide();
    process.disconnect();
  }
});
