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
    loginActor = 'admin';
    const adminAccountId = await loggedIn(login);
    await checkpoint('admin-login', { accountId: adminAccountId });
    const management = mount('school-configuration');
    await until(
      () => management.page.data.loaded && !management.page.data.busy,
      'school management entry',
      management.page,
    );
    const entry = management
      .nodes()
      .find(
        (node) =>
          typeof node !== 'string' &&
          node.tag === 'navigator' &&
          String(node.attrs.url).startsWith('/pages/school-posting-policy/'),
      );
    assert.ok(entry, 'Actual school management WXML exposes policy page');
    const target = new URL(entry.attrs.url, 'https://native-entry.invalid');
    assert.equal(target.searchParams.get('regionId'), input.home.regionId);
    close(management);
    let policy = mount('school-posting-policy', {
      regionId: target.searchParams.get('regionId'),
    });
    await until(
      () => policy.page.data.loaded && !policy.page.data.busy,
      'fixed school policy',
      policy.page,
    );
    assert.equal(policy.page.data.regionId, input.home.regionId);
    assert.equal(policy.page.data.management, 'fixed');
    assert.equal(policy.page.data.sourceState, 'unconfigured');
    policy.event(
      'bindchange',
      'onSwitch',
      { value: true },
      { field: 'unverifiedPostEnabled' },
    );
    policy.event(
      'bindchange',
      'onSwitch',
      { value: true },
      { field: 'unverifiedCommentEnabled' },
    );
    policy.event('bindchange', 'onCategories', { value: ['discussion'] });
    policy.event('bindchange', 'onExpiryKind', { value: 'policy_exempt' });
    transport.dropSuccess = {
      path: `/v1/me/school-posting-policy/${input.home.regionId}`,
      method: 'POST',
    };
    policy.tap('onSave');
    await until(
      () => !policy.page.data.busy,
      'lost policy save response',
      policy.page,
    );
    assert.equal(policy.page.data.pending, true, policy.page.data.error);
    const policyRequestId = policy.page.data.pendingRequestId;
    close(policy);
    policy = mount('school-posting-policy');
    await until(
      () => !policy.page.data.busy,
      'recover saved policy key',
      policy.page,
    );
    policy.tap('onRecover');
    await until(
      () => !policy.page.data.busy,
      'query original saved policy receipt',
      policy.page,
    );
    assert.equal(policy.page.data.pending, false, policy.page.data.error);
    policy.tap('onRefresh');
    await until(
      () => policy.page.data.loaded && !policy.page.data.busy,
      'read published policy',
      policy.page,
    );
    assert.equal(policy.page.data.revision, 1);
    assert.equal(policy.page.data.sourceState, 'active');
    assert.equal(policy.page.data.form.unverifiedPostEnabled, true);
    assert.equal(
      transport.exchanges.filter(
        (e) =>
          e.path === `/v1/me/school-posting-policy/${input.home.regionId}` &&
          e.method === 'POST',
      ).length,
      1,
    );
    close(policy);
    await checkpoint('policy-published', {
      accountId: adminAccountId,
      requestId: policyRequestId,
    });
    await logout(login);
    loginActor = 'owner';
    const accountId = await loggedIn(login);
    assert.notEqual(accountId, adminAccountId);
    const campus = mount('campus');
    await until(
      () => campus.page.data.loaded,
      'ordinary browsing campus',
      campus.page,
    );
    campus.tap('onChoose', { id: input.home.campusId });
    campus.tap('onSave');
    await until(
      () => !campus.page.data.saving,
      'save browsing campus',
      campus.page,
    );
    close(campus);
    let compose = mount('community-compose', {
      spaceId: input.home.spaceId,
      category: 'discussion',
    });
    await until(
      () => !compose.page.data.busy,
      'phone remains mandatory',
      compose.page,
    );
    assert.equal(compose.page.data.canSubmit, false);
    close(compose);
    const phone = mount('phone-binding');
    await until(() => !phone.page.data.busy, 'phone page', phone.page);
    phone.tap('onPrepare');
    await until(
      () => phone.page.data.phase === 'reserved' && !phone.page.data.busy,
      'phone reservation',
      phone.page,
    );
    phone.event('bindgetphonenumber', 'onPhone', {
      errMsg: 'getPhoneNumber:ok',
      code: 'synthetic-journey-explicit-phone-code',
    });
    await until(() => !phone.page.data.busy, 'phone authorization', phone.page);
    assert.equal(phone.page.data.phase, 'verified', phone.page.data.message);
    close(phone);
    const verification = mount('verification');
    await until(
      () => verification.page.data.loaded,
      'only phone verified',
      verification.page,
    );
    assert.deepEqual(
      verification.page.data.rows.slice(0, 3).map((row) => row.value),
      ['未验证', '未验证', '已验证'],
    );
    close(verification);
    await checkpoint('user-phone', { accountId });
    const created = [],
      phrase = 'Synthetic school posting policy journey';
    async function prepareReview(name, route, text) {
      compose = mount('community-compose', route);
      await until(
        () => compose.page.data.loaded && !compose.page.data.busy,
        `${name} compose`,
        compose.page,
      );
      compose.event('bindinput', 'onText', { value: text });
      assert.equal(
        compose.page.data.canSubmit,
        true,
        compose.page.data.blocker,
      );
      assert.equal(compose.page.data.authorMode, 'named');
      compose.tap('onSubmit');
      await until(
        () => !compose.page.data.busy,
        `${name} request`,
        compose.page,
      );
      assert.equal(
        compose.page.data.reviewStatus,
        'pending',
        compose.page.data.error,
      );
      const original = app.community.pending.load(accountId);
      assert.ok(original);
      await checkpoint(name, {
        accountId,
        requestId: original.payload.clientRequestId,
      });
      compose.tap('onReceipt');
      await until(
        () => !compose.page.data.busy,
        `${name} approval`,
        compose.page,
      );
      assert.equal(
        compose.page.data.reviewStatus,
        'approved',
        compose.page.data.error,
      );
      assert.deepEqual(app.community.pending.load(accountId), original);
      return original;
    }
    async function publish(name, route, text, loseResponse = false) {
      const original = await prepareReview(name, route, text);
      const path =
        name === 'post-review'
          ? '/v1/community/posts'
          : name === 'comment-review'
            ? `/v1/community/posts/${route.postId}/comments`
            : `/v1/community/comments/${route.rootCommentId}/replies`;
      if (loseResponse) transport.dropSuccess = { path, method: 'POST' };
      compose.tap('onRetry');
      await until(
        () => !compose.page.data.busy,
        `${name} explicit publish`,
        compose.page,
      );
      if (loseResponse) {
        assert.deepEqual(app.community.pending.load(accountId), original);
        close(compose);
        compose = mount('community-compose');
        compose.tap('onReceipt');
        await until(
          () => !compose.page.data.busy,
          'recover publication',
          compose.page,
        );
      }
      assert.equal(
        compose.page.data.receiptStatus,
        '发布已确认',
        compose.page.data.error,
      );
      const resourceId = compose.page.data.resourceId;
      created.push({ requestId: original.payload.clientRequestId, resourceId });
      close(compose);
      return resourceId;
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
      'feed',
      feed.page,
    );
    assert.deepEqual(
      feed.page.data.posts.map((p) => p.id),
      [postId],
    );
    close(feed);
    const detail = mount('community-detail', { postId });
    await until(
      () => detail.page.data.loaded && !detail.page.data.busy,
      'detail',
      detail.page,
    );
    assert.ok(
      renderedReferenceText(
        detail.nodes(),
        `${dist}pages/community-detail/community-detail`,
        dist,
      ).some((n) => typeof n === 'string' && n.includes(`${phrase} comment`)),
    );
    close(detail);
    const thread = mount('community-thread', { postId, rootCommentId });
    await until(
      () => thread.page.data.loaded && !thread.page.data.busy,
      'thread',
      thread.page,
    );
    assert.deepEqual(
      thread.page.data.replies.map((r) => r.id),
      [replyId],
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
      'search results',
      search.page,
    );
    assert.deepEqual(
      search.page.data.hits.map((hit) => hit.contentId).sort(),
      [postId, rootCommentId, replyId].sort(),
    );
    close(search);
    const old = await prepareReview(
      'old-policy-review',
      { spaceId: input.home.spaceId, category: 'discussion' },
      'Synthetic old approved policy must not revive',
    );
    close(compose);
    await logout(login);
    loginActor = 'admin';
    assert.equal(await loggedIn(login), adminAccountId);
    policy = mount('school-posting-policy');
    await until(
      () => policy.page.data.loaded && !policy.page.data.busy,
      'admin allowed revision page',
      policy.page,
    );
    assert.equal(policy.page.data.revision, 1);
    policy.tap('onSave');
    await until(
      () => !policy.page.data.busy,
      'republish unchanged allow policy',
      policy.page,
    );
    assert.equal(policy.page.data.pending, false, policy.page.data.error);
    close(policy);
    await checkpoint('policy-revised-allowed', {
      accountId,
      requestId: old.payload.clientRequestId,
      created,
    });
    await logout(login);
    loginActor = 'owner';
    assert.equal(await loggedIn(login), accountId);
    compose = mount('community-compose');
    await until(
      () => !compose.page.data.busy,
      'restore old revision',
      compose.page,
    );
    let exactConflict = false;
    transport.checkResponse = (_path, _status, body) => {
      if (body?.error?.code === 'REQUEST_CONFLICT') exactConflict = true;
    };
    compose.tap('onRetry');
    await until(
      () => !compose.page.data.busy,
      'same allowed policy still requires current revision',
      compose.page,
    );
    assert.equal(
      exactConflict,
      true,
      'Old approved request must fail exact revision even while current policy allows its category',
    );
    transport.checkResponse = null;
    assert.deepEqual(app.community.pending.load(accountId), old);
    compose.tap('onCancelReview');
    await until(
      () => !compose.page.data.busy,
      'cancel old revision key',
      compose.page,
    );
    assert.equal(
      app.community.pending.load(accountId),
      null,
      compose.page.data.error,
    );
    close(compose);
    await checkpoint('revision-retry-denied', {
      accountId,
      requestId: old.payload.clientRequestId,
    });
    const closing = await prepareReview(
      'closing-policy-review',
      { spaceId: input.home.spaceId, category: 'discussion' },
      'Synthetic approved before closing policy',
    );
    close(compose);
    await logout(login);
    loginActor = 'admin';
    assert.equal(await loggedIn(login), adminAccountId);
    policy = mount('school-posting-policy');
    await until(
      () => policy.page.data.loaded && !policy.page.data.busy,
      'admin disable page',
      policy.page,
    );
    assert.equal(policy.page.data.revision, 2);
    policy.event(
      'bindchange',
      'onSwitch',
      { value: false },
      { field: 'unverifiedPostEnabled' },
    );
    policy.event(
      'bindchange',
      'onSwitch',
      { value: false },
      { field: 'unverifiedCommentEnabled' },
    );
    policy.tap('onSave');
    await until(
      () => !policy.page.data.busy,
      'disable both exception paths',
      policy.page,
    );
    assert.equal(policy.page.data.pending, false, policy.page.data.error);
    policy.tap('onRefresh');
    await until(
      () => policy.page.data.loaded && !policy.page.data.busy,
      'read disabled policy',
      policy.page,
    );
    assert.equal(policy.page.data.revision, 3);
    assert.equal(policy.page.data.form.unverifiedPostEnabled, false);
    assert.equal(policy.page.data.form.unverifiedCommentEnabled, false);
    close(policy);
    await checkpoint('policy-disabled', {
      accountId,
      adminAccountId,
      requestId: closing.payload.clientRequestId,
      created,
    });
    await logout(login);
    loginActor = 'owner';
    assert.equal(await loggedIn(login), accountId);
    compose = mount('community-compose');
    await until(
      () => !compose.page.data.busy,
      'restore old approved request',
      compose.page,
    );
    assert.deepEqual(app.community.pending.load(accountId), closing);
    compose.tap('onRetry');
    await until(
      () => !compose.page.data.busy,
      'old policy retry denied',
      compose.page,
    );
    assert.equal(
      compose.page.data.receiptStatus,
      '服务器已确认拒绝，本次请求未创建内容',
    );
    assert.equal(app.community.pending.load(accountId), null);
    assert.equal(
      compose.page.data.text,
      closing.payload.text,
      'Deterministic denial retains the original draft',
    );
    const { Cancellation } = emitted('platform/contracts');
    const rejection = {
      requestId: closing.payload.clientRequestId,
      operation: 'publish_post',
      outcome: 'rejected',
      code: 'STUDENT_VERIFICATION_REQUIRED',
    };
    assert.deepEqual(
      await app.community.gateway.receipt(
        closing.payload.clientRequestId,
        new Cancellation(),
      ),
      rejection,
    );
    assert.deepEqual(
      await app.community.gateway.publishPost(
        closing.payload,
        new Cancellation(),
      ),
      rejection,
      'Explicit replay preserves the original rejection, never creates another key',
    );
    assert.equal(app.community.pending.load(accountId), null);

    close(compose);
    for (const route of [
      { spaceId: input.home.spaceId, category: 'discussion' },
      { postId },
      { postId, rootCommentId },
    ]) {
      compose = mount('community-compose', route);
      await until(
        () => !compose.page.data.busy,
        'current disabled exception',
        compose.page,
      );
      assert.equal(compose.page.data.canSubmit, false);
      close(compose);
    }
    const retained = mount('community-detail', { postId });
    await until(
      () => retained.page.data.loaded && !retained.page.data.busy,
      'existing content retained',
      retained.page,
    );
    assert.ok(
      renderedReferenceText(
        retained.nodes(),
        `${dist}pages/community-detail/community-detail`,
        dist,
      ).some((n) => typeof n === 'string' && n.includes(`${phrase} post`)),
    );
    close(retained);
    await checkpoint('user-denied', {
      accountId,
      requestId: closing.payload.clientRequestId,
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
