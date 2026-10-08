import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ViewObserver,
  type ViewObservationSink,
} from '../src/community/view-observer';
import type { WxApi } from '../src/platform/wechat';
import { FakeClock, signedIn } from './helpers';
const a = '11111111-1111-4111-8111-111111111111',
  b = '22222222-2222-4222-8222-222222222222';
function fixture(kind: 'list_exposure' | 'detail_visit' = 'list_exposure') {
  const clock = new FakeClock(),
    sessions = signedIn(),
    events: { kind: string; postId: string }[] = [];
  let active = true,
    ready = true;
  const listeners = new Set<() => void>(),
    ticks: (() => void)[] = [];
  const observations: {
    selector: string;
    callback: (result: { intersectionRatio: number }) => void;
    disconnected: boolean;
  }[] = [];
  const sink: ViewObservationSink = {
    captureOwner: () => sessions.snapshot(),
    canPresent: (owner) => active && owner.epoch === sessions.snapshot().epoch,
    canObserve: (owner) =>
      ready && active && owner.epoch === sessions.snapshot().epoch,
    observe: (kind, postId) => {
      events.push({ kind, postId });
    },
    subscribeInvalidation: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const wx: Pick<WxApi, 'createIntersectionObserver' | 'nextTick'> = {
    nextTick: (callback) => {
      ticks.push(callback);
    },
    createIntersectionObserver: () => {
      const observation = {
        selector: '',
        callback: (_result: { intersectionRatio: number }) => {},
        disconnected: false,
      };
      observations.push(observation);
      return {
        relativeToViewport() {
          return this;
        },
        observe(selector, callback) {
          observation.selector = selector;
          observation.callback = callback;
        },
        disconnect() {
          observation.disconnected = true;
        },
      };
    },
  };
  const observer = new ViewObserver(wx, {}, clock, sink, kind);
  const commit = (ids: readonly string[], scope = 'feed') => {
    observer.render(ids, scope)();
    while (ticks.length) ticks.shift()!();
  };
  const ratio = (id: string, value: number) => {
    const found = observations
      .filter((o) => o.selector === `#view-${id}` && !o.disconnected)
      .slice(-1)[0];
    assert.ok(found);
    found.callback({ intersectionRatio: value });
  };
  return {
    observer,
    clock,
    sessions,
    events,
    observations,
    ticks,
    commit,
    ratio,
    setReady(value: boolean) {
      ready = value;
      for (const listener of listeners) listener();
    },
    setActive(value: boolean) {
      active = value;
      for (const listener of listeners) listener();
    },
  };
}
test('list qualifies at 0.50 and 1000ms, not 0.49 or 999ms; duplicate callbacks and re-entry behave separately', () => {
  const f = fixture();
  f.commit([a]);
  f.ratio(a, 0.49);
  f.clock.advance(2000);
  assert.equal(f.events.length, 0);
  f.ratio(a, 0.5);
  f.clock.advance(999);
  assert.equal(f.events.length, 0);
  f.ratio(a, 0.8);
  f.clock.advance(1);
  assert.equal(f.events.length, 1);
  f.ratio(a, 0.8);
  f.clock.advance(1000);
  assert.equal(f.events.length, 1);
  f.ratio(a, 0.49);
  f.ratio(a, 0.5);
  f.clock.advance(1000);
  assert.equal(f.events.length, 2);
  f.observer.dispose();
});
test('interruption, removal, scope replacement, hide and stale native callbacks cancel unqualified intervals', () => {
  const f = fixture();
  f.commit([a]);
  const stale = f.observations[0]!;
  f.ratio(a, 0.5);
  f.clock.advance(500);
  f.ratio(a, 0);
  f.clock.advance(500);
  assert.equal(f.events.length, 0);
  f.ratio(a, 0.5);
  f.commit([b]);
  f.clock.advance(1000);
  stale.callback({ intersectionRatio: 1 });
  f.clock.advance(1000);
  assert.equal(f.events.length, 0);
  f.ratio(b, 0.5);
  f.commit([b], 'other');
  f.clock.advance(1000);
  assert.equal(f.events.length, 0);
  f.ratio(b, 0.5);
  f.setActive(false);
  f.clock.advance(1000);
  assert.equal(f.events.length, 0);
  f.observer.dispose();
});
test('same-scope pagination preserves current target timer and qualified interval rather than creating new exposures', () => {
  const f = fixture();
  f.commit([a]);
  f.ratio(a, 0.5);
  f.clock.advance(500);
  f.commit([a, b]);
  f.clock.advance(500);
  assert.deepEqual(f.events, [{ kind: 'list_exposure', postId: a }]);
  f.commit([a, b]);
  f.ratio(a, 0.9);
  f.clock.advance(1000);
  assert.equal(f.events.length, 1);
  assert.equal(
    f.observations.filter((o) => o.selector === `#view-${a}`).length,
    1,
  );
  f.observer.dispose();
});
test('only current committed render attaches; stale setData and nextTick callbacks cannot observe', () => {
  const f = fixture();
  const old = f.observer.render([a]);
  const current = f.observer.render([b]);
  old();
  current();
  f.observer.render([])();
  while (f.ticks.length) f.ticks.shift()!();
  assert.equal(f.observations.length, 0);
  f.observer.dispose();
});
test('readiness starts still-visible intervals, hourly refresh never duplicates an already-qualified interval', () => {
  const f = fixture();
  f.setReady(false);
  f.commit([a]);
  f.ratio(a, 0.6);
  f.clock.advance(1000);
  assert.equal(f.events.length, 0);
  f.setReady(true);
  f.clock.advance(1000);
  assert.equal(f.events.length, 1);
  f.setReady(false);
  f.setReady(true);
  f.clock.advance(1000);
  assert.equal(f.events.length, 1);
  f.observer.dispose();
});
test('detail requires positive viewport intersection after commit, once per show even through refresh/comment pagination', () => {
  const f = fixture('detail_visit');
  const callback = f.observer.render([a]);
  assert.equal(f.events.length, 0);
  callback();
  while (f.ticks.length) f.ticks.shift()!();
  f.ratio(a, 0);
  assert.equal(f.events.length, 0);
  f.ratio(a, 0.001);
  assert.equal(f.events.length, 1);
  f.ratio(a, 1);
  assert.equal(f.events.length, 1);
  f.commit([]);
  f.commit([a]);
  assert.equal(f.events.length, 1);
  f.observer.dispose();
  const next = fixture('detail_visit');
  next.commit([a]);
  next.ratio(a, 0.001);
  assert.equal(next.events.length, 1);
  next.observer.dispose();
});
test('detail waiting for epoch qualifies only if still visible; owner switch and unavailable native observers never report', () => {
  const f = fixture('detail_visit');
  f.setReady(false);
  f.commit([a]);
  f.ratio(a, 0.01);
  f.setReady(true);
  assert.equal(f.events.length, 1);
  f.observer.dispose();
  const g = fixture();
  g.commit([a]);
  g.ratio(a, 0.5);
  g.sessions.logout();
  g.clock.advance(1000);
  assert.equal(g.events.length, 0);
  g.observer.dispose();
});
