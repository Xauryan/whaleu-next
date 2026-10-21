import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NoticeExposureObserver,
  type NoticeExposureRow,
} from '../src/notifications/notice-exposure';
import { guardNoticeRead } from '../src/notifications/notice-read-guard';
import { Cancellation } from '../src/platform/contracts';
import { nativeObservation } from './notice-exposure-helpers';
import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';
import { SafetyChanges } from '../src/community/safety-changes';
import { FakeClock, flush, signedIn, credentials } from './helpers';

const id = '77777777-7777-4777-8777-777777777777';
const row = (
  source = 'system',
  fingerprint = 'exact original row',
): NoticeExposureRow => ({
  key: `${source}:${id}`,
  source,
  noticeId: id,
  unread: true,
  fingerprint,
});

function fixture() {
  const clock = new FakeClock();
  const sessions = signedIn();
  const privateViews = new PrivateViewLifecycle();
  const safetyChanges = new SafetyChanges();
  const browsingScopeChanges = new PrivateViewLifecycle();
  const directoryScopeChanges = new PrivateViewLifecycle();
  const native = nativeObservation();
  const reads: NoticeExposureRow[] = [];
  const observer = new NoticeExposureObserver(
    native.wx,
    {},
    clock,
    {
      sessions,
      privateViews,
      safetyChanges,
      browsingScopeChanges,
      directoryScopeChanges,
    },
    async (notice, guard) => {
      assert.equal(guard(), true);
      reads.push(notice);
    },
  );
  const render = (rows = [row()], scope = 'system:timeline', ready = true) => {
    const commit = observer.render(rows, scope, ready);
    commit.committed();
    native.tick();
    return commit;
  };
  return {
    clock,
    sessions,
    privateViews,
    safetyChanges,
    browsingScopeChanges,
    directoryScopeChanges,
    native,
    reads,
    observer,
    render,
  };
}

test('fetch/render is not evidence: exact row native commit, intersection and 1000 continuous ms are all required', async () => {
  const h = fixture();
  const commit = h.observer.render([row()], 'system:timeline', true);
  h.clock.advance(5000);
  await flush();
  assert.equal(h.native.observers.length, 0);
  commit.committed();
  assert.equal(h.native.observers.length, 0);
  h.native.tick();
  assert.equal(h.native.observers.length, 1);
  assert.equal(
    h.native.observers[0]!.selector,
    `#${commit.ids.get(row().key)}`,
  );
  h.clock.advance(5000);
  await flush();
  assert.deepEqual(h.reads, []);
  for (const ratio of [0, 0.49, NaN, Infinity, -1, 2])
    h.native.observers[0]!.emit(ratio);
  h.clock.advance(1000);
  await flush();
  assert.deepEqual(h.reads, []);
  h.native.observers[0]!.emit(0.5);
  h.clock.advance(999);
  await flush();
  assert.deepEqual(h.reads, []);
  h.clock.advance(1);
  await flush();
  assert.deepEqual(h.reads, [row()]);
  h.observer.dispose();
});

test('exit, offscreen reentry and same-turn exit after expiry require a fresh uninterrupted interval', async () => {
  const h = fixture();
  h.render();
  const native = h.native.observers[0]!;
  native.emit(1);
  h.clock.advance(900);
  native.emit(0);
  native.emit(1);
  h.clock.advance(999);
  await flush();
  assert.equal(h.reads.length, 0);
  h.clock.advance(1);
  native.emit(0);
  native.emit(1);
  await flush();
  assert.equal(
    h.reads.length,
    0,
    'expiry microtask cannot borrow reentry visibility',
  );
  h.clock.advance(1000);
  await flush();
  assert.equal(h.reads.length, 1);
  h.observer.dispose();
});

test('stale commit, nextTick, observer callback, same-ID replaced body and category cannot read old rows', async () => {
  const h = fixture();
  const readRows = (): readonly NoticeExposureRow[] => h.reads;
  const old = h.observer.render([row()], 'likes', true);
  const next = h.observer.render(
    [row('system', 'changed body')],
    'likes',
    true,
  );
  old.committed();
  next.committed();
  h.observer.render([row()], 'followers', false).committed();
  h.native.tick();
  assert.equal(h.native.observers.length, 0);
  h.render();
  const native = h.native.observers[h.native.observers.length - 1]!;
  native.emit(1);
  h.clock.advance(999);
  h.render([row('system', 'changed body')]);
  native.emit(1);
  h.clock.advance(1000);
  await flush();
  assert.deepEqual(h.reads, []);
  h.native.observers[h.native.observers.length - 1]!.emit(1);
  h.clock.advance(1000);
  await flush();
  assert.equal(readRows()[0]!.fingerprint, 'changed body');
  h.observer.dispose();
});

for (const boundary of [
  'hide',
  'occlusion',
  'loading',
  'scope',
  'account',
  'relogin',
  'safety',
  'root-hide',
  'private',
  'browse',
  'directory',
] as const)
  test(`${boundary} clears dwell and rejects both stale callbacks and queued qualification`, async () => {
    const h = fixture();
    h.render();
    const native = h.native.observers[0]!;
    native.emit(1);
    h.clock.advance(1000);
    if (boundary === 'hide') h.observer.dispose();
    else if (boundary === 'occlusion') h.observer.setOccluded(true);
    else if (boundary === 'loading')
      h.render([row()], 'system:timeline', false);
    else if (boundary === 'scope') h.render([row()], 'other', true);
    else if (boundary === 'account' || boundary === 'relogin')
      h.sessions.completeLogin(
        h.sessions.beginLogin(),
        credentials(boundary === 'account' ? '13' : '12'),
      );
    else if (boundary === 'safety') h.safetyChanges.invalidate('12');
    else if (boundary === 'root-hide') h.privateViews.clear();
    else if (boundary === 'private') h.privateViews.clear('12');
    else if (boundary === 'browse') h.browsingScopeChanges.clear('12');
    else h.directoryScopeChanges.clear('12');
    native.emit(1);
    await flush();
    h.clock.advance(10000);
    await flush();
    assert.deepEqual(h.reads, []);
    assert.equal(native.disconnected, true);
    h.observer.dispose();
  });

