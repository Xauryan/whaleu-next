import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RatingCatalogChanges,
  type RatingCatalogChange,
} from '../src/ratings/catalog-changes';
import { RatingController, type RatingView } from '../src/ratings/controller';
import {
  RatingThreadController,
  type RatingThreadView,
} from '../src/ratings/discussion-controller';
import {
  RatingRandomController,
  type RatingRandomView,
} from '../src/ratings/random-controller';
import {
  DirectoryReadController,
  type DirectoryView,
} from '../src/directory/controller';
import {
  RatingTargetOwnerEditingController,
  type RatingTargetOwnerEditingView,
} from '../src/ratings/target-owner-editing-controller';
import {
  RatingManagementController,
  type RatingManagementView,
} from '../src/ratings/management-controller';
import type { RatingRandomResult } from '../src/ratings/random-contract';
import type { RatingCategoryPage } from '../src/ratings/contract';
import { Cancellation } from '../src/platform/contracts';
import {
  categoryId,
  category,
  categoryPage,
  harness,
  nextRevision,
  otherId,
  revision,
  targetId,
} from './ratings-helpers';
import { editingHarness } from './rating-owner-editing-helpers';
import {
  FakeRatingDiscussionGateway,
  replyId,
  replyPage,
  route as threadRoute,
} from './ratings-r2a-helpers';
import { randomResult } from './rating-random-helpers';
import { directoryDetailRoute, directoryHarness } from './directory-helpers';
import { deferred, flush } from './helpers';
const publication = (): RatingCatalogChange => ({
  releaseId: nextRevision,
  catalogs: [{ regionId: null, catalogRevision: otherId }],
});

class TrackedCatalogChanges extends RatingCatalogChanges {
  count = 0;
  override subscribe(listener: (change: RatingCatalogChange) => void) {
    this.count++;
    const off = super.subscribe(listener);
    let active = true;
    return () => {
      if (active) {
        active = false;
        this.count--;
        off();
      }
    };
  }
}

test('catalog event clones minimal immutable release identity and isolates a broken subscriber', () => {
  const changes = new RatingCatalogChanges(),
    seen: RatingCatalogChange[] = [];
  changes.subscribe(() => {
    throw new Error('render failed');
  });
  const unsubscribe = changes.subscribe((event) => seen.push(event));
  const raw = { ...publication(), privateText: 'must not leak' };
  changes.publish(raw);
  assert.deepEqual(seen, [publication()]);
  assert.equal(Object.isFrozen(seen[0]), true);
  assert.equal(Object.isFrozen(seen[0]!.catalogs), true);
  assert.equal(Object.isFrozen(seen[0]!.catalogs[0]), true);
  unsubscribe();
  changes.publish(publication());
  assert.equal(seen.length, 1);
});

for (const mode of ['catalog', 'detail'] as const)
  test(`publication clears real loaded ${mode} projection and current action inputs until a fresh read`, async () => {
    const s = harness(),
      changes = new TrackedCatalogChanges(),
      views: RatingView[] = [];
    const controller = new RatingController(
      { ...s.runtime, ratingCatalogChanges: changes },
      mode,
      (view) => views.push(view),
    );
    await controller.load(mode === 'catalog' ? {} : { targetId });
    assert.equal(views[views.length - 1]!.loaded, true);
    if (mode === 'detail') {
      controller.openComposer();
      controller.setText('Private input');
      assert.equal(views[views.length - 1]!.text, 'Private input');
    } else assert.ok(views[views.length - 1]!.categories.length);
    const before = s.ratings.calls.length;
    changes.publish(publication());
    const view = views[views.length - 1]!;
    assert.equal(view.loaded, false);
    assert.equal(view.detail, null);
    assert.deepEqual(view.categories, []);
    assert.deepEqual(view.comments, []);
    assert.deepEqual(view.targets, []);
    assert.equal(view.text, '');
    assert.equal(view.myScoreKnown, false);
    assert.equal(view.summary, null);
    assert.deepEqual(view.subscriptions, {});
    assert.equal(view.needsRefresh, true);
    assert.equal(view.busy, false);
    assert.equal(controller.categoryPath(categoryId), null);
    assert.equal(controller.targetPath(targetId), null);
    assert.equal(controller.randomPath(categoryId), null);
    assert.equal(controller.discussionPath(otherId), null);
    await controller.more('categories');
    await controller.confirmScore();
    await controller.publish();
    assert.equal(s.ratings.calls.length, before);
    await controller.reload();
    assert.equal(views[views.length - 1]!.loaded, true);
    controller.dispose();
    assert.equal(changes.count, 0);
    const rendered = views.length;
    changes.publish(publication());
    assert.equal(views.length, rendered);
  });

