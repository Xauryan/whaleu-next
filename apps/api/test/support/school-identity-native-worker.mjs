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
  let currentPage = 'startup';
  const pages = new Set();
  try {
    const transport = new NativeExperienceTransport(input.port),
      platform = platformStorage();
    let loginActor = 'owner';
    let failJournal = false;
    const sentCommands = [];
    const journalPrefix = 'whaleu.school-identity.pending.v1:';
    const commandPath = '/v1/admin/school-identities/commands';
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
      setStorageSync(key, value) {
        if (failJournal && key.startsWith(journalPrefix))
          throw Error('Synthetic journal write failure');
        return platform.setStorageSync(key, value);
      },
      nextTick: queueMicrotask,
      login: (o) =>
        queueMicrotask(() =>
          o.success({ code: `synthetic-school-uid-native-${loginActor}` }),
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
        const path = new URL(o.url).pathname;
        if (o.method === 'POST' && path.startsWith(commandPath)) {
          const actor = app.identity.sessions.snapshot().credentials.accountId;
          const pending = app.community.pendingSchoolIdentity.load(actor);
          assert.deepEqual(
            pending.command,
            o.data,
            'Full immutable journal persisted before HTTP',
          );
          assert.equal(
            pending.phase,
            path.endsWith('/cancel') ? 'cancel' : 'submit',
          );
          sentCommands.push({ path, command: structuredClone(o.data) });
        }
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
    function boot() {
      emitted('config').clientConfiguration = Object.freeze({
        apiOrigin: nativeOrigin,
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
    }
    boot();
    const mount = (name, route = {}) => {
      currentPage = name;
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
    let login = mount('login');
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
    let review = mount('student-verification-review', {
      regionId: input.home.regionId,
    });
    await until(
      () => review.page.data.loaded && !review.page.data.busy,
      'real scoped review queue',
      review.page,
    );
    assert.equal(review.page.data.management, 'global');
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
    const pageText = (h) =>
      h
        .nodes()
        .filter((n) => typeof n === 'string')
        .join('');
    const ownUid = async (name = 'verification') => {
      const h = mount(name);
      await until(
        () => h.page.data.schoolUidView?.loaded,
        'own UID ' + name,
        h.page,
      );
      const value = h.page.data.schoolUidView.schoolUid;
      if (value.status === 'assigned')
        assert.ok(pageText(h).includes(value.formattedUid));
      close(h);
      return value;
    };
    const saveProfile = async (nickname) => {
      const h = mount('profile');
      await until(
        () =>
          h.page.data.loaded &&
          !h.page.data.loading &&
          !h.page.data.avatar.busy,
        'own profile edit',
        h.page,
      );
      h.event('bindinput', 'onNickname', { value: nickname });
      h.tap('onSaveProfile');
      await until(
        () => !h.page.data.saving && !h.page.data.profileDirty,
        'save native public nickname',
        h.page,
      );
      close(h);
      const profile = mount('public-profile');
      await until(
        () => profile.page.data.loaded && !profile.page.data.busy,
        'native own public profile',
        profile.page,
      );
      assert.equal(
        profile.page.data.profile.status,
        'available',
        profile.page.data.error,
      );
      const result = profile.page.data.profile;
      close(profile);
      return result;
    };
    const uidA = await ownUid();
    assert.equal(uidA.status, 'assigned');
    assert.equal(uidA.school.code, input.home.schoolCode);
    assert.equal(uidA.uid, '1');
    assert.deepEqual(await ownUid('student-verification'), uidA);
    const primary = await saveProfile('合成UID原生用户'),
      profileId = primary.profileId;
    assert.equal(primary.schoolUidStatus, 'assigned');
    assert.equal(primary.publicUid.value, uidA.uid);
    assert.equal(primary.affiliation.schoolCode, uidA.school.code);
    assert.deepEqual(await ownUid('profile'), uidA);
    const lookup = async (campusId, uid, expected) => {
      const h = mount('school-uid-lookup');
      await until(
        () => !h.page.data.busy && h.page.data.canLookup,
        'UID lookup permission',
        h.page,
      );
      h.tap('onSearch');
      await until(
        () =>
          !h.page.data.busy &&
          h.page.data.campuses.some((c) => c.id === campusId),
        'UID lookup school directory',
        h.page,
      );
      h.tap('onChoose', { id: campusId });
      h.event('bindinput', 'onUid', { value: uid });
      h.tap('onLookup');
      await until(
        () => !h.page.data.busy && h.page.data.result,
        'exact current UID lookup',
        h.page,
      );
      assert.equal(h.page.data.result.status, expected);
      if (expected === 'found')
        assert.equal(h.page.data.result.target.profileId, profileId);
      close(h);
    };
    const management = async (target) => {
      const h = mount('school-identity-management', {
        targetProfileId: target,
      });
      await until(
        () => !h.page.data.busy && h.page.data.loaded,
        'school identity management',
        h.page,
      );
      return h;
    };
    const selectDestination = async (h, campusId) => {
      h.tap('onSearchCampuses');
      await until(
        () =>
          !h.page.data.busy &&
          h.page.data.campuses.some((c) => c.id === campusId),
        'management destination catalog',
        h.page,
      );
      h.tap('onSelectCampus', { id: campusId });
      await until(
        () =>
          !h.page.data.busy &&
          h.page.data.management?.destination?.campusId === campusId,
        'exact destination preview',
        h.page,
      );
      h.tap('onRequest', { action: 'correct_school' });
      assert.equal(h.page.data.confirming, 'correct_school');
    };
    const settled = async (h) =>
      until(
        () =>
          !h.page.data.busy &&
          !h.page.data.frozen &&
          !!h.page.data.receiptStatus,
        'school identity terminal result',
        h.page,
      );
    const pending = async (h) =>
      until(
        () =>
          !h.page.data.busy &&
          h.page.data.frozen &&
          !!h.page.data.pendingRequestId,
        'durable original key',
        h.page,
      );
    await logout();
    const adminAccountId = await logIn('admin');
    await lookup(input.home.campusId, uidA.formattedUid, 'found');
    let managementPage = await management(profileId);
    await selectDestination(managementPage, input.deferred.campusId);
    managementPage.tap('onSubmit');
    await pending(managementPage);
    const unavailableCommand =
      app.community.pendingSchoolIdentity.load(adminAccountId).command;
    assert.match(managementPage.page.data.error, /校内 UID 来源暂不可确认/);
    await rpc('uid_native_unavailable', {
      accountId,
      profileId,
      adminAccountId,
      command: unavailableCommand,
      uidA,
    });
    managementPage.tap('onCancelRequest');
    managementPage.tap('onConfirmCancel');
    await settled(managementPage);
    assert.ok(pageText(managementPage).includes('原请求已取消'));
    assert.equal(
      managementPage.page.data.management.current.schoolUid.uid,
      uidA.uid,
    );
    await selectDestination(managementPage, input.destination.campusId);
    assert.ok(pageText(managementPage).includes('永久保留'));
    transport.dropSuccess = { path: commandPath, method: 'POST' };
    managementPage.tap('onSubmit');
    await pending(managementPage);
    const original = app.community.pendingSchoolIdentity.load(adminAccountId);
    assert.ok(original);
    await rpc('uid_native_corrected', {
      accountId,
      profileId,
      adminAccountId,
      command: original.command,
      uidA,
    });
    close(managementPage);
    close(login);
    app.onHide();
    const journalBytes = JSON.stringify(
      [...platform.storage.values].filter(([key]) =>
        key.startsWith(journalPrefix),
      ),
    );
    assert.equal(journalBytes.includes(adminAccountId), false);
    assert.doesNotMatch(
      journalBytes,
      /"(?:accountId|sessionId|accessToken|refreshToken|assertionId|studentNumber|evidence)"/,
    );
    // Restart consumes serialized platform persistence, never the old controller's object graph.
    const persisted = JSON.parse(JSON.stringify([...platform.storage.values]));
    platform.storage.values.clear();
    for (const [key, value] of persisted) platform.setStorageSync(key, value);
    boot();
    login = mount('login');
    await logout(); // End the restored session before explicitly creating its same-account replacement.
    await logIn('admin');
    managementPage = mount('school-identity-management', {
      targetProfileId: 'invalid',
    });
    await pending(managementPage);
    assert.equal(managementPage.page.data.management, null);
    managementPage.tap('onRecover');
    await settled(managementPage);
    assert.equal(
      app.community.pendingSchoolIdentity.load(adminAccountId),
      null,
    );
    assert.equal(managementPage.page.data.canManage, false);
    assert.ok(pageText(managementPage).includes('历史结果'));
    close(managementPage);
    await rpc('uid_native_recovered', {
      accountId,
      profileId,
      adminAccountId,
      command: original.command,
    });
    await logout();
    await logIn('owner');
    const uidB = await ownUid();
    assert.equal(uidB.status, 'assigned');
    assert.equal(uidB.school.code, input.destination.schoolCode);
    assert.equal(uidB.uid, '1');
    const publicB = mount('public-profile', { profileId });
    await until(
      () => publicB.page.data.loaded && !publicB.page.data.busy,
      'public corrected UID',
      publicB.page,
    );
    assert.equal(publicB.page.data.profile.profileId, profileId);
    assert.equal(
      publicB.page.data.profile.affiliation.schoolCode,
      uidB.school.code,
    );
    assert.equal(publicB.page.data.profile.publicUid.value, uidB.uid);
    close(publicB);
    const identityB = mount('identity-campus');
    await until(
      () => identityB.page.data.loaded && !identityB.page.data.busy,
      'corrected identity campus',
      identityB.page,
    );
    assert.notEqual(identityB.page.data.state.selection, 'valid');
    assert.equal(identityB.page.data.state.canSelect, true);
    identityB.tap('onChoose', { id: input.destination.campusId });
    identityB.tap('onRequestConfirmation');
    identityB.tap('onConfirm');
    await until(
      () => !identityB.page.data.busy && !identityB.page.data.frozen,
      'explicit corrected campus selection',
      identityB.page,
    );
    assert.equal(
      identityB.page.data.state.selectedCampus.id,
      input.destination.campusId,
    );
    close(identityB);
    await logout();
    await logIn('admin');
    await lookup(input.home.campusId, uidA.formattedUid, 'unavailable');
    await lookup(input.destination.campusId, uidB.formattedUid, 'found');
    managementPage = await management(profileId);
    await selectDestination(managementPage, input.home.campusId);
    const heldReturn = transport.holdNext(commandPath, 'POST');
    const beforeReturnDispatch = sentCommands.length;
    managementPage.tap('onSubmit');
    managementPage.page.onSubmit(); // Duplicate native event must coalesce even before redraw.
    await heldReturn.arrived; // The real server committed; the platform callback is still withheld.
    assert.equal(sentCommands.length, beforeReturnDispatch + 1);
    const returnPending =
      app.community.pendingSchoolIdentity.load(adminAccountId);
    assert.ok(returnPending);
    const returnCommand = returnPending.command;
    managementPage.tap('onStopWaiting');
    assert.deepEqual(
      app.community.pendingSchoolIdentity.load(adminAccountId),
      returnPending,
    );
    const hiddenPage = managementPage;
    close(hiddenPage); // Actual onHide and onUnload are navigation, never cancellation.
    assert.equal(hiddenPage.page.data.management, null);
    assert.equal(hiddenPage.page.data.pendingTargetProfileId, '');
    await logout();
    await logIn('owner');
    const otherActorPage = mount('school-identity-management');
    await until(
      () =>
        !otherActorPage.page.data.busy &&
        otherActorPage.page.data.capabilityKnown,
      'other actor cannot recover admin journal',
      otherActorPage.page,
    );
    assert.equal(otherActorPage.page.data.frozen, false);
    assert.equal(otherActorPage.page.data.pendingRequestId, '');
    assert.equal(otherActorPage.page.data.management, null);
    assert.deepEqual(
      app.community.pendingSchoolIdentity.load(adminAccountId),
      returnPending,
    );
    close(otherActorPage);
    await logout();
    await logIn('admin');
    managementPage = mount('school-identity-management');
    await pending(managementPage);
    assert.equal(
      managementPage.page.data.pendingRequestId,
      returnCommand.clientRequestId,
    );
    // Apply won the server race. Explicit cancellation must return that historical applied receipt.
    managementPage.tap('onCancelRequest');
    managementPage.tap('onConfirmCancel');
    await settled(managementPage);
    assert.ok(pageText(managementPage).includes('学校归属已更正'));
    assert.equal(
      app.community.pendingSchoolIdentity.load(adminAccountId),
      null,
    );
    heldReturn.release();
    await delay(30);
    assert.equal(hiddenPage.page.data.management, null);
    assert.equal(hiddenPage.page.data.pendingTargetProfileId, '');
    assert.equal(
      app.community.pendingSchoolIdentity.load(adminAccountId),
      null,
    );
    const uidNewA = managementPage.page.data.management.current.schoolUid;
    assert.equal(uidNewA.status, 'assigned');
    assert.equal(uidNewA.school.code, input.home.schoolCode);
    assert.ok(BigInt(uidNewA.uid) > BigInt(uidA.uid));
    await selectDestination(managementPage, input.home.campusId);
    assert.ok(pageText(managementPage).includes('同一学校'));
    managementPage.tap('onSubmit');
    await settled(managementPage);
    assert.ok(pageText(managementPage).includes('未更正学校'));
    assert.equal(
      managementPage.page.data.management.current.schoolUid.uid,
      uidNewA.uid,
    );
    close(managementPage);
    // A cold native journal carrying a new key and an old target version must receive stale.
    const stale = {
      ...returnCommand,
      clientRequestId: await app.community.newRequestId(),
    };
    app.community.pendingSchoolIdentity.freeze({
      version: 1,
      accountId: adminAccountId,
      origin: nativeOrigin,
      phase: 'submit',
      command: stale,
    });
    managementPage = mount('school-identity-management');
    await pending(managementPage);
    managementPage.tap('onRetry');
    await settled(managementPage);
    assert.ok(pageText(managementPage).includes('状态已变化'));
    close(managementPage);
    // Real cancel-vs-late-apply protocol: lose the outbound send, cancel using the exact key.
    managementPage = await management(profileId);
    await selectDestination(managementPage, input.destination.campusId);
    transport.failNext = commandPath;
    managementPage.tap('onSubmit');
    await pending(managementPage);
    const cancelCommand =
      app.community.pendingSchoolIdentity.load(adminAccountId).command;
    managementPage.tap('onCancelRequest');
    managementPage.tap('onConfirmCancel');
    await settled(managementPage);
    assert.ok(pageText(managementPage).includes('原请求已取消'));
    close(managementPage);
    await rpc('uid_native_cancelled', {
      accountId,
      profileId,
      adminAccountId,
      command: cancelCommand,
    });
    // Native storage failure cannot dispatch an HTTP mutation.
    managementPage = await management(profileId);
    await selectDestination(managementPage, input.destination.campusId);
    const countBefore = sentCommands.length;
    failJournal = true;
    managementPage.tap('onSubmit');
    await until(
      () => !managementPage.page.data.busy,
      'native storage failure',
      managementPage.page,
    );
    assert.equal(sentCommands.length, countBefore);
    failJournal = false;
    close(managementPage);
    await rpc('uid_native_returned', {
      accountId,
      profileId,
      adminAccountId,
      commands: sentCommands,
      uidA,
      uidB,
      uidNewA,
    });
    // A different real native student is approved before any inventory admission for C.
    await logout();
    const deferredAccountId = await logIn('deferred');
    student = mount('student-verification');
    await until(
      () => student.page.data.loaded && !student.page.data.busy,
      'deferred student enrollment',
      student.page,
    );
    student.tap('onSearch');
    await until(
      () =>
        !student.page.data.busy &&
        student.page.data.campuses.some(
          (c) => c.id === input.deferred.campusId,
        ),
      'deferred campus search',
      student.page,
    );
    student.tap('onChooseCampus', { id: input.deferred.campusId });
    student.tap('onPrepare');
    await until(
      () =>
        !student.page.data.busy &&
        student.page.data.application?.state === 'draft',
      'deferred draft',
      student.page,
    );
    const deferredApplicationId = student.page.data.application.id;
    await upload.select(Buffer.from(input.png, 'base64'), 'image/png', {
      width: 48,
      height: 48,
      type: 'png',
    });
    student.tap('onChooseEvidence');
    await until(
      () => !student.page.data.busy,
      'deferred evidence processing',
      student.page,
    );
    if (!student.page.data.evidenceReady) student.tap('onRecoverEvidence');
    await until(
      () => !student.page.data.busy && student.page.data.evidenceReady,
      'deferred evidence ready',
      student.page,
    );
    student.tap('onSubmit');
    student.tap('onConfirm');
    await until(
      () =>
        !student.page.data.busy &&
        student.page.data.application?.state === 'pending',
      'deferred actual submit',
      student.page,
    );
    close(student);
    await logout();
    await logIn('admin');
    review = mount('student-verification-review', {
      regionId: input.deferred.regionId,
    });
    await until(
      () => review.page.data.loaded && !review.page.data.busy,
      'deferred real review queue',
      review.page,
    );
    review.tap('onSelect', { id: deferredApplicationId });
    await until(
      () =>
        !review.page.data.busy &&
        review.page.data.application?.id === deferredApplicationId,
      'deferred review detail',
      review.page,
    );
    review.tap('onApprove');
    review.tap('onConfirm');
    await until(
      () =>
        !review.page.data.busy &&
        review.page.data.application?.state === 'approved',
      'deferred approval still succeeds',
      review.page,
    );
    close(review);
    await logout();
    await logIn('deferred');
    student = mount('student-verification');
    await until(
      () =>
        student.page.data.loaded &&
        !student.page.data.busy &&
        student.page.data.schoolUidView.loaded,
      'deferred native outcome',
      student.page,
    );
    assert.equal(student.page.data.application.state, 'approved');
    assert.equal(
      student.page.data.schoolUidView.schoolUid.status,
      'unavailable',
    );
    assert.ok(pageText(student).includes('认证已通过，校内 UID 暂不可用'));
    close(student);
    const deferredProfile = await saveProfile('合成UID待补用户');
    assert.equal(deferredProfile.schoolUidStatus, 'unavailable');
    await rpc('uid_native_deferred', {
      accountId: deferredAccountId,
      applicationId: deferredApplicationId,
      profileId: deferredProfile.profileId,
    });
    await logout();
    await logIn('admin');
    managementPage = await management(deferredProfile.profileId);
    assert.equal(managementPage.page.data.management.actions.completeUid, true);
    managementPage.tap('onRequest', { action: 'complete_uid' });
    managementPage.tap('onSubmit');
    await settled(managementPage);
    const completeCommand = sentCommands.at(-1).command;
    assert.equal(
      managementPage.page.data.management.current.schoolUid.status,
      'assigned',
    );
    close(managementPage);
    await logout();
    await logIn('deferred');
    assert.equal((await ownUid()).status, 'assigned');
    await rpc('uid_native_completed', {
      accountId: deferredAccountId,
      applicationId: deferredApplicationId,
      profileId: deferredProfile.profileId,
      command: completeCommand,
    });
    await send({
      event: 'done',
      accountId,
      applicationId,
      profileId,
      deferredAccountId,
      deferredApplicationId,
      deferredProfileId: deferredProfile.profileId,
      requests: transport.exchanges.length,
    });
  } catch (e) {
    await send({
      event: 'failure',
      message: `[${currentPage}] ${e instanceof Error ? e.stack : String(e)}`,
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
