/** Emitted App/Page/WXML -> production HTTP gateways -> loopback AppModule/PostgreSQL.
 * Only native platform storage, navigation and transport callbacks are synthetic. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
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
async function checkpoint(name, fields = {}) {
  const next = new Promise((resolve) => process.once('message', resolve));
  await send({ event: 'checkpoint', name, ...fields });
  const result = await next;
  assert.equal(result.event, 'continue');
  assert.equal(result.name, name);
  return result;
}
async function until(check, label, h) {
  const deadline = Date.now() + 20000;
  while (!check()) {
    assert.ok(
      Date.now() < deadline,
      `${label}: ${h?.page.data.error || h?.page.data.status || 'condition not reached'}`,
    );
    await delay(10);
  }
}
const text = (h) =>
  h
    .nodes()
    .filter((node) => typeof node === 'string')
    .join(' ');
process.once('message', async (input) => {
  let app;
  const pages = new Set();
  try {
    const transport = new NativeExperienceTransport(input.port),
      platform = platformStorage(),
      commands = [],
      requests = [],
      navigation = [];
    let failJournal = false;
    const wx = {
      ...platform,
      setStorageSync: (key, value) => {
        if (failJournal && key.includes('canteen-floor-scores.pending'))
          throw Error('Synthetic local persistence failure');
        platform.setStorageSync(key, value);
      },
      nextTick: queueMicrotask,
      navigateTo: (options) => {
        navigation.push(options.url);
        options.success?.();
      },
      request: (options) => {
        const path = new URL(options.url).pathname;
        requests.push({ path, method: options.method });
        if (options.method === 'POST' && path.endsWith('/first-score'))
          commands.push({ path, command: structuredClone(options.data) });
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
            () =>
              options.fail({ errMsg: 'request:fail synthetic interruption' }),
          );
        return { abort() {} };
      },
    };
    emitted('config').clientConfiguration = Object.freeze({
      apiOrigin: nativeOrigin,
      providerLoginEnabled: true,
    });
    function boot() {
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
    const loaded = (h) =>
      until(
        () => !h.page.data.busy && h.page.data.loaded,
        'current data loaded',
        h,
      );
    const settled = (h) =>
      until(
        () => !h.page.data.busy && !h.page.data.frozen,
        'matching terminal receipt',
        h,
      );
    const uncertain = (h) =>
      until(
        () => !h.page.data.busy && h.page.data.frozen,
        'original journal retained',
        h,
      );
    const ensureScoreOpen = (h) => {
      if (h.page.data.uiPanel !== 'score')
        h.tap('onTogglePanel', { panel: 'score' });
    };
    const choose = (h, value) => {
      ensureScoreOpen(h);
      h.event('bindinput', 'onScore', { value: String(value) });
      h.tap('onConfirm');
      assert.equal(h.page.data.confirming, 'score');
    };
    const base = '/v1/ratings/canteen-floors',
      scorePath = base + '/' + input.floorId + '/first-score',
      detailPath = base + '/' + input.floorId,
      secondPath = base + '/' + input.secondFloorId + '/first-score';
    boot();
    login(input.actor);
    const appPages = JSON.parse(readFileSync(`${dist}app.json`, 'utf8')).pages;
    assert.ok(
      appPages.includes('pages/canteen-floor-scores/canteen-floor-scores'),
    );
    assert.ok(
      appPages.includes(
        'pages/canteen-floor-score-detail/canteen-floor-score-detail',
      ),
    );
    const entry = mountEmittedPage('rating-catalog', app, wx);
    entry.tap('onTogglePanel', { panel: 'more' });
    assert.ok(
      entry
        .nodes()
        .some(
          (node) =>
            typeof node !== 'string' &&
            node.tag === 'navigator' &&
            node.attrs.url ===
              '/pages/canteen-floor-scores/canteen-floor-scores',
        ),
    );
    let list = mount('canteen-floor-scores');
    await loaded(list);
    assert.equal(list.page.data.catalog.canteens.length, 2);
    list.tap('onCanteen', { id: input.canteenId });
    list.tap('onTogglePanel', { panel: 'filter' });
    list.event('bindchange', 'onFloor', {
      value: String(
        list.page.data.floorOptions.findIndex((f) => f.id === input.floorId) +
          1,
      ),
    });
    list.tap('onOpenFloor', { id: input.floorId });
    assert.equal(
      navigation.at(-1),
      '/pages/canteen-floor-score-detail/canteen-floor-score-detail?floorId=' +
        input.floorId,
    );
    close(list);
    let h = mount('canteen-floor-score-detail', { floorId: input.floorId });
    await loaded(h);
    assert.equal(h.page.data.canScore, true);
    h.tap('onTogglePanel', { panel: 'info' });
    assert.match(text(h), /B1-mezzanine/);
    assert.equal(h.page.data.detail.floor.summary.kind, 'known');
    assert.equal(h.page.data.detail.floor.summary.ratingCount, 0);
    assert.equal(h.page.data.detail.myScore.kind, 'not_submitted');
    assert.match(text(h), /暂无评分/);
    assert.match(text(h), /还没有评分记录/);
    ensureScoreOpen(h);
    h.event('bindinput', 'onScore', { value: '1.25' });
    h.event('bindinput', 'onScore', { value: 'bad' });
    assert.equal(h.page.data.selectedScore, null);
    assert.equal(h.button('bindtap', 'onConfirm').attrs.disabled, 'true');
    assert.equal(h.page.data.confirming, null);
    choose(h, 1.25);
    h.tap('onCloseConfirmation');
    assert.equal(commands.length, 0);
    choose(h, 1.25);
    failJournal = true;
    h.tap('onSubmit');
    await until(() => !h.page.data.busy, 'storage failure blocked', h);
    assert.equal(commands.length, 0);
    failJournal = false;
    h.tap('onRefresh');
    await loaded(h);
    choose(h, 1.25);
    transport.dropSuccess = { path: scorePath, method: 'POST' };
    h.tap('onSubmit');
    await uncertain(h);
    assert.equal(commands.length, 1);
    const firstRequestId = commands[0].command.clientRequestId;
    assert.equal(commands[0].command.score, 1.25);
    await checkpoint('first-committed', { requestId: firstRequestId });
    close(h);
    app.onHide();
    boot();
    login(input.actor);
    // Recovery remains reachable from the root selector with no target route
    // and no current catalog. The journal owns the exact original floor key.
    h = mount('canteen-floor-scores');
    await uncertain(h);
    assert.equal(h.page.data.catalog, null);
    assert.equal(h.page.data.detail, null);
    h.tap('onRecover');
    await settled(h);
    assert.equal(h.page.data.catalog, null);
    assert.equal(h.page.data.detail, null);
    assert.match(text(h), /历史回执/);
    assert.equal(commands.length, 1);
    await checkpoint('first-recovered', { requestId: firstRequestId });
    h.tap('onRefresh');
    await loaded(h);
    assert.equal(h.page.data.catalog.canteens.length, 2);
    close(h);
    h = mount('canteen-floor-score-detail', { floorId: input.floorId });
    await loaded(h);
    assert.equal(h.page.data.detail.myScore.score, 1.25);
    assert.equal(h.page.data.canScore, false);
    assert.match(text(h), /已有有效楼层评分，当前不能重复提交或修改/);
    close(h);
    h = mount('canteen-floor-score-detail', { floorId: input.unknownFloorId });
    await loaded(h);
    assert.equal(h.page.data.canScore, false);
    assert.match(text(h), /历史评分/);
    close(h);
    h = mount('canteen-floor-score-detail', { floorId: input.secondFloorId });
    await loaded(h);
    choose(h, 4.75);
    transport.failNext = secondPath;
    h.tap('onSubmit');
    await uncertain(h);
    const cancelledRequestId = commands.at(-1).command.clientRequestId;
    assert.equal(commands.length, 2);
    h.tap('onRequestCancellation');
    await until(
      () => !h.page.data.busy && h.page.data.confirming === 'cancel',
      'cancel preview',
      h,
    );
    const cancelPath = base + '/requests/' + cancelledRequestId + '/cancel';
    transport.dropSuccess = { path: cancelPath, method: 'POST' };
    h.tap('onConfirmCancellation');
    await uncertain(h);
    assert.equal(h.page.data.recoveryPhase, 'cancel');
    await checkpoint('cancel-committed', { requestId: cancelledRequestId });
    close(h);
    app.onHide();
    boot();
    login(input.actor);
    h = mount('canteen-floor-score-detail', { floorId: input.secondFloorId });
    await uncertain(h);
    h.tap('onRetry');
    await settled(h);
    assert.equal(commands.length, 2);
    assert.match(text(h), /确认取消/);
    await checkpoint('cancel-recovered', { requestId: cancelledRequestId });
    close(h);
    // A fully received old-account read cannot render after login epoch replacement.
    const held = transport.holdNext(detailPath);
    h = mount('canteen-floor-score-detail', { floorId: input.floorId });
    await held.arrived;
    login(input.other);
    assert.equal(h.page.data.detail, null);
    held.release();
    await until(
      () => !h.page.data.busy,
      'late prior account callback fenced',
      h,
    );
    assert.equal(h.page.data.detail, null);
    h.tap('onRefresh');
    await loaded(h);
    assert.equal(h.page.data.detail.myScore.kind, 'not_submitted');
    close(h);
    login(input.actor);
    const hideHold = transport.holdNext(detailPath);
    h = mount('canteen-floor-score-detail', { floorId: input.floorId });
    await hideHold.arrived;
    close(h);
    hideHold.release();
    await delay(30);
    assert.equal(h.page.data.detail, null);
    // Prior cancellation is not score retirement: a later explicit new key may
    // score the still-empty target, and a held committed response is recovered.
    h = mount('canteen-floor-score-detail', { floorId: input.secondFloorId });
    await loaded(h);
    assert.equal(h.page.data.canScore, true);
    choose(h, 4.75);
    const committed = transport.holdNext(secondPath, 'POST');
    h.tap('onSubmit');
    await committed.arrived;
    assert.equal(commands.length, 3);
    const finalRequestId = commands.at(-1).command.clientRequestId;
    assert.notEqual(finalRequestId, cancelledRequestId);
    close(h);
    committed.release();
    await delay(30);
    app.onHide();
    boot();
    login(input.actor);
    h = mount('canteen-floor-score-detail', { floorId: input.secondFloorId });
    await uncertain(h);
    h.tap('onRecover');
    await settled(h);
    await loaded(h);
    assert.equal(h.page.data.detail.myScore.score, 4.75);
    assert.equal(h.page.data.detail.floor.summary.ratingCount, 1);
    assert.equal(h.page.data.detail.floor.summary.mean, 4.8);
    assert.equal(h.page.data.canScore, false);
    assert.equal(commands.length, 3);
    close(h);
    await send({
      event: 'done',
      firstRequestId,
      cancelledRequestId,
      finalRequestId,
      nativeCommands: commands.length,
      receiptReads: requests.filter(
        (r) => r.method === 'GET' && r.path.includes('/requests/'),
      ).length,
    });
  } catch (error) {
    await send({ event: 'failure', message: error?.stack ?? String(error) });
  } finally {
    for (const h of pages) {
      h.page.onHide?.();
      h.page.onUnload?.();
    }
    app?.onHide?.();
    process.disconnect();
  }
});
