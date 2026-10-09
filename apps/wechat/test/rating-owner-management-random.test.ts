import assert from 'node:assert/strict';
import test from 'node:test';
import type { Cancellation } from '../src/platform/contracts';
import {
  RatingRandomController,
  type RatingRandomView,
} from '../src/ratings/random-controller';
import type { RatingRandomResult } from '../src/ratings/random-contract';
import {
  ownerHarness,
  ownerIntent,
  ownerReceipt,
} from './rating-owner-management-helpers';
import { randomResult } from './rating-random-helpers';
import { categoryId, otherId, targetId } from './ratings-helpers';
import { deferred, flush } from './helpers';

for (const recovered of [false, true])
  for (const inFlight of [false, true])
    test(`${recovered ? 'recovered' : 'confirmed'} owner deletion clears ${inFlight ? 'in-flight' : 'loaded'} random results and prevents stale target navigation`, async () => {
      const owner = ownerHarness(),
        result = deferred<RatingRandomResult>(),
        views: RatingRandomView[] = [];
      let drawCancellation: Cancellation | undefined;
      const random = new RatingRandomController(
        {
          ...owner.runtime,
          ratingRandom: {
            draw: async (_query, cancel) => {
              drawCancellation = cancel;
              return inFlight ? result.promise : randomResult();
            },
          },
        },
        (view) => views.push(view),
      );
      random.load({ categoryId });
      const reading = random.draw();
      if (inFlight) await flush();
      else {
        await reading;
        assert.equal(views[views.length - 1]!.loaded, true);
        assert.ok(random.targetPath());
      }
      if (recovered) {
        owner.pendingRatings.freeze({
          version: 6,
          accountId: owner.accountId,
          intent: ownerIntent(),
        });
        owner.gateway.receipt = async () => ownerReceipt();
        await owner.controller.load(null);
      } else {
        await owner.controller.load({ targetId });
        owner.controller.requestDelete();
        await owner.controller.confirmDelete();
      }
      assert.equal(drawCancellation?.isCancelled, inFlight);
      result.resolve(randomResult());
      await reading;
      const view = views[views.length - 1]!;
      assert.equal(view.loaded, false);
      assert.equal(view.result, null);
      assert.equal(view.busy, false);
      assert.equal(view.categoryId, categoryId);
      assert.equal(random.targetPath(), null);
      assert.match(view.status, /重新抽取/);
      random.dispose();
      owner.controller.dispose();
    });

test('any deletion invalidates the complete-pool snapshot; random dispose unsubscribes once', async () => {
  const owner = ownerHarness(),
    views: RatingRandomView[] = [];
  const changes = owner.runtime.ratingTargetChanges!;
  const original = changes.subscribe.bind(changes);
  let unsubscribed = 0;
  changes.subscribe = (listener: Parameters<typeof original>[0]) => {
    const dispose = original(listener);
    return () => {
      unsubscribed++;
      dispose();
    };
  };
  const random = new RatingRandomController(
    { ...owner.runtime, ratingRandom: { draw: async () => randomResult() } },
    (view) => views.push(view),
  );
  random.load({ categoryId });
  await random.draw();
  changes.publish({ targetId: otherId, revision: otherId });
  assert.equal(views[views.length - 1]!.result, null);
  assert.equal(views[views.length - 1]!.loaded, false);
  assert.equal(random.targetPath(), null);
  random.dispose();
  random.dispose();
  assert.equal(unsubscribed, 1);
  const count = views.length;
  changes.publish({ targetId, revision: otherId });
  assert.equal(views.length, count);
  owner.controller.dispose();
});
