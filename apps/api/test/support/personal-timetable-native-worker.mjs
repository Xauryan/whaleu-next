/** Emitted native UI → real AppModule HTTP/PostgreSQL worker.
 * Native callbacks only are modeled. No provider, fake API result, or forced exit. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createTimetableJourney } from '../../../wechat/test/personal-timetable-emitted-harness.mjs';
const require = createRequire(import.meta.url);
const {
  NativeExperienceTransport,
  nativeOrigin,
} = require('./experience-native-bridge.ts');
const dist = path.resolve(
  fileURLToPath(new URL('../../../wechat/dist/', import.meta.url)),
);
const base = '/v1/me/timetable';
function send(value) {
  return new Promise((resolve, reject) => {
    if (!process.send) return reject(new Error('Native worker needs IPC'));
    process.send(value, (error) => (error ? reject(error) : resolve()));
  });
}
process.once('message', async (input) => {
  let journey,
    actual,
    inspectState = () => ({}),
    stage = 'initialization';
  try {
    assert.ok(
      input &&
        Number.isInteger(input.port) &&
        input.credentials &&
        input.otherCredentials,
      'Expected two real authenticated fixture accounts',
    );
    actual = new NativeExperienceTransport(input.port);
    const storage = new Map(),
      commands = [],
      assertions = [];
    const transport = {
      async send(request) {
        const url = new URL(request.url);
        assert.equal(
          url.search,
          '',
          'Schedule text never appears in URL query',
        );
        assert.ok(
          url.pathname.startsWith(base),
          'Timetable only calls its private endpoints',
        );
        assert.ok(
          request.headers.Authorization,
          'Every timetable HTTP request is authenticated',
        );
        if (url.pathname === `${base}/commands` && request.method === 'POST')
          commands.push(structuredClone(request.body));
        return actual.send(request);
      },
    };
    const start = (credentials = input.credentials) =>
      createTimetableJourney({
        dist,
        origin: nativeOrigin,
        credentials,
        transport,
        storage,
      });
    journey = start();
    stage = 'term-create';
    let page = journey.mount('personal-timetable-term');
    inspectState = () =>
      Object.fromEntries(
        [
          'busy',
          'ready',
          'authenticated',
          'blocked',
          'pending',
          'cancelPending',
        ].map((key) => [key, page.page.data[key] === true]),
      );
    await page.idle();
    stage = 'term-create-loaded';
    assert.equal(page.page.data.ready, true);
    page.input('onTerm', 'name', '原生验收学期');
    page.picker('onDate', '2026-09-07');
    page.input('onTerm', 'weekCount', '12');
    stage = 'term-create-press';
    assert.equal(page.press('onSave'), true);
    await page.idle();
    stage = 'term-create-settled';
    assert.match(page.page.data.message, /已保存/);
    const termId = commands.at(-1).termId;
    page.unload();
    assertions.push('native-term-create');
    stage = 'after-native-term-create';
    page = journey.mount('personal-timetable-term', { termId });
    await page.idle();
    page.picker('onDate', '2026-09-14');
    assert.equal(page.press('onSave'), true);
    assert.match(page.page.data.dateShiftPrompt, /所有课程日期/);
    const beforeConfirm = commands.length;
    assert.equal(page.press('onConfirmDateShift'), true);
    await page.idle();
    assert.equal(commands.length, beforeConfirm + 1);
    page.unload();
    assertions.push('native-term-date-confirm-update');
    stage = 'after-native-term-date-confirm-update';
    page = journey.mount('personal-timetable-entry', { termId });
    await page.idle();
    page.input('onEntry', 'name', '线性代数');
    page.input('onEntry', 'teacher', '林老师');
    page.input('onEntry', 'location', '理科楼 201');
    page.picker('onDay', 1);
    page.picker('onStart', '08:00');
    page.picker('onEnd', '09:00');
    assert.equal(page.press('onWeeks', { kind: 'odd' }), true);
    assert.equal(page.press('onSave'), true);
    await page.idle();
    const entryId = commands.at(-1).entryId;
    assert.match(page.page.data.message, /已保存/);
    page.unload();
    assertions.push('native-entry-create-explicit-odd-weeks');
    stage = 'after-native-entry-create-explicit-odd-weeks';
    page = journey.mount('personal-timetable', { termId });
    await page.idle();
    page.picker('onWeekChoice', 0);
    assert.equal(page.press('onDetails', { id: entryId }), true);
    assert.equal(page.page.data.selected.entryId, entryId);
    assert.equal(page.press('onNavigate', { target: 'duplicate' }), true);
    assert.match(journey.navigations.at(-1), /duplicate=1$/);
    page.unload();
    page = journey.mount('personal-timetable-entry', {
      termId,
      entryId,
      duplicate: '1',
    });
    await page.idle();
    assert.match(page.page.data.conflictWarning, /仍可保存/);
    assert.equal(page.press('onSave'), true);
    await page.idle();
    const duplicateId = commands.at(-1).entryId;
    assert.notEqual(duplicateId, entryId);
    page.unload();
    assertions.push('native-detail-copy-overlap-accepted');
    stage = 'after-native-detail-copy-overlap-accepted';
    page = journey.mount('personal-timetable-entry', { termId, entryId });
    await page.idle();
    page.input('onEntry', 'name', '线性代数（已调整）');
    actual.dropSuccess = { path: `${base}/commands`, method: 'POST' };
    assert.equal(page.press('onSave'), true);
    await page.idle();
    assert.equal(page.page.data.pending, true);
    const committedLost = commands.at(-1),
      beforeRecovery = commands.length;
    page.unload();
    journey.close();
    journey = start();
    page = journey.mount('personal-timetable', { termId });
    await page.idle();
    assert.equal(page.page.data.requestId, committedLost.requestId);
    assert.equal(page.press('onCancelOriginal'), true);
    await page.idle();
    assert.match(page.page.data.message, /已保存/);
    assert.equal(commands.length, beforeRecovery);
    page.unload();
    assertions.push('native-cold-committed-recovery-cancel-race');
    stage = 'after-native-cold-committed-recovery-cancel-race';
    page = journey.mount('personal-timetable-entry', { termId, entryId });
    await page.idle();
    page.input('onEntry', 'name', '线性代数（原请求重试）');
    actual.failNext = `${base}/commands`;
    assert.equal(page.press('onSave'), true);
    await page.idle();
    assert.equal(page.page.data.pending, true);
    const retryOriginal = structuredClone(commands.at(-1));
    page.unload();
    journey.close();
    journey = start();
    page = journey.mount('personal-timetable', { termId });
    await page.idle();
    assert.equal(page.press('onRetry'), true);
    await page.idle();
    assert.deepEqual(commands.at(-1), retryOriginal);
    assert.match(page.page.data.message, /已保存/);
    page.unload();
    assertions.push('native-cold-exact-original-retry');
    stage = 'after-native-cold-exact-original-retry';
    page = journey.mount('personal-timetable-entry', { termId, entryId });
    await page.idle();
    page.input('onEntry', 'name', '不得执行的取消内容');
    actual.failNext = `${base}/commands`;
    assert.equal(page.press('onSave'), true);
    await page.idle();
    const cancelled = commands.at(-1);
    assert.equal(page.press('onCancelOriginal'), true);
    await page.idle();
    assert.match(page.page.data.message, /已取消/);
    page.unload();
    assertions.push('native-unknown-original-cancel-fence');
    stage = 'after-native-unknown-original-cancel-fence';
    page = journey.mount('personal-timetable-entry', { termId, entryId });
    await page.idle();
    assert.equal(page.page.data.entryForm.name, '线性代数（原请求重试）');
    journey.sessions.completeLogin(
      journey.sessions.beginLogin(),
      input.otherCredentials,
    );
    assert.equal(page.page.data.entryForm.name, '');
    assert.equal(page.page.data.term, null);
    page.unload();
    journey.close();
    journey = start(input.otherCredentials);
    page = journey.mount('personal-timetable', { termId });
    await page.idle();
    assert.equal(page.page.data.term, null);
    assert.deepEqual(page.page.data.days, []);
    assert.deepEqual(page.page.data.terms, []);
    page.unload();
    journey.close();
    journey = start();
    assertions.push('native-cross-account-no-private-render');
    stage = 'after-native-cross-account-no-private-render';
    page = journey.mount('personal-timetable-entry', {
      termId,
      entryId: duplicateId,
    });
    await page.idle();
    assert.equal(page.press('onDelete'), true);
    assert.equal(page.press('onConfirmDelete'), true);
    await page.idle();
    assert.match(page.page.data.message, /已删除/);
    page.unload();
    assertions.push('native-entry-delete');
    stage = 'after-native-entry-delete';
    page = journey.mount('personal-timetable', { termId });
    await page.idle();
    journey.setNavigationFailure(true);
    assert.equal(page.press('onNavigate', { target: 'newEntry' }), true);
    assert.match(page.page.data.error, /数据未改变/);
    page.unload();
    journey.setNavigationFailure(false);
    assertions.push('native-navigation-failure');
    stage = 'after-native-navigation-failure';
    page = journey.mount('personal-timetable-term', { termId });
    await page.idle();
    assert.equal(page.press('onDelete'), true);
    page.input('onDeleteText', '', '错误名称');
    assert.equal(page.press('onConfirmDelete'), false);
    page.input('onDeleteText', '', '原生验收学期');
    assert.equal(page.press('onConfirmDelete'), true);
    await page.idle();
    assert.match(page.page.data.message, /已删除/);
    page.unload();
    assertions.push('native-exact-typed-term-delete');
    stage = 'after-native-exact-typed-term-delete';
    page = journey.mount('personal-timetable');
    await page.idle();
    assert.deepEqual(page.page.data.terms, []);
    page.unload();
    assert.equal(storage.size, 0, 'All original journals settled and removed');
    journey.close();
    journey = undefined;
    await send({
      event: 'done',
      termId,
      entryId,
      duplicateId,
      cancelledRequestId: cancelled.requestId,
      requestIds: [...new Set(commands.map((command) => command.requestId))],
      exchanges: actual.exchanges,
      assertions,
    });
  } catch (error) {
    const diagnostics = {
      state: inspectState(),
      // Never include request/response bodies, credentials, forms or assertion diffs.
      exchanges: actual?.exchanges.map(({ method, status }) => ({
        method,
        status,
      })),
    };
    journey?.close();
    // Do not serialize raw requests, credentials, forms, or assertion diffs.
    await send({
      event: 'error',
      message:
        error instanceof Error
          ? error.name +
            ': native timetable journey failed at ' +
            stage +
            ' ' +
            JSON.stringify(diagnostics)
          : 'Native timetable journey failed',
      diagnostics,
    });
  } finally {
    if (process.connected) process.disconnect();
  }
});
