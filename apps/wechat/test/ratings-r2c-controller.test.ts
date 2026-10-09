import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { Cancellation } from '../src/platform/contracts';
import {
  readRatingSubscriptionState,
  readRatingSubscriptionStates,
} from '../src/ratings/subscription-controller';
import { runRatingCommand } from '../src/ratings/commands';
import type {
  RatingSubscriptionBatch,
  RatingSubscriptionReceipt,
  RatingSubscriptionState,
} from '../src/ratings/subscription-contract';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  categoryId,
  commentId,
  cursor,
  intent,
  otherId,
  receipt,
  regionId,
  revision,
  requestId,
  target,
  targetId,
  targetPage,
} from './ratings-helpers';
import {
  noticeId,
  readReceipt,
  replyId,
  replyIntent,
  replyReceipt,
  route,
} from './ratings-r2a-helpers';
import { likeIntent, likeReceipt } from './ratings-r2b-helpers';
import {
  FakeRatingSubscriptionsGateway,
  r2cHarness,
  subscriptionBatch,
  subscriptionIntent,
  subscriptionLocator,
  subscriptionNotice,
  subscriptionNoticeTarget,
  subscriptionReceipt,
  subscriptionRevision,
  subscriptionState,
  subscriptionUpdates,
} from './ratings-r2c-helpers';
const timeout = () =>
  new ClientError('timeout', 'Synthetic response lost after commit');
const unavailable = () =>
  new ClientError('http', 'Synthetic inaccessible', {
    httpStatus: 404,
    serverCode: 'RATING_NOT_FOUND',
  });
