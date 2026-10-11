/** Actual emitted App/Page/WXML; only platform callbacks and network bridge are synthetic. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { mountEmittedPage } from '../../../wechat/test/text-review-emitted-harness.mjs';
const require = createRequire(import.meta.url),
  dist = fileURLToPath(new URL('../../../wechat/dist/', import.meta.url)),
  emitted = (name) => require(`${dist}${name}.js`);
const {
  NativeExperienceTransport,
  nativeOrigin,
  platformStorage,
} = require('./experience-native-bridge.ts');
const {
  NativeMediaUploadBridge,
} = require('../../../wechat/test/support/media-upload-bridge.ts');
const { NativeMediaReadBridge } = require('./media/native-read-bridge.ts');
const send = (v) =>
  new Promise((r, j) => process.send(v, (e) => (e ? j(e) : r())));
async function rpc(name, fields = {}) {
  const p = new Promise((r) => process.once('message', r));
  await send({ event: 'checkpoint', name, ...fields });
  assert.deepEqual(await p, { event: 'continue', name });
}
async function until(check, label, page) {
  const deadline = Date.now() + 25000;
  while (!check()) {
    assert.ok(
      Date.now() < deadline,
      `${label}: ${page?.data.error || page?.data.message || 'timeout'}; evidence=${page?.data.evidenceMessage}; busy=${page?.data.busy}`,
    );
    await delay(10);
  }
}
process.once('message', async (input) => {
  let app, upload, read;
  const pages = new Set();
  try {
    const transport = new NativeExperienceTransport(input.port),
      platform = platformStorage();
    let loginActor = 'owner';
    upload = await NativeMediaUploadBridge.create(
      input.port,
      nativeOrigin,
      'verification-evidence',
    );
    read = await NativeMediaReadBridge.create(
      input.port,
      'verification-evidence',
    );
    const fsFor = (p) =>
      p.includes('native-upload-')
        ? upload.wx.getFileSystemManager()
        : read.wx.getFileSystemManager();
    const wx = {
      ...platform,
      ...upload.wx,
      nextTick: queueMicrotask,
      login: (o) =>
        queueMicrotask(() =>
          o.success({ code: `synthetic-student-native-${loginActor}` }),
        ),
      getFileSystemManager: () =>
        Object.fromEntries(
          ['getFileInfo', 'readFile', 'unlink'].map((n) => [
            n,
            (o) => fsFor(o.filePath)[n](o),
          ]),
        ),
      getImageInfo: (o) =>
        (o.src.includes('native-upload-') ? upload.wx : read.wx).getImageInfo(
          o,
        ),
      downloadFile: (o) => read.wx.downloadFile(o),
      request: (o) => {
        void transport
          .send({
            url: o.url,
            method: o.method,
            headers: o.header,
            body: o.data,
            timeoutMs: o.timeout,
          })
          .then(
            async (r) => {
              if (
                r.status === 200 &&
                new URL(o.url).pathname.endsWith('/finalize')
              )
                await rpc('process-images');
              o.success({
                statusCode: r.status,
                header: r.headers,
                data: r.body,
              });
            },
            () => o.fail({ errMsg: 'request:fail synthetic response loss' }),
          );
        return { abort() {} };
      },
      navigateTo: (o) => o.success?.(),
      showModal: (o) => o.success({ confirm: true, cancel: false }),
    };
    emitted('config').clientConfiguration = Object.freeze({
      apiOrigin: nativeOrigin,
      providerLoginEnabled: true,
    });
    globalThis.wx = wx;
    globalThis.App = (v) => (app = v);
    globalThis.getApp = () => app;
    emitted('app');
    app.onLaunch();
    const mount = (name, route = {}) => {
      const h = mountEmittedPage(name, app, wx);
      pages.add(h);
      h.page.onLoad?.(route);
      h.page.onShow?.();
      return h;
    };
    const close = (h) => {
      h.page.onHide?.();
      h.page.onUnload?.();
      pages.delete(h);
    };
    const login = mount('login');
    const logIn = async (actor) => {
      loginActor = actor;
      login.tap('onLogin');
      await until(() => !login.page.data.busy, 'native login', login.page);
      assert.equal(login.page.data.verified, true, login.page.data.error);
      return app.identity.sessions.snapshot().credentials.accountId;
    };
    const logout = async () => {
      login.tap('onLogout');
      await until(() => !login.page.data.busy, 'native logout', login.page);
      assert.equal(app.identity.sessions.snapshot().credentials, null);
    };
    const accountId = await logIn('owner');
    let summary = mount('verification');
    await until(
      () => summary.page.data.loaded,
      'native unverified summary',
      summary.page,
    );
    assert.deepEqual(
      summary.page.data.rows.slice(0, 3).map((r) => r.value),
      ['未验证', '未验证', '未验证'],
    );
    close(summary);
    const campus = mount('campus');
    await until(() => campus.page.data.loaded, 'campus catalog', campus.page);
    campus.tap('onChoose', { id: input.home.campusId });
    campus.tap('onSave');
    await until(() => !campus.page.data.saving, 'browsing campus', campus.page);
    close(campus);
    let student = mount('student-verification');
    await until(
      () => student.page.data.loaded && !student.page.data.busy,
      'own student application',
      student.page,
    );
    assert.equal(student.page.data.canApply, true);
    student.tap('onSearch');
    await until(
      () => !student.page.data.busy && student.page.data.campuses.length,
      'campus search',
      student.page,
    );
    student.tap('onChooseCampus', { id: input.home.campusId });
    student.tap('onPrepare');
    await until(
      () =>
        !student.page.data.busy &&
        student.page.data.application?.state === 'draft',
      'draft reserve',
      student.page,
    );
    const applicationId = student.page.data.application.id;
    await upload.select(Buffer.from(input.png, 'base64'), 'image/png', {
      width: 48,
      height: 48,
      type: 'png',
    });
    student.tap('onChooseEvidence');
    await until(
      () => !student.page.data.busy,
      'private evidence processing',
      student.page,
    );
    if (!student.page.data.evidenceReady) student.tap('onRecoverEvidence');
    await until(
      () => !student.page.data.busy && student.page.data.evidenceReady,
      'private evidence ready',
      student.page,
    );
    student.tap('onSubmit');
    assert.equal(student.page.data.confirmation, 'submit');
    transport.dropSuccess = {
      path: `/v1/me/student-verification/applications/${applicationId}/submit`,
      method: 'POST',
    };
    student.tap('onConfirm');
    await until(
      () => !student.page.data.busy,
      'lost submit response',
      student.page,
    );
    assert.equal(student.page.data.pending, true);
    student.tap('onRecover');
    await until(
      () => !student.page.data.busy && !student.page.data.pending,
      'recover exact submit',
      student.page,
    );
    assert.equal(student.page.data.application.state, 'pending');
    close(student);
    summary = mount('verification');
    await until(
      () => summary.page.data.loaded,
      'pending summary',
      summary.page,
    );
    assert.equal(summary.page.data.rows[0].value, '未验证');
    assert.equal(summary.page.data.rows[3].value, '等待审核');
    close(summary);
    await rpc('pending', { accountId, applicationId });
    await logout();
    const reviewerId = await logIn('admin');
    assert.notEqual(reviewerId, accountId);
    let review = mount('student-verification-review');
    await until(
      () => review.page.data.loaded && !review.page.data.busy,
      'real scoped review queue',
      review.page,
    );
    assert.equal(review.page.data.management, 'fixed');
    assert.ok(review.page.data.items.some((i) => i.id === applicationId));
    review.tap('onSelect', { id: applicationId });
    await until(
      () =>
        !review.page.data.busy &&
        review.page.data.application?.id === applicationId,
      'review detail',
      review.page,
    );
    review.tap('onPreview');
    await until(
      () => !!review.page.data.evidenceSrc,
      'private inline authenticated bytes',
      review.page,
    );
    const privatePath = review.page.data.evidenceSrc;
    assert.ok(
      privatePath.startsWith('wxfile://tmp') ||
        privatePath.startsWith('http://tmp/'),
    );
    review.tap('onApprove');
    review.tap('onConfirm');
    await until(
      () =>
        !review.page.data.busy &&
        review.page.data.application?.state === 'approved',
      'document decision ledger',
      review.page,
    );
    assert.equal(review.page.data.evidenceSrc, '');
    close(review);
    await rpc('approved', { accountId, applicationId });
    await logout();
    await logIn('owner');
    summary = mount('verification');
    await until(
      () => summary.page.data.loaded,
      'actual approved summary',
      summary.page,
    );
    assert.deepEqual(
      summary.page.data.rows.slice(0, 3).map((r) => r.value),
      ['已验证', '未验证', '未验证'],
    );
    close(summary);
    const notices = mount('student-verification-notices');
    await until(
      () => notices.page.data.loaded,
      'owner result notice',
      notices.page,
    );
    assert.ok(
      notices.page.data.notices.some(
        (n) => n.kind === 'auth_result' && n.outcome === 'approved',
      ),
    );
    close(notices);
    const phone = mount('phone-binding');
    await until(() => !phone.page.data.busy, 'phone restore', phone.page);
    phone.tap('onPrepare');
    await until(
      () => !phone.page.data.busy && phone.page.data.phase === 'reserved',
      'phone reserve',
      phone.page,
    );
    assert.equal(
      phone.button('bindgetphonenumber', 'onPhone').attrs['open-type'],
      'getPhoneNumber',
    );
    phone.event('bindgetphonenumber', 'onPhone', {
      errMsg: 'getPhoneNumber:ok',
      code: 'synthetic-student-native-phone-code',
    });
    await until(
      () => !phone.page.data.busy && phone.page.data.phase === 'verified',
      'actual simulated phone provider',
      phone.page,
    );
    close(phone);
    const identity = mount('identity-campus');
    await until(
      () => identity.page.data.loaded && !identity.page.data.busy,
      'identity campus real affiliation options',
      identity.page,
    );
    assert.equal(identity.page.data.state.canSelect, true);
    identity.tap('onChoose', { id: input.home.campusId });
    identity.tap('onRequestConfirmation');
    identity.tap('onConfirm');
    await until(
      () => !identity.page.data.busy && !identity.page.data.frozen,
      'identity exact snapshot selection',
      identity.page,
    );
    assert.equal(
      identity.page.data.state.selectedCampus.id,
      input.home.campusId,
    );
    close(identity);
    await rpc('identity-selected', { accountId, applicationId });
    const compose = mount('community-compose', {
      spaceId: input.home.spaceId,
      category: 'discussion',
    });
    await until(
      () => compose.page.data.loaded && !compose.page.data.busy,
      'ordinary composer',
      compose.page,
    );
    const text = 'Synthetic student verification complete native publication';
    compose.event('bindinput', 'onText', { value: text });
    assert.equal(compose.page.data.canSubmit, true, compose.page.data.blocker);
    compose.tap('onSubmit');
    await until(
      () => !compose.page.data.busy,
      'exact text review request',
      compose.page,
    );
    assert.equal(
      compose.page.data.reviewStatus,
      'pending',
      compose.page.data.error,
    );
    const original = app.community.pending.load(accountId);
    assert.ok(original);
    await rpc('post-review', {
      accountId,
      requestId: original.payload.clientRequestId,
      text,
    });
    compose.tap('onReceipt');
    await until(
      () =>
        !compose.page.data.busy &&
        compose.page.data.reviewStatus === 'approved',
      'real review approved',
      compose.page,
    );
    compose.tap('onRetry');
    await until(
      () =>
        !compose.page.data.busy &&
        compose.page.data.receiptStatus === '发布已确认',
      'ordinary publication',
      compose.page,
    );
    const postId = compose.page.data.resourceId;
    assert.ok(postId);
    close(compose);
    const detail = mount('community-detail', { postId });
    await until(
      () => detail.page.data.loaded && !detail.page.data.busy,
      'ordinary post read',
      detail.page,
    );
    assert.equal(detail.page.data.post.text, text);
    close(detail);
    assert.equal(
      JSON.stringify([...platform.storage.values]).includes(
        'synthetic-student-native-phone-code',
      ),
      false,
    );
    assert.equal(
      JSON.stringify([...platform.storage.values]).includes(
        'verification-evidence-upload',
      ),
      false,
    );
    await send({
      event: 'done',
      accountId,
      applicationId,
      postId,
      requests: transport.exchanges.length,
    });
  } catch (e) {
    await send({
      event: 'failure',
      message: e instanceof Error ? e.stack : String(e),
    });
  } finally {
    for (const h of pages) {
      h.page.onHide?.();
      h.page.onUnload?.();
    }
    app?.onHide?.();
    app?.identity?.dispose?.();
    await upload?.dispose();
    await read?.dispose();
    process.disconnect?.();
  }
});
