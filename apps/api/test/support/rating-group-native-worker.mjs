/** Actual emitted catalog Page/WXML with synthetic wx→real loopback HTTP/PG.
 * This does not claim physical WeChat or tappable transport acceptance. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { mountEmittedPage } from '../../../wechat/test/text-review-emitted-harness.mjs';
const require = createRequire(import.meta.url),
  dist = fileURLToPath(new URL('../../../wechat/dist/', import.meta.url));
const emitted = (name) => require(`${dist}${name}.js`);
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
      wx = {
        ...platformStorage(),
        nextTick: queueMicrotask,
        request: (options) => {
          void transport
            .send({
              url: options.url,
              method: options.method,
              headers: options.header,
              body: options.data,
              timeoutMs: options.timeout,
            })
            .then(
              (result) =>
                options.success({
                  statusCode: result.status,
                  header: result.headers,
                  data: result.body,
                }),
              () => options.fail({ errMsg: 'request:fail fixture' }),
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
    emitted('app');
    app.onLaunch();
    app.identity.sessions.completeLogin(
      app.identity.sessions.beginLogin(),
      input.actor,
    );
    const query = Object.fromEntries(
      new URL(`https://fixture.invalid/${input.locator}`).searchParams,
    );
    const catalog = mountEmittedPage('rating-catalog', app, wx);
    pages.push(catalog);
    catalog.page.onLoad(query);
    catalog.page.onShow();
    const until = Date.now() + 20000;
    while (catalog.page.data.busy || !catalog.page.data.loaded) {
      assert.ok(
        Date.now() < until,
        catalog.page.data.error || 'Catalog did not load',
      );
      await delay(10);
    }
    assert.equal(catalog.page.data.parentId, input.categoryId);
    assert.equal(catalog.page.data.regionId, query.regionId ?? null);
    assert.ok(
      transport.exchanges.some((e) => e.authorized && e.status === 200),
    );
    assert.ok(catalog.nodes().length > 0, 'Actual emitted WXML rendered');
    const before = transport.exchanges.length;
    const invalid = mountEmittedPage('rating-catalog', app, wx);
    pages.push(invalid);
    invalid.page.onLoad({ categoryId: '60', isSystem: 'true' });
    invalid.page.onShow();
    await delay(30);
    assert.ok(invalid.page.data.error);
    assert.equal(
      transport.exchanges.length,
      before,
      'Invalid legacy locator emits no request',
    );
    app.identity.sessions.logout();
    catalog.page.onHide();
    catalog.page.onShow();
    await delay(30);
    assert.equal(catalog.page.data.loaded, false);
    assert.equal(catalog.page.data.hasSession, false);
    process.send({
      event: 'done',
      categoryId: catalog.page.route.parentId,
      requests: transport.exchanges.length,
    });
  } catch (error) {
    process.send({ event: 'failure', message: error.stack ?? String(error) });
    process.exitCode = 1;
  } finally {
    for (const p of pages) {
      p.page.onHide?.();
      p.page.onUnload?.();
    }
    app?.onHide?.();
    process.disconnect();
  }
});
