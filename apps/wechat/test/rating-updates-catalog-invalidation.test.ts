import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommunityRuntime } from '../src/community/runtime';
import { Cancellation } from '../src/platform/contracts';
import {
  RatingCatalogChanges,
  type RatingCatalogChange,
} from '../src/ratings/catalog-changes';
import {
  RatingUpdatesController,
  type RatingUpdatesView,
} from '../src/ratings/updates-controller';
import { setup } from './community-helpers';
import { deferred, flush } from './helpers';
import {
  cursor,
  nextRevision,
  otherId,
  targetId,
  timestamp,
} from './ratings-helpers';
import {
  FakeRatingUpdatesGateway,
  notice,
  noticeId,
  noticeTarget,
  readReceipt,
  updates,
} from './ratings-r2a-helpers';
import {
  FakeRatingLikeUpdatesGateway,
  likeNotice,
  likeNoticeTarget,
  likeUpdates,
} from './ratings-r2b-helpers';
import {
  FakeRatingSubscriptionUpdatesGateway,
  subscriptionNotice,
  subscriptionNoticeTarget,
  subscriptionUpdates,
} from './ratings-r2c-helpers';

type Category = RatingUpdatesView['category'];
type DeferredMethod = 'list' | 'target' | 'markRead';
class TrackedCatalogChanges extends RatingCatalogChanges {
  subscriptions = 0;
  callbacks = 0;
  override subscribe(listener: (change: RatingCatalogChange) => void) {
    this.subscriptions += 1;
    const unsubscribe = super.subscribe((change) => {
      this.callbacks += 1;
      listener(change);
    });
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.subscriptions -= 1;
      unsubscribe();
    };
  }
}

function gatewayControls<Page, Target>(
  gateway: {
    calls: Array<{ method: string; args: unknown[] }>;
    listImpl: (cursor: string | null, cancel: Cancellation) => Promise<Page>;
    targetImpl: (noticeId: string, cancel: Cancellation) => Promise<Target>;
    markReadImpl: (
      noticeId: string,
      cancel: Cancellation,
    ) => Promise<ReturnType<typeof readReceipt>>;
  },
  first: Page,
  next: Page,
  fresh: Page,
  target: Target,
) {
  gateway.listImpl = async (nextCursor) => (nextCursor ? next : first);
  return {
    calls: gateway.calls,
    useFreshPage: () => {
      gateway.listImpl = async () => fresh;
    },
    delay: (method: DeferredMethod) => {
      if (method === 'list') {
        const hold = deferred<Page>();
        let result = first;
        gateway.listImpl = (nextCursor) => {
          result = nextCursor ? next : first;
          return hold.promise;
        };
        return () => hold.resolve(result);
      }
      if (method === 'target') {
        const hold = deferred<Target>();
        gateway.targetImpl = () => hold.promise;
        return () => hold.resolve(target);
      }
      const hold = deferred<ReturnType<typeof readReceipt>>();
      gateway.markReadImpl = () => hold.promise;
      return () => hold.resolve(readReceipt());
    },
  };
}

function harness(category: Category) {
  const s = setup();
  const ratingUpdates = new FakeRatingUpdatesGateway();
  const ratingLikeUpdates = new FakeRatingLikeUpdatesGateway();
  const ratingSubscriptionUpdates = new FakeRatingSubscriptionUpdatesGateway();
  const changes = new TrackedCatalogChanges();
  const unavailable = {
    noticeId,
    createdAt: timestamp,
    readAt: timestamp,
    status: 'unavailable' as const,
  };
  const moreCursor = 'b'.repeat(43);
  const fresh = { items: [unavailable], unreadCount: 0, nextCursor: null };
  const controls =
    category === 'reply'
      ? gatewayControls(
          ratingUpdates,
          updates({ nextCursor: cursor }),
          updates({
            items: [notice({ noticeId: otherId })],
            nextCursor: moreCursor,
            unreadCount: 2,
          }),
          updates(fresh),
          noticeTarget(),
        )
      : category === 'like'
        ? gatewayControls(
            ratingLikeUpdates,
            likeUpdates({ nextCursor: cursor }),
            likeUpdates({
              items: [likeNotice({ noticeId: otherId })],
              nextCursor: moreCursor,
              unreadCount: 2,
            }),
            likeUpdates(fresh),
            likeNoticeTarget(),
          )
        : gatewayControls(
            ratingSubscriptionUpdates,
            subscriptionUpdates({ nextCursor: cursor }),
            subscriptionUpdates({
              items: [subscriptionNotice({ noticeId: otherId })],
              nextCursor: moreCursor,
              unreadCount: 2,
            }),
            subscriptionUpdates(fresh),
            subscriptionNoticeTarget(),
          );
  const runtime: CommunityRuntime = {
    ...s.runtime,
    ratingUpdates,
    ratingLikeUpdates,
    ratingSubscriptionUpdates,
    ratingCatalogChanges: changes,
  };
  const views: RatingUpdatesView[] = [];
  const navigation: string[] = [];
  const controller = new RatingUpdatesController(
    runtime,
    (view) => views.push(view),
    async (path) => {
      navigation.push(path);
    },
  );
  return {
    ...controls,
    controller,
    changes,
    views,
    navigation,
    unavailable,
    lastCall: () => controls.calls[controls.calls.length - 1],
    view: () => views[views.length - 1]!,
  };
}

function cleared(view: RatingUpdatesView, category: Category): void {
  assert.equal(view.loaded, false);
  assert.deepEqual(view.items, []);
  assert.equal(view.unreadCount, null);
  assert.equal(view.canMore, false);
  assert.equal(view.busy, false);
  assert.equal(view.category, category);
  assert.equal(view.hasSession, true);
  assert.equal(view.configured, true);
}

