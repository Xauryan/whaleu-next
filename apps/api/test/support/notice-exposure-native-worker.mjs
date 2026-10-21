/** Emitted native Page/controller/ApiClient -> real AppModule loopback HTTP/PG.
 * wx intersection, nextTick, setData commit timing and the dwell clock below are
 * simulated platform adapters, NOT Tencent rendering, hit-testing or device proof.
 * Server payloads, source writers, worker receipts and read timestamps are real.
 * Build the native artifact separately; this worker never builds or seeds data.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createSocialUpdatesJourney } from '../../../wechat/test/social-updates-emitted-harness.mjs';

const require = createRequire(import.meta.url);
const {
  NativeExperienceTransport,
  nativeOrigin,
} = require('./experience-native-bridge.ts');
const {
  checkedNoticeTransport,
} = require('./notice-exposure-native-transport.ts');
const dist = fileURLToPath(new URL('../../../wechat/dist/', import.meta.url));

/** Deliberately adversarial simulated callbacks may fire after disconnect. */
function simulatedPlatform() {
  let timestamp = Date.now();
  let serial = 0;
  const timers = new Map();
  const ticks = [];
  const observers = [];
  return {
    observers,
    clock: {
      now: () => timestamp,
      schedule(callback, milliseconds) {
        const id = ++serial;
        timers.set(id, { at: timestamp + milliseconds, callback });
        return () => timers.delete(id);
      },
    },
    wx: {
      nextTick(callback) {
        ticks.push(callback);
      },
      createIntersectionObserver(_page, options) {
        assert.deepEqual(options, { thresholds: [0, 0.5], initialRatio: 0 });
        let callback;
        const record = {
          selector: '',
          disconnected: false,
          emit(intersectionRatio) {
            callback?.({ intersectionRatio });
          },
        };
        observers.push(record);
        const observer = {
          relativeToViewport() {
            return observer;
          },
          observe(selector, listener) {
            record.selector = selector;
            callback = listener;
          },
          disconnect() {
            record.disconnected = true;
          },
        };
        return observer;
      },
    },
    tick() {
      for (const callback of ticks.splice(0)) callback();
    },
    advance(milliseconds) {
      timestamp += milliseconds;
      for (const [id, timer] of [...timers]) {
        if (timer.at > timestamp) continue;
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

const checkpoints = new Map();
let checkpointSequence = 0;
process.on('message', (message) => {
  if (message?.event !== 'checkpoint-result') return;
  const pending = checkpoints.get(message.sequence);
  assert.ok(pending, 'Only the requested database checkpoint can settle');
  checkpoints.delete(message.sequence);
  pending(message);
});
function sendToParent(message) {
  return new Promise((resolve, reject) => {
    if (!process.connected || !process.send) {
      reject(new Error('Native exposure parent IPC is closed'));
      return;
    }
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}
async function requestCheckpoint(name) {
  const sequence = ++checkpointSequence;
  const result = new Promise((resolve) => checkpoints.set(sequence, resolve));
  try {
    await sendToParent({ event: 'checkpoint', name, sequence });
    return await result;
  } finally {
    checkpoints.delete(sequence);
  }
}

process.once('message', async (input) => {
  let journey;
  let restoreClock;
  let releaseHeldResponse;
  try {
    assert.equal(input.event, 'start');
    const entry = path.join(dist, 'pages/social-notices/social-notices');
    assert.match(
      readFileSync(`${entry}.js`, 'utf8'),
      /notice-exposure/,
      'Refuse a stale emitted Page without the exposure implementation',
    );
    assert.match(
      readFileSync(`${entry}.wxml`, 'utf8'),
      /id="{{item\.observationId}}"/,
      'Emitted WXML must bind the exact committed row observation identity',
    );
    const { systemClock } = require(path.join(dist, 'platform/clock.js'));
    const originalClock = { ...systemClock };
    const native = simulatedPlatform();
    Object.assign(systemClock, native.clock);
    restoreClock = () => Object.assign(systemClock, originalClock);

    const real = new NativeExperienceTransport(input.port);
    const audit = checkedNoticeTransport(
      real,
      input.credentials,
      input.noticeIds,
      nativeOrigin,
    );
    const { transport, writes } = audit;
    const receipts = [];
    real.checkResponse = (pathname, status, body) => {
      if (!pathname.endsWith('/read') || status !== 200) return;
      audit.validate(() => {
        assert.equal(pathname, `/v1/me/social-updates/${body.noticeId}/read`);
        assert.match(body.readAt, /^\d{4}-.*\.\d{6}Z$/);
        assert.equal(body.unreadCountStatus, 'available');
        receipts.push({ ...body });
      });
    };
    journey = createSocialUpdatesJourney({
      dist,
      origin: nativeOrigin,
      credentials: input.credentials,
      transport,
    });
    Object.assign(globalThis.wx, native.wx);

    async function flush() {
      for (let i = 0; i < 20; i++) {
        native.tick();
        await Promise.resolve();
      }
      audit.assertHealthy();
    }
    async function checkpoint(name) {
      await flush();
      audit.assertHealthy();
      await requestCheckpoint(name);
      audit.assertHealthy();
    }
    async function until(check, label, page) {
      const deadline = Date.now() + 20000;
      while (!check()) {
        await flush();
        assert.ok(
          Date.now() < deadline,
          `${label}: ${page?.data.error || 'not settled'}`,
        );
        await delay(5);
      }
      await flush();
    }
    async function mount(kind) {
      const mounted = journey.mount(kind);
      await mounted.idle();
      await flush();
      assert.equal(mounted.page.data.loaded, true);
      assert.equal(typeof mounted.page.renderNotices, 'function');
      assert.ok(
        mounted.page.noticeExposure,
        'Actual emitted Page owns the observer',
      );
      assert.equal(
        'unreadCount' in mounted.page.data,
        false,
        'No inferred cross-source total',
      );
      return mounted;
    }
    const row = (mounted, role) => {
      const value = mounted.page.data.rows.find(
        (item) => item.noticeId === input.noticeIds[role],
      );
      assert.ok(value, `Real server row ${role} must be present`);
      assert.equal(
        value.id,
        `${role === 'follower' ? 'follower' : 'community-like'}:${value.noticeId}`,
      );
      assert.equal(value.available, true);
      return value;
    };
    function target(mounted, role) {
      const value = row(mounted, role);
      assert.ok(value.observationId);
      const observer = native.observers.findLast(
        (item) =>
          !item.disconnected && item.selector === `#${value.observationId}`,
      );
      assert.ok(
        observer,
        `Only the committed ${role} row may have an active observer`,
      );
      return observer;
    }
    async function noWrite(expected, label) {
      await flush();
      audit.assertHealthy();
      assert.equal(writes.length, expected, label);
    }
    async function allOldSignals(role) {
      for (const observer of native.observers.filter((item) =>
        item.selector.endsWith(`-${input.noticeIds[role]}`),
      ))
        observer.emit(1);
      native.advance(10000);
      await flush();
    }
    async function readSettled(mounted, role, count) {
      await until(
        () =>
          writes.length === count &&
          !mounted.page.data.busy &&
          row(mounted, role).unread === false,
        `${role} read`,
        mounted.page,
      );
    }

    let likes = await mount('likes');
    assert.equal(likes.page.data.rows.length, 4);
    assert.ok(likes.page.data.rows.every((item) => item.unread));
    await noWrite(0, 'Loading rows is not evidence of visibility');
    await checkpoint('loaded');
    native.advance(10000);
    await noWrite(0, 'Offscreen committed rows remain unread');
    await checkpoint('offscreen');

    let visible = target(likes, 'qualifying');
    visible.emit(0.49);
    native.advance(1500);
    await noWrite(0, 'Less than half visible is not qualifying');
    visible.emit(0.5);
    native.advance(999);
    await noWrite(0, '999 ms is insufficient');
    visible.emit(0);
    native.advance(1);
    await noWrite(0, 'Leaving the viewport discards accumulated dwell');
    await checkpoint('short-dwell');

    // Delay actual Page setData commit callbacks. An older render's callback and
    // even a disconnected observer may still arrive, but cannot arm a read.
    const originalSetData = likes.page.setData;
    const commits = [];
    likes.page.setData = function (patch, committed) {
      originalSetData.call(this, patch);
      if (committed) commits.push(committed);
    };
    likes.page.renderNotices(likes.page.controller.snapshot());
    likes.page.renderNotices(likes.page.controller.snapshot());
    assert.equal(commits.length, 2);
    const observerCount = native.observers.length;
    commits.shift()();
    await flush();
    assert.equal(
      native.observers.length,
      observerCount,
      'A stale native commit cannot attach observers',
    );
    visible.emit(1);
    native.advance(1000);
    await noWrite(0, 'A stale render cannot acknowledge');
    commits.shift()();
    await flush();
    likes.page.setData = originalSetData;
    visible = target(likes, 'qualifying');
    await checkpoint('stale-render');

    visible.emit(1);
    native.advance(1000);
    // The timer has qualified but its dispatch microtask has not run yet.
    likes.hide();
    await allOldSignals('qualifying');
    await noWrite(
      0,
      'Hide invalidates both the timer and disconnected callbacks',
    );
    assert.deepEqual(likes.page.data.rows, []);
    await checkpoint('hidden');
    likes.unload();

    likes = await mount('likes');
    visible = target(likes, 'qualifying');
    visible.emit(1);
    native.advance(1000);
    // Replacing ownership in the queued-dispatch gap must still prevent I/O.
    journey.sessions.completeLogin(
      journey.sessions.beginLogin(),
      input.otherCredentials,
    );
    await allOldSignals('qualifying');
    await noWrite(
      0,
      'Account replacement cannot dispatch the former owner read',
    );
    assert.deepEqual(likes.page.data.rows, []);
    await checkpoint('account-changed');
    likes.unload();
    journey.sessions.completeLogin(
      journey.sessions.beginLogin(),
      input.credentials,
    );

    likes = await mount('likes');
    const navigations = journey.navigations.length;
    target(likes, 'qualifying').emit(1);
    native.advance(1000);
    // Open clears qualified exposure before its queued dispatch can run.
    assert.equal(
      likes.press('onOpen', { id: row(likes, 'qualifying').id }),
      true,
    );
    await until(
      () => journey.navigations.length > navigations && !likes.page.data.busy,
      'real target navigation',
      likes.page,
    );
    assert.ok(journey.navigations.at(-1).includes(input.postIds.qualifying));
    assert.equal(row(likes, 'qualifying').unread, true);
    await noWrite(
      0,
      'Opening the real target cancels queued dwell and does not acknowledge',
    );
    await checkpoint('navigated');

    target(likes, 'qualifying').emit(0.5);
    native.advance(999);
    await noWrite(0, 'A new render requires its own complete dwell');
    native.advance(1);
    await readSettled(likes, 'qualifying', 1);
    await allOldSignals('qualifying');
    await noWrite(1, 'One qualifying committed row produces exactly one read');
    await checkpoint('qualified');

    // The real server commits, but its successful response is deliberately lost.
    // The display must remain unread and the observer must never retry itself.
    real.dropSuccess = {
      path: `/v1/me/social-updates/${input.noticeIds.unknown}/read`,
      method: 'PUT',
    };
    target(likes, 'unknown').emit(1);
    native.advance(1000);
    await until(
      () => real.dropSuccess === null && !likes.page.data.busy,
      'lost committed response',
      likes.page,
    );
    assert.equal(writes.length, 2);
    assert.equal(row(likes, 'unknown').unread, true);
    assert.ok(
      likes.page.data.sources.find((source) => source.key === 'community-like')
        .error,
    );
    await checkpoint('unknown-committed');
    await allOldSignals('unknown');
    await noWrite(
      2,
      'An uncertain outcome does not trigger an automatic retry',
    );
    await checkpoint('unknown-not-retried');
    assert.equal(likes.press('onRead', { id: row(likes, 'unknown').id }), true);
    await readSettled(likes, 'unknown', 3);
    await checkpoint('manual-reconciled');

    // Hold a fully received, committed real response past hide. Cancellation is
    // deliberately uncooperative here; lifecycle fencing must discard it itself.
    const gate = real.holdNext(
      `/v1/me/social-updates/${input.noticeIds.late}/read`,
      'PUT',
    );
    releaseHeldResponse = gate.release;
    let arrived = false;
    void gate.arrived.then(() => {
      arrived = true;
    });
    target(likes, 'late').emit(1);
    native.advance(1000);
    await until(
      () => arrived,
      'real read committed before response release',
      likes.page,
    );
    assert.equal(writes.length, 4);
    assert.equal(row(likes, 'late').unread, true);
    await checkpoint('late-in-flight');
    likes.hide();
    gate.release();
    releaseHeldResponse = undefined;
    await until(
      () =>
        receipts.some((receipt) => receipt.noticeId === input.noticeIds.late),
      'late response delivered after hide',
      likes.page,
    );
    assert.deepEqual(likes.page.data.rows, []);
    await allOldSignals('late');
    await noWrite(4, 'A late receipt cannot repaint or retry a hidden Page');
    await checkpoint('late-discarded');
    likes.unload();

    likes = await mount('likes');
    for (const role of ['qualifying', 'unknown', 'late'])
      assert.equal(row(likes, role).unread, false);
    assert.equal(row(likes, 'manual').unread, true);
    await noWrite(
      4,
      'Fresh owner reload reads durable server state without writing',
    );
    await checkpoint('reloaded');
    likes.unload();

    delete globalThis.wx.createIntersectionObserver;
    likes = await mount('likes');
    native.advance(10000);
    await noWrite(4, 'A missing platform observer stays manual-only');
    assert.equal(row(likes, 'manual').unread, true);
    assert.equal(likes.press('onRead', { id: row(likes, 'manual').id }), true);
    await readSettled(likes, 'manual', 5);
    await checkpoint('manual-only');
    likes.unload();
    globalThis.wx.createIntersectionObserver =
      native.wx.createIntersectionObserver;

    const followers = await mount('followers');
    assert.equal(followers.page.data.rows.length, 1);
    assert.equal(row(followers, 'follower').unread, true);
    native.advance(10000);
    await noWrite(5, 'Loading the other category cannot read it');
    target(followers, 'follower').emit(1);
    native.advance(1000);
    await readSettled(followers, 'follower', 6);
    await checkpoint('follow-qualified');
    followers.unload();

    for (const kind of ['likes', 'followers']) {
      const mounted = await mount(kind);
      assert.ok(mounted.page.data.rows.every((item) => !item.unread));
      mounted.unload();
    }
    await noWrite(6, 'Read receipts survive Page recreation without replay');
    assert.equal(
      real.exchanges.filter((exchange) => exchange.method === 'PUT').length,
      6,
    );
    assert.ok(
      real.exchanges.every(
        (exchange) => exchange.authorized && exchange.status === 200,
      ),
    );
    await checkpoint('durable');
    journey.close();
    journey = undefined;
    restoreClock();
    restoreClock = undefined;
    audit.assertHealthy();
    assert.equal(
      audit.attempts.length,
      real.exchanges.length,
      'Every attempted dispatch reached the real loopback server, with no silently rejected invalid request',
    );
    await sendToParent({ event: 'done', writes, receipts });
    process.disconnect();
  } catch (error) {
    releaseHeldResponse?.();
    journey?.close();
    restoreClock?.();
    process.exitCode = 1;
    try {
      await sendToParent({
        event: 'failure',
        message: error instanceof Error ? error.stack : String(error),
      });
    } catch {
      // Parent termination is already a failing test; never retry closed IPC.
    }
    if (process.connected) process.disconnect();
  }
});