test('unoccluding cannot reuse old evidence; new commit and dwell are necessary', async () => {
  const h = fixture();
  h.render();
  h.native.observers[0]!.emit(1);
  h.clock.advance(900);
  h.observer.setOccluded(true);
  h.observer.setOccluded(false);
  h.clock.advance(5000);
  await flush();
  assert.deepEqual(h.reads, []);
  h.render();
  h.native.observers[h.native.observers.length - 1]!.emit(1);
  h.clock.advance(1000);
  await flush();
  assert.equal(h.reads.length, 1);
  h.observer.dispose();
});

test('source collisions remain independent; duplicates, malformed IDs and already-read rows never arm', async () => {
  const h = fixture();
  h.render([
    row('system'),
    row('errand'),
    row('feedback'),
    row('feedback'),
    { ...row('verification'), unread: false },
    { ...row('bad'), key: id },
  ]);
  assert.equal(h.native.observers.length, 2);
  h.native.observers.find((o) => o.selector.includes('-errand-'))!.emit(1);
  h.clock.advance(1000);
  await flush();
  assert.deepEqual(
    h.reads.map((r) => r.key),
    [`errand:${id}`],
  );
  h.render([row('system'), row('errand')]);
  h.native.observers[h.native.observers.length - 1]!.emit(1);
  h.clock.advance(1000);
  await flush();
  assert.deepEqual(
    h.reads.map((r) => r.key),
    [`errand:${id}`, `system:${id}`],
  );
  h.observer.dispose();
});

test('missing or failed native observer stays manual-only and unknown acknowledgments never replay', async () => {
  for (const wx of [
    {},
    {
      createIntersectionObserver() {
        throw Error('unsupported');
      },
    },
  ]) {
    const h = fixture();
    const observer = new NoticeExposureObserver(
      wx,
      {},
      h.clock,
      { sessions: h.sessions },
      async () => {
        throw Error('must not dispatch');
      },
    );
    observer.render([row()], 'system', true).committed();
    h.clock.advance(10000);
    await flush();
    observer.dispose();
    h.observer.dispose();
  }
  const h = fixture();
  let calls = 0;
  const observer = new NoticeExposureObserver(
    h.native.wx,
    {},
    h.clock,
    { sessions: h.sessions },
    async () => {
      calls++;
      throw Error('unknown');
    },
  );
  observer.render([row()], 'system', true).committed();
  h.native.tick();
  h.native.observers[h.native.observers.length - 1]!.emit(1);
  h.clock.advance(1000);
  await flush();
  observer.render([row()], 'system', true).committed();
  h.native.tick();
  h.native.observers[h.native.observers.length - 1]!.emit(1);
  h.clock.advance(10000);
  await flush();
  assert.equal(calls, 1);
  observer.dispose();
  h.observer.dispose();
});

test('guard cancellation keeps manual behavior and cannot revive a stale attempt', () => {
  const original = new Cancellation();
  assert.equal(guardNoticeRead(original), original);
  let current = true;
  const guarded = guardNoticeRead(original, () => current);
  assert.equal(guarded.isCancelled, false);
  current = false;
  assert.equal(guarded.isCancelled, true);
  current = true;
  assert.equal(guarded.isCancelled, true);
  assert.throws(() => guardNoticeRead(original, () => false));
});

test('own busy echo requires explicit readiness exception; genuine not-loaded transition cancels identical-row lease', async () => {
  const h = fixture();
  let guard: (() => boolean) | undefined;
  let finish: (() => void) | undefined;
  const observer = new NoticeExposureObserver(
    h.native.wx,
    {},
    h.clock,
    { sessions: h.sessions },
    async (_row, current) => {
      guard = current;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  );
  observer.render([row()], 'system', true).committed();
  h.native.tick();
  h.native.observers[h.native.observers.length - 1]!.emit(1);
  h.clock.advance(1000);
  await flush();
  assert.equal(guard!(), true);
  observer.render([row()], 'system', false, true).committed();
  assert.equal(guard!(), true, 'only qualified own busy echo survives');
  observer.render([row()], 'system', false).committed();
  assert.equal(
    guard!(),
    false,
    'same row while no longer loaded is not exposure',
  );
  finish!();
  await flush();
  observer.dispose();
  h.observer.dispose();
});

test('oversized row that never reaches local 50 percent threshold stays manual-only', async () => {
  const h = fixture();
  h.render();
  // Native intersectionRatio is the area ratio; no invented viewport-size shortcut.
  h.native.observers[0]!.emit(0.499999);
  h.clock.advance(10000);
  await flush();
  assert.equal(h.reads.length, 0);
  h.native.observers[0]!.emit(0.5);
  h.clock.advance(1000);
  await flush();
  assert.equal(h.reads.length, 1);
  h.observer.dispose();
});
