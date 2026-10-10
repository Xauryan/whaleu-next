import assert from 'node:assert/strict';
import test from 'node:test';
import { RatingCoverViewport } from '../src/ratings/target-cover-viewport';
import type { WxIntersectionObserver } from '../src/platform/wechat';
import { targetId, otherId } from './ratings-helpers';
test('thumbnail admission follows committed viewport evidence and revokes offscreen or replaced nodes', () => {
  const events: [string, boolean][] = [],
    callbacks = new Map<
      string,
      (event: { intersectionRatio: number }) => void
    >();
  let observers = 0,
    disconnected = 0;
  const viewport = new RatingCoverViewport(
    {
      createIntersectionObserver() {
        observers++;
        const observer: WxIntersectionObserver = {
          relativeToViewport: () => observer,
          observe: (selector, callback) => {
            callbacks.set(selector, callback);
          },
          disconnect: () => {
            disconnected++;
          },
        };
        return observer;
      },
    },
    {},
    (id, visible) => events.push([id, visible]),
    () => assert.fail('observer should exist'),
  );
  const commit = viewport.render([targetId, otherId]);
  assert.equal(observers, 0);
  commit();
  assert.equal(observers, 2);
  assert.equal(events.length, 0);
  callbacks.get(`#rating-cover-row-${targetId}`)!({ intersectionRatio: 0.6 });
  callbacks.get(`#rating-cover-row-${targetId}`)!({ intersectionRatio: 0 });
  assert.deepEqual(events.slice(), [
    [targetId, true],
    [targetId, false],
  ]);
  viewport.render([otherId])();
  assert.equal(disconnected, 1);
  callbacks.get(`#rating-cover-row-${targetId}`)!({ intersectionRatio: 1 });
  assert.equal(
    events.filter(([id, visible]) => id === targetId && visible).length,
    1,
  );
  viewport.dispose();
  assert.equal(disconnected, 2);
});