test('publication cancels an old catalog read and never overwrites a fresh revision or cursor with a late callback', async () => {
  const s = harness(),
    changes = new RatingCatalogChanges(),
    views: RatingView[] = [],
    response = deferred<RatingCategoryPage>();
  let cancellation: Cancellation | undefined;
  s.ratings.categoriesImpl = async (_region, _parent, _cursor, cancel) => {
    cancellation = cancel;
    return response.promise;
  };
  const controller = new RatingController(
    { ...s.runtime, ratingCatalogChanges: changes },
    'catalog',
    (view) => views.push(view),
  );
  const old = controller.load({});
  await flush();
  assert.equal(views[views.length - 1]!.busy, true);
  changes.publish(publication());
  assert.equal(cancellation?.isCancelled, true);
  await old;
  s.ratings.categoriesImpl = async () =>
    categoryPage({
      items: [
        category({ name: 'Fresh current category', revision: nextRevision }),
      ],
    });
  await controller.reload();
  assert.equal(
    views[views.length - 1]!.categories[0]!.name,
    'Fresh current category',
  );
  const current = views[views.length - 1],
    rendered = views.length;
  response.resolve(categoryPage());
  await flush();
  assert.equal(views[views.length - 1], current);
  assert.equal(views.length, rendered);
  controller.dispose();
});

for (const inFlight of [false, true])
  test(`publication clears ${inFlight ? 'in-flight' : 'loaded'} thread body, aliases, quote and draft`, async () => {
    const s = harness(),
      changes = new RatingCatalogChanges(),
      discussion = new FakeRatingDiscussionGateway();
    const response = deferred<ReturnType<typeof replyPage>>(),
      views: RatingThreadView[] = [];
    if (inFlight) discussion.repliesImpl = async () => response.promise;
    const controller = new RatingThreadController(
      {
        ...s.runtime,
        ratingDiscussion: discussion,
        ratingCatalogChanges: changes,
      },
      (view) => views.push(view),
    );
    const old = controller.load(threadRoute);
    if (inFlight) await flush();
    else {
      await old;
      assert.ok(views[views.length - 1]!.discussion);
      controller.compose(replyId);
      controller.setText('Private reply');
      assert.ok(views[views.length - 1]!.replyToName);
    }
    changes.publish(publication());
    response.resolve(replyPage());
    await old;
    const view = views[views.length - 1]!;
    assert.equal(view.loaded, false);
    assert.equal(view.detail, null);
    assert.equal(view.discussion, null);
    assert.deepEqual(view.replies, []);
    assert.equal(view.replyToName, '');
    assert.equal(view.text, '');
    assert.equal(view.canMore, false);
    assert.equal(view.busy, false);
    assert.equal(view.needsRefresh, true);
    controller.dispose();
  });

for (const inFlight of [false, true])
  test(`publication clears ${inFlight ? 'in-flight' : 'loaded'} whole-pool random result without starting another draw`, async () => {
    const s = harness(),
      changes = new TrackedCatalogChanges(),
      response = deferred<RatingRandomResult>(),
      views: RatingRandomView[] = [];
    let cancellation: Cancellation | undefined,
      draws = 0;
    const controller = new RatingRandomController(
      {
        ...s.runtime,
        ratingCatalogChanges: changes,
        ratingRandom: {
          draw: async (_query, cancel) => {
            draws++;
            cancellation = cancel;
            return inFlight ? response.promise : randomResult();
          },
        },
      },
      (view) => views.push(view),
    );
    controller.load({ categoryId });
    const work = controller.draw();
    if (inFlight) await flush();
    else {
      await work;
      assert.ok(controller.targetPath());
      assert.equal(views[views.length - 1]!.loaded, true);
    }
    changes.publish(publication());
    assert.equal(cancellation?.isCancelled, inFlight);
    response.resolve(randomResult());
    await work;
    assert.equal(views[views.length - 1]!.loaded, false);
    assert.equal(views[views.length - 1]!.result, null);
    assert.equal(views[views.length - 1]!.busy, false);
    assert.equal(controller.targetPath(), null);
    assert.equal(draws, 1);
    controller.dispose();
    assert.equal(changes.count, 0);
  });