for (const category of ['reply', 'like', 'subscription'] as const) {
  for (const changedScope of [null, otherId])
    test(`${category} catalog publication ${changedScope} clears real loaded previews and paging without changing notice history`, async () => {
      const s = harness(category);
      await s.controller.selectCategory(category);
      assert.equal(s.view().loaded, true);
      assert.equal(s.view().category, category);
      const item = s.view().items[0];
      assert.ok(item && item.status === 'available');
      assert.equal(item.kind, category);
      assert.equal(item.target.targetId, targetId);
      assert.ok(item.preview.text.length > 0);
      assert.equal(s.view().unreadCount, 1);
      assert.equal(s.view().canMore, true);
      await s.controller.more();
      assert.deepEqual(
        s.view().items.map((entry) => entry.noticeId),
        [noticeId, otherId],
      );
      assert.equal(s.view().canMore, true);
      await s.controller.acknowledge(noticeId);
      assert.equal(s.view().items[0]?.readAt, timestamp);
      const callsBefore = s.calls.length;

      s.changes.publish({
        releaseId: nextRevision,
        catalogs: [{ regionId: changedScope, catalogRevision: nextRevision }],
      });

      cleared(s.view(), category);
      assert.match(s.view().status, /评分分类目录已变化/);
      await s.controller.more();
      await s.controller.open(noticeId);
      await s.controller.acknowledge(noticeId);
      assert.equal(s.calls.length, callsBefore);
      assert.deepEqual(s.navigation, []);

      s.useFreshPage();
      await s.controller.load();
      assert.equal(s.lastCall()?.method, 'list');
      assert.equal(s.lastCall()?.args[0], null);
      assert.equal(s.view().loaded, true);
      assert.equal(s.view().category, category);
      assert.deepEqual(s.view().items, [s.unavailable]);
      assert.equal(s.view().unreadCount, 0);
      assert.equal(s.view().canMore, false);
      assert.equal(
        s.calls.filter((call) => call.method === 'markRead').length,
        1,
      );
      s.controller.dispose();
    });

  for (const operation of ['initial', 'more', 'target', 'markRead'] as const)
    test(`${category} catalog publication cancels in-flight ${operation} and fences late callbacks from a fresh reload`, async () => {
      const s = harness(category);
      if (operation !== 'initial') {
        await s.controller.selectCategory(category);
        assert.equal(s.view().loaded, true);
        assert.equal(s.view().items.length, 1);
      }
      const method =
        operation === 'initial' || operation === 'more' ? 'list' : operation;
      const release = s.delay(method);
      const work =
        operation === 'initial'
          ? s.controller.selectCategory(category)
          : operation === 'more'
            ? s.controller.more()
            : operation === 'target'
              ? s.controller.open(noticeId)
              : s.controller.acknowledge(noticeId);
      await flush();
      assert.equal(s.view().busy, true);
      assert.equal(s.lastCall()?.method, method);
      assert.equal(
        s.lastCall()?.args[0],
        operation === 'initial'
          ? null
          : operation === 'more'
            ? cursor
            : noticeId,
      );
      const cancellation = s.lastCall()?.args[1];
      assert.ok(cancellation instanceof Cancellation);
      assert.equal(cancellation.isCancelled, false);

      s.changes.publish({
        releaseId: nextRevision,
        catalogs: [{ regionId: null, catalogRevision: nextRevision }],
      });

      assert.equal(cancellation.isCancelled, true);
      cleared(s.view(), category);
      await work;
      cleared(s.view(), category);
      s.useFreshPage();
      await s.controller.load();
      const current = s.view();
      assert.equal(current.loaded, true);
      assert.equal(current.category, category);
      assert.deepEqual(current.items, [s.unavailable]);
      const rendered = s.views.length;
      const calls = s.calls.length;
      release();
      await flush();

      assert.equal(s.views.length, rendered);
      assert.equal(s.view(), current);
      assert.equal(s.calls.length, calls);
      assert.deepEqual(s.navigation, []);
      assert.equal(
        s.calls.filter((call) => call.method === 'markRead').length,
        operation === 'markRead' ? 1 : 0,
      );
      s.controller.dispose();
    });

  test(`${category} disposal unsubscribes catalog publications and prevents late navigation or rendering`, async () => {
    const s = harness(category);
    await s.controller.selectCategory(category);
    assert.equal(s.view().loaded, true);
    assert.equal(s.changes.subscriptions, 1);
    const release = s.delay('target');
    const work = s.controller.open(noticeId);
    await flush();
    const cancellation = s.lastCall()?.args[1];
    assert.ok(cancellation instanceof Cancellation);
    assert.equal(cancellation.isCancelled, false);

    s.controller.dispose();

    assert.equal(cancellation.isCancelled, true);
    assert.equal(s.changes.subscriptions, 0);
    const rendered = s.views.length;
    const callbacks = s.changes.callbacks;
    const calls = s.calls.length;
    s.changes.publish({
      releaseId: nextRevision,
      catalogs: [{ regionId: null, catalogRevision: nextRevision }],
    });
    assert.equal(s.changes.callbacks, callbacks);
    release();
    await work;
    await flush();
    await s.controller.load();
    await s.controller.selectCategory(category);
    await s.controller.more();
    await s.controller.open(noticeId);
    await s.controller.acknowledge(noticeId);
    s.controller.dispose();
    assert.equal(s.changes.subscriptions, 0);
    assert.equal(s.views.length, rendered);
    assert.equal(s.calls.length, calls);
    assert.deepEqual(s.navigation, []);
  });
}
