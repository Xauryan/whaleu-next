import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { RatingTargetOwnerDeletionController } from '../src/ratings/target-owner-deletion-controller';
import { RatingController, type RatingView } from '../src/ratings/controller';
import { RatingManagementController } from '../src/ratings/management-controller';
import { RatingDeletionController } from '../src/ratings/deletion-controller';
import { RatingThreadController } from '../src/ratings/discussion-controller';
import type { RatingTargetOwnerDeletionReceipt } from '../src/ratings/target-owner-deletion-contract';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import { targetId, otherId, requestId } from './ratings-helpers';
import { creationIntent } from './ratings-management-helpers';
import {
  FakeRatingDiscussionGateway,
  route as threadRoute,
  replyPage,
  replyId,
} from './ratings-r2a-helpers';
import type { RatingThreadView } from '../src/ratings/discussion-controller';
import {
  cancelledReceipt,
  ownerHarness,
  ownerIntent,
  ownerReceipt,
} from './rating-owner-management-helpers';
async function ready() {
  const s = ownerHarness();
  await s.controller.load({ targetId });
  return s;
}
test('only metadata is loaded; second confirmation freezes/readbacks v6 once before dispatch', async () => {
  const s = await ready(),
    result = deferred<RatingTargetOwnerDeletionReceipt>();
  assert.deepEqual(s.calls, ['context']);
  assert.equal(s.ratings.calls.length, 0);
  await s.controller.confirmDelete();
  assert.equal(s.ids.count, 0);
  let calls = 0;
  s.gateway.command = async (intent) => {
    calls++;
    assert.deepEqual(s.pendingRatings.load(s.accountId), {
      version: 6,
      accountId: s.accountId,
      intent,
    });
    return result.promise;
  };
  s.controller.requestDelete();
  const first = s.controller.confirmDelete(),
    second = s.controller.confirmDelete();
  await flush();
  assert.equal(calls, 1);
  assert.equal(s.ids.count, 1);
  assert.equal(s.view().frozen, true);
  result.resolve(ownerReceipt());
  await Promise.all([first, second]);
  assert.equal(s.pendingRatings.load(s.accountId), null);
  assert.equal(s.view().returnToCatalog, true);
  assert.equal(s.view().ready, false);
  assert.equal(s.view().deleted, false); // A historical receipt is not current context.
  assert.match(s.view().receiptStatus, /历史操作/);
});
test('unknown commit survives close/back/reopen, different or invalid routes and same-key retry', async () => {
  const s = await ready();
  const dispatched: unknown[] = [];
  s.gateway.command = async (intent) => {
    dispatched.push(intent);
    throw new ClientError('network', 'lost');
  };
  s.controller.requestDelete();
  await s.controller.confirmDelete();
  const original = s.pendingRatings.load(s.accountId);
  s.controller.cancel();
  s.controller.dispose();
  for (const route of [null, { targetId: otherId }]) {
    const reopened = new RatingTargetOwnerDeletionController(
      s.runtime,
      () => undefined,
    );
    await reopened.load(route);
    assert.deepEqual(s.pendingRatings.load(s.accountId), original);
    assert.equal(s.calls.filter((c) => c === 'context').length, 1);
    reopened.dispose();
  }
  const reopened = new RatingTargetOwnerDeletionController(
    s.runtime,
    () => undefined,
  );
  await reopened.load({ targetId: otherId });
  s.gateway.command = async (intent) => {
    dispatched.push(intent);
    return ownerReceipt();
  };
  await reopened.recover(true);
  assert.deepEqual(dispatched, [ownerIntent(), ownerIntent()]);
  assert.equal(s.ids.count, 1);
  assert.equal(s.pendingRatings.load(s.accountId), null);
});
test('every independent rating page recovers v6 before invalid route/current visibility and never paints history text', async () => {
  for (const make of [
    (s: ReturnType<typeof ownerHarness>) =>
      new RatingController(s.runtime, 'recovery', () => undefined),
    (s: ReturnType<typeof ownerHarness>) =>
      new RatingController(s.runtime, 'detail', () => undefined),
    (s: ReturnType<typeof ownerHarness>) =>
      new RatingManagementController(s.runtime, () => undefined),
    (s: ReturnType<typeof ownerHarness>) =>
      new RatingDeletionController(s.runtime, () => undefined),
    (s: ReturnType<typeof ownerHarness>) =>
      new RatingThreadController(s.runtime, () => undefined),
  ]) {
    const s = ownerHarness();
    // These gateways are needed only to mark the legacy page configured; no current call is allowed.
    const runtime = s.runtime as {
      ratingManagement?: unknown;
      ratingDeletion?: unknown;
      ratingDiscussion?: unknown;
    };
    runtime.ratingManagement = {};
    runtime.ratingDeletion = {};
    runtime.ratingDiscussion = {};
    s.pendingRatings.freeze({
      version: 6,
      accountId: s.accountId,
      intent: ownerIntent(),
    });
    s.gateway.receipt = async () => {
      s.calls.push('receipt');
      return ownerReceipt();
    };
    const page = make(s);
    await page.load(null);
    assert.equal(s.pendingRatings.load(s.accountId), null);
    assert.deepEqual(s.calls, ['receipt']);
    assert.equal(s.ratings.calls.length, 0);
    page.dispose();
  }
});
test('unknown HTTP/review/infra failures keep the journal; bad context never permits deletion', async () => {
  for (const code of [
    'CONTENT_REVIEW_UNAVAILABLE',
    'RATING_UNAVAILABLE',
    'RATING_NOT_FOUND',
    'RATING_REVISION_CONFLICT',
  ]) {
    const s = await ready();
    s.gateway.command = async () => {
      throw new ClientError('http', 'unknown', {
        httpStatus: 503,
        serverCode: code,
      });
    };
    s.controller.requestDelete();
    await s.controller.confirmDelete();
    assert.equal(s.pendingRatings.load(s.accountId)?.version, 6);
    assert.equal(s.view().frozen, true);
    await s.controller.recover();
    assert.equal(s.pendingRatings.load(s.accountId)?.version, 6);
  }
  const s = ownerHarness();
  s.gateway.context = async () => ({
    targetId: otherId,
    revision: ownerIntent().payload.expectedTargetRevision,
    deletion: { kind: 'not_owner_deleted' },
  });
  await s.controller.load({ targetId });
  s.controller.requestDelete();
  await s.controller.confirmDelete();
  assert.equal(s.view().ready, false);
  assert.equal(s.ids.count, 0);
});
test('UUID wait close/scope changes stop dispatch; account switch and late receipt never settle another session', async () => {
  for (const stop of ['close', 'scope', 'browse', 'safety'] as const) {
    const s = await ready(),
      id = deferred<string>();
    s.ids.next = () => id.promise;
    s.controller.requestDelete();
    const work = s.controller.confirmDelete();
    await flush();
    if (stop === 'close') s.controller.cancel();
    else if (stop === 'scope') s.directoryScopeChanges.clear(s.accountId);
    else if (stop === 'browse') s.browsingScopeChanges.clear(s.accountId);
    else s.safetyChanges.invalidate(s.accountId);
    id.resolve(requestId);
    await work;
    assert.equal(s.pendingRatings.load(s.accountId), null);
    assert.deepEqual(s.calls, ['context']);
  }
  for (const stop of ['account', 'same-account', 'hide', 'close'] as const) {
    const s = await ready(),
      result = deferred<RatingTargetOwnerDeletionReceipt>();
    s.gateway.command = async () => result.promise;
    s.controller.requestDelete();
    const work = s.controller.confirmDelete();
    await flush();
    const original = s.pendingRatings.load(s.accountId);
    if (stop === 'account' || stop === 'same-account')
      s.sessions.completeLogin(
        s.sessions.beginLogin(),
        stop === 'account'
          ? { ...wireCredentials('b'), accountId: otherId }
          : wireCredentials('b'),
      );
    else if (stop === 'hide') s.runtime.privateViews!.clear();
    else s.controller.cancel();
    result.resolve(ownerReceipt());
    await work;
    assert.deepEqual(s.pendingRatings.load(s.accountId), original);
    assert.equal(s.view().receiptStatus, '');
  }
});
test('explicit server cancellation alone closes an unknown command and prior applied receipt wins', async () => {
  for (const applied of [false, true]) {
    const s = await ready();
    s.gateway.command = async () => {
      throw new ClientError('network', 'lost');
    };
    s.controller.requestDelete();
    await s.controller.confirmDelete();
    await s.controller.confirmCancelDeletion();
    assert.equal(s.calls.includes('cancel'), false);
    let calls = 0;
    s.gateway.cancel = async (intent) => {
      calls++;
      assert.deepEqual(intent, ownerIntent());
      return applied ? ownerReceipt() : cancelledReceipt();
    };
    s.controller.requestCancelDeletion();
    s.controller.dismissCancelDeletion();
    await s.controller.confirmCancelDeletion();
    assert.equal(calls, 0);
    s.controller.requestCancelDeletion();
    await s.controller.confirmCancelDeletion();
    assert.equal(calls, 1);
    assert.equal(s.pendingRatings.load(s.accountId), null);
    assert.equal(s.view().returnToCatalog, applied);
    assert.equal(s.view().receiptStatus.includes('已撤销'), !applied);
  }
});
test('lost cancellation or cancellation arriving after account switch cannot erase unknown journal', async () => {
  const s = await ready();
  s.gateway.command = async () => {
    throw new ClientError('network', 'lost');
  };
  s.controller.requestDelete();
  await s.controller.confirmDelete();
  const original = s.pendingRatings.load(s.accountId);
  s.gateway.cancel = async () => {
    throw new ClientError('network', 'lost cancel');
  };
  s.controller.requestCancelDeletion();
  await s.controller.confirmCancelDeletion();
  await s.controller.recover();
  assert.deepEqual(s.pendingRatings.load(s.accountId), original);
  const result = deferred<RatingTargetOwnerDeletionReceipt>();
  s.gateway.cancel = async () => result.promise;
  s.controller.requestCancelDeletion();
  const work = s.controller.confirmCancelDeletion();
  await flush();
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: otherId,
  });
  result.resolve(cancelledReceipt());
  await work;
  assert.deepEqual(s.pendingRatings.load(s.accountId), original);
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials());
  s.gateway.receipt = async () => cancelledReceipt();
  await s.controller.load(null);
  assert.equal(s.pendingRatings.load(s.accountId), null);
});
test('legacy pending creation blocks new deletion without disclosing its frozen name; storage failure blocks dispatch', async () => {
  const s = ownerHarness();
  const runtime = s.runtime as { ratingManagement?: unknown };
  runtime.ratingManagement = {
    receipt: async () => {
      throw new ClientError('network', 'unknown');
    },
  };
  s.pendingRatings.freeze({
    version: 5,
    accountId: s.accountId,
    intent: creationIntent(),
  });
  await s.controller.load({ targetId });
  assert.deepEqual(s.calls, []);
  assert.equal(
    JSON.stringify(s.view()).includes(creationIntent().payload.name),
    false,
  );
  s.controller.requestDelete();
  await s.controller.confirmDelete();
  assert.equal(s.ids.count, 0);
  const t = await ready();
  t.storage.failWrite = true;
  t.controller.requestDelete();
  await t.controller.confirmDelete();
  assert.deepEqual(t.calls, ['context']);
});
test('confirmed deletion invalidates catalog/detail text using only target/revision; hidden known-ID entry remains available', async () => {
  const s = await ready(),
    details: RatingView[] = [],
    catalog: RatingView[] = [];
  const detail = new RatingController(s.runtime, 'detail', (view) =>
    details.push(view),
  );
  const list = new RatingController(s.runtime, 'catalog', (view) =>
    catalog.push(view),
  );
  await detail.load({ targetId });
  await list.load({});
  assert.ok(details[details.length - 1]!.detail);
  const changes: unknown[] = [];
  s.runtime.ratingTargetChanges!.subscribe((change) => changes.push(change));
  s.controller.requestDelete();
  await s.controller.confirmDelete();
  assert.deepEqual(changes, [{ targetId, revision: ownerReceipt().revision }]);
  assert.equal(details[details.length - 1]!.detail, null);
  assert.equal(catalog[catalog.length - 1]!.categories.length, 0);
  assert.equal(details[details.length - 1]!.needsRefresh, true);
  assert.equal(
    detail.ownerDeletionPath(),
    `/pages/target-owner-delete/target-owner-delete?targetId=${targetId}`,
  );
});

