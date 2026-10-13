/** Emitted App/Page/WXML -> real loopback AppModule. Only WeChat platform callbacks are synthetic. */
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
let checkpointId = 0;
async function checkpoint(name, extra) {
  const id = ++checkpointId;
  const reply = new Promise((resolve) => {
    const listener = (value) => {
      if (value.event === 'continue' && value.checkpointId === id) {
        process.off('message', listener);
        resolve(value);
      }
    };
    process.on('message', listener);
  });
  await send({ event: 'checkpoint', name, checkpointId: id, ...extra });
  const answer = await reply;
  assert.equal(answer.name, name);
  return answer;
}
process.once('message', async (input) => {
  let app;
  const pages = new Set();
  try {
    const transport = new NativeExperienceTransport(input.port),
      platform = platformStorage(),
      commands = [],
      navigations = [];
    const wx = {
      ...platform,
      nextTick: queueMicrotask,
      navigateTo(options) {
        navigations.push(options.url);
        options.success();
      },
      request(options) {
        const path = new URL(options.url).pathname;
        if (
          options.method === 'POST' &&
          /(?:appeal-commands|management\/commands)/.test(path)
        ) {
          const account =
            app.identity.sessions.snapshot().credentials.accountId;
          const journal = app.community.pendingAccountModeration.load(account);
          assert.deepEqual(
            journal.command,
            options.data,
            'Exact durable intent must precede HTTP dispatch',
          );
          assert.equal(
            journal.phase,
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
    globalThis.wx = wx;
    globalThis.App = (value) => {
      app = value;
    };
    globalThis.getApp = () => app;
    delete require.cache[require.resolve(`${dist}app.js`)];
    emitted('app');
    app.onLaunch();
    const login = (credentials) =>
      app.identity.sessions.completeLogin(
        app.identity.sessions.beginLogin(),
        credentials,
      );
    const mount = (name, query = {}) => {
      const h = mountEmittedPage(name, app, wx);
      pages.add(h);
      h.page.onLoad(query);
      h.page.onShow();
      return h;
    };
    const close = (h) => {
      h.page.onHide();
      h.page.onUnload();
      pages.delete(h);
    };
    const until = async (check, label, h) => {
      const end = Date.now() + 25000;
      while (!check()) {
        assert.ok(
          Date.now() < end,
          `${label}: ${JSON.stringify({ view: h?.page.data, exchanges: transport.exchanges.slice(-8) })}`,
        );
        await delay(10);
      }
    };
    const loaded = (h) =>
      until(() => !h.page.data.busy && h.page.data.loaded, 'loaded', h);
    const settled = (h) =>
      until(
        () =>
          !h.page.data.busy &&
          !h.page.data.frozen &&
          !!h.page.data.receiptStatus,
        'terminal original receipt',
        h,
      );
    const text = (h) =>
      h
        .nodes()
        .filter((n) => typeof n === 'string')
        .join('');
    const browse = () =>
      app.identity.api.request({
        path: input.browsePath,
        method: 'GET',
        authentication: 'optional',
        authReplay: 'never',
        successStatus: 200,
        decode: (v) => v,
      });
    transport.checkResponse = (path, status, body) => {
      if (path.includes('/safety/') && status === 200)
        assert.doesNotMatch(
          JSON.stringify(body),
          /"(?:accountId|openid|phone|studentNumber|sessionId)"/,
        );
    };
    login(input.owner);
    const ownerTicket = app.identity.sessions.snapshot();
    await assert.rejects(
      browse(),
      (error) => error.details.serverCode === 'SAFETY_ACCESS_SUSPENDED',
    );
    app.identity.sessions.assertCurrent(ownerTicket);
    assert.deepEqual(navigations, ['/pages/account-status/account-status']);
    let h = mount('account-status');
    await loaded(h);
    assert.equal(h.page.data.accountStatus.effective, 'access_suspension');
    assert.deepEqual(
      new Set(h.page.data.accountStatus.current.map((p) => p.kind)),
      new Set(['access_suspension', 'interaction_mute']),
    );
    assert.ok(text(h).includes('封号不会退出登录'));
    close(h);
    h = mount('safety-appeal', { punishmentId: input.suspensionId });
    await loaded(h);
    h.event('bindinput', 'onText', { value: '合成私人申诉：请复核此项封号' });
    h.tap('onRequestAppeal');
    assert.equal(h.page.data.confirming, 'submit_appeal');
    assert.ok(text(h).includes('不会发布到公开反馈'));
    transport.dropSuccess = {
      path: '/v1/me/safety/appeal-commands',
      method: 'POST',
    };
    h.tap('onSubmit');
    await until(
      () => !h.page.data.busy && h.page.data.frozen,
      'lost response journal',
      h,
    );
    const original = structuredClone(
      app.community.pendingAccountModeration.load(input.owner.accountId)
        .command,
    );
    close(h);
    h = mount('safety-appeal');
    await until(
      () => !h.page.data.busy && h.page.data.frozen,
      'restored original journal',
      h,
    );
    h.tap('onRecover');
    await settled(h);
    assert.equal(
      commands.filter((c) => c.path === '/v1/me/safety/appeal-commands').length,
      1,
    );
    assert.equal(h.page.data.appeals.length, 1);
    const appealId = h.page.data.appeals[0].appealId;
    h.tap('onSelectAppeal', { id: appealId });
    await loaded(h);
    assert.equal(h.page.data.selectedAppeal.state, 'pending');
    close(h);
    login(input.admin);
    h = mount('safety-appeal-management', { appealId });
    await loaded(h);
    assert.equal(h.page.data.canDecide, true);
    h.event('bindinput', 'onReason', {
      value: '合成决定：解除这项封号，保留独立禁言',
    });
    h.tap('onRequestDecision', { decision: 'released' });
    transport.dropSuccess = {
      path: '/v1/safety/appeal-management/commands',
      method: 'POST',
    };
    h.tap('onSubmit');
    await until(
      () => !h.page.data.busy && h.page.data.frozen,
      'decision lost response',
      h,
    );
    const decision = structuredClone(
      app.community.pendingAccountModeration.load(input.admin.accountId)
        .command,
    );
    let newSuspensionId;
    if (input.reissueAfterDecision) {
      const reply = await checkpoint('decision-applied-reissue', {
        command: decision,
      });
      newSuspensionId = reply.newSuspensionId;
      assert.equal(typeof newSuspensionId, 'string');
      assert.notEqual(newSuspensionId, input.suspensionId);
    }
    h.tap('onRetry');
    await settled(h);
    assert.equal(h.page.data.selectedAppeal.decision.outcome, 'released');
    close(h);
    login(input.owner);
    h = mount('account-status');
    await loaded(h);
    if (newSuspensionId) {
      assert.equal(h.page.data.accountStatus.effective, 'access_suspension');
      assert.ok(
        h.page.data.accountStatus.current.some(
          (p) => p.punishmentId === newSuspensionId && p.state === 'active',
        ),
      );
      await assert.rejects(
        browse(),
        (error) => error.details.serverCode === 'SAFETY_ACCESS_SUSPENDED',
      );
      close(h);
      login(input.admin);
      h = mount('safety-punishment-management', {
        punishmentId: newSuspensionId,
      });
      await loaded(h);
      h.event('bindinput', 'onReason', {
        value: '合成显式解除新处罚，旧决定不得解除它',
      });
      h.tap('onRequestRelease');
      h.tap('onSubmit');
      await settled(h);
      assert.equal(
        h.page.data.selectedPunishment.punishmentId,
        newSuspensionId,
      );
      assert.equal(h.page.data.selectedPunishment.state, 'released');
      close(h);
      login(input.owner);
      h = mount('account-status');
      await loaded(h);
    }
    assert.equal(h.page.data.accountStatus.effective, 'interaction_mute');
    await browse();
    close(h);
    h = mount('safety-appeal', { appealId });
    await loaded(h);
    assert.equal(h.page.data.selectedAppeal.decision.outcome, 'released');
    close(h);
    login(input.admin);
    h = mount('safety-punishment-management', { punishmentId: input.muteId });
    await loaded(h);
    h.tap('onHistory');
    await until(
      () => !h.page.data.busy && h.page.data.history.length >= 2,
      'both histories',
      h,
    );
    h.event('bindinput', 'onReason', { value: '合成解除独立禁言' });
    h.tap('onRequestRelease');
    assert.ok(text(h).includes(input.muteId));
    h.tap('onSubmit');
    await settled(h);
    assert.equal(h.page.data.selectedPunishment.state, 'released');
    close(h);
    login(input.owner);
    h = mount('account-status');
    await loaded(h);
    assert.equal(h.page.data.accountStatus.effective, 'clear');
    await browse();
    close(h);
    assert.ok(
      transport.exchanges
        .filter((e) => e.path.includes('/safety/'))
        .every((e) => e.authorized),
      'No private operation falls back to guest',
    );
    await send({
      event: 'done',
      commands,
      appealId,
      original,
      decision,
      exchanges: transport.exchanges,
      navigations,
    });
  } catch (error) {
    await send({ event: 'error', message: error.stack ?? String(error) });
  } finally {
    for (const h of pages) {
      h.page.onHide?.();
      h.page.onUnload?.();
    }
    app?.onHide?.();
    process.disconnect();
  }
});
