import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import {
  ReportMutationController,
  ReportProgressController,
  type ReportMutationView,
  type ReportProgressView,
} from '../src/community/report-controller';
import type {
  ReportProgress,
  ReportReceipt,
} from '../src/community/report-contract';
import { PendingReportStore } from '../src/community/report-pending';
import {
  FeedController,
  type FeedView,
} from '../src/pages/community-feed/controller';
import {
  DetailController,
  type DetailView,
} from '../src/pages/community-detail/controller';
import { FakeClock, deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  commentId,
  createdAt,
  otherId,
  post,
  postId,
  requestId,
} from './community-helpers';
import {
  deny,
  juryProgress,
  reportHarness,
  reportProgress,
  reportReceipt,
  voteIntent,
} from './report-helpers';
const candidate = { id: postId, viewer: { isSelf: false } };
test('one confirmation report accepts anonymous nonself post/root/reply references only and cancel sends nothing', async () => {
  const s = reportHarness();
  s.controller.requestReport('post', {
    ...candidate,
    viewer: { isSelf: true },
  });
  assert.equal(s.view().confirmation, null);
  for (const kind of ['post', 'comment', 'reply'] as const) {
    s.controller.requestReport(kind, candidate);
    assert.equal(s.view().confirmation?.operation, 'report');
    s.controller.dismiss();
    await s.controller.confirm();
  }
  assert.equal(s.sent.length, 0);
  s.controller.requestReport('reply', candidate);
  s.controller.requestReport('post', { ...candidate, id: otherId });
  await s.controller.confirm();
  assert.equal(s.sent.length, 1);
  assert.deepEqual(s.sent[0], {
    operation: 'report',
    clientRequestId: requestId,
    target: { kind: 'reply', id: postId },
  });
  assert.match(s.view().receiptStatus, /不代表已审核或已删除/);
  assert.equal(s.view().frozen, false);
});
test('freeze/readback precedes dispatch; report and jury journals cannot overwrite each other or ordinary polls', async () => {
  const s = reportHarness(),
    late = deferred<ReportReceipt>();
  s.runtime.pendingJuryVotes.freeze({
    version: 1,
    accountId: s.accountId,
    intent: voteIntent(),
  });
  s.behavior.apply = async (intent) => {
    assert.deepEqual(
      s.runtime.pendingReports.load(s.accountId)?.intent,
      intent,
    );
    return late.promise;
  };
  s.controller.requestReport('post', candidate);
  const running = s.controller.confirm();
  await flush();
  await s.controller.confirm();
  s.controller.requestReport('comment', candidate);
  assert.equal(s.sent.length, 1);
  assert.ok(s.runtime.pendingJuryVotes.load(s.accountId));
  late.resolve(reportReceipt());
  await running;
  assert.equal(s.runtime.pendingReports.load(s.accountId), null);
  assert.ok(s.runtime.pendingJuryVotes.load(s.accountId));
  assert.equal(
    new PendingReportStore(s.storage, 'other-origin', 'vote').load(s.accountId),
    null,
  );
  assert.equal(s.runtime.pendingJuryVotes.load(otherId), null);
  assert.throws(() =>
    s.runtime.pendingReports.freeze({
      version: 1,
      accountId: s.accountId,
      intent: voteIntent(),
    }),
  );
});
test('lost response survives restart and unavailable target; notfound retains original key and exact retry only', async () => {
  const s = reportHarness();
  s.behavior.apply = async () => {
    throw new ClientError('timeout', 'synthetic');
  };
  s.controller.requestReport('post', candidate);
  await s.controller.confirm();
  const frozen = s.runtime.pendingReports.load(s.accountId)!;
  s.controller.dispose();
  const views: ReportMutationView[] = [],
    reopened = new ReportMutationController(s.runtime, 'report', (v) =>
      views.push(v),
    );
  reopened.load();
  assert.equal(views[views.length - 1]!.frozen, true);
  s.behavior.receipt = async () => {
    throw new ClientError('http', 'missing', {
      serverCode: 'REQUEST_NOT_FOUND',
    });
  };
  await reopened.recover();
  assert.deepEqual(s.runtime.pendingReports.load(s.accountId), frozen);
  s.behavior.progress = async () => {
    throw new ClientError('http', 'removed', {
      serverCode: 'REPORT_TARGET_UNAVAILABLE',
    });
  };
  s.behavior.apply = async (intent) => reportReceipt(intent);
  await reopened.recover(true);
  assert.deepEqual(s.sent[1], frozen.intent);
  assert.equal(views[views.length - 1]!.frozen, false);
  assert.equal(s.runtime.pendingReports.load(s.accountId), null);
  reopened.dispose();
});
test('malformed/mismatched receipt preserves journal and cannot invalidate current content', async () => {
  const s = reportHarness();
  let invalidations = 0;
  s.runtime.safetyChanges.subscribe(() => invalidations++);
  s.behavior.apply = async () => ({ ...reportReceipt(), requestId: otherId });
  s.controller.requestReport('post', candidate);
  await s.controller.confirm();
  assert.equal(invalidations, 0);
  assert.ok(s.runtime.pendingReports.load(s.accountId));
  assert.equal(s.view().receiptStatus, '');
  s.behavior.receipt = async () =>
    ({
      ...reportReceipt(),
      outcome: 'rejected',
      code: 'REPORT_SELF_NOT_ALLOWED',
    }) as ReportReceipt;
  // Extra receiptId would be an invalid hybrid and must not release the barrier.
  await s.controller.recover();
  assert.equal(invalidations, 0);
  assert.ok(s.runtime.pendingReports.load(s.accountId));
  s.behavior.receipt = async () => ({
    requestId,
    operation: 'report',
    outcome: 'rejected',
    code: 'REPORT_SELF_NOT_ALLOWED',
  });
  await s.controller.recover();
  assert.equal(invalidations, 1);
  assert.equal(s.runtime.pendingReports.load(s.accountId), null);
  assert.match(s.view().receiptStatus, /自己/);
});
test('committed result invalidates feed before journal cleanup failure, keeps known receipt and recovery barrier', async () => {
  const s = reportHarness(),
    views: FeedView[] = [];
  s.gateway.feedImpl = async () => ({
    items: [post()],
    nextCursor: null,
    continuation: 'end',
  });
  const feed = new FeedController(s.runtime, (v) => views.push(v));
  await feed.load();
  assert.equal(views[views.length - 1]!.posts.length, 1);
  let invalidated = false;
  s.runtime.safetyChanges.subscribe(() => (invalidated = true));
  s.storage.remove = () => {
    assert.equal(invalidated, true);
    throw Error('storage unavailable');
  };
  s.behavior.apply = async (intent) => {
    s.gateway.feedImpl = async () => ({
      items: [],
      nextCursor: null,
      continuation: 'end',
    });
    return reportReceipt(intent);
  };
  s.controller.requestReport('post', candidate);
  await s.controller.confirm();
  await flush();
  assert.deepEqual(views[views.length - 1]!.posts, []);
  assert.ok(s.runtime.pendingReports.load(s.accountId));
  assert.equal(s.view().frozen, true);
  assert.match(s.view().receiptStatus, /已受理/);
  assert.match(s.view().status, /本地记录尚未清理/);
  feed.dispose();
});
test('failed persistence sends nothing; same-account relogin and account-switch late results never settle', async () => {
  const s = reportHarness();
  s.storage.failWrite = true;
  s.controller.requestReport('post', candidate);
  await s.controller.confirm();
  assert.equal(s.sent.length, 0);
  s.storage.failWrite = false;
  s.controller.load();
  const result = deferred<ReportReceipt>();
  s.behavior.apply = () => result.promise;
  s.controller.requestReport('post', candidate);
  const running = s.controller.confirm();
  await flush();
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('b'));
  result.resolve(reportReceipt());
  await running;
  assert.ok(s.runtime.pendingReports.load(s.accountId));
  assert.equal(s.view().receiptStatus, '');
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('c'),
    accountId: otherId,
  });
  s.controller.load();
  assert.equal(s.view().frozen, false);
  assert.equal(s.runtime.pendingReports.load(otherId), null);
});
test('cancel before request ID prevents persistence; cancel/app hide after dispatch preserves recovery and blocks callback', async () => {
  const s = reportHarness(),
    id = deferred<string>();
  s.runtime.newRequestId = () => id.promise;
  s.controller.requestReport('post', candidate);
  const before = s.controller.confirm();
  await flush();
  s.controller.cancel();
  id.resolve(requestId);
  await before;
  assert.equal(s.sent.length, 0);
  s.runtime.newRequestId = async () => requestId;
  const result = deferred<ReportReceipt>();
  s.behavior.apply = () => result.promise;
  s.controller.requestReport('post', candidate);
  const running = s.controller.confirm();
  await flush();
  s.runtime.privateViews!.clear();
  result.resolve(reportReceipt());
  await running;
  assert.ok(s.runtime.pendingReports.load(s.accountId));
  assert.equal(s.view().confirmation, null);
  assert.equal(s.view().receiptStatus, '');
});
test('jury choice is immutable post/jury-bound, blocks authors/reporters/closed/unknown capabilities and ordinary ballot shapes', async () => {
  const s = reportHarness('vote'),
    valid = juryProgress(),
    jury = valid.jury!;
  for (const raw of [
    {
      ...valid,
      isSelf: true,
      jury: { ...jury, voteCapability: deny('JURY_INELIGIBLE') },
    },
    {
      ...valid,
      hasReported: true,
      jury: { ...jury, voteCapability: deny('JURY_INELIGIBLE') },
    },
    {
      ...valid,
      jury: {
        ...jury,
        state: 'settlement_pending',
        voteCapability: deny('JURY_CLOSED'),
      },
    },
    {
      ...valid,
      jury: {
        ...jury,
        ownVote: 'keep',
        keepVotes: 1,
        voteCapability: deny('JURY_ALREADY_VOTED'),
      },
    },
  ]) {
    s.controller.requestVote(raw as ReportProgress, 'remove');
    assert.equal(s.view().confirmation, null);
  }
  s.controller.requestVote(valid, 'remove');
  s.controller.requestVote(valid, 'keep');
  await s.controller.confirm();
  assert.deepEqual(s.sent[0], { ...voteIntent(), vote: 'remove' });
  assert.match(s.view().receiptStatus, /最终结果/);
});
test('progress independent from detail and cert capabilities; a failing unknown read is never no-jury', async () => {
  const s = reportHarness(),
    views: ReportProgressView[] = [],
    detailViews: DetailView[] = [];
  const progress = new ReportProgressController(
    s.runtime,
    { kind: 'post', id: postId },
    (v) => views.push(v),
  );
  const detail = new DetailController(s.runtime, postId, (v) =>
    detailViews.push(v),
  );
  s.behavior.progress = async () => ({
    ...reportProgress(),
    reportCapability: {
      status: 'unavailable',
      code: 'VERIFICATION_UNAVAILABLE',
      evaluatedAt: createdAt,
    },
  });
  await Promise.all([detail.load(), progress.load()]);
  assert.equal(detailViews[detailViews.length - 1]!.loaded, true);
  assert.equal(views[views.length - 1]!.loaded, true);
  assert.equal(views[views.length - 1]!.canReport, false);
  assert.equal(views[views.length - 1]!.progress!.reportCount, 0);
  s.behavior.progress = async () => {
    throw new ClientError('http', 'coverage', {
      serverCode: 'SAFETY_UNAVAILABLE',
    });
  };
  await progress.load();
  assert.equal(detailViews[detailViews.length - 1]!.loaded, true);
  assert.equal(views[views.length - 1]!.progress, null);
  assert.equal(views[views.length - 1]!.loaded, false);
  assert.match(views[views.length - 1]!.status, /不能据此认定/);
  progress.dispose();
  detail.dispose();
});
test('eligible unvoted jury hides inline tallies; own immutable ballot reveals them without ordinary poll fields', async () => {
  const s = reportHarness(),
    views: ReportProgressView[] = [],
    clock = new FakeClock();
  s.behavior.progress = async () => juryProgress();
  const progress = new ReportProgressController(
    s.runtime,
    { kind: 'post', id: postId },
    (v) => views.push(v),
    clock,
  );
  await progress.load();
  assert.equal(views[views.length - 1]!.canVote, true);
  assert.equal(views[views.length - 1]!.showTallies, false);
  s.behavior.progress = async () => ({
    ...juryProgress(),
    jury: {
      ...juryProgress().jury!,
      keepVotes: 1,
      ownVote: 'keep',
      voteCapability: deny('JURY_ALREADY_VOTED'),
    },
  });
  await progress.load();
  assert.equal(views[views.length - 1]!.canVote, false);
  assert.equal(views[views.length - 1]!.showTallies, true);
  progress.dispose();
  assert.equal(clock.timers, 0);
});
test('deadline timer only reloads authoritative status; no local settlement, tie decision or stale snapshot restoration', async () => {
  const s = reportHarness(),
    clock = new FakeClock(),
    views: ReportProgressView[] = [];
  clock.advance(Date.parse('2026-10-07T23:59:59.000Z') - clock.now());
  let reads = 0;
  const late = deferred<ReportProgress>();
  s.behavior.progress = async () => {
    reads++;
    return reads === 1 ? juryProgress() : late.promise;
  };
  const progress = new ReportProgressController(
    s.runtime,
    { kind: 'post', id: postId },
    (v) => views.push(v),
    clock,
  );
  await progress.load();
  clock.advance(1000);
  await flush();
  assert.equal(reads, 2);
  assert.equal(views[views.length - 1]!.progress, null);
  assert.equal(s.sent.length, 0);
  progress.cancel();
  late.resolve({
    ...juryProgress(),
    jury: {
      ...juryProgress().jury!,
      state: 'kept',
      voteCapability: deny('JURY_CLOSED'),
    },
  });
  await flush();
  assert.equal(views[views.length - 1]!.loaded, false);
  assert.equal(clock.timers, 0);
  progress.dispose();
});
test('progress safety invalidation cancels old reader and session change clears counts and timers', async () => {
  const s = reportHarness(),
    clock = new FakeClock(),
    views: ReportProgressView[] = [];
  const old = deferred<ReportProgress>();
  s.behavior.progress = () => old.promise;
  const progress = new ReportProgressController(
    s.runtime,
    { kind: 'post', id: postId },
    (v) => views.push(v),
    clock,
  );
  const running = progress.load();
  await flush();
  s.behavior.progress = async () => juryProgress();
  s.runtime.safetyChanges.invalidate(s.accountId);
  await flush();
  old.resolve(reportProgress());
  await running;
  assert.equal(views[views.length - 1]!.progress?.reportCount, 5);
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: otherId,
  });
  assert.equal(views[views.length - 1]!.progress, null);
  assert.equal(clock.timers, 0);
  progress.dispose();
});
test('discussion progress has provider-disabled review and typed-target binding, without needing detail render', async () => {
  const s = reportHarness(),
    views: ReportProgressView[] = [];
  s.behavior.progress = async () => ({
    kind: 'comment',
    id: commentId,
    reportCount: 9,
    hasReported: false,
    isSelf: false,
    reportCapability: {
      status: 'deny',
      code: 'PHONE_VERIFICATION_REQUIRED',
      evaluatedAt: createdAt,
    },
    review: 'provider_disabled',
  });
  const progress = new ReportProgressController(
    s.runtime,
    { kind: 'comment', id: commentId },
    (v) => views.push(v),
  );
  await progress.load();
  assert.equal(views[views.length - 1]!.loaded, true);
  assert.equal(views[views.length - 1]!.progress!.reportCount, 9);
  assert.equal(views[views.length - 1]!.canReport, false);
  progress.dispose();
});
test('automatic removal observed by deadline status invalidates stale detail/media once without a reload loop', async () => {
  const s = reportHarness(),
    clock = new FakeClock(),
    progressViews: ReportProgressView[] = [],
    detailViews: DetailView[] = [];
  clock.advance(Date.parse('2026-10-07T23:59:59.000Z') - clock.now());
  s.behavior.progress = async () => juryProgress();
  const detail = new DetailController(s.runtime, postId, (v) =>
    detailViews.push(v),
  );
  const progress = new ReportProgressController(
    s.runtime,
    { kind: 'post', id: postId },
    (v) => progressViews.push(v),
    clock,
  );
  await Promise.all([detail.load(), progress.load()]);
  assert.equal(detailViews[detailViews.length - 1]!.loaded, true);
  let invalidations = 0,
    reads = 0;
  s.runtime.safetyChanges.subscribe(() => invalidations++);
  s.behavior.progress = async () => {
    reads++;
    throw new ClientError('http', 'removed', {
      serverCode: 'REPORT_TARGET_UNAVAILABLE',
      httpStatus: 404,
    });
  };
  s.gateway.postImpl = async () => {
    throw new ClientError('http', 'unavailable', {
      serverCode: 'POST_NOT_FOUND',
      httpStatus: 404,
    });
  };
  clock.advance(1000);
  await flush();
  assert.equal(invalidations, 1);
  assert.equal(reads, 1);
  assert.equal(detailViews[detailViews.length - 1]!.post, null);
  assert.equal(progressViews[progressViews.length - 1]!.progress, null);
  assert.equal(clock.timers, 0);
  await progress.load();
  assert.equal(invalidations, 1);
  assert.equal(reads, 2);
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('b'));
  await progress.load();
  assert.equal(invalidations, 2);
  detail.dispose();
  progress.dispose();
});
test('cleanup that deletes and then throws restores the same durable receipt key for restart recovery', async () => {
  const s = reportHarness();
  const remove = s.storage.remove.bind(s.storage);
  s.storage.remove = (key) => {
    remove(key);
    throw Error('adapter failed after removal');
  };
  s.controller.requestReport('post', candidate);
  await s.controller.confirm();
  assert.equal(s.view().frozen, true);
  assert.equal(
    s.runtime.pendingReports.load(s.accountId)?.intent.clientRequestId,
    requestId,
  );
  s.controller.dispose();
  s.storage.remove = remove;
  const views: ReportMutationView[] = [],
    reopened = new ReportMutationController(s.runtime, 'report', (v) =>
      views.push(v),
    );
  reopened.load();
  await reopened.recover();
  assert.equal(views[views.length - 1]!.frozen, false);
  assert.equal(s.sent.length, 1);
  assert.equal(s.runtime.pendingReports.load(s.accountId), null);
  reopened.dispose();
});
