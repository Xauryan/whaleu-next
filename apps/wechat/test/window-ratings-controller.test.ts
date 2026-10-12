import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import {
  WindowRatingController,
  type WindowRatingView,
} from '../src/window-ratings/controller';
import type { WindowReceipt } from '../src/window-ratings/contract';
import { PendingWindowRatingStore } from '../src/window-ratings/pending';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  cancelled,
  canteenId,
  choose,
  command,
  detail,
  floorId,
  id,
  missing,
  otherId,
  page,
  receipt,
  recordedAt,
  requestId,
  scoreRevision,
  window,
  windowHarness,
} from './window-ratings-helpers';
test('explicit preview and confirmation retain signed zero; later edits carry current own revision', async () => {
  const s = windowHarness();
  await s.controller.load(id);
  s.controller.chooseScore(0);
  await s.controller.submit();
  assert.equal(s.commands.length, 0);
  s.controller.confirm();
  s.controller.chooseScore(10);
  assert.equal(s.view().selectedScore, 0);
  await Promise.all([s.controller.submit(), s.controller.submit()]);
  assert.deepEqual(s.commands, [command({ score: 0 })]);
  assert.equal(s.view().detail!.myScore.kind, 'recorded');
  assert.equal(s.view().canScore, true);
  s.ids.next = async () => otherId;
  choose(s, 10);
  await s.controller.submit();
  assert.equal(s.commands[1]!.expectedOwnScoreRevision, scoreRevision);
  assert.equal(s.commands[1]!.score, 10);
  assert.equal(s.pendingWindowRatings.load(s.accountId), null);
});
test('durable readback precedes dispatch and write failure cannot send', async () => {
  const s = windowHarness();
  await s.controller.load(id);
  choose(s);
  s.storage.failWrite = true;
  await s.controller.submit();
  assert.equal(s.commands.length, 0);
  const t = windowHarness();
  await t.controller.load(id);
  choose(t);
  t.impl.submit = async (_id, input) => {
    assert.deepEqual(t.pendingWindowRatings.load(t.accountId)?.command, input);
    assert.equal(t.view().loaded, false);
    throw new ClientError('network', 'Lost');
  };
  await t.controller.submit();
  assert.equal(t.view().frozen, true);
});
test('restart retry reads receipt before exact resend; recovered historical score never overrides newer current detail', async () => {
  const s = windowHarness();
  await s.controller.load(id);
  choose(s);
  s.impl.submit = async () => {
    throw new ClientError('network', 'Lost');
  };
  await s.controller.submit();
  const original = s.pendingWindowRatings.load(s.accountId)!;
  s.controller.dispose();
  const views: WindowRatingView[] = [],
    restarted = new WindowRatingController(s.runtime, 'detail', (view) =>
      views.push(view),
    );
  await restarted.load(id);
  await restarted.recover(true);
  assert.deepEqual(s.commands[1], original.command);
  assert.deepEqual(
    s.calls.slice(-2).map((call) => call.method),
    ['receipt', 'submit'],
  );
  assert.equal(s.ids.count, 1);
  s.impl.receipt = async () => receipt();
  s.impl.detail = async () =>
    detail({
      myScore: { kind: 'recorded', score: 7, revision: otherId, recordedAt },
      window: window({ summary: { kind: 'known', ratingCount: 1, mean: 7 } }),
    });
  await restarted.recover(true);
  assert.equal(s.commands.length, 2);
  assert.equal(s.pendingWindowRatings.load(s.accountId), null);
  const last = views[views.length - 1]!;
  assert.equal(
    last.detail!.myScore.kind === 'recorded' && last.detail!.myScore.score,
    7,
  );
  assert.match(last.receiptStatus, /历史回执/);
});
test('recovery ignores current catalog/phone availability and never turns old receipt into current read authority', async () => {
  const s = windowHarness();
  s.pendingWindowRatings.freeze(s.pending());
  s.impl.detail = async () => {
    throw new ClientError('http', 'Withdrawn', {
      httpStatus: 503,
      serverCode: 'WINDOW_CATALOG_UNAVAILABLE',
    });
  };
  await s.controller.load(id);
  assert.equal(s.view().loaded, false);
  assert.equal(s.view().frozen, true);
  s.impl.receipt = async () => receipt();
  await s.controller.recover();
  assert.equal(s.view().frozen, false);
  assert.equal(s.view().loaded, false);
  assert.equal(s.view().detail, null);
});
test('only genuine absence allows retry; unavailable, protocol or wrong-status absence remains frozen', async () => {
  for (const error of [
    new ClientError('http', 'Unavailable', {
      httpStatus: 503,
      serverCode: 'WINDOW_HISTORY_UNAVAILABLE',
    }),
    new ClientError('protocol', 'Bad', {
      httpStatus: 404,
      serverCode: 'REQUEST_NOT_FOUND',
    }),
    new ClientError('http', 'Bad status', {
      httpStatus: 503,
      serverCode: 'REQUEST_NOT_FOUND',
    }),
  ]) {
    const s = windowHarness();
    s.pendingWindowRatings.freeze(s.pending());
    await s.controller.load(id);
    s.impl.receipt = async () => {
      throw error;
    };
    await s.controller.recover(true);
    assert.equal(s.commands.length, 0);
    assert.equal(s.view().frozen, true);
    assert.equal(s.view().receiptMissing, false);
  }
});
test('cancel requires explicit preview; durable cancellation survives response loss and restart without resending score', async () => {
  const s = windowHarness();
  s.pendingWindowRatings.freeze(s.pending());
  await s.controller.load(id);
  await s.controller.recover();
  await s.controller.confirmCancellation();
  assert.equal(s.calls.filter((call) => call.method === 'cancel').length, 0);
  await s.controller.recover(false, true);
  assert.equal(s.view().confirming, 'cancel');
  s.controller.closeConfirmation();
  assert.equal(s.pendingWindowRatings.load(s.accountId)!.phase, 'submit');
  await s.controller.recover(false, true);
  s.impl.cancel = async () => {
    throw new ClientError('network', 'Cancel lost');
  };
  await s.controller.confirmCancellation();
  assert.equal(s.pendingWindowRatings.load(s.accountId)!.phase, 'cancel');
  s.controller.dispose();
  const restarted = new WindowRatingController(
    s.runtime,
    'detail',
    () => undefined,
  );
  await restarted.load(id);
  s.impl.cancel = async () => cancelled();
  await restarted.recover(true);
  assert.deepEqual(
    s.calls.slice(-3).map((call) => call.method),
    ['receipt', 'cancel', 'detail'],
  );
  assert.equal(s.commands.length, 0);
  assert.equal(s.pendingWindowRatings.load(s.accountId), null);
});
test('cancel race returns applied result and stale CAS rejection requires fresh explicit decision', async () => {
  const s = windowHarness();
  s.pendingWindowRatings.freeze(s.pending());
  await s.controller.load(id);
  await s.controller.recover(false, true);
  s.impl.cancel = async () => receipt();
  await s.controller.confirmCancellation();
  assert.equal(s.pendingWindowRatings.load(s.accountId), null);
  assert.match(s.view().receiptStatus, /已确认记为/);
  const t = windowHarness();
  await t.controller.load(id);
  choose(t);
  t.impl.submit = async () =>
    ({
      ...cancelled(),
      code: 'WINDOW_SCORE_REVISION_CONFLICT',
    }) as WindowReceipt;
  await t.controller.submit();
  assert.match(t.view().receiptStatus, /在别处变化/);
  assert.equal(t.view().confirming, null);
  assert.equal(t.view().selectedScore, null);
  await t.controller.submit();
  assert.equal(t.commands.length, 1);
});
test('wrong receipts and journal deletion failure cannot unlock scoring', async () => {
  const s = windowHarness();
  await s.controller.load(id);
  choose(s);
  s.impl.submit = async () => receipt(command({ score: 1 }));
  await s.controller.submit();
  assert.equal(s.view().frozen, true);
  s.impl.receipt = async () => receipt();
  s.storage.failRemove = true;
  await s.controller.recover();
  assert.equal(s.view().frozen, true);
  assert.ok(s.pendingWindowRatings.load(s.accountId));
});
test('account, same-account login, hide, root-hide and stopped waits fence late score receipts', async () => {
  for (const action of [
    'hide',
    'cancel',
    'account',
    'relogin',
    'root-hide',
  ] as const) {
    const s = windowHarness();
    await s.controller.load(id);
    choose(s);
    const delayed = deferred<WindowReceipt>();
    s.impl.submit = () => delayed.promise;
    const submitted = s.controller.submit();
    await flush();
    const original = s.pendingWindowRatings.load(s.accountId)!;
    if (action === 'hide') s.controller.dispose();
    else if (action === 'cancel') s.controller.cancel();
    else if (action === 'root-hide') s.runtime.privateViews!.clear();
    else
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials(),
        accountId: action === 'account' ? otherId : s.accountId,
      });
    delayed.resolve(receipt());
    await submitted;
    assert.equal(s.view().loaded, false);
    assert.equal(s.view().detail, null);
    assert.deepEqual(s.pendingWindowRatings.load(s.accountId), original);
    if (action !== 'cancel') assert.equal(s.view().recoveryWindowId, '');
  }
});
test('pending secure id and late absent receipts cannot write after lifecycle cancellation', async () => {
  const s = windowHarness();
  await s.controller.load(id);
  choose(s);
  const uuid = deferred<string>();
  s.ids.next = () => uuid.promise;
  const submit = s.controller.submit();
  await flush();
  s.controller.dispose();
  uuid.resolve(requestId);
  await submit;
  assert.equal(s.commands.length, 0);
  assert.equal(s.pendingWindowRatings.load(s.accountId), null);
  const t = windowHarness();
  t.pendingWindowRatings.freeze(t.pending());
  await t.controller.load(id);
  const read = deferred<WindowReceipt>();
  t.impl.receipt = () => read.promise;
  const retry = t.controller.recover(true);
  await flush();
  t.controller.cancel();
  read.reject(missing());
  await retry;
  assert.equal(t.commands.length, 0);
});
test('accepted canteen/floor filters carry opaque identities and pagination drift clears stale rows', async () => {
  const s = windowHarness('catalog');
  await s.controller.load();
  s.controller.toggleCanteen(canteenId);
  s.controller.setFloor(floorId);
  s.controller.setMinimum('0');
  s.impl.list = async () =>
    page({
      items: [window({ summary: { kind: 'known', ratingCount: 1, mean: 0 } })],
      nextCursor: 'next',
      continuation: 'more',
    });
  await s.controller.search();
  assert.deepEqual(s.calls[s.calls.length - 1]!.args[0], {
    canteenIds: [canteenId],
    floorId,
    minRating: 0,
  });
  assert.equal(s.view().pageNumber, 1);
  s.impl.list = async () => page({ scoreRevision: '2' });
  await s.controller.next();
  assert.equal(s.view().loaded, false);
  assert.deepEqual(s.view().items, []);
  assert.equal(s.view().restartRequired, true);
});
test('unknown history and corrupted storage block writes; journals isolate origin and account', async () => {
  const s = windowHarness();
  s.impl.detail = async () =>
    detail({
      myScore: { kind: 'unavailable' },
      window: window({ summary: { kind: 'unavailable' } }),
    });
  await s.controller.load(id);
  choose(s);
  await s.controller.submit();
  assert.equal(s.commands.length, 0);
  assert.equal(s.view().canScore, false);
  const t = windowHarness();
  const original = t.pendingWindowRatings.freeze(t.pending());
  assert.equal(
    new PendingWindowRatingStore(t.storage, 'other-origin').load(t.accountId),
    null,
  );
  assert.equal(t.pendingWindowRatings.load(otherId), null);
  assert.throws(() =>
    t.pendingWindowRatings.freeze({
      ...original,
      command: command({ score: 0 }),
    }),
  );
  t.storage.data.set(
    `whaleu.window-ratings.pending.v1:synthetic-window-origin:${t.accountId}`,
    { broken: true },
  );
  await t.controller.load(id);
  choose(t);
  await t.controller.submit();
  assert.equal(t.commands.length, 0);
  assert.equal(t.view().frozen, true);
});
