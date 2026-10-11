/** Emitted native publication and locator opening; no business-owner stubs. */
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
const send = (v) =>
  new Promise((resolve, reject) =>
    process.send(v, (e) => (e ? reject(e) : resolve())),
  );
async function rpc(name, fields = {}) {
  const next = new Promise((r) => process.once('message', r));
  await send({ event: 'checkpoint', name, ...fields });
  const reply = await next;
  assert.equal(reply.event, 'continue');
  assert.equal(reply.name, name);
  return reply;
}
async function until(check, label, page) {
  const end = Date.now() + 25000;
  while (!check()) {
    assert.ok(Date.now() < end, `${label}: ${JSON.stringify(page?.data)}`);
    await delay(10);
  }
}
process.once('message', async (input) => {
  let app, upload;
  const pages = new Set();
  try {
    const transport = new NativeExperienceTransport(input.port),
      platform = platformStorage();
    upload = await NativeMediaUploadBridge.create(
      input.port,
      nativeOrigin,
      'errands',
    );
    const wx = {
      ...platform,
      ...upload.wx,
      nextTick: queueMicrotask,
      request: (o) => {
        void (async () => {
          const path = new URL(o.url).pathname;
          if (o.method === 'POST' && path === '/v1/errands')
            await rpc('review-text', { body: o.data });
          const r = await transport.send({
            url: o.url,
            method: o.method,
            headers: o.header,
            body: o.data,
            timeoutMs: o.timeout,
          });
          if (r.status === 200 && path.endsWith('/finalize'))
            await rpc('process-images');
          if (r.status === 200 && path === '/v2/errand-publications/prepare')
            await rpc('review-images', { requestId: r.body.requestId });
          o.success({ statusCode: r.status, header: r.headers, data: r.body });
        })().catch(() => o.fail({ errMsg: 'request:fail synthetic loopback' }));
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
    const login = (name) =>
      app.identity.sessions.completeLogin(
        app.identity.sessions.beginLogin(),
        input.actors[name],
      );
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
    const orders = [];
    for (const version of [1, 2]) {
      login('publisher');
      const compose = mount('errand-compose', {
        regionId: input.targetRegionId,
      });
      await until(
        () => compose.page.data.loaded && !compose.page.data.busy,
        'compose',
        compose.page,
      );
      for (const [field, value] of Object.entries({
        title: `Native group v${version}`,
        publicText: 'PUBLIC_BODY_NOT_DELIVERED',
        privateText: 'PRIVATE_BODY_NOT_DELIVERED',
        expectedTimeText: 'Today',
        reward: '12.50',
        wechat: 'PRIVATE_CONTACT',
        phone: '12345678901',
      }))
        compose.event('bindinput', 'onForm', { value }, { field });
      if (version === 2)
        for (const slot of ['public0', 'private0']) {
          await upload.select(Buffer.from(input.png, 'base64'), 'image/png', {
            width: 48,
            height: 48,
            type: 'png',
          });
          compose.tap('onChooseOrderImage', { value: slot });
          await until(
            () =>
              compose.page.data.imagePublication.images.find(
                (x) => x.slot === slot,
              )?.ready && !compose.page.data.imagePublication.busy,
            'image ready',
            compose.page,
          );
          await upload.idle();
        }
      compose.tap('onPublish');
      await until(
        () =>
          !!(version === 1
            ? compose.page.data.confirmedOrderId
            : compose.page.data.imagePublication.confirmedOrderId),
        'published',
        compose.page,
      );
      const orderId =
        version === 1
          ? compose.page.data.confirmedOrderId
          : compose.page.data.imagePublication.confirmedOrderId;
      orders.push(orderId);
      close(compose);
      const { locator } = await rpc('deliver', { orderId, version });
      assert.equal(
        locator,
        `pages/errand-detail/errand-detail?orderId=${orderId}`,
      );
      // The delivered route is opened via the actual emitted native page loader.
      const [pagePath, query] = locator.split('?');
      assert.equal(pagePath, 'pages/errand-detail/errand-detail');
      login('reader');
      const detail = mount(
        'errand-detail',
        Object.fromEntries(new URLSearchParams(query)),
      );
      await until(
        () => detail.page.data.loaded,
        'locator public detail',
        detail.page,
      );
      assert.equal(detail.page.data.detail.id, orderId);
      assert.equal(
        detail.page.data.detail.targetRegion.id,
        input.targetRegionId,
      );
      for (const field of ['privateText', 'privateMedia', 'oppositeContact'])
        assert.equal(field in detail.page.data.detail, false);
      assert.equal(
        detail
          .nodes()
          .some(
            (n) =>
              typeof n !== 'string' && n.attrs?.['data-value'] === 'private0',
          ),
        false,
      );
      close(detail);
    }
    await send({ event: 'done', orders, uploads: upload.exchanges.length });
  } catch (e) {
    await send({ event: 'failure', message: e?.stack ?? String(e) });
  } finally {
    for (const h of pages) {
      h.page.onHide?.();
      h.page.onUnload?.();
    }
    app?.onHide?.();
    await upload?.dispose();
    process.disconnect();
  }
});
