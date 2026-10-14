/** Actual emitted App/Page/WXML -> ordinary HTTP/PG. Only native device callbacks
 * and the first-party origin are bridged; no provider grant or location request. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { mountEmittedPage } from './text-review-emitted-harness.mjs';
const require = createRequire(import.meta.url),
  dist = fileURLToPath(new URL('../dist/', import.meta.url)),
  emitted = (name) => require(`${dist}${name}.js`);
const {
  NativeExperienceTransport,
  nativeOrigin,
  platformStorage,
} = require('../../api/test/support/experience-native-bridge.ts');
const {
  NativeMediaReadBridge,
} = require('../../api/test/support/media/native-read-bridge.ts');
const send = (value) =>
  new Promise((resolve, reject) =>
    process.send(value, (error) => (error ? reject(error) : resolve())),
  );
async function rpc(name) {
  const next = new Promise((resolve) => process.once('message', resolve));
  await send({ event: 'checkpoint', name });
  assert.deepEqual(await next, { event: 'continue', name });
}
async function until(check, label, page) {
  const end = Date.now() + 20000;
  while (!(await check())) {
    assert.ok(Date.now() < end, `${label}: ${JSON.stringify(page?.data)}`);
    await delay(10);
  }
}
process.once('message', async (input) => {
  let app, read;
  const pages = new Set();
  try {
    const transport = new NativeExperienceTransport(input.port),
      platform = platformStorage(),
      copies = [],
      navigation = [];
    read = await NativeMediaReadBridge.create(input.port, 'campus-tools');
    const wx = {
      ...platform,
      ...read.wx,
      nextTick: queueMicrotask,
      login() {
        throw Error('No provider request allowed');
      },
      getLocation() {
        throw Error('No actual location request allowed');
      },
      previewImage() {
        throw Error('No unmanaged native preview');
      },
      navigateTo(options) {
        navigation.push(options.url);
        options.success();
      },
      navigateBack(options) {
        options.fail({});
      },
      reLaunch(options) {
        navigation.push(options.url);
        options.success();
      },
      setClipboardData(options) {
        copies.push(options.data);
        options.success();
      },
      request(options) {
        const requestPath = new URL(options.url).pathname;
        assert.ok(
          options.method === 'GET' ||
            (options.method === 'POST' && requestPath === '/v1/auth/refresh'),
        );
        if (options.method === 'GET') assert.equal(options.data, undefined);
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
    require(`${dist}app.js`);
    assert.ok(app);
    app.onLaunch();
    assert.ok(app.campusTools);
    assert.equal(app.identity.sessions.snapshot().credentials, null);
    const mount = (name, query = {}) => {
      const h = mountEmittedPage(name, app, wx);
      pages.add(h);
      h.page.onLoad?.(query);
      h.page.onShow();
      return h;
    };
    const close = (h) => {
      h.page.onHide();
      h.page.onUnload();
      pages.delete(h);
    };
    const route = (entry) => ({
      campusId: input.campusId,
      catalogId: input.catalogId,
      entryId: entry.id,
    });
    const hub = mount('campus-tools', { campusId: input.campusId });
    await until(
      () => hub.page.data.state === 'ready',
      'guest hub ready',
      hub.page,
    );
    assert.equal(hub.page.data.entries.length, 4);
    assert.ok(transport.exchanges.every((e) => !e.authorized));
    hub.tap('onOpen', { id: input.entries[0].id });
    assert.ok(navigation[0].startsWith('/pages/campus-tools-map/'));
    close(hub);
    const map = mount('campus-tools-map', route(input.entries[0]));
    await until(() => map.page.data.entry, 'map ready', map.page);
    map.tap('onMarker', { id: 1 });
    assert.equal(map.page.data.marker.details, 'Synthetic details');
    assert.equal(map.button('bindtap', 'onLocate').attrs.disabled, 'true');
    map.tap('onReset');
    assert.deepEqual(map.page.data.center, { latitude: 30, longitude: 110 });
    close(map);
    const shuttle = mount('campus-tools-shuttle', route(input.entries[1]));
    await until(() => shuttle.page.data.entry, 'shuttle ready', shuttle.page);
    shuttle.tap('onToggleGroup', { id: 'shuttle' });
    shuttle.tap('onToggleGroup', { id: 'bus' });
    assert.equal(shuttle.page.data.expandedGroups.shuttle, true);
    assert.equal(shuttle.page.data.expandedGroups.bus, true);
    shuttle.tap('onPreview', {
      binding: input.entries[1].groups[0].slots[0].bindingId,
    });
    await until(
      () => shuttle.page.data.image.status === 'ready',
      'shuttle current bytes',
      shuttle.page,
    );
    const old = { ...shuttle.page.data.image };
    assert.ok((await read.bytes(old.src)).length > 0);
    assert.equal(read.exchanges.at(-1).authorized, false);
    shuttle.tap('onImageNext');
    await until(
      () =>
        shuttle.page.data.image.status === 'ready' &&
        shuttle.page.data.image.selected === 1,
      'second image',
      shuttle.page,
    );
    assert.notEqual(shuttle.page.data.image.src, old.src);
    shuttle.page.onImageError({
      currentTarget: { dataset: { source: old.src, viewId: old.viewId } },
    });
    assert.equal(shuttle.page.data.image.status, 'ready');
    shuttle.tap('onToggleGroup', { id: 'bus' });
    assert.equal(shuttle.page.data.expandedGroups.bus, false);
    assert.equal(shuttle.page.data.image.expanded, false);
    await until(
      () => read.removed.length >= 2,
      'collapsed group releases temporary files',
      shuttle.page,
    );
    assert.equal(shuttle.page.data.image.src, '');
    shuttle.tap('onToggleGroup', { id: 'bus' });
    shuttle.tap('onPreview', {
      binding: input.entries[1].groups[1].slots[0].bindingId,
    });
    await until(
      () => shuttle.page.data.image.status === 'ready',
      'reopened collapsed group',
      shuttle.page,
    );
    shuttle.tap('onCloseImage');
    await until(
      () => read.removed.length >= 3,
      'explicit preview close releases temporary files',
      shuttle.page,
    );
    assert.equal(shuttle.page.data.image.src, '');
    close(shuttle);
    const research = mount('campus-tools-research', route(input.entries[2]));
    await until(
      () => research.page.data.entry,
      'research ready',
      research.page,
    );
    research.tap('onCopy');
    await until(
      () => research.page.data.status === '已复制外部链接',
      'copy callback',
      research.page,
    );
    assert.deepEqual(copies, ['https://tools.example.com/resource']);
    research.tap('onPreview', { binding: input.entries[2].image.bindingId });
    await until(
      () => research.page.data.image.status === 'ready',
      'research bytes',
      research.page,
    );
    close(research);
    await until(() => read.removed.length >= 4, 'hide cleanup');
    const web = mount('campus-tools-webview', route(input.entries[3]));
    await until(
      () => web.page.data.state === 'webview_unconfigured',
      'disabled embed',
      web.page,
    );
    assert.equal(web.page.data.webviewSrc, '');
    assert.ok(
      !web
        .nodes()
        .some((node) => typeof node !== 'string' && node.tag === 'web-view'),
    );
    web.tap('onBack');
    assert.equal(navigation.at(-1), '/pages/campus-tools/campus-tools');
    close(web);
    const malformed = mount('campus-tools-webview', {
      ...route(input.entries[3]),
      url: 'https://attacker.example/',
    });
    assert.match(malformed.page.data.error, /入口无效/);
    close(malformed);
    // Synthetic software-only attestation on both sides. No real platform grant.
    const { createCampusToolsRuntime } = emitted('campus-tools/runtime'),
      { WechatNativeMediaFiles } = emitted('media/native-files'),
      { systemClock } = emitted('platform/clock');
    app.campusTools.hide();
    app.campusTools = createCampusToolsRuntime({
      api: app.identity.api,
      sessions: app.identity.sessions,
      auth: app.identity.auth,
      origin: nativeOrigin,
      wx,
      files: new WechatNativeMediaFiles(wx, systemClock),
      registry: app.mediaLocalFiles,
      clock: systemClock,
      embed: {
        authorize: async (url, policy) =>
          url === 'https://tools.example.com/controlled' &&
          policy.id === input.policyId,
      },
    });
    const admitted = mount('campus-tools-webview', route(input.entries[3]));
    await until(
      () => admitted.page.data.webviewSrc,
      'synthetically admitted embed',
      admitted.page,
    );
    const priorEmbed = { ...admitted.page.data };
    close(admitted);
    const currentEmbed = mount('campus-tools-webview', route(input.entries[3]));
    await until(
      () => currentEmbed.page.data.webviewSrc,
      'reopened embed',
      currentEmbed.page,
    );
    assert.equal(currentEmbed.page.data.webviewSrc, priorEmbed.webviewSrc);
    assert.notEqual(
      currentEmbed.page.data.webviewViewId,
      priorEmbed.webviewViewId,
    );
    const staleWebEvent = {
      currentTarget: {
        dataset: {
          source: priorEmbed.webviewSrc,
          viewId: priorEmbed.webviewViewId,
        },
      },
    };
    currentEmbed.page.onWebviewLoad(staleWebEvent);
    assert.equal(currentEmbed.page.data.webviewLoaded, false);
    currentEmbed.page.onWebviewError(staleWebEvent);
    assert.ok(currentEmbed.page.data.webviewSrc);
    currentEmbed.page.onWebviewMessage({
      detail: {
        data: [{ url: 'https://attacker.example/', command: 'navigate' }],
      },
    });
    assert.equal(
      currentEmbed.page.data.webviewSrc,
      'https://tools.example.com/controlled',
    );
    const currentWebEvent = {
      currentTarget: {
        dataset: {
          source: currentEmbed.page.data.webviewSrc,
          viewId: currentEmbed.page.data.webviewViewId,
        },
      },
    };
    currentEmbed.page.onWebviewLoad(currentWebEvent);
    assert.equal(currentEmbed.page.data.webviewLoaded, true);
    currentEmbed.page.onWebviewError(currentWebEvent);
    assert.equal(currentEmbed.page.data.webviewSrc, '');
    close(currentEmbed);

    await rpc('replace-catalog');
    const stale = mount('campus-tools-research', route(input.entries[2]));
    await until(() => !stale.page.data.busy, 'stale entry denied', stale.page);
    assert.equal(stale.page.data.entry, null);
    assert.equal(stale.page.data.image.src, '');
    close(stale);
    const known = mount('campus-tools', { campusId: input.campusId });
    await until(
      () => known.page.data.state === 'known_empty',
      'known empty replacement',
      known.page,
    );
    assert.equal(known.page.data.entries.length, 0);
    close(known);
    const unknown = mount('campus-tools', { campusId: input.otherCampusId });
    await until(
      () => unknown.page.data.state === 'unknown',
      'other campus unknown',
      unknown.page,
    );
    close(unknown);
    app.identity.sessions.completeLogin(
      app.identity.sessions.beginLogin(),
      input.actor,
    );
    const signed = mount('campus-tools', { campusId: input.campusId });
    await until(
      () => signed.page.data.state === 'known_empty',
      'signed current catalog',
      signed.page,
    );
    assert.equal(transport.exchanges.at(-1).authorized, true);
    await rpc('revoke-session');
    signed.tap('onRefresh');
    await until(
      () => !signed.page.data.busy && signed.page.data.error,
      'revoked supplied session',
      signed.page,
    );
    assert.ok(app.identity.sessions.snapshot().credentials);
    assert.equal(app.campusTools.continueGuest(), false);
    close(signed);
    const denied = mount('campus-tools', { campusId: input.campusId });
    await until(
      () => !denied.page.data.busy && denied.page.data.error,
      'revoked retry stays authenticated',
      denied.page,
    );
    assert.equal(transport.exchanges.at(-1).authorized, true);
    close(denied);
    app.identity.sessions.completeLogin(
      app.identity.sessions.beginLogin(),
      input.expiredActor,
    );
    await rpc('expire-refresh');
    const expired = mount('campus-tools', { campusId: input.campusId });
    await until(
      () => expired.page.data.authRecovery,
      'failed refresh latches guest recovery',
      expired.page,
    );
    assert.equal(app.identity.sessions.snapshot().credentials, null);
    close(expired);
    const beforeRecovery = transport.exchanges.length,
      recovery = mount('campus-tools', { campusId: input.campusId });
    assert.equal(recovery.page.data.authRecovery, true);
    assert.equal(transport.exchanges.length, beforeRecovery);
    recovery.tap('onContinueGuest');
    await until(
      () => recovery.page.data.state === 'known_empty',
      'explicit guest continuation',
      recovery.page,
    );
    assert.equal(transport.exchanges.at(-1).authorized, false);
    close(recovery);
    app.onHide();
    platform.storage.set(`whaleu.identity.v1:${nativeOrigin}`, {
      version: 1,
      credentials: { corrupt: true },
    });
    delete require.cache[require.resolve(`${dist}app.js`)];
    require(`${dist}app.js`);
    app.onLaunch();
    assert.ok(app.identity.startupError);
    const beforeCorrupt = transport.exchanges.length,
      corrupt = mount('campus-tools', { campusId: input.campusId });
    assert.equal(corrupt.page.data.authRecovery, true);
    assert.equal(transport.exchanges.length, beforeCorrupt);
    close(corrupt);
    const reopened = mount('campus-tools', { campusId: input.campusId });
    assert.equal(reopened.page.data.authRecovery, true);
    assert.equal(transport.exchanges.length, beforeCorrupt);
    reopened.tap('onContinueGuest');
    await until(
      () => reopened.page.data.state === 'known_empty',
      'cold corrupt explicit guest',
      reopened.page,
    );
    close(reopened);
    app.onHide();
    await read.idle();
    await until(
      async () => (await read.fileCount()) === 0,
      'all media cleaned',
    );
    assert.ok(transport.exchanges.every((e) => !e.path.includes('location')));
    await send({
      event: 'done',
      downloads: read.exchanges.length,
      requests: transport.exchanges.length,
    });
  } catch (error) {
    await send({ event: 'failure', message: error?.stack ?? String(error) });
  } finally {
    for (const h of pages) {
      h.page.onHide?.();
      h.page.onUnload?.();
    }
    app?.onHide();
    await read?.dispose();
    process.disconnect();
  }
});
