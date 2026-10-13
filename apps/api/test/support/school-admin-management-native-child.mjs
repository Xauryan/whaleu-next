/** Real emitted App/Page/WXML to real loopback API; only wx callbacks are simulated. */
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
const base = '/v1/admin/school-administrators',
  commandPath = `${base}/commands`,
  journalPrefix = 'whaleu.school-admin-management.pending.v1:';
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
process.once('message', async (input) => {
  let app;
  const pages = new Set();
  try {
    const transport = new NativeExperienceTransport(input.port),
      platform = platformStorage(),
      commands = [],
      calls = [];
    let failJournal = '',
      written = false;
    const wx = {
      ...platform,
      nextTick: queueMicrotask,
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
          const durable = app.community.pendingSchoolAdminManagement.load(
            input.admin.accountId,
          );
          assert.deepEqual(
            durable.command,
            options.data,
            'Exact journal readback precedes dispatch',
          );
          assert.equal(
            durable.phase,
            path.endsWith('/cancel') ? 'cancel' : 'submit',
          );
          assert.deepEqual(
            Object.keys(options.data).sort(),
            [
              'action',
              'clientRequestId',
              'expectedStateVersion',
              ...(options.data.action === 'revoke' ? [] : ['regionId']),
              'targetProfileId',
            ].sort(),
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
        return { abort() {} }; // Deliberately late callbacks exercise ownership guards.
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
    }
    const login = (actor) =>
      app.identity.sessions.completeLogin(
        app.identity.sessions.beginLogin(),
        actor,
      );
    const mount = (targetProfileId) => {
      const h = mountEmittedPage('school-admin-management', app, wx);
      pages.add(h);
      h.page.onLoad(targetProfileId ? { targetProfileId } : {});
      h.page.onShow();
      return h;
    };
    const close = (h) => {
      h.page.onHide();
      h.page.onUnload();
      pages.delete(h);
    };
    const until = async (check, label, h) => {
      const deadline = Date.now() + 25000;
      while (!check()) {
        assert.ok(
          Date.now() < deadline,
          `${label}: ${JSON.stringify({ view: h?.page.data, exchanges: transport.exchanges.slice(-8) })}`,
        );
        await delay(10);
      }
    };
    const loaded = (h) =>
      until(
        () => !h.page.data.busy && h.page.data.loaded,
        'fresh management',
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
        'historical terminal receipt',
        h,
      );
    const text = (h) =>
      h
        .nodes()
        .filter((node) => typeof node === 'string')
        .join('');
    const confirm = (h, action, regionId = input.regions.home) => {
      if (action !== 'revoke') h.tap('onSelectRegion', { id: regionId });
      h.tap('onRequest', { action });
      assert.equal(h.page.data.confirming, action);
      for (const copy of [
        '公开主页 ID',
        '固定',
        '不会自动佩戴',
        '撤权保留',
        '头衔不代表当前权限',
        '不发送通知',
      ])
        assert.ok(text(h).includes(copy), copy);
    };
    transport.checkResponse = (path, status, body) => {
      if (path.startsWith(base) && status === 200)
        assert.doesNotMatch(
          JSON.stringify(body),
          /"(?:accountId|openid|studentNumber|phone|grantId|assertionId|sessionId)"/,
        );
    };
    boot();
    login(input.admin);
    let h = mount();
    await until(
      () => !h.page.data.busy && h.page.data.capabilityKnown,
      'capability',
      h,
    );
    assert.equal(
      h.page.data.canManage,
      true,
      'Highest developer label still admits actual super grant',
    );
    h.event('bindinput', 'onTargetInput', { value: 'bad' });
    h.tap('onReload');
    await until(
      () => !h.page.data.busy && !!h.page.data.error,
      'invalid ID',
      h,
    );
    h.event('bindinput', 'onTargetInput', { value: input.missingProfileId });
    h.tap('onReload');
    await until(
      () => !h.page.data.busy && !!h.page.data.error,
      'nonexistent profile',
      h,
    );
    h.event('bindinput', 'onTargetInput', { value: input.targets.primary });
    h.tap('onReload');
    await loaded(h);
    assert.equal(
      h.page.data.selectedRegionId,
      '',
      'No singleton/default auto-selection',
    );
    assert.ok(
      !h.page.data.management.eligibility.regions.some(
        (r) => r.id === input.regions.foreign,
      ),
    );
    confirm(h, 'appoint');
    h.tap('onClose');
    h.page.onSubmit();
    await delay(20);
    assert.equal(commands.length, 0);
    confirm(h, 'appoint');
    transport.dropSuccess = { path: commandPath, method: 'POST' };
    h.tap('onSubmit');
    h.page.onSubmit();
    await pending(h);
    assert.equal(commands.length, 1);
    const first = commands.at(-1).body;
    const firstHash = app.community.pendingSchoolAdminManagement.load(
      input.admin.accountId,
    ).requestHash;
    close(h);
    app.onHide();
    await checkpoint('appointment-lost-revoke-super', {
      command: first,
      requestHash: firstHash,
    });
    boot();
    login(input.stranger);
    h = mount();
    assert.equal(h.page.data.pendingRequestId, '');
    close(h);
    app.onHide();
    boot('https://other-school-admin.invalid');
    login(input.admin);
    h = mount();
    assert.equal(h.page.data.pendingRequestId, '');
    close(h);
    app.onHide();
    boot();
    login(input.admin);
    const recoveryStart = calls.length;
    h = mount();
    await pending(h);
    assert.equal(
      calls.length,
      recoveryStart,
      'Cold restore precedes capabilities and target reads',
    );
    h.tap('onRecover');
    await settled(h);
    assert.equal(h.page.data.canManage, false);
    assert.match(h.page.data.receiptStatus, /已确认任命/);
    assert.equal(commands.length, 1);
    assert.ok(
      calls
        .slice(recoveryStart)
        .every(
          (c) =>
            c.path.includes('/requests/') || c.path === '/v1/me/authorization',
        ),
    );
    await checkpoint('restore-super');
    h.tap('onReload');
    await loaded(h);
    assert.equal(
      h.page.data.management.currentAssignment.regionId,
      input.regions.home,
    );
    confirm(h, 'reassign', input.regions.related);
    h.tap('onSubmit');
    await settled(h);
    const reassigned = commands.at(-1).body;
    assert.equal(
      h.page.data.management.currentAssignment.regionId,
      input.regions.related,
    );
    confirm(h, 'reassign', input.regions.related);
    h.tap('onSubmit');
    await settled(h);
    const unchanged = commands.at(-1).body;
    assert.match(h.page.data.receiptStatus, /无需变更/);
    confirm(h, 'revoke');
    h.tap('onSubmit');
    await settled(h);
    const revoked = commands.at(-1).body;
    assert.equal(h.page.data.management.currentAssignment, null);
    await checkpoint('revoked-title-retained', {
      requests: [
        first.clientRequestId,
        reassigned.clientRequestId,
        unchanged.clientRequestId,
        revoked.clientRequestId,
      ],
    });
    close(h);

    h = mount(input.targets.cancelled);
    await loaded(h);
    confirm(h, 'appoint');
    transport.failNext = commandPath;
    h.tap('onSubmit');
    await pending(h);
    const cancelled = commands.at(-1).body;
    h.tap('onRecover');
    await pending(h);
    assert.equal(
      h.page.data.pendingRequestId,
      cancelled.clientRequestId,
      'not_recorded preserves key',
    );
    h.tap('onCancelRequest');
    transport.dropSuccess = { path: `${commandPath}/cancel`, method: 'POST' };
    h.tap('onConfirmCancel');
    await pending(h);
    assert.equal(
      app.community.pendingSchoolAdminManagement.load(input.admin.accountId)
        .phase,
      'cancel',
    );
    close(h);
    app.onHide();
    boot();
    login(input.admin);
    h = mount();
    await pending(h);
    h.tap('onRetry');
    await settled(h);
    assert.match(h.page.data.receiptStatus, /原请求已取消/);
    await checkpoint('cancelled-late-original', { command: cancelled });
    close(h);

    h = mount(input.targets.applyWinner);
    await loaded(h);
    confirm(h, 'appoint');
    transport.dropSuccess = { path: commandPath, method: 'POST' };
    h.tap('onSubmit');
    await pending(h);
    const appliedWinner = commands.at(-1).body;
    h.tap('onCancelRequest');
    h.tap('onConfirmCancel');
    await settled(h);
    assert.match(h.page.data.receiptStatus, /已确认任命/);
    close(h);

    h = mount(input.targets.stale);
    await loaded(h);
    confirm(h, 'appoint');
    await checkpoint('change-target-version', {
      targetProfileId: input.targets.stale,
      version: h.page.data.management.stateVersion,
    });
    h.tap('onSubmit');
    await settled(h);
    const stale = commands.at(-1).body;
    assert.match(h.page.data.receiptStatus, /状态已变化/);
    close(h);

    h = mount(input.targets.late);
    await loaded(h);
    confirm(h, 'appoint');
    const hold = transport.holdNext(commandPath, 'POST');
    h.tap('onSubmit');
    await hold.arrived;
    const late = commands.at(-1).body;
    close(h);
    login(input.stranger);
    hold.release();
    await delay(30);
    assert.equal(h.page.data.management, null);
    assert.equal(h.page.data.receiptStatus, '');
    assert.ok(
      app.community.pendingSchoolAdminManagement.load(input.admin.accountId),
    );
    h = mount();
    await until(() => !h.page.data.busy, 'other actor', h);
    assert.equal(h.page.data.pendingRequestId, '');
    close(h);
    login(input.admin);
    h = mount();
    await pending(h);
    h.tap('onRecover');
    await settled(h);
    close(h);

    h = mount(input.targets.storage);
    await loaded(h);
    for (const mode of ['write', 'silent', 'readback']) {
      confirm(h, 'appoint');
      const before = commands.length;
      failJournal = mode;
      written = false;
      h.tap('onSubmit');
      await until(() => !h.page.data.busy, 'failed journal persistence', h);
      assert.equal(commands.length, before, mode);
      failJournal = '';
      const original = app.community.pendingSchoolAdminManagement.load(
        input.admin.accountId,
      );
      if (original) {
        h.tap('onReload');
        await pending(h);
        h.tap('onCancelRequest');
        h.tap('onConfirmCancel');
        await settled(h);
      } else {
        h.tap('onReload');
        await loaded(h);
      }
    }
    confirm(h, 'appoint');
    failJournal = 'remove';
    h.tap('onSubmit');
    await pending(h);
    const storage = commands.at(-1).body;
    assert.match(h.page.data.receiptStatus, /清理失败/);
    failJournal = '';
    h.tap('onRecover');
    await settled(h);
    close(h);
    await send({
      event: 'done',
      httpCalls: transport.exchanges.length,
      receiptReads: transport.exchanges.filter((x) =>
        x.path.includes('/requests/'),
      ).length,
      requestIds: {
        first: first.clientRequestId,
        reassigned: reassigned.clientRequestId,
        unchanged: unchanged.clientRequestId,
        revoked: revoked.clientRequestId,
        cancelled: cancelled.clientRequestId,
        appliedWinner: appliedWinner.clientRequestId,
        stale: stale.clientRequestId,
        late: late.clientRequestId,
        storage: storage.clientRequestId,
      },
    });
  } catch (error) {
    await send({ event: 'failure', message: error?.stack ?? String(error) });
    process.exitCode = 1;
  } finally {
    for (const h of pages) {
      h.page.onHide?.();
      h.page.onUnload?.();
    }
    app?.onHide?.();
    process.disconnect();
  }
});
