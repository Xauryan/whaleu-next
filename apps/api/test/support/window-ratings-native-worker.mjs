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
        if (failJournal && key.includes('window-ratings.pending'))
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
        if (options.method === 'POST' && path.endsWith('/score'))
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
    const choose = (h, score) => {
      h.tap('onScore', { score });
      h.tap('onConfirm');
      assert.equal(h.page.data.confirming, 'score');
    };
    const scorePath = `/v1/ratings/windows/${input.windowId}/score`,
      detailPath = `/v1/ratings/windows/${input.windowId}`;
    boot();
    login(input.actor);
    const appPages = JSON.parse(readFileSync(`${dist}app.json`, 'utf8')).pages;
    assert.ok(appPages.includes('pages/window-ratings/window-ratings'));
    assert.ok(
      appPages.includes('pages/window-rating-detail/window-rating-detail'),
    );
    const entry = mountEmittedPage('rating-catalog', app, wx);
    assert.ok(
      entry
        .nodes()
        .some(
          (node) =>
            typeof node !== 'string' &&
            node.tag === 'navigator' &&
            node.attrs.url === '/pages/window-ratings/window-ratings',
        ),
    );
    let list = mount('window-ratings');
    await loaded(list);
    assert.equal(list.page.data.items.length, 20);
    assert.equal(list.page.data.canNext, true);
    const firstIds = new Set(list.page.data.items.map((item) => item.id));
    list.tap('onNext');
    await loaded(list);
    assert.equal(list.page.data.pageNumber, 2);
    assert.ok(list.page.data.items.every((item) => !firstIds.has(item.id)));
    assert.equal(list.page.data.canNext, false);
    list.tap('onCanteen', { id: input.canteenId });
    const secondCanteen = list.page.data.catalog.canteens.find(
      (item) => item.id !== input.canteenId,
    );
    assert.ok(secondCanteen);
    list.tap('onCanteen', { id: secondCanteen.id });
    assert.equal(list.page.data.canteenDraft.length, 2);
    list.event('bindchange', 'onFloor', {
      value: String(
        list.page.data.floorOptions.findIndex(
          (floor) => floor.id === input.floorId,
        ) + 1,
      ),
    });
    list.tap('onSearch');
    await loaded(list);
    assert.ok(
      list.page.data.items.every(
        (item) =>
          item.canteenId === input.canteenId && item.floor.id === input.floorId,
      ),
    );
    assert.ok(
      list.page.data.items.every(
        (item) => item.floor.sourceFloorKey === 'B1-mezzanine',
      ),
    );
    const selected =
      list.page.data.items.find((item) => item.id === input.windowId) ??
      list.page.data.items[0];
    list.tap('onWindow', { id: selected.id });
    assert.equal(
      navigation.at(-1),
      `/pages/window-rating-detail/window-rating-detail?windowId=${selected.id}`,
    );
    close(list);
    let h = mount('window-rating-detail', { windowId: input.windowId });
    await loaded(h);
    const scoreButtons = h
      .nodes()
      .filter(
        (node) => typeof node !== 'string' && node.attrs.bindtap === 'onScore',
      );
    assert.equal(scoreButtons.length, 21);
    assert.deepEqual(
      scoreButtons.map((node) => Number(node.attrs['data-score'])),
      Array.from({ length: 21 }, (_, i) => i - 10),
    );
    assert.equal(h.page.data.detail.myScore.kind, 'not_submitted');
    assert.match(text(h), /暂无均分/);
    choose(h, -10);
    transport.dropSuccess = { path: scorePath, method: 'POST' };
    h.tap('onSubmit');
    h.page.onSubmit();
    await uncertain(h);
    const original = app.community.pendingWindowRatings.load(
      input.actor.accountId,
    );
    assert.equal(original.command.score, -10);
    assert.equal(original.command.expectedOwnScoreRevision, null);
    assert.equal(original.origin, nativeOrigin);
    assert.equal(commands.length, 1);
    await checkpoint('first-committed', {
      requestId: original.command.clientRequestId,
    });
    close(h);
    app.onHide();
    boot();
    login(input.actor);
    h = mount('window-rating-detail', { windowId: input.windowId });
    await uncertain(h);
    assert.equal(h.page.data.loaded, false);
    h.tap('onRetry');
    await settled(h);
    assert.equal(commands.length, 1);
    assert.equal(h.page.data.detail, null);
    assert.match(h.page.data.receiptStatus, /历史回执/);
    await checkpoint('first-recovered', {
      requestId: original.command.clientRequestId,
    });
    h.tap('onRefresh');
    await loaded(h);
    assert.equal(h.page.data.detail.myScore.score, 7);
    assert.equal(h.page.data.detail.window.summary.ratingCount, 1);
    assert.equal(h.page.data.detail.window.summary.mean, 7);
    const sevenRevision = h.page.data.detail.myScore.revision;
    choose(h, 0);
    h.tap('onSubmit');
    await settled(h);
    assert.equal(
      commands.at(-1).command.expectedOwnScoreRevision,
      sevenRevision,
    );
    assert.equal(h.page.data.detail.myScore.score, 0);
    assert.equal(h.page.data.detail.window.summary.ratingCount, 1);
    assert.equal(h.page.data.detail.window.summary.mean, 0);
    const zeroRevision = h.page.data.detail.myScore.revision;
    choose(h, 0);
    h.tap('onSubmit');
    await settled(h);
    assert.equal(h.page.data.detail.myScore.revision, zeroRevision);
    assert.match(h.page.data.receiptStatus, /无需变更/);
    choose(h, 10);
    h.tap('onSubmit');
    await settled(h);
    assert.equal(h.page.data.detail.myScore.score, 10);
    assert.equal(h.page.data.detail.window.summary.ratingCount, 1);
    choose(h, 2);
    await checkpoint('concurrent-edit', {
      expectedRevision: h.page.data.detail.myScore.revision,
    });
    h.tap('onSubmit');
    await settled(h);
    assert.match(h.page.data.receiptStatus, /在别处变化/);
    assert.equal(h.page.data.detail.myScore.score, -4);
    assert.equal(h.page.data.selectedScore, null);
    assert.equal(h.page.data.confirming, null);
    choose(h, -3);
    transport.failNext = scorePath;
    h.tap('onSubmit');
    await uncertain(h);
    const cancellable = app.community.pendingWindowRatings.load(
      input.actor.accountId,
    );
    assert.equal(cancellable.command.score, -3);
    h.tap('onRequestCancellation');
    await until(
      () => !h.page.data.busy && h.page.data.confirming === 'cancel',
      'explicit cancellation preview',
      h,
    );
    transport.dropSuccess = {
      path: `/v1/ratings/windows/requests/${cancellable.command.clientRequestId}/cancel`,
      method: 'POST',
    };
    h.tap('onConfirmCancellation');
    await uncertain(h);
    assert.equal(
      app.community.pendingWindowRatings.load(input.actor.accountId).phase,
      'cancel',
    );
    await checkpoint('cancel-committed', {
      requestId: cancellable.command.clientRequestId,
    });
    const countBeforeRecovery = commands.length;
    close(h);
    app.onHide();
    boot();
    login(input.actor);
    h = mount('window-rating-detail', { windowId: input.windowId });
    await uncertain(h);
    assert.equal(h.page.data.recoveryPhase, 'cancel');
    h.tap('onRetry');
    await settled(h);
    assert.equal(commands.length, countBeforeRecovery);
    assert.match(h.page.data.receiptStatus, /已确认取消/);
    const replay = await transport.send({
      url: `${nativeOrigin}${scorePath}`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.actor.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: cancellable.command,
      timeoutMs: 10000,
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.code, 'WINDOW_SCORE_CANCELLED');
    await checkpoint('cancel-recovered', {
      requestId: cancellable.command.clientRequestId,
    });
    h.tap('onRefresh');
    await loaded(h);
    assert.equal(h.page.data.detail.myScore.score, -4);
    const filtered = mount('window-ratings');
    await loaded(filtered);
    filtered.event('bindinput', 'onMinimum', { value: '0' });
    filtered.tap('onSearch');
    await loaded(filtered);
    assert.equal(
      filtered.page.data.items.find((item) => item.id === input.windowId)
        .summary.mean,
      -4,
    );
    filtered.event('bindinput', 'onMinimum', { value: '1' });
    filtered.tap('onSearch');
    await loaded(filtered);
    assert.deepEqual(filtered.page.data.items, []);
    filtered.event('bindinput', 'onMinimum', { value: '-10' });
    filtered.tap('onSearch');
    await loaded(filtered);
    assert.equal(
      filtered.page.data.items.find((item) => item.id === input.windowId)
        .summary.mean,
      -4,
    );
    close(filtered);
    failJournal = true;
    choose(h, 3);
    const beforeStorage = commands.length;
    h.tap('onSubmit');
    await until(() => !h.page.data.busy, 'failed journal write', h);
    assert.equal(commands.length, beforeStorage);
    assert.equal(
      app.community.pendingWindowRatings.load(input.actor.accountId),
      null,
    );
    failJournal = false;
    h.tap('onRefresh');
    await loaded(h);
    choose(h, 5);
    const late = transport.holdNext(scorePath, 'POST');
    h.tap('onSubmit');
    await late.arrived;
    const delayed = app.community.pendingWindowRatings.load(
      input.actor.accountId,
    );
    close(h);
    late.release();
    await delay(30);
    assert.ok(app.community.pendingWindowRatings.load(input.actor.accountId));
    h = mount('window-rating-detail', { windowId: input.windowId });
    await loaded(h);
    h.tap('onRecover');
    await settled(h);
    assert.equal(h.page.data.detail.myScore.score, 5);
    assert.equal(
      app.community.pendingWindowRatings.load(input.actor.accountId),
      null,
    );
    const held = transport.holdNext(detailPath);
    h.tap('onRefresh');
    await held.arrived;
    login(input.other);
    assert.equal(h.page.data.loaded, false);
    assert.equal(h.page.data.detail, null);
    assert.equal(h.page.data.recoveryWindowId, '');
    held.release();
    await delay(30);
    assert.equal(h.page.data.detail, null);
    h.page.onShow();
    await loaded(h);
    assert.equal(h.page.data.detail.myScore.kind, 'not_submitted');
    assert.equal(h.page.data.detail.window.summary.mean, 5);
    app.onHide();
    assert.equal(h.page.data.detail, null);
    close(h);
    const unknown = mount('window-rating-detail', {
      windowId: input.unknownId,
    });
    await loaded(unknown);
    assert.equal(unknown.page.data.canScore, false);
    assert.equal(unknown.page.data.detail.myScore.kind, 'unavailable');
    assert.match(text(unknown), /历史评分暂不能确认/);
    assert.doesNotMatch(text(unknown), /当前已确认尚未评分/);
    close(unknown);
    await send({
      event: 'done',
      firstRequestId: original.command.clientRequestId,
      cancelledRequestId: cancellable.command.clientRequestId,
      delayedRequestId: delayed.command.clientRequestId,
      nativeCommands: commands.length,
      receiptReads: requests.filter(
        (r) => r.method === 'GET' && r.path.includes('/requests/'),
      ).length,
    });
  } catch (error) {
    await send({
      event: 'failure',
      message: error instanceof Error ? error.stack : String(error),
    });
    process.exitCode = 1;
  } finally {
    for (const h of pages) {
      h.page.onHide?.();
      h.page.onUnload?.();
    }
    app?.onHide?.();
    process.disconnect?.();
  }
});
