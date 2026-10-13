/** Emitted removal controls and durable command path against the real loopback API. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { mountEmittedPage } from '../../../wechat/test/text-review-emitted-harness.mjs';
const require = createRequire(import.meta.url);
const dist = fileURLToPath(new URL('../../../wechat/dist/', import.meta.url));
const {
  NativeExperienceTransport,
  nativeOrigin,
  platformStorage,
} = require('./experience-native-bridge.ts');
process.once('message', async (input) => {
  let app;
  const pages = [];
  try {
    const transport = new NativeExperienceTransport(input.port),
      platform = platformStorage(),
      commands = [];
    const wx = {
      ...platform,
      nextTick: queueMicrotask,
      request(options) {
        if (options.method === 'POST' && options.url.endsWith('/commands'))
          commands.push(structuredClone(options.data));
        transport
          .send({
            url: options.url,
            method: options.method,
            headers: options.header,
            body: options.data,
            timeoutMs: options.timeout,
          })
          .then(
            (r) =>
              options.success({
                statusCode: r.status,
                header: r.headers,
                data: r.body,
              }),
            () => options.fail({ errMsg: 'request:fail' }),
          );
        return { abort() {} };
      },
    };
    require(`${dist}config.js`).clientConfiguration = Object.freeze({
      apiOrigin: nativeOrigin,
      providerLoginEnabled: true,
    });
    globalThis.wx = wx;
    globalThis.App = (value) => {
      app = value;
    };
    globalThis.getApp = () => app;
    require(`${dist}app.js`);
    app.onLaunch();
    const {
      accountId,
      sessionId,
      accessToken,
      refreshToken,
      expiresAt,
      refreshExpiresAt,
    } = input.admin;
    app.identity.sessions.completeLogin(app.identity.sessions.beginLogin(), {
      accountId,
      sessionId,
      accessToken,
      refreshToken,
      expiresAt,
      refreshExpiresAt,
    });
    const until = async (check, h) => {
      const end = Date.now() + 25000;
      while (!check()) {
        assert.ok(Date.now() < end, JSON.stringify(h.page.data));
        await delay(10);
      }
    };
    for (const item of input.targets) {
      const name =
        item.target.kind === 'post'
          ? 'admin-post-removal'
          : 'admin-discussion-removal';
      const h = mountEmittedPage(name, app, wx);
      pages.push(h);
      h.page.onLoad(item.target);
      h.page.onShow();
      await until(
        () => !h.page.data.busy && h.page.data.management?.punishmentOptions,
        h,
      );
      h.tap(
        item.target.kind === 'post' ? 'onRemovePost' : 'onRemoveDiscussion',
      );
      await until(
        () => !h.page.data.busy && h.page.data.confirming === 'remove',
        h,
      );
      h.event('bindchange', 'onPunishmentKind', { value: item.kind });
      h.event('bindchange', 'onPunishmentUnit', { value: item.unit });
      h.event('bindinput', 'onPunishmentValue', { value: '7' });
      h.event('bindinput', 'onPunishmentReason', {
        value: 'Synthetic native causal moderation',
      });
      h.tap('onSubmit');
      await until(
        () => !h.page.data.busy && !h.page.data.frozen && h.page.data.applied,
        h,
      );
      const command = commands.at(-1);
      assert.equal(command.version, 2);
      assert.equal(command.punishment.kind, item.kind);
      assert.equal(command.punishment.duration.unit, item.unit);
      assert.ok(!JSON.stringify(command).includes(input.subjectId));
      h.page.onHide();
      h.page.onUnload();
    }
    process.send({ event: 'done', commands });
  } catch (error) {
    process.send({ event: 'failed', error: String(error?.stack ?? error) });
  } finally {
    for (const h of pages) h.page.onHide?.();
    app?.onHide?.();
  }
});
