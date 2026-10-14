/** Actual emitted App/Page/WXML plus platform-only loopback HTTP adapter.
 * No source controller import, mocked gateway, provider network or device claim.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { mountEmittedPage } from '../../../wechat/test/text-review-emitted-harness.mjs';
const require = createRequire(import.meta.url);
const dist =
  process.env.WHALEU_WECHAT_DIST ??
  fileURLToPath(new URL('../../../wechat/dist/', import.meta.url));
const emitted = (name) => require(`${dist}/${name}.js`);
const {
  NativeExperienceTransport,
  nativeOrigin,
  platformStorage,
} = require('./experience-native-bridge.ts');
const B = '/v1/me/official-account-operations';
const send = (value) =>
  new Promise((resolve, reject) =>
    process.send(value, (error) => (error ? reject(error) : resolve())),
  );
async function checkpoint(name, fields = {}) {
  const answer = new Promise((resolve) => process.once('message', resolve));
  await send({ event: 'checkpoint', name, ...fields });
  assert.deepEqual(await answer, { event: 'continue', name });
}
async function until(check, label) {
  const deadline = Date.now() + 20000;
  while (!check()) {
    assert.ok(Date.now() < deadline, label);
    await delay(10);
  }
}
process.once('message', async (input) => {
  let app, h;
  const mounted = new Set();
  try {
    const transport = new NativeExperienceTransport(input.port),
      platform = platformStorage();
    let storageFault = null;
    const wx = {
      ...platform,
      nextTick: queueMicrotask,
      setStorageSync(key, value) {
        if (key.startsWith('whaleu.official-account.v1:')) {
          if (storageFault === 'write')
            throw Error('Synthetic platform write failure');
          if (storageFault === 'readback') {
            platform.setStorageSync(key, { broken: true });
            return;
          }
        }
        platform.setStorageSync(key, value);
      },
      request(o) {
        void transport
          .send({
            url: o.url,
            method: o.method,
            headers: o.header,
            body: o.data,
            timeoutMs: o.timeout,
          })
          .then(
            (r) =>
              o.success({
                statusCode: r.status,
                header: r.headers,
                data: r.body,
              }),
            () => o.fail({ errMsg: 'request:fail synthetic response loss' }),
          );
        // Deliberately noncooperative cancellation proves generation fencing.
        return { abort() {} };
      },
      navigateTo: (o) => o.success?.(),
    };
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
    const login = (actor) =>
      app.identity.sessions.completeLogin(
        app.identity.sessions.beginLogin(),
        actor,
      );
    login(input.author);
    const storageKey = `whaleu.official-account.v1:${nativeOrigin}:${input.author.accountId}`;
    const pending = () => platform.getStorageSync(storageKey);
    const officialPosts = () =>
      transport.exchanges.filter(
        (e) => e.path.startsWith(B) && e.method === 'POST',
      );
    const mount = () => {
      const value = mountEmittedPage('official-account-operations', app, wx);
      mounted.add(value);
      value.page.onLoad({ programId: input.programId });
      value.page.onShow();
      return value;
    };
    const close = (value) => {
      value.page.onHide();
      value.page.onUnload();
      mounted.delete(value);
    };
    const loaded = async () =>
      until(
        () => !h.page.data.busy && !!h.page.data.config,
        'Configuration not loaded',
      );
    const load = async () => {
      h.tap('onLoadProgram');
      await loaded();
    };
    const preview = async (kind) => {
      h.tap(kind === 'test' ? 'onTestPreview' : 'onPreview');
      await until(
        () => !h.page.data.busy && h.page.data.preview?.kind === kind,
        'Preview not loaded',
      );
    };
    const entry = mountEmittedPage('school-configuration', app, wx);
    const navigator = entry
      .nodes()
      .find(
        (n) =>
          typeof n !== 'string' &&
          n.tag === 'navigator' &&
          n.attrs.url ===
            '/pages/official-account-operations/official-account-operations',
      );
    assert.ok(
      navigator,
      'Actual emitted school configuration entry links the registered page',
    );
    const appJson = JSON.parse(readFileSync(`${dist}/app.json`, 'utf8'));
    assert.ok(
      appJson.pages.includes(
        'pages/official-account-operations/official-account-operations',
      ),
    );
    assert.doesNotMatch(
      readFileSync(
        `${dist}/pages/official-account-operations/official-account-operations.wxml`,
        'utf8',
      ),
      /bindtap="[^"]*[Pp]ublish|确认发布/,
    );
    h = mount();
    if (input.disabled) {
      await until(
        () =>
          !h.page.data.busy && h.page.data.capabilities?.mode === 'disabled',
        'Ordinary AppModule disabled capability',
      );
      assert.equal(h.page.data.config, null);
      assert.equal(h.page.data.preview, null);
      assert.equal(h.button('bindtap', 'onSave'), undefined);
      assert.equal(h.button('bindtap', 'onCreateTest'), undefined);
      assert.equal(officialPosts().length, 0);
      assert.match(h.page.data.message, /暂不可用/);
      await send({
        event: 'done',
        requests: transport.exchanges.filter((e) => e.path.startsWith(B))
          .length,
      });
      return;
    }
    await loaded();

    // Both failure modes block dispatch before any request key leaves the device.
    for (const fault of ['write', 'readback']) {
      const before = officialPosts().length;
      storageFault = fault;
      h.event('bindinput', 'onAuthor', { value: '不应发送的配置' });
      h.tap('onSave');
      await until(
        () => !h.page.data.busy && !!h.page.data.error,
        'Storage failure must surface',
      );
      assert.equal(officialPosts().length, before);
      assert.match(h.page.data.error, /记录无法安全保存或读取/);
      storageFault = null;
      platform.removeStorageSync(storageKey);
      await load();
    }

    h.event('bindinput', 'onAuthor', { value: '已单独保存的合成作者' });
    transport.dropSuccess = { path: `${B}/config-commands`, method: 'POST' };
    h.tap('onSave');
    h.page.onSave(); // two delivered native events join one flight
    await until(
      () => !h.page.data.busy && h.page.data.pending && !!h.page.data.error,
      'Lost save response',
    );
    const savedKey = pending().command.requestId;
    assert.equal(
      officialPosts().filter((e) => e.path === `${B}/config-commands`).length,
      1,
    );
    const beforeRestart = transport.exchanges.length;
    close(h);
    h = mount();
    await loaded();
    assert.equal(h.page.data.author, '已单独保存的合成作者');
    assert.equal(h.page.data.pending, false);
    assert.equal(pending(), undefined);
    const restartCalls = transport.exchanges
      .slice(beforeRestart)
      .filter((e) => e.path.startsWith(B));
    assert.equal(restartCalls[0].path, `${B}/requests/${savedKey}`);
    assert.equal(restartCalls[0].method, 'GET');
    await checkpoint('saved-once', { requestId: savedKey });

    await preview('daily_hot');
    assert.equal(h.page.data.preview.eligibleCount, 1);
    assert.ok(
      h.nodes().some((n) => typeof n === 'string' && n.includes(input.body)),
    );
    assert.equal(h.button('bindtap', 'onCreateTest'), undefined);
    await checkpoint('preview-no-effect');
    await preview('test');
    transport.failNext = `${B}/test-commands`;
    h.tap('onCreateTest');
    await until(
      () => !h.page.data.busy && h.page.data.pending && !!h.page.data.error,
      'Test command offline',
    );
    const testIntent = structuredClone(pending());
    const testKey = testIntent.command.requestId;
    assert.notEqual(testKey, savedKey, 'Save and test are independent intents');
    const postCount = officialPosts().length;
    close(h);
    h = mount();
    await loaded();
    assert.equal(h.page.data.pending, true);
    assert.equal(h.page.data.requestId, testKey);
    assert.match(h.page.data.message, /尚未记录/);
    assert.deepEqual(pending(), testIntent);
    assert.equal(
      officialPosts().length,
      postCount,
      'not_recorded never silently redispatches',
    );
    assert.equal(h.page.data.author, '已单独保存的合成作者');
    h.tap('onRetry');
    await until(
      () => !h.page.data.busy && h.page.data.status?.state === 'pending',
      'Explicit retry admits original intent',
    );
    assert.equal(h.page.data.requestId, testKey);
    h.tap('onResume');
    await until(() => !h.page.data.busy, 'Explicit current-authority resume');
    assert.equal(h.page.data.requestId, testKey);
    assert.equal(
      officialPosts().filter(
        (e) => e.path === `${B}/requests/${testKey}/resume`,
      ).length,
      1,
    );
    await checkpoint('run-test', { requestId: testKey });
    h.tap('onRecover');
    await until(
      () =>
        !h.page.data.busy && h.page.data.status?.state === 'draft_confirmed',
      'Draft-only result',
    );
    assert.equal(h.page.data.message, '草稿已生成，未发布');
    assert.equal(h.page.data.pending, false);
    assert.equal(pending(), undefined);
    assert.equal(
      officialPosts().filter((e) => e.path === `${B}/test-commands`).length,
      1,
    );
    assert.equal(
      officialPosts().some((e) => e.path.includes('publish')),
      false,
    );

    // A failed admission followed by a lost cancel ACK recovers the server's
    // minimal tombstone on an actual emitted-page cold restart.
    await load();
    await preview('test');
    transport.failNext = `${B}/test-commands`;
    h.tap('onCreateTest');
    await until(
      () => !h.page.data.busy && h.page.data.pending && !!h.page.data.error,
      'Pre-admission test offline',
    );
    const cancelledKey = pending().command.requestId;
    transport.dropSuccess = {
      path: `${B}/requests/${cancelledKey}/cancel`,
      method: 'POST',
    };
    h.tap('onCancel');
    await until(
      () => !h.page.data.busy && h.page.data.pending && !!h.page.data.error,
      'Lost pre-admission cancel acknowledgement',
    );
    close(h);
    h = mount();
    await loaded();
    assert.equal(h.page.data.pending, false);
    assert.equal(pending(), undefined);
    await checkpoint('cancel-tombstone', { requestId: cancelledKey });

    await load();
    const held = transport.holdNext(`${B}/previews`, 'POST');
    h.tap('onPreview');
    await held.arrived;
    h.page.onHide();
    held.release();
    await delay(30);
    assert.equal(h.page.data.preview, null);
    assert.equal(h.page.data.config, null);
    assert.equal(h.page.data.author, '');
    close(h);
    h = mount();
    await loaded();
    const switched = transport.holdNext(`${B}/previews`, 'POST');
    h.tap('onPreview');
    await switched.arrived;
    login(input.reader);
    switched.release();
    await delay(30);
    assert.equal(h.page.data.preview, null);
    assert.equal(h.page.data.config, null);
    assert.equal(h.page.data.requestId, '');
    login(input.author);
    close(h);
    h = mount();
    await loaded();
    const moved = transport.holdNext(`${B}/previews`, 'POST');
    h.tap('onPreview');
    await moved.arrived;
    h.event('bindinput', 'onProgram', { value: input.foreignProgram });
    moved.release();
    await delay(30);
    assert.equal(h.page.data.preview, null);
    assert.equal(h.page.data.config, null);
    assert.equal(h.page.data.programInput, input.foreignProgram);
    h.event('bindinput', 'onProgram', { value: input.programId });
    await load();
    await preview('test');
    h.tap('onCreateTest');
    await until(
      () => !h.page.data.busy && h.page.data.pending,
      'New explicit test pending',
    );
    const revokedIntent = structuredClone(pending());
    await checkpoint('revoke-capability', {
      requestId: revokedIntent.command.requestId,
    });
    h.tap('onLoadProgram');
    await until(() => !h.page.data.busy, 'Recovery after authority loss');
    assert.equal(h.page.data.config, null);
    assert.equal(h.page.data.preview, null);
    assert.equal(h.page.data.pending, true);
    h.tap('onResume');
    await until(
      () => !h.page.data.busy && !!h.page.data.error,
      'Revoked resume refused',
    );
    assert.deepEqual(pending(), revokedIntent);
    const refused = transport.exchanges.find(
      (e) =>
        e.path === `${B}/requests/${revokedIntent.command.requestId}/resume`,
    );
    assert.equal(refused?.status, 403);
    await checkpoint('revoked-no-dispatch', {
      requestId: revokedIntent.command.requestId,
    });
    const { OfficialCommandJournal } = emitted(
      'official-account-operations/journal',
    );
    const { WechatStorage } = emitted('platform/wechat');
    assert.equal(
      new OfficialCommandJournal(
        new WechatStorage(wx),
        'https://other-native.invalid',
      ).read(input.author.accountId),
      null,
    );
    assert.deepEqual(
      pending(),
      revokedIntent,
      'Other-origin journal cannot consume original pending intent',
    );
    const stored = JSON.stringify(
      [...platform.storage.values].filter(([key]) =>
        key.startsWith('whaleu.official-account.v1:'),
      ),
    );
    assert.ok(!stored.includes(input.author.accessToken));
    assert.ok(!stored.includes(input.body));
    await send({
      event: 'done',
      requests: transport.exchanges.filter((e) => e.path.startsWith(B)).length,
    });
  } catch (error) {
    await send({
      event: 'failure',
      message: error instanceof Error ? error.stack : String(error),
    });
    process.exitCode = 1;
  } finally {
    for (const page of mounted) {
      page.page.onHide?.();
      page.page.onUnload?.();
    }
    app?.community?.views?.dispose();
    process.disconnect?.();
  }
});
