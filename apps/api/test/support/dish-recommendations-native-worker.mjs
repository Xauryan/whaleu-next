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
    let failJournal = false,
      currentActor = input.actor;
    const wx = {
      ...platform,
      setStorageSync: (key, value) => {
        if (failJournal && key.includes('dish-recommendations.pending'))
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
        const mutation =
          options.method === 'POST' &&
          /\/dishes\/(recommend|retract)$/.test(path);
        if (mutation)
          commands.push({ path, command: structuredClone(options.data) });
        void (async () => {
          if (mutation && path.endsWith('/recommend'))
            await checkpoint('review', {
              windowId: path.split('/')[4],
              actorId: currentActor.accountId,
              command: options.data,
            });
          return transport.send({
            url: options.url,
            method: options.method,
            headers: options.header,
            body: options.data,
            timeoutMs: options.timeout,
          });
        })().then(
          (result) =>
            options.success({
              statusCode: result.status,
              header: result.headers,
              data: result.body,
            }),
          () => options.fail({ errMsg: 'request:fail synthetic interruption' }),
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
    function login(actor) {
      currentActor = actor;
      app.identity.sessions.completeLogin(
        app.identity.sessions.beginLogin(),
        actor,
      );
    }
    function mount(name = 'window-dishes', windowId = input.windowId) {
      const h = mountEmittedPage(name, app, wx);
      pages.add(h);
      h.page.onLoad?.(windowId === null ? {} : { windowId });
      h.page.onShow?.();
      return h;
    }
    function close(h) {
      h.page.onHide?.();
      h.page.onUnload?.();
      pages.delete(h);
    }
    const idle = (h) => until(() => !h.page.data.busy, 'idle', h);
    const loaded = (h) =>
      until(
        () => !h.page.data.busy && h.page.data.loaded,
        'current dish list',
        h,
      );
    const settled = (h) =>
      until(
        () => !h.page.data.busy && !h.page.data.frozen,
        'terminal matching dish receipt',
        h,
      );
    const uncertain = (h) =>
      until(
        () => !h.page.data.busy && h.page.data.frozen,
        'durable original dish request',
        h,
      );
    function openDishPanel(h) {
      if (h.page.data.uiPanel !== 'dish')
        h.tap('onTogglePanel', { panel: 'dish' });
      assert.equal(h.page.data.uiPanel, 'dish');
    }
    function editName(h, value) {
      openDishPanel(h);
      h.event('bind:input', 'onName', { value, cursor: value.length });
    }
    async function select(h, name, kind = 'recommend') {
      editName(h, name);
      h.tap('onLookup');
      await until(
        () => !h.page.data.busy && h.page.data.own !== null,
        'own exact dish membership',
        h,
      );
      h.tap(kind === 'recommend' ? 'onRecommend' : 'onRetract');
      assert.equal(h.page.data.confirming, kind);
    }
    async function submit(h, name, kind = 'recommend') {
      await select(h, name, kind);
      h.tap('onSubmit');
      await settled(h);
    }
    const path = `/v1/ratings/windows/${input.windowId}/dishes`,
      recommendPath = `${path}/recommend`,
      retractPath = `${path}/retract`;
    const emoji = '😀'.repeat(10);
    boot();
    login(input.actor);
    const appPages = JSON.parse(readFileSync(`${dist}app.json`, 'utf8')).pages;
    assert.ok(appPages.includes('pages/window-dishes/window-dishes'));
    const detail = mount('window-rating-detail');
    await loaded(detail);
    detail.tap('onOpenRecommendations');
    assert.equal(
      navigation.at(-1),
      `/pages/window-dishes/window-dishes?windowId=${input.windowId}`,
    );
    close(detail);
    function recoveryEntry() {
      const recovery = mountEmittedPage('rating-recovery', app, wx);
      const entry = recovery
        .nodes()
        .find(
          (node) =>
            typeof node !== 'string' &&
            node.tag === 'navigator' &&
            node.attrs.url === '/pages/window-dishes/window-dishes',
        );
      assert.ok(
        entry,
        'Cold App has a static dish recovery entry independent of catalog and phone',
      );
      return mount('window-dishes', null);
    }
    let h = mount();
    await loaded(h);
    assert.deepEqual(h.page.data.items, []);
    openDishPanel(h);
    const inputNode = h
      .nodes()
      .find(
        (node) =>
          typeof node !== 'string' &&
          node.tag === 'wu-f7-input' &&
          node.attrs['bind:input'] === 'onName',
      );
    assert.equal(inputNode.attrs.maxlength, '-1');
    const nativeInput = h.captureInput('onName');
    try {
      assert.equal(nativeInput.instance.properties.maxlength, -1);
      assert.equal(nativeInput.instance.data.nativeMaxlength, -1);
    } finally {
      nativeInput.detach();
    }
    const beforeInvalid = requests.length;
    for (const name of [' ', 'a\n', '\ud800', '😀'.repeat(11)]) {
      editName(h, name);
      h.tap('onLookup');
      await idle(h);
      assert.equal(h.page.data.own, null);
    }
    assert.equal(requests.length, beforeInvalid);
    await select(h, emoji);
    transport.dropSuccess = { path: recommendPath, method: 'POST' };
    h.tap('onSubmit');
    h.page.onSubmit();
    await uncertain(h);
    const original = app.community.pendingDishRecommendations.load(
      input.actor.accountId,
    );
    assert.equal(original.command.dishName, emoji);
    assert.equal(original.origin, nativeOrigin);
    assert.equal(commands.length, 1);
    await checkpoint('first-committed', {
      requestId: original.command.clientRequestId,
      command: original.command,
    });
    close(h);
    app.onHide();
    boot();
    login(input.actor);
    h = recoveryEntry();
    await uncertain(h);
    assert.equal(h.page.data.loaded, false);
    h.tap('onRetry');
    await settled(h);
    assert.equal(commands.length, 1);
    assert.equal(h.page.data.loaded, false);
    assert.equal(h.page.data.own.active, false);
    assert.match(h.page.data.receiptStatus, /历史回执/);
    await checkpoint('source-restored');
    h.tap('onRefresh');
    await loaded(h);
    await submit(h, emoji);
    const reactivated = h.page.data.own.revision;
    assert.notEqual(reactivated, original.command.expectedMembershipRevision);
    assert.equal(h.page.data.items[0].recommendationCount, 1);
    close(h);
    login(input.other);
    h = mount();
    await loaded(h);
    assert.equal(h.page.data.items[0].isRecommended, false);
    assert.equal(h.page.data.items[0].myMembershipRevision, null);
    await submit(h, emoji);
    assert.equal(h.page.data.items[0].recommendationCount, 2);
    await submit(h, '0');
    assert.equal(h.page.data.items.length, 2);
    assert.equal(
      h.page.data.items.find((item) => item.dishName === '0')
        .recommendationCount,
      1,
    );
    for (const item of h.page.data.items)
      assert.deepEqual(
        Object.keys(item).sort(),
        [
          'dishIdentity',
          'dishName',
          'isRecommended',
          'myMembershipRevision',
          'recommendationCount',
        ].sort(),
      );
    close(h);
    login(input.actor);
    h = mount();
    await loaded(h);
    assert.equal(
      h.page.data.items.find((item) => item.dishName === '0').isRecommended,
      false,
    );
    await select(h, emoji, 'retract');
    await checkpoint('concurrent-membership', {
      revision: h.page.data.own.revision,
      dishName: emoji,
    });
    h.tap('onSubmit');
    await settled(h);
    assert.match(h.page.data.receiptStatus, /在别处变化/);
    assert.equal(h.page.data.own.active, false);
    await submit(h, emoji);
    assert.equal(
      h.page.data.items.find((item) => item.dishName === emoji)
        .recommendationCount,
      2,
    );
    await submit(h, '拒绝菜');
    assert.match(h.page.data.receiptStatus, /未通过审核/);
    assert.equal(h.page.data.own.kind, 'not_recommended');
    assert.ok(!h.page.data.items.some((item) => item.dishName === '拒绝菜'));
    await select(h, '待审菜');
    h.tap('onSubmit');
    await uncertain(h);
    const cancelAttempt = app.community.pendingDishRecommendations.load(
      input.actor.accountId,
    );
    assert.equal(cancelAttempt.command.dishName, '待审菜');
    h.tap('onRequestCancellation');
    await until(
      () => !h.page.data.busy && h.page.data.confirming === 'cancel',
      'cancel preview',
      h,
    );
    transport.dropSuccess = {
      path: `/v1/ratings/windows/dish-requests/${cancelAttempt.command.clientRequestId}/cancel`,
      method: 'POST',
    };
    h.tap('onConfirmCancellation');
    await uncertain(h);
    assert.equal(
      app.community.pendingDishRecommendations.load(input.actor.accountId)
        .phase,
      'cancel',
    );
    await checkpoint('cancel-loss');
    const countBeforeRecovery = commands.length;
    close(h);
    app.onHide();
    boot();
    login(input.actor);
    h = recoveryEntry();
    await uncertain(h);
    h.tap('onRetry');
    await settled(h);
    assert.equal(commands.length, countBeforeRecovery);
    assert.match(h.page.data.receiptStatus, /已确认取消/);
    const replay = await transport.send({
      url: `${nativeOrigin}${recommendPath}`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.actor.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: cancelAttempt.command,
      timeoutMs: 10000,
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.code, 'DISH_CANCELLED');
    await checkpoint('restore-all');
    h.tap('onRefresh');
    await loaded(h);
    // Revocation hides the actor's contribution without deleting their private membership.
    await checkpoint('review-revoked', { dishName: emoji });
    h.tap('onRefresh');
    await loaded(h);
    const remaining = h.page.data.items.find((item) => item.dishName === emoji);
    assert.equal(remaining.recommendationCount, 1);
    assert.equal(remaining.isRecommended, true);
    await submit(h, emoji, 'retract');
    assert.equal(h.page.data.own.active, false);
    await submit(h, emoji);
    // Respect the real shared 120/minute rating request budget; do not reset or replace its guard.
    await delay(61000);
    for (const loss of [
      'source',
      'parent',
      'phone',
      'safety',
      'population',
      'membership',
    ]) {
      await checkpoint('loss', { loss });
      h.tap('onRefresh');
      await idle(h);
      assert.equal(h.page.data.loaded, false);
      await select(h, emoji, 'retract');
      h.tap('onSubmit');
      await settled(h);
      assert.equal(h.page.data.own.active, false);
      assert.equal(h.page.data.loaded, false);
      await checkpoint('restore-all');
      h.tap('onRefresh');
      await loaded(h);
      await submit(h, emoji);
      assert.equal(
        h.page.data.own?.active,
        true,
        JSON.stringify({
          loss,
          data: h.page.data,
          exchanges: transport.exchanges.slice(-4),
        }),
      );
    }
    // Unknown history never becomes a false zero or false "not recommended".
    const unknown = mount('window-dishes', input.unknownId);
    await idle(unknown);
    assert.equal(unknown.page.data.loaded, false);
    editName(unknown, '未知菜');
    unknown.tap('onLookup');
    await until(
      () => !unknown.page.data.busy && unknown.page.data.own !== null,
      'unknown own history',
      unknown,
    );
    assert.equal(unknown.page.data.own.kind, 'unavailable');
    assert.equal(unknown.page.data.canRecommend, false);
    assert.doesNotMatch(text(unknown), /已确认尚未推荐/);
    close(unknown);
    const paging = mount('window-dishes', input.pagingId);
    await loaded(paging);
    assert.equal(paging.page.data.items.length, 20);
    assert.equal(paging.page.data.canNext, true);
    paging.tap('onNext');
    await loaded(paging);
    assert.equal(paging.page.data.pageNumber, 2);
    paging.tap('onRefresh');
    await loaded(paging);
    await checkpoint('offpage-change');
    paging.tap('onNext');
    await idle(paging);
    assert.equal(paging.page.data.loaded, false);
    assert.equal(paging.page.data.restartRequired, true);
    assert.deepEqual(paging.page.data.items, []);
    paging.tap('onRefresh');
    await loaded(paging);
    assert.equal(paging.page.data.items[0].recommendationCount, 2);
    close(paging);
    failJournal = true;
    await select(h, '存储菜');
    const beforeStorage = commands.length;
    h.tap('onSubmit');
    await idle(h);
    assert.equal(commands.length, beforeStorage);
    failJournal = false;
    h.tap('onRefresh');
    await loaded(h);
    // Stop waiting fences the full refresh sequence, including the follow-on own lookup.
    editName(h, emoji);
    h.tap('onLookup');
    await idle(h);
    const stoppedList = transport.holdNext(path),
      readsBeforeStop = requests.filter(
        (r) => r.path === `${path}/my-membership`,
      ).length;
    h.tap('onRefresh');
    await stoppedList.arrived;
    h.tap('onCancelWait');
    await idle(h);
    stoppedList.release();
    await delay(30);
    assert.equal(h.page.data.busy, false);
    assert.equal(h.page.data.own, null);
    assert.equal(
      requests.filter((r) => r.path === `${path}/my-membership`).length,
      readsBeforeStop,
    );
    h.tap('onRefresh');
    await loaded(h);
    // A committed retract whose response arrives after page hide remains durable.
    await select(h, emoji, 'retract');
    const heldWrite = transport.holdNext(retractPath, 'POST');
    h.tap('onSubmit');
    await heldWrite.arrived;
    close(h);
    heldWrite.release();
    await delay(30);
    assert.ok(
      app.community.pendingDishRecommendations.load(input.actor.accountId),
    );
    h = mount();
    await loaded(h);
    h.tap('onRecover');
    await settled(h);
    assert.equal(h.page.data.own.active, false);
    await submit(h, emoji);
    const held = transport.holdNext(`${path}/my-membership`);
    editName(h, emoji);
    h.tap('onLookup');
    await held.arrived;
    login(input.other);
    assert.equal(h.page.data.own, null);
    assert.equal(h.page.data.nameDraft, '');
    held.release();
    await delay(30);
    assert.equal(h.page.data.own, null);
    h.page.onShow();
    await loaded(h);
    app.onHide();
    assert.equal(h.page.data.items.length, 0);
    close(h);
    // Losing the current session blocks all reads/mutations, then the same owner can recover.
    login(input.actor);
    h = mount();
    await loaded(h);
    app.identity.sessions.logout();
    assert.equal(h.page.data.hasSession, false);
    assert.equal(h.page.data.own, null);
    login(input.actor);
    h.page.onShow();
    await loaded(h);
    await select(h, emoji, 'retract');
    h.tap('onSubmit');
    await settled(h);
    assert.equal(h.page.data.own.active, false);
    await send({
      event: 'done',
      firstRequestId: original.command.clientRequestId,
      cancelledRequestId: cancelAttempt.command.clientRequestId,
      nativeCommands: commands.length,
      receiptReads: requests.filter(
        (r) => r.method === 'GET' && r.path.includes('/dish-requests/'),
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