for (const inFlight of [false, true])
  test(`publication clears ${inFlight ? 'in-flight' : 'loaded'} directory details, contacts and pagination`, async () => {
    const s = directoryHarness('detail'),
      changes = new TrackedCatalogChanges(),
      views: DirectoryView[] = [];
    const originalDetail = s.behavior.detail,
      response = deferred<Awaited<ReturnType<typeof originalDetail>>>();
    if (inFlight) s.behavior.detail = async () => response.promise;
    const controller = new DirectoryReadController(
      { ...s.runtime, ratingCatalogChanges: changes },
      'detail',
      (view) => views.push(view),
    );
    const work = controller.load(directoryDetailRoute);
    if (inFlight) await flush();
    else {
      await work;
      assert.equal(views[views.length - 1]!.loaded, true);
      assert.ok(views[views.length - 1]!.detail);
    }
    const before = s.calls.length;
    changes.publish(publication());
    response.resolve(
      await originalDetail(
        directoryDetailRoute.regionId,
        directoryDetailRoute.entryId,
        new Cancellation(),
      ),
    );
    await work;
    const view = views[views.length - 1]!;
    assert.equal(view.loaded, false);
    assert.equal(view.detail, null);
    assert.equal(view.canCopy, false);
    assert.deepEqual(view.entries, []);
    assert.equal(view.canNext, false);
    assert.equal(view.canPrevious, false);
    assert.equal(view.restartRequired, true);
    assert.equal(view.busy, false);
    assert.equal(s.calls.length, before);
    controller.dispose();
    assert.equal(changes.count, 0);
  });

test('publication clears existing creator edit confirmation and prevents a late UUID from making a new request', async () => {
  const s = editingHarness(),
    changes = new RatingCatalogChanges(),
    views: RatingTargetOwnerEditingView[] = [],
    id = deferred<string>();
  s.ids.next = () => id.promise;
  const controller = new RatingTargetOwnerEditingController(
    { ...s.runtime, ratingCatalogChanges: changes },
    (view) => views.push(view),
  );
  await controller.load({ targetId });
  controller.setName('Edit draft');
  controller.requestEdit();
  const work = controller.confirmEdit();
  await flush();
  changes.publish(publication());
  id.resolve(otherId);
  await work;
  assert.equal(s.pendingRatings.load(s.accountId), null);
  assert.equal(views[views.length - 1]!.name, '');
  assert.equal(views[views.length - 1]!.ready, false);
  assert.equal(views[views.length - 1]!.editConfirmation, false);
  assert.deepEqual(s.calls, ['context']);
  controller.dispose();
});

test('publication clears M1 target creation context without replacing an unresolved shared journal', async () => {
  const s = harness(),
    changes = new RatingCatalogChanges(),
    views: RatingManagementView[] = [];
  const controller = new RatingManagementController(
    {
      ...s.runtime,
      ratingCatalogChanges: changes,
      ratingManagement: {
        prepare: async () => {
          throw new Error('must not prepare');
        },
        command: async () => {
          throw new Error('must not send');
        },
        cancel: async () => {
          throw new Error('must not cancel');
        },
        receipt: async () => {
          throw new Error('must not look up');
        },
      },
    },
    (view) => views.push(view),
  );
  await controller.load({
    regionId: null,
    categoryId,
    expectedCategoryRevision: revision,
    expectedCatalogRevision: revision,
  });
  assert.equal(views[views.length - 1]!.ready, true);
  controller.setName('Unpublished target draft');
  changes.publish(publication());
  assert.equal(views[views.length - 1]!.ready, false);
  assert.equal(views[views.length - 1]!.name, '');
  assert.equal(views[views.length - 1]!.needsRefresh, true);
  await controller.create();
  assert.equal(s.ids.count, 0);
  assert.equal(s.pendingRatings.load(s.accountId), null);
  controller.dispose();
});