const rows = (size: number) =>
  Array.from({ length: size }, (_, n) => ({
    targetId: `${String(n).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    expectedTargetRevision: revision,
  }));

test('R2C 50 directory cards dispatch exactly three ≤20 single-scope batches with one inflight', async () => {
  const gateway = new FakeRatingSubscriptionsGateway(),
    cancel = new Cancellation(),
    hold = deferred<void>(),
    targets = rows(50);
  let active = 0,
    peak = 0;
  gateway.statesImpl = async (scope, batch) => {
    assert.equal(scope, regionId);
    active++;
    peak = Math.max(peak, active);
    await hold.promise;
    active--;
    return subscriptionBatch(batch.map((t) => t.targetId));
  };
  const run = readRatingSubscriptionStates(gateway, regionId, targets, cancel);
  await flush();
  assert.equal(gateway.calls.length, 1);
  hold.resolve();
  const states = await run;
  assert.equal(Object.keys(states).length, 50);
  assert.equal(peak, 1);
  assert.deepEqual(
    gateway.calls.map((c) => (c.args[1] as unknown[]).length),
    [20, 20, 10],
  );
  assert.equal(gateway.calls.filter((c) => c.method === 'state').length, 0);
  await assert.rejects(
    readRatingSubscriptionStates(gateway, null, rows(51), cancel),
  );
  await assert.rejects(
    readRatingSubscriptionStates(
      gateway,
      null,
      [targets[0]!, targets[0]!],
      cancel,
    ),
  );
  assert.deepEqual(
    await readRatingSubscriptionStates(gateway, null, [], cancel),
    {},
  );
});
for (const length of [1, 50])
  test(`R2C cancelling ${length}-card batch fences late result and prevents all remaining dispatch`, async () => {
    const gateway = new FakeRatingSubscriptionsGateway(),
      cancel = new Cancellation(),
      hold = deferred<RatingSubscriptionBatch>();
    gateway.statesImpl = async () => hold.promise;
    const run = readRatingSubscriptionStates(
      gateway,
      null,
      rows(length),
      cancel,
    );
    await flush();
    assert.equal(gateway.calls.length, 1);
    cancel.cancel();
    hold.resolve(
      subscriptionBatch(rows(Math.min(length, 20)).map((t) => t.targetId)),
    );
    await assert.rejects(run, { kind: 'cancelled' });
    assert.equal(gateway.calls.length, 1);
  });
test('R2C per-item unknown and failed whole batch preserve no false/zero or stale state while later batch may succeed', async () => {
  const gateway = new FakeRatingSubscriptionsGateway(),
    cancel = new Cancellation(),
    targets = rows(50);
  let index = 0;
  gateway.statesImpl = async (_scope, batch) => {
    index++;
    if (index === 2) throw timeout();
    return {
      items: batch.map((t, n) => ({
        targetId: t.targetId,
        state:
          index === 1 && n === 0
            ? { status: 'unavailable' }
            : subscriptionState({
                targetId: t.targetId,
                count: 8,
                subscribed: true,
              }),
      })),
    };
  };
  const result = await readRatingSubscriptionStates(
    gateway,
    null,
    targets,
    cancel,
  );
  assert.deepEqual(result[targets[0]!.targetId], { status: 'unavailable' });
  for (const t of targets.slice(20, 40))
    assert.deepEqual(result[t.targetId], { status: 'unavailable' });
  assert.equal(result[targets[49]!.targetId]?.status, 'known');
  assert.equal(gateway.calls.length, 3);
  assert.deepEqual(
    await readRatingSubscriptionStates(
      undefined,
      null,
      [{ targetId, expectedTargetRevision: revision }],
      cancel,
    ),
    { [targetId]: { status: 'unavailable' } },
  );
  gateway.statesImpl = async () => subscriptionBatch([otherId]);
  await assert.rejects(
    readRatingSubscriptionStates(
      gateway,
      null,
      [{ targetId, expectedTargetRevision: revision }],
      cancel,
    ),
    { kind: 'protocol' },
  );
});
test('R2C detail has one independent current GET; independent interaction denial cannot poison readable target/comment content', async () => {
  for (const kind of [
    'http',
    'network',
    'timeout',
    'configuration',
    'phone-verification-required',
  ] as const) {
    const s = r2cHarness();
    s.ratingSubscriptions.stateImpl = async () => {
      throw new ClientError(kind, 'Synthetic unavailable');
    };
    await s.detailController.load({ targetId });
    assert.equal(s.detailView().loaded, true);
    assert.ok(s.detailView().detail);
    assert.ok(s.detailView().comments.length);
    assert.deepEqual(s.detailView().subscriptions[targetId], {
      status: 'unavailable',
    });
    await s.detailController.toggleSubscription();
    assert.equal(s.ids.count, 0);
    assert.equal(s.ratingSubscriptions.commands.length, 0);
    assert.deepEqual(
      s.ratingSubscriptions.calls.map((c) => c.method),
      ['state'],
    );
  }
  const gateway = new FakeRatingSubscriptionsGateway(),
    cancel = new Cancellation();
  assert.deepEqual(
    await readRatingSubscriptionState(undefined, null, targetId, cancel),
    { status: 'unavailable' },
  );
  gateway.stateImpl = async () => subscriptionState({ targetId: otherId });
  await assert.rejects(
    readRatingSubscriptionState(gateway, null, targetId, cancel),
    { kind: 'protocol' },
  );
});
test('R2C catalog states attach to visible card revision, refresh after command, and never GET each target', async () => {
  const s = r2cHarness();
  s.ratings.targetsImpl = async () =>
    targetPage({ items: rows(50).map((t) => target({ id: t.targetId })) });
  await s.directoryController.load({ parentId: categoryId });
  assert.equal(s.directoryView().loaded, true);
  assert.equal(s.directoryView().targets.length, 50);
  assert.deepEqual(
    s.ratingSubscriptions.calls.map((c) => [
      c.method,
      (c.args[1] as unknown[]).length,
    ]),
    [
      ['states', 20],
      ['states', 20],
      ['states', 10],
    ],
  );
  assert.deepEqual(s.ratingSubscriptions.calls[0]!.args[1], rows(20));
  const first = rows(50)[0]!.targetId;
  s.ratingSubscriptions.commandImpl = async (command) => {
    s.ratingSubscriptions.statesImpl = async (_scope, batch) => ({
      items: batch.map((t) => ({
        targetId: t.targetId,
        state: subscriptionState({
          targetId: t.targetId,
          subscribed: true,
          count: 7,
        }),
      })),
    });
    return subscriptionReceipt(command);
  };
  await s.directoryController.toggleSubscription(first);
  assert.equal(s.ratingSubscriptions.commands[0]?.targetId, first);
  assert.equal(
    s.ratingSubscriptions.commands[0]?.payload.expectedTargetRevision,
    revision,
    requestId,
  );
  assert.equal(s.directoryView().subscriptions[first]?.status, 'known');
  assert.equal(
    (
      s.directoryView().subscriptions[first] as Extract<
        RatingSubscriptionState,
        { status: 'known' }
      >
    ).count,
    7,
  );
  assert.equal(s.storage.data.size, 0);
});
test('R2C applied receipt is historical only: current GET decides membership/count and no XP arrival is claimed', async () => {
  const s = r2cHarness();
  await s.detailController.load({ targetId });
  s.ratingSubscriptions.commandImpl = async (command) => {
    assert.deepEqual(s.pendingRatings.load(s.accountId)?.intent, command);
    s.ratingSubscriptions.stateImpl = async () =>
      subscriptionState({ subscribed: false, count: 11, revision: otherId });
    return subscriptionReceipt(command);
  };
  await s.detailController.toggleSubscription();
  assert.deepEqual(s.ratingSubscriptions.commands, [subscriptionIntent()]);
  assert.deepEqual(
    s.detailView().subscriptions[targetId],
    subscriptionState({ subscribed: false, count: 11, revision: otherId }),
  );
  assert.equal(s.storage.data.size, 0);
  assert.doesNotMatch(s.detailView().receiptStatus, /经验.*到账|送达/);
});
test('R2C desired unsubscribe uses current membership; off-page, unknown and duplicate clicks mint no replacement', async () => {
  const s = r2cHarness();
  s.ratingSubscriptions.stateImpl = async () =>
    subscriptionState({ subscribed: true, count: 9 });
  await s.detailController.load({ targetId });
  await s.detailController.toggleSubscription(otherId);
  assert.equal(s.ids.count, 0);
  const held = deferred<RatingSubscriptionReceipt>();
  s.ratingSubscriptions.commandImpl = async () => held.promise;
  const run = s.detailController.toggleSubscription();
  void s.detailController.toggleSubscription();
  await flush();
  assert.equal(s.ratingSubscriptions.commands.length, 1);
  assert.equal(s.ids.count, 1);
  assert.equal(s.ratingSubscriptions.commands[0]!.payload.subscribed, false);
  assert.equal(
    s.ratingSubscriptions.commands[0]!.payload.expectedSubscriptionRevision,
    subscriptionRevision,
  );
  held.resolve(subscriptionReceipt(subscriptionIntent(false)));
  await run;
});
test('R2C response-loss recovery uses original key/CAS, queries before retry, then independently refreshes current state', async () => {
  const s = r2cHarness();
  await s.detailController.load({ targetId });
  s.ratingSubscriptions.commandImpl = async () => {
    throw timeout();
  };
  await s.detailController.toggleSubscription();
  const original = s.pendingRatings.load(s.accountId)!;
  assert.equal(original.version, 3);
  await s.detailController.recover();
  assert.deepEqual(s.pendingRatings.load(s.accountId), original);
  assert.equal(s.ratingSubscriptions.commands.length, 1);
  s.ratingSubscriptions.commandImpl = async (command) =>
    subscriptionReceipt(command, { subscribed: false });
  await s.detailController.recover(true);
  assert.deepEqual(s.ratingSubscriptions.commands[1], original.intent);
  assert.deepEqual(s.pendingRatings.load(s.accountId), original);
  assert.equal(s.ids.count, 1);
  s.ratingSubscriptions.receiptImpl = async () => subscriptionReceipt();
  s.ratingSubscriptions.stateImpl = async () =>
    subscriptionState({ count: 0, subscribed: false, revision: otherId });
  await s.detailController.recover();
  assert.equal(s.storage.data.size, 0);
  assert.equal(s.ratingSubscriptions.commands.length, 2);
  assert.deepEqual(
    s.detailView().subscriptions[targetId],
    subscriptionState({ count: 0, subscribed: false, revision: otherId }),
  );
});
test('R2C legacy v1/v2 pending prevents subscription before mint; v3 pending prevents score, reply and like', async () => {
  for (const old of [intent(), replyIntent(), likeIntent()]) {
    const s = r2cHarness();
    await s.detailController.load({ targetId });
    s.pendingRatings.freeze(
      old.operation === 'set_score'
        ? {
            version: 1,
            accountId: s.accountId,
            intent: old,
          }
        : {
            version: 2,
            accountId: s.accountId,
            intent: old,
          },
    );
    await s.detailController.toggleSubscription();
    assert.equal(s.ids.count, 0);
    assert.equal(s.ratingSubscriptions.commands.length, 0);
  }
  const s = r2cHarness();
  await s.detailController.load({ targetId });
  await s.controller.load(route);
  s.pendingRatings.freeze({
    version: 3,
    accountId: s.accountId,
    intent: subscriptionIntent(),
  });
  s.detailController.chooseScore(5);
  await s.detailController.confirmScore();
  await s.detailController.toggleLike(commentId);
  s.controller.compose();
  s.controller.setText('Synthetic reply');
  s.controller.setAuthorMode('anonymous');
  await s.controller.publish();
  await s.controller.toggleLike(replyId);
  assert.equal(s.ids.count, 0);
  assert.equal(
    s.ratings.commands.length +
      s.ratingDiscussion.commands.length +
      s.ratingLikes.commands.length,
    0,
  );
});
test('R2C command coordinator dispatches v3 only through subscription gateway without changing original gateway routes', async () => {
  for (const command of [
    intent(),
    replyIntent(),
    likeIntent(),
    subscriptionIntent(),
  ]) {
    const s = r2cHarness();
    const pending = s.pendingRatings.freeze(
      command.operation === 'set_target_subscription'
        ? { version: 3, accountId: s.accountId, intent: command }
        : { version: 2, accountId: s.accountId, intent: command },
    );
    s.ratings.receiptImpl = async () => receipt();
    s.ratingDiscussion.receiptImpl = async () => replyReceipt();
    s.ratingLikes.receiptImpl = async () => likeReceipt();
    s.ratingSubscriptions.receiptImpl = async () => subscriptionReceipt();
    await runRatingCommand(s.runtime, pending, new Cancellation(), false);
    await runRatingCommand(s.runtime, pending, new Cancellation(), true);
    const expected =
      command.operation === 'set_target_subscription'
        ? s.ratingSubscriptions
        : command.operation === 'set_comment_like'
          ? s.ratingLikes
          : command.operation === 'create_reply'
            ? s.ratingDiscussion
            : s.ratings;
    assert.deepEqual(
      expected.calls.map((c) => c.method),
      ['receipt', 'command'],
    );
  }
});
for (const boundary of [
  'cancel',
  'dispose',
  'logout',
  'account',
  'epoch',
  'hide',
  'safety',
  'scope',
] as const)
  test(`R2C ${boundary} clears current state and fences late receipt without releasing original owner journal`, async () => {
    const s = r2cHarness(),
      hold = deferred<RatingSubscriptionReceipt>();
    await s.detailController.load({ targetId });
    s.ratingSubscriptions.commandImpl = async () => hold.promise;
    const run = s.detailController.toggleSubscription();
    await flush();
    const original = s.pendingRatings.load(s.accountId)!;
    assert.ok(original);
    if (boundary === 'cancel') s.detailController.cancel();
    else if (boundary === 'dispose') s.detailController.dispose();
    else if (boundary === 'logout') s.sessions.logout();
    else if (boundary === 'account' || boundary === 'epoch')
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials(),
        accountId: boundary === 'account' ? otherId : s.accountId,
      });
    else if (boundary === 'hide') s.runtime.privateViews?.clear();
    else if (boundary === 'safety') s.safetyChanges.invalidate(s.accountId);
    else s.browsingScopeChanges.clear(s.accountId);
    hold.resolve(subscriptionReceipt());
    await run;
    assert.equal(s.detailView().loaded, false);
    assert.equal(s.detailView().detail, null);
    assert.deepEqual(s.detailView().subscriptions, {});
    assert.deepEqual(s.pendingRatings.load(s.accountId), original);
  });
test('R2C new route or region cancels old 50-card supplement before queued batches can dispatch', async () => {
  for (const boundary of ['route', 'region'] as const) {
    const s = r2cHarness(),
      hold = deferred<RatingSubscriptionBatch>();
    s.ratings.targetsImpl = async () =>
      targetPage({ items: rows(50).map((t) => target({ id: t.targetId })) });
    s.ratingSubscriptions.statesImpl = async () => hold.promise;
    const run = s.directoryController.load({ parentId: categoryId });
    await flush();
    assert.equal(s.ratingSubscriptions.calls.length, 1);
    if (boundary === 'route') await s.directoryController.load({});
    else await s.directoryController.selectRegion(null);
    hold.resolve(subscriptionBatch(rows(20).map((t) => t.targetId)));
    await run;
    assert.equal(s.ratingSubscriptions.calls.length, 1);
    assert.deepEqual(s.directoryView().subscriptions, {});
    assert.equal(s.directoryView().loaded, true);
  }
});
test('R2C failed refresh clears old known batch instead of retaining stale count or replacing readable cards', async () => {
  const s = r2cHarness();
  await s.directoryController.load({ parentId: categoryId });
  assert.equal(s.directoryView().subscriptions[targetId]?.status, 'known');
  s.ratingSubscriptions.statesImpl = async () => {
    throw timeout();
  };
  await s.directoryController.reload();
  assert.equal(s.directoryView().loaded, true);
  assert.equal(s.directoryView().targets.length, 1);
  assert.deepEqual(s.directoryView().subscriptions[targetId], {
    status: 'unavailable',
  });
});
test('R2C catalog continuation supplements only newly returned visible page and preserves current card states', async () => {
  const s = r2cHarness();
  s.ratings.targetsImpl = async (scope, parent, after) =>
    targetPage({
      context: {
        regionId: scope,
        categoryId: parent,
        catalogRevision: revision,
      },
      items: [target({ id: after ? otherId : targetId })],
      nextCursor: after ? null : cursor,
      continuation: after ? 'end' : 'more',
    });
  await s.directoryController.load({ parentId: categoryId });
  await s.directoryController.more('targets');
  assert.deepEqual(
    s.directoryView().targets.map((t) => t.id),
    [targetId, otherId],
  );
  assert.deepEqual(
    s.ratingSubscriptions.calls.map((c) =>
      (c.args[1] as { targetId: string }[]).map((t) => t.targetId),
    ),
    [[targetId], [otherId]],
  );
  assert.equal(s.directoryView().subscriptions[targetId]?.status, 'known');
  assert.equal(s.directoryView().subscriptions[otherId]?.status, 'known');
});
test('R2C subscription list category owns separate cursor/count/target/read and opening never marks on source page', async () => {
  const s = r2cHarness();
  await s.updatesController.load();
  assert.equal(s.updateView().category, 'reply');
  await s.updatesController.selectCategory('subscription');
  assert.equal(s.updateView().category, 'subscription');
  assert.equal(s.updateView().unreadCount, 1);
  await s.updatesController.open(noticeId);
  assert.match(
    s.navigation[0]!,
    new RegExp(`subscriptionNoticeId=${noticeId}`),
  );
  assert.doesNotMatch(s.navigation[0]!, /[?&](noticeId|likeNoticeId|replyId)=/);
  assert.equal(
    s.ratingSubscriptionUpdates.calls.filter((c) => c.method === 'markRead')
      .length,
    0,
  );
  await s.updatesController.acknowledge(noticeId);
  assert.equal(s.updateView().unreadCount, 0);
  assert.equal(s.updateView().items[0]?.readAt, readReceipt().readAt);
  assert.equal(
    s.ratingUpdates.calls.filter((c) => c.method === 'markRead').length,
    0,
  );
  assert.equal(s.ratingLikeUpdates.calls.length, 0);
});
for (const anchored of [false, true])
  test(`R2C subscription ${anchored ? 'reply' : 'root'} notice reads only after exact current content has loaded`, async () => {
    const s = r2cHarness();
    s.ratingSubscriptionUpdates.targetImpl = async () =>
      subscriptionNoticeTarget({
        target: subscriptionLocator({ replyId: anchored ? replyId : null }),
      });
    s.ratingSubscriptionUpdates.markReadImpl = async () => {
      assert.equal(s.view().loaded, true);
      if (anchored) assert.equal(s.view().anchorReplyId, replyId);
      return readReceipt();
    };
    await s.controller.load({
      ...route,
      ...(anchored ? { replyId } : {}),
      subscriptionNoticeId: noticeId,
    });
    assert.equal(s.view().loaded, true);
    assert.deepEqual(
      s.ratingSubscriptionUpdates.calls.map((c) => c.method),
      ['target', 'markRead'],
    );
    assert.equal(s.ratingUpdates.calls.length, 0);
    assert.equal(s.ratingLikeUpdates.calls.length, 0);
    assert.ok(
      s.ratingDiscussion.calls.some(
        (c) => c.method === (anchored ? 'position' : 'replies'),
      ),
    );
  });
for (const failure of ['unavailable', 'mismatch', 'position'] as const)
  test(`R2C ${failure} subscription locator stays unread but supports explicit unread-list acknowledgement`, async () => {
    const s = r2cHarness();
    s.ratingSubscriptionUpdates.targetImpl = async () =>
      failure === 'unavailable'
        ? { noticeId, status: 'unavailable' }
        : subscriptionNoticeTarget({
            target: subscriptionLocator({
              replyId,
              ...(failure === 'mismatch' ? { rootId: otherId } : {}),
            }),
          });
    if (failure === 'position')
      s.ratingDiscussion.positionImpl = async () => {
        throw unavailable();
      };
    await s.controller.load({
      ...route,
      replyId,
      subscriptionNoticeId: noticeId,
    });
    assert.equal(s.view().loaded, false);
    assert.equal(
      s.ratingSubscriptionUpdates.calls.filter((c) => c.method === 'markRead')
        .length,
      0,
    );
    s.ratingSubscriptionUpdates.listImpl = async () =>
      subscriptionUpdates({
        items: [
          {
            noticeId,
            status: 'unavailable',
            createdAt: subscriptionNotice().createdAt,
            readAt: null,
          },
        ],
      });
    await s.updatesController.selectCategory('subscription');
    await s.updatesController.acknowledge(noticeId);
    assert.equal(s.updateView().unreadCount, 0);
  });
test('R2C changing to direct or like cancels a late subscription list/locator without cursor or read contamination', async () => {
  const s = r2cHarness(),
    hold = deferred<ReturnType<typeof subscriptionUpdates>>();
  s.ratingSubscriptionUpdates.listImpl = async () => hold.promise;
  const run = s.updatesController.selectCategory('subscription');
  await flush();
  await s.updatesController.selectCategory('like');
  hold.resolve(subscriptionUpdates({ nextCursor: cursor }));
  await run;
  assert.equal(s.updateView().category, 'like');
  const currentItem = s.updateView().items[0];
  assert.equal(currentItem?.status === 'available' && currentItem.kind, 'like');
  s.ratingSubscriptionUpdates.listImpl = async () => subscriptionUpdates();
  await s.updatesController.selectCategory('subscription');
  const locator = deferred<ReturnType<typeof subscriptionNoticeTarget>>();
  s.ratingSubscriptionUpdates.targetImpl = async () => locator.promise;
  const opening = s.updatesController.open(noticeId);
  await flush();
  await s.updatesController.selectCategory('reply');
  locator.resolve(subscriptionNoticeTarget());
  await opening;
  assert.equal(s.navigation.length, 0);
  assert.equal(s.updateView().category, 'reply');
});
for (const boundary of ['cancel', 'account', 'route', 'hide'] as const)
  for (const anchored of [false, true])
    test(`R2C ${boundary} after ${anchored ? 'reply' : 'root'} content render still prevents subsequent subscription auto-read`, async () => {
      let interrupted = false;
      const s = r2cHarness((view) => {
        if (!view.loaded || interrupted) return;
        interrupted = true;
        if (boundary === 'cancel') s.controller.cancel();
        else if (boundary === 'account')
          s.sessions.completeLogin(s.sessions.beginLogin(), {
            ...wireCredentials(),
            accountId: otherId,
          });
        else if (boundary === 'hide') s.runtime.privateViews?.clear();
        else void s.controller.load(route);
      });
      s.ratingSubscriptionUpdates.targetImpl = async () =>
        subscriptionNoticeTarget({
          target: subscriptionLocator({ replyId: anchored ? replyId : null }),
        });
      await s.controller.load({
        ...route,
        ...(anchored ? { replyId } : {}),
        subscriptionNoticeId: noticeId,
      });
      await flush();
      assert.equal(interrupted, true);
      assert.equal(
        s.ratingSubscriptionUpdates.calls.filter((c) => c.method === 'markRead')
          .length,
        0,
      );
    });

for (const code of [
  'AFFILIATION_VERIFICATION_REQUIRED',
  'IDENTITY_CAMPUS_REQUIRED',
  'SAFETY_ACTION_RESTRICTED',
])
  test(`R2C purpose-only 403 ${code} becomes independent subscription unknown without clearing readable content`, async () => {
    const s = r2cHarness();
    s.ratingSubscriptions.stateImpl = async () => {
      throw new ClientError('forbidden', 'Synthetic purpose denial', {
        httpStatus: 403,
        serverCode: code,
      });
    };
    await s.detailController.load({ targetId });
    assert.equal(s.detailView().loaded, true);
    assert.ok(s.detailView().detail);
    assert.ok(s.detailView().comments.length);
    assert.deepEqual(s.detailView().subscriptions[targetId], {
      status: 'unavailable',
    });
    await s.detailController.toggleSubscription();
    assert.equal(s.ids.count, 0);
  });
for (const code of ['ACCOUNT_BLOCKED', 'FORBIDDEN'])
  test(`R2C whole-account 403 ${code} cannot masquerade as harmless subscription unknown`, async () => {
    const gateway = new FakeRatingSubscriptionsGateway();
    gateway.stateImpl = async () => {
      throw new ClientError('forbidden', 'Synthetic whole-account denial', {
        httpStatus: 403,
        serverCode: code,
      });
    };
    await assert.rejects(
      readRatingSubscriptionState(gateway, null, targetId, new Cancellation()),
      { kind: 'forbidden' },
    );
  });

test('R2C unavailable independent current read after successful receipt preserves content but never copies historical true', async () => {
  const s = r2cHarness();
  await s.detailController.load({ targetId });
  s.ratingSubscriptions.commandImpl = async (command) => {
    s.ratingSubscriptions.stateImpl = async () => ({ status: 'unavailable' });
    return subscriptionReceipt(command);
  };
  await s.detailController.toggleSubscription();
  assert.equal(s.detailView().loaded, true);
  assert.ok(s.detailView().detail);
  assert.ok(s.detailView().comments.length);
  assert.deepEqual(s.detailView().subscriptions[targetId], {
    status: 'unavailable',
  });
  assert.equal(s.storage.data.size, 0);
  const minted = s.ids.count;
  await s.detailController.toggleSubscription();
  assert.equal(s.ids.count, minted);
  assert.equal(s.ratingSubscriptions.commands.length, 1);
});
test('R2C cancellation during UUID generation freezes no v3 journal and dispatches no command', async () => {
  const s = r2cHarness(),
    held = deferred<string>();
  s.ids.next = () => held.promise;
  await s.detailController.load({ targetId });
  const run = s.detailController.toggleSubscription();
  await flush();
  assert.equal(s.ids.count, 1);
  s.detailController.cancel();
  held.resolve(requestId);
  await run;
  assert.equal(s.storage.data.size, 0);
  assert.equal(s.ratingSubscriptions.commands.length, 0);
  assert.deepEqual(s.detailView().subscriptions, {});
});
for (const failure of ['write', 'remove'] as const)
  test(`R2C storage ${failure} failure freezes uncertain intent and cannot release or replace it`, async () => {
    const s = r2cHarness();
    await s.detailController.load({ targetId });
    s.storage.failWrite = failure === 'write';
    s.storage.failRemove = failure === 'remove';
    await s.detailController.toggleSubscription();
    assert.equal(s.detailView().frozen, true);
    assert.equal(s.detailView().loaded, false);
    assert.deepEqual(s.detailView().subscriptions, {});
    assert.equal(
      s.ratingSubscriptions.commands.length,
      failure === 'write' ? 0 : 1,
    );
    if (failure === 'remove') {
      s.storage.failRemove = false;
      const original = s.pendingRatings.load(s.accountId);
      assert.ok(original);
      s.ratingSubscriptions.receiptImpl = async () => subscriptionReceipt();
      s.ratings.detailImpl = async () => {
        throw unavailable();
      };
      await s.detailController.recover();
      assert.equal(s.storage.data.size, 0);
      assert.equal(s.detailView().loaded, false);
      assert.deepEqual(s.detailView().subscriptions, {});
    }
  });

test('R2C newer detail sort cancels old current state and a late false/count response cannot overwrite fresh subscription', async () => {
  const s = r2cHarness(),
    hold = deferred<RatingSubscriptionState>();
  let first = true;
  s.ratingSubscriptions.stateImpl = async () => {
    if (first) {
      first = false;
      return hold.promise;
    }
    return subscriptionState({
      subscribed: true,
      count: 21,
      revision: otherId,
    });
  };
  const loading = s.detailController.load({ targetId });
  await flush();
  assert.equal(s.ratingSubscriptions.calls.length, 1);
  const oldCancel = s.ratingSubscriptions.calls[0]!.args[2] as Cancellation;
  await s.detailController.selectSort('likes', 'asc');
  assert.equal(oldCancel.isCancelled, true);
  assert.equal(s.detailView().commentSort, 'likes');
  hold.resolve(subscriptionState({ subscribed: false, count: 0 }));
  await loading;
  assert.deepEqual(
    s.detailView().subscriptions[targetId],
    subscriptionState({ subscribed: true, count: 21, revision: otherId }),
  );
});
