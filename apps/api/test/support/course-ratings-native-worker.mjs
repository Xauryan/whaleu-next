/** Emitted App + Pages/WXML -> real production gateways -> loopback AppModule.
 * Only native wx callbacks/storage/network are synthetic; no course-owner stubs. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { parse, render } from '../../../wechat/scripts/smoke-ratings.mjs';
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
  const reply = await next;
  assert.equal(reply.event, 'continue');
  assert.equal(reply.name, name);
  return reply;
}
async function until(check, label, page) {
  const untilAt = Date.now() + 20000;
  while (!check()) {
    assert.ok(
      Date.now() < untilAt,
      `${label}: ${page?.data.error || page?.data.status || 'condition not reached'}`,
    );
    await delay(10);
  }
}
const visibleText = (page) =>
  page
    .nodes()
    .filter((node) => typeof node === 'string')
    .join(' ');
const componentText = (nodes) =>
  nodes
    .map((node) =>
      typeof node === 'string' ? node : componentText(node.children),
    )
    .join('');
process.once('message', async (input) => {
  let app;
  const pages = new Set();
  try {
    const transport = new NativeExperienceTransport(input.port),
      platform = platformStorage();
    const navigations = [],
      commands = [];
    const wx = {
      ...platform,
      nextTick: queueMicrotask,
      navigateTo: (options) => {
        navigations.push(options.url);
        options.success?.();
      },
      request: (options) => {
        const path = new URL(options.url).pathname;
        if (options.method === 'POST' && path.endsWith('/first-score'))
          commands.push(structuredClone(options.data));
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
              options.fail({ errMsg: 'request:fail synthetic response loss' }),
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
      app.identity.sessions.completeLogin(
        app.identity.sessions.beginLogin(),
        actor,
      );
    }
    function mount(name, route = {}) {
      const h = mountEmittedPage(name, app, wx, { dist });
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
    const loaded = (h, label) =>
      until(() => !h.page.data.busy && h.page.data.loaded, label, h.page);
    boot();
    assert.equal(
      transport.exchanges.length,
      0,
      'Startup never queries course data',
    );
    login(input.actor);
    let catalog = mount('course-ratings');
    await loaded(catalog, 'course catalog');
    assert.ok(catalog.page.data.items.length > 0);
    const reference = catalog.page.data.items.find(
      (item) => item.id === input.courseId,
    );
    assert.ok(
      reference,
      'Fixture rated course must be in the initial bounded catalog page',
    );
    const courseControl = catalog.capturePress('onCourse', {
      id: input.courseId,
    });
    try {
      assert.equal(courseControl.node.tag, 'wu-f7-list-item');
      assert.equal(courseControl.node.attrs.title, reference.name);
      assert.equal(courseControl.node.attrs['aria-label'], reference.name);
      const component = JSON.parse(
        readFileSync(`${dist}pages/course-ratings/course-ratings.json`, 'utf8'),
      ).usingComponents[courseControl.node.tag];
      assert.equal(component, '../../components/f7-list-item/f7-list-item');
      assert.equal(courseControl.instance.properties.titleSlot, false);
      const actualTemplate = parse(
        readFileSync(
          `${dist}components/f7-list-item/f7-list-item.wxml`,
          'utf8',
        ),
      );
      assert.ok(
        componentText(
          render(
            actualTemplate.children,
            {
              ...courseControl.instance.data,
              ...courseControl.instance.properties,
            },
            {},
          ),
        ).includes(reference.name),
        'The registered real ListItem template renders the selected course title',
      );
    } finally {
      courseControl.detach();
    }
    for (const key of [
      'department',
      'category',
      'nature',
      'code',
      'campusLabel',
    ])
      assert.ok(
        String(visibleText(catalog)).includes(
          String(reference[key] ?? '未提供'),
        ),
        `Visible source ${key}`,
      );
    if (
      reference.code &&
      !reference.name.toLowerCase().includes(reference.code.toLowerCase())
    ) {
      catalog.event('bindinput', 'onSearchInput', { value: reference.code });
      catalog.tap('onSearch');
      await loaded(catalog, 'name-only search does not match course code');
      assert.equal(
        catalog.page.data.items.some((item) => item.id === input.courseId),
        false,
      );
    }
    catalog.event('bindinput', 'onSearchInput', { value: reference.name });
    catalog.tap('onSearch');
    await loaded(catalog, 'name substring search');
    assert.ok(
      catalog.page.data.items.some((item) => item.id === input.courseId),
    );
    catalog.event('bindchange', 'onDepartment', {
      value: String(reference.department <= 54 ? reference.department : 55),
    });
    if (reference.category) {
      if (catalog.page.data.uiPanel !== 'filters')
        catalog.tap('onTogglePanel', { panel: 'filters' });
      catalog.event('bindinput', 'onCategoryInput', {
        value: reference.category,
      });
      assert.equal(catalog.page.data.departmentDraft, null);
      catalog.tap('onSearch');
      await loaded(catalog, 'category filter');
      assert.ok(
        catalog.page.data.items.every(
          (item) => item.category === reference.category,
        ),
      );
    }
    catalog.event('bindinput', 'onSearchInput', { value: '' });
    catalog.event('bindchange', 'onDepartment', { value: '55' });
    assert.equal(catalog.page.data.categoryDraft, '');
    catalog.tap('onSearch');
    await loaded(catalog, 'legacy 90-99 filter');
    assert.ok(
      catalog.page.data.items.every(
        (item) => item.department >= 90 && item.department <= 99,
      ),
    );
    if (input.legacyId)
      assert.ok(
        catalog.page.data.items.some((item) => item.id === input.legacyId),
      );
    catalog.event('bindchange', 'onDepartment', { value: '0' });
    catalog.event('bindinput', 'onSearchInput', { value: reference.name });
    catalog.tap('onSearch');
    await loaded(catalog, 'return to chosen course');
    catalog.tap('onCourse', { id: input.courseId });
    assert.equal(
      navigations.at(-1),
      `/pages/course-rating-detail/course-rating-detail?courseId=${input.courseId}`,
    );
    close(catalog);
    const unknown = mount('course-rating-detail', {
      courseId: input.unknownId,
    });
    await loaded(unknown, 'unknown history course');
    assert.equal(unknown.page.data.detail.myScore.kind, 'unavailable');
    assert.equal(unknown.page.data.detail.course.summary.kind, 'unavailable');
    assert.equal(unknown.page.data.canScore, false);
    assert.match(visibleText(unknown), /暂未确认你的历史评分，请稍后重试。/);
    assert.equal(unknown.button('bindtap', 'onConfirm'), undefined);
    close(unknown);
    let detail = mount('course-rating-detail', { courseId: input.courseId });
    await loaded(detail, 'known empty first score');
    assert.equal(detail.page.data.detail.myScore.kind, 'not_submitted');
    assert.equal(detail.page.data.detail.course.summary.kind, 'known');
    if (detail.page.data.uiPanel !== 'score')
      detail.tap('onTogglePanel', { panel: 'score' });
    const choices = detail
      .nodes()
      .filter(
        (node) =>
          typeof node !== 'string' &&
          node.tag === 'wu-f7-button' &&
          node.attrs['bind:press'] === 'onScore',
      );
    for (const axis of ['gradeScore', 'abilityScore', 'overallScore'])
      assert.deepEqual(
        choices
          .filter((node) => node.attrs['data-axis'] === axis)
          .map((node) => Number(node.attrs['data-score'])),
        [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5],
      );
    const enteredCatalogRevision = detail.page.data.detail.catalogRevision;
    const enteredCourseRevision = detail.page.data.detail.course.revision;
    const tuple = { gradeScore: 0.5, abilityScore: 4.5, overallScore: 1.5 };
    detail.tap('onScore', { axis: 'gradeScore', score: 0.5 });
    detail.tap('onScore', { axis: 'abilityScore', score: 4.5 });
    assert.equal(
      detail.page.data.overallScore,
      null,
      'Overall is never derived',
    );
    assert.equal(detail.page.data.canSubmit, false);
    detail.tap('onScore', { axis: 'overallScore', score: 1.5 });
    detail.tap('onConfirm');
    detail.tap('onCloseConfirmation');
    assert.equal(commands.length, 0, 'Cancelling confirmation cannot send');
    detail.tap('onConfirm');
    transport.dropSuccess = {
      path: `/v1/ratings/courses/${input.courseId}/first-score`,
      method: 'POST',
    };
    detail.tap('onSubmit');
    detail.page.onSubmit();
    await until(
      () => detail.page.data.frozen && !detail.page.data.busy,
      'response loss after first-score commit',
      detail.page,
    );
    assert.equal(
      commands.length,
      1,
      'Repeated final tap sends one original command',
    );
    const original = app.community.pendingCourseRatings.load(
      input.actor.accountId,
    );
    assert.ok(original);
    assert.deepEqual(commands[0], original.payload);
    for (const axis of Object.keys(tuple))
      assert.equal(original.payload[axis], tuple[axis]);
    assert.equal(
      original.payload.expectedCatalogRevision,
      enteredCatalogRevision,
    );
    assert.equal(
      original.payload.expectedCourseRevision,
      enteredCourseRevision,
    );
    assert.equal(
      detail.page.data.detail,
      null,
      'Pre-submit own status and means are cleared while the outcome is unknown',
    );
    assert.equal(detail.page.data.loaded, false);
    assert.equal(visibleText(detail).includes('当前已确认尚未评分'), false);
    assert.equal(visibleText(detail).includes('还没有为这门课评分'), false);
    detail.tap('onRefresh');
    await loaded(
      detail,
      'fresh snapshot cannot settle an unresolved original request',
    );
    assert.equal(detail.page.data.frozen, true);
    assert.match(visibleText(detail), /上次评分结果待确认/);
    assert.match(
      visibleText(detail),
      /请查询或重试原请求。确认结果前不能重新评分。/,
    );
    assert.equal(visibleText(detail).includes('当前已确认尚未评分'), false);
    assert.equal(visibleText(detail).includes('还没有为这门课评分'), false);
    assert.equal(detail.button('bindtap', 'onConfirm'), undefined);
    assert.deepEqual(
      app.community.pendingCourseRatings.load(input.actor.accountId),
      original,
    );
    await checkpoint('course-score-committed', {
      requestId: original.payload.clientRequestId,
      courseId: input.courseId,
      tuple,
    });
    close(detail);
    app.onHide();
    boot();
    assert.equal(
      app.identity.sessions.snapshot().credentials.accountId,
      input.actor.accountId,
      'Process-style App restart restores the existing session',
    );
    catalog = mount('course-ratings');
    await until(
      () => !catalog.page.data.busy,
      'withdrawn catalog load',
      catalog.page,
    );
    assert.equal(catalog.page.data.loaded, false);
    assert.equal(catalog.page.data.frozen, true);
    assert.ok(catalog.button('bindtap', 'onRecover'));
    assert.deepEqual(
      app.community.pendingCourseRatings.load(input.actor.accountId),
      original,
    );
    catalog.tap('onRecover');
    await until(
      () => !catalog.page.data.busy && !catalog.page.data.frozen,
      'historical receipt after source withdrawal',
      catalog.page,
    );
    assert.equal(
      app.community.pendingCourseRatings.load(input.actor.accountId),
      null,
    );
    assert.match(visibleText(catalog), /已确认成功/);
    assert.equal(
      catalog.page.data.loaded,
      false,
      'A receipt is not current catalog authority',
    );
    assert.equal(commands.length, 1);
    await checkpoint('course-recovery-confirmed', {
      requestId: original.payload.clientRequestId,
      courseId: input.courseId,
    });
    close(catalog);
    detail = mount('course-rating-detail', { courseId: input.courseId });
    await loaded(detail, 'recorded immutable own tuple and independent means');
    assert.equal(detail.page.data.detail.myScore.kind, 'recorded');
    for (const axis of Object.keys(tuple))
      assert.equal(detail.page.data.detail.myScore[axis], tuple[axis]);
    assert.equal(detail.page.data.canScore, false);
    assert.equal(detail.button('bindtap', 'onConfirm'), undefined);
    const summary = detail.page.data.detail.course.summary;
    assert.deepEqual(
      summary,
      input.expectedSummary ?? { kind: 'known', count: 1, ...tuple },
    );
    const accountGate = transport.holdNext(
      `/v1/ratings/courses/${input.courseId}`,
    );
    detail.tap('onRefresh');
    await accountGate.arrived;
    login(input.other);
    assert.equal(
      detail.page.data.detail,
      null,
      'Account switch clears previous own score synchronously',
    );
    accountGate.release();
    await delay(25);
    assert.equal(
      detail.page.data.detail,
      null,
      'Old account callback cannot repopulate',
    );
    close(detail);
    detail = mount('course-rating-detail', { courseId: input.courseId });
    await loaded(detail, 'other account own score');
    assert.equal(detail.page.data.detail.myScore.kind, 'not_submitted');
    assert.equal(detail.page.data.overallScore, null);
    assert.equal(
      app.community.pendingCourseRatings.load(input.other.accountId),
      null,
    );
    const hideGate = transport.holdNext(
      `/v1/ratings/courses/${input.courseId}`,
    );
    detail.tap('onRefresh');
    await hideGate.arrived;
    app.onHide();
    assert.equal(detail.page.data.detail, null);
    hideGate.release();
    await delay(25);
    assert.equal(detail.page.data.detail, null);
    close(detail);
    login(input.actor);
    detail = mount('course-rating-detail', { courseId: input.courseId });
    await loaded(detail, 'same account relogin own immutable tuple');
    assert.equal(detail.page.data.detail.myScore.kind, 'recorded');
    assert.equal(commands.length, 1);
    assert.ok(
      transport.exchanges.every((exchange) => exchange.authorized),
      'Every actual course request is authenticated',
    );
    for (const h of pages) {
      const patches = JSON.stringify(h.page.patches);
      assert.equal(patches.includes(input.actor.accessToken), false);
      assert.equal(patches.includes(input.actor.refreshToken), false);
    }
    await send({
      event: 'done',
      requestId: original.payload.clientRequestId,
      courseId: input.courseId,
      tuple,
      commands: commands.length,
      exchanges: transport.exchanges.length,
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