test('deletion invalidates loaded thread bodies, quoted identity and draft, and cancels late reply reads', async () => {
  for (const inFlight of [false, true]) {
    const s = await ready(),
      discussion = new FakeRatingDiscussionGateway(),
      response = deferred<ReturnType<typeof replyPage>>(),
      views: RatingThreadView[] = [];
    if (inFlight) discussion.repliesImpl = () => response.promise;
    const thread = new RatingThreadController(
      { ...s.runtime, ratingDiscussion: discussion },
      (view) => views.push(view),
    );
    const work = thread.load(threadRoute);
    if (inFlight) await flush();
    else {
      await work;
      assert.ok(views[views.length - 1]!.discussion);
      assert.equal(views[views.length - 1]!.replies.length, 1);
      thread.compose(replyId);
      thread.setText('Private pending reply');
      assert.ok(views[views.length - 1]!.replyToName);
    }
    s.controller.requestDelete();
    await s.controller.confirmDelete();
    response.resolve(replyPage());
    await work;
    const view = views[views.length - 1]!;
    assert.equal(view.detail, null);
    assert.equal(view.discussion, null);
    assert.deepEqual(view.replies, []);
    assert.equal(view.replyToName, '');
    assert.equal(view.text, '');
    assert.equal(view.busy, false);
    assert.equal(view.needsRefresh, true);
    thread.dispose();
  }
});

test('new account cannot display, replay or cancel the old account deletion journal', async () => {
  const s = await ready();
  s.gateway.command = async () => {
    throw new ClientError('network', 'lost');
  };
  s.controller.requestDelete();
  await s.controller.confirmDelete();
  const original = s.pendingRatings.load(s.accountId);
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: otherId,
  });
  assert.equal(s.view().canCancelDeletion, false);
  assert.equal(s.view().recoveryOperation, '');
  assert.equal(s.pendingRatings.load(otherId), null);
  s.controller.requestCancelDeletion();
  await s.controller.confirmCancelDeletion();
  await s.controller.recover(true);
  assert.deepEqual(s.pendingRatings.load(s.accountId), original);
  assert.equal(s.calls.includes('cancel'), false);
});
