import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import {
  PollController,
  type PollView,
} from '../src/community/poll-controller';
import type { BallotReceipt, Poll } from '../src/community/poll-contract';
import { PendingBallotStore } from '../src/community/poll-pending';
import {
  MineController,
  type MineView,
} from '../src/pages/community-mine/controller';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  ballotReceipt,
  optionOne,
  optionThree,
  optionTwo,
  otherId,
  poll,
  pollPost,
  post,
  postId,
  requestId,
  setup,
} from './community-helpers';
function controller(raw: Poll = poll()) {
  const s = setup(),
    views: PollView[] = [];
  s.gateway.pollImpl = async () => raw;
  const controller = new PollController(s.runtime, postId, (view) =>
    views.push(view),
  );
  return {
    ...s,
    controller,
    view: () => views[views.length - 1]!,
    load: () => controller.load(pollPost(raw)),
  };
}
function voted(
  ids: readonly string[] = [optionOne],
  mode: Poll['selectionMode'] = 'single',
): Poll {
  return poll({
    selectionMode: mode,
    voterCount: 1,
    selectionCount: ids.length,
    options: poll().options.map((option) => ({
      ...option,
      count: ids.includes(option.id) ? 1 : 0,
    })),
    viewer: {
      hasVoted: true,
      selectedOptionIds: ids,
      canVote: false,
      reason: 'POLL_ALREADY_VOTED',
    },
  });
}
test('single-choice tap immediately freezes once; author may vote and bars appear only after authoritative read', async () => {
  const s = controller();
  await s.load();
  assert.equal(s.view().revealResults, false);
  assert.equal(s.view().canVote, true);
  s.gateway.castBallotImpl = async (target, payload) => {
    assert.equal(target, postId);
    assert.deepEqual(
      s.runtime.pendingBallots.load(s.accountId)?.payload,
      payload,
    );
    s.gateway.pollImpl = async () => voted();
    return ballotReceipt();
  };
  await s.controller.select(optionOne);
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'castBallot').length,
    1,
  );
  assert.equal(s.view().poll?.viewer.hasVoted, true);
  assert.equal(s.view().canVote, false);
  assert.equal(s.view().revealResults, true);
  assert.equal(s.view().rows[0]?.percent, 100);
  assert.equal(s.runtime.pendingBallots.load(s.accountId), null);
  await s.controller.select(optionTwo);
  await s.controller.submit();
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'castBallot').length,
    1,
  );
});
test('multi-choice stays local until explicit confirmation, permits final option and honestly counts five selections/two voters', async () => {
  const initial = poll({
    selectionMode: 'multiple',
    voterCount: 1,
    selectionCount: 2,
    options: poll().options.map((option) => ({
      ...option,
      count: option.position === 2 ? 0 : 1,
    })),
  });
  const s = controller(initial);
  await s.load();
  await s.controller.select(optionThree);
  await s.controller.select(optionOne);
  await s.controller.select(optionTwo);
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'castBallot').length,
    0,
  );
  assert.equal(s.view().canSubmit, true);
  await s.controller.submit();
  assert.equal(s.view().poll?.voterCount, 2);
  assert.equal(s.view().poll?.selectionCount, 5);
  assert.deepEqual(
    s.view().rows.map((row) => row.percent),
    [40, 40, 20],
  );
  assert.equal(s.view().revealResults, true);
});
test('empty, repeated and foreign selection do not create ballots; double taps cannot dispatch twice', async () => {
  const s = controller(poll({ selectionMode: 'multiple' }));
  await s.load();
  await s.controller.submit();
  await s.controller.select(otherId);
  assert.equal(s.view().selectedOptionIds.length, 0);
  await s.controller.select(optionOne);
  await s.controller.select(optionOne);
  assert.equal(s.view().canSubmit, false);
  await s.controller.select(optionTwo);
  const late = deferred<BallotReceipt>();
  s.gateway.castBallotImpl = () => late.promise;
  const first = s.controller.submit();
  await flush();
  await s.controller.submit();
  await s.controller.select(optionThree);
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'castBallot').length,
    1,
  );
  assert.deepEqual(
    s.runtime.pendingBallots.load(s.accountId)?.payload.optionIds,
    [optionTwo],
  );
  s.gateway.pollImpl = async () => voted([optionTwo], 'multiple');
  late.resolve(ballotReceipt());
  await first;
});
test('timeout-after-commit keeps frozen intent through NOT_FOUND, malformed receipt and identical explicit retry', async () => {
  const s = controller();
  await s.load();
  let keys = 0;
  Object.assign(s.runtime, {
    newRequestId: async () => {
      keys++;
      return requestId;
    },
  });
  s.gateway.castBallotImpl = async () => {
    throw new ClientError('timeout', 'safe');
  };
  await s.controller.select(optionOne);
  assert.equal(s.view().frozen, true);
  assert.equal(s.view().revealResults, false);
  await s.controller.select(optionTwo);
  assert.equal(keys, 1);
  s.gateway.ballotReceiptImpl = async () => {
    throw new ClientError('http', 'safe', {
      serverCode: 'REQUEST_NOT_FOUND',
      httpStatus: 404,
    });
  };
  await s.controller.recover();
  assert.equal(s.view().frozen, true);
  s.gateway.ballotReceiptImpl = async () =>
    ballotReceipt({ requestId: otherId });
  await s.controller.recover();
  assert.equal(s.view().frozen, true);
  s.gateway.ballotReceiptImpl = async () =>
    ({ ...ballotReceipt(), accountId: otherId }) as unknown as BallotReceipt;
  await s.controller.recover();
  assert.ok(s.runtime.pendingBallots.load(s.accountId));
  s.gateway.castBallotImpl = async () => {
    s.gateway.pollImpl = async () => voted();
    return ballotReceipt();
  };
  await s.controller.recover(true);
  const sends = s.gateway.calls.filter((call) => call.method === 'castBallot');
  assert.deepEqual(sends[0]!.args[1], sends[1]!.args[1]);
  assert.equal(keys, 1);
  assert.equal(s.runtime.pendingBallots.load(s.accountId), null);
});
test('cancel, page close, storage-store recreation and same-account reopen preserve one original pending vote', async () => {
  const s = controller();
  await s.load();
  const late = deferred<BallotReceipt>();
  s.gateway.castBallotImpl = () => late.promise;
  const first = s.controller.select(optionOne);
  await flush();
  s.controller.cancel();
  await first;
  assert.equal(s.view().frozen, true);
  s.controller.dispose();
  late.resolve(ballotReceipt());
  await flush();
  assert.ok(s.runtime.pendingBallots.load(s.accountId));
  const store = new PendingBallotStore(s.storage, 'synthetic');
  assert.deepEqual(store.load(s.accountId)?.payload.optionIds, [optionOne]);
  const views: PollView[] = [];
  const reopened = new PollController(
    { ...s.runtime, pendingBallots: store },
    postId,
    (view) => views.push(view),
  );
  await reopened.load(pollPost());
  assert.equal(views[views.length - 1]!.frozen, true);
  s.gateway.pollImpl = async () => voted();
  await reopened.recover();
  assert.equal(store.load(s.accountId), null);
  assert.equal(views[views.length - 1]!.poll?.viewer.hasVoted, true);
});
test('account and login-epoch changes clear choices synchronously, old callbacks cannot settle new login', async () => {
  const s = controller();
  await s.load();
  const late = deferred<BallotReceipt>();
  s.gateway.castBallotImpl = () => late.promise;
  const first = s.controller.select(optionOne);
  await flush();
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: otherId,
  });
  assert.equal(s.view().poll, null);
  assert.deepEqual(s.view().selectedOptionIds, []);
  await first;
  late.resolve(ballotReceipt());
  await flush();
  assert.ok(s.runtime.pendingBallots.load(s.accountId));
  await s.controller.load(pollPost());
  assert.equal(s.view().frozen, false);
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('c'));
  await s.controller.load(null);
  assert.equal(s.view().frozen, true);
  assert.equal(s.view().poll, null);
});
test('same-tick cancellation, account switch and missing durable storage prevent first dispatch', async () => {
  const s = controller();
  await s.load();
  let first = s.controller.select(optionOne);
  s.controller.cancel();
  await first;
  assert.equal(
    s.gateway.calls.some((call) => call.method === 'castBallot'),
    false,
  );
  assert.equal(s.runtime.pendingBallots.load(s.accountId), null);
  await s.load();
  first = s.controller.select(optionOne);
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('b'));
  await first;
  assert.equal(
    s.gateway.calls.some((call) => call.method === 'castBallot'),
    false,
  );
  await s.load();
  s.storage.failWrite = true;
  await s.controller.select(optionOne);
  assert.equal(
    s.gateway.calls.some((call) => call.method === 'castBallot'),
    false,
  );
});
test('active original account recovers after hidden/deleted parent without fetching content or inventing a result', async () => {
  const s = controller();
  s.runtime.pendingBallots.freeze({
    version: 1,
    accountId: s.accountId,
    postId,
    payload: { clientRequestId: requestId, optionIds: [optionOne] },
  });
  await s.controller.load(null);
  assert.equal(s.view().frozen, true);
  assert.equal(s.gateway.calls.length, 0);
  await s.controller.inspectOwnBallot();
  assert.match(s.view().ownStatus, /仍需通过回执/);
  assert.ok(s.runtime.pendingBallots.load(s.accountId));
  assert.equal(s.view().poll, null);
  await s.controller.recover();
  assert.equal(s.runtime.pendingBallots.load(s.accountId), null);
  assert.equal(s.view().poll, null);
  assert.match(s.view().receiptStatus, /投票已确认/);
  assert.equal(
    s.gateway.calls.some(
      (call) => call.method === 'poll' || call.method === 'post',
    ),
    false,
  );
});
test('terminal receipts only release storage after reliable settlement and a fresh authoritative read', async () => {
  const s = controller();
  await s.load();
  s.gateway.castBallotImpl = async () => ({
    requestId,
    operation: 'cast_poll_ballot',
    outcome: 'rejected',
    code: 'POLL_EXPIRED',
  });
  s.storage.failRemove = true;
  await s.controller.select(optionOne);
  assert.equal(s.view().frozen, true);
  assert.ok(s.runtime.pendingBallots.load(s.accountId));
  s.storage.failRemove = false;
  s.gateway.ballotReceiptImpl = async () => ({
    requestId,
    operation: 'cast_poll_ballot',
    outcome: 'rejected',
    code: 'POLL_EXPIRED',
  });
  s.gateway.pollImpl = async () =>
    poll({
      deadline: '2020-01-01T00:00:00.000Z',
      expired: true,
      viewer: {
        hasVoted: false,
        selectedOptionIds: [],
        canVote: false,
        reason: 'POLL_EXPIRED',
      },
    });
  await s.controller.recover();
  assert.equal(s.view().frozen, false);
  assert.equal(s.view().canVote, false);
  assert.equal(s.view().revealResults, true);
});
test('a successful receipt followed by an inconsistent stale projection never permits a second ballot', async () => {
  const s = controller();
  await s.load();
  s.gateway.castBallotImpl = async () => ballotReceipt();
  await s.controller.select(optionOne);
  assert.equal(s.view().poll, null);
  assert.equal(s.view().canVote, false);
  assert.match(s.view().error, /格式异常/);
  await s.controller.select(optionTwo);
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'castBallot').length,
    1,
  );
});
test('null deadline remains live; dated expiry and unavailable/phone/restriction policy are explicit and cannot vote', async () => {
  const s = controller();
  await s.load();
  assert.equal(s.view().poll?.deadline, null);
  assert.equal(s.view().canVote, true);
  for (const reason of [
    'COMMUNITY_UNAVAILABLE',
    'PHONE_VERIFICATION_REQUIRED',
    'COMMUNITY_ACTION_RESTRICTED',
  ]) {
    const blocked = controller(
      poll({
        viewer: {
          hasVoted: false,
          selectedOptionIds: [],
          canVote: false,
          reason,
        },
      }),
    );
    await blocked.load();
    await blocked.controller.select(optionOne);
    assert.equal(blocked.view().canVote, false);
    assert.ok(blocked.view().blocker);
    assert.equal(
      blocked.gateway.calls.some((call) => call.method === 'castBallot'),
      false,
    );
  }
});
test('parent clear and root app-hide cancel poll reads and prevent late or background repopulation', async () => {
  const s = controller();
  const late = deferred<Poll>();
  s.gateway.pollImpl = (_id, cancel) => {
    assert.equal(cancel.isCancelled, false);
    return late.promise;
  };
  const first = s.load();
  await flush();
  await s.controller.load(null);
  late.resolve(poll());
  await first;
  assert.equal(s.view().poll, null);
  s.gateway.pollImpl = async () => poll();
  await s.load();
  s.runtime.privateViews!.clear();
  assert.equal(s.view().poll, null);
  assert.deepEqual(s.view().selectedOptionIds, []);
  const requests = s.gateway.calls.length;
  await s.load();
  assert.equal(s.gateway.calls.length, requests);
});
test('unresolved account-wide vote blocks another poll and own-publication entry exposes a safe recovery link', async () => {
  const s = controller();
  s.runtime.pendingBallots.freeze({
    version: 1,
    accountId: s.accountId,
    postId: otherId,
    payload: { clientRequestId: requestId, optionIds: [optionOne] },
  });
  await s.load();
  assert.equal(s.view().canVote, false);
  assert.equal(s.view().recoveryPostId, otherId);
  await s.controller.select(optionTwo);
  assert.equal(
    s.gateway.calls.some((call) => call.method === 'castBallot'),
    false,
  );
  const views: MineView[] = [];
  const mine = new MineController(s.runtime, (view) => views.push(view));
  await mine.load();
  assert.equal(views[views.length - 1]!.ballotRecoveryPostId, otherId);
});
test('nonpoll and wrong-parent detail never issue poll fetch; global and regional scopes rely on parent authority', async () => {
  const s = controller();
  await s.controller.load(post());
  await s.controller.load(post({ id: otherId }));
  assert.equal(s.gateway.calls.length, 0);
  const global = pollPost();
  await s.controller.load({
    ...global,
    space: { ...global.space, kind: 'global' },
    category: 'discussion',
  });
  assert.equal(s.view().canVote, true);
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'poll').length,
    1,
  );
});
