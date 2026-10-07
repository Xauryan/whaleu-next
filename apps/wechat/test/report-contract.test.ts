import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeReportCapability,
  decodeReportIntent,
  decodeReportProgress,
  decodeReportReceipt,
  matchReportReceipt,
  reportRejectionCodes,
  reportUnavailableCodes,
} from '../src/community/report-contract';
import {
  allow,
  deny,
  juryProgress,
  reportIntent,
  reportProgress,
  reportReceipt,
  voteIntent,
} from './report-helpers';
import { otherId } from './community-helpers';
test('strict report/vote target-only contracts do not accept reason evidence weight or anonymous actor identifiers', () => {
  for (const intent of [reportIntent(), voteIntent()]) {
    assert.deepEqual(decodeReportIntent(intent), intent);
    assert.deepEqual(
      decodeReportReceipt(reportReceipt(intent)),
      reportReceipt(intent),
    );
  }
  for (const key of [
    'reason',
    'evidence',
    'weight',
    'ownerAccountId',
    'campusId',
  ])
    assert.throws(() =>
      decodeReportIntent({ ...reportIntent(), [key]: 'forged' }),
    );
  for (const key of [
    'counts',
    'removed',
    'reviewed',
    'postId',
    'vote',
    'ownerAccountId',
  ])
    assert.throws(() =>
      decodeReportReceipt({ ...reportReceipt(), [key]: true }),
    );
  assert.throws(() => decodeReportIntent({ ...voteIntent(), vote: 'yes' }));
  assert.throws(() => matchReportReceipt(voteIntent(), reportReceipt()));
  assert.throws(() =>
    matchReportReceipt(reportIntent(), {
      ...reportReceipt(),
      requestId: otherId,
    }),
  );
});
test('receipt/capability enums closed; unavailable is not a committed rejection or an implicit member', () => {
  for (const code of reportRejectionCodes)
    assert.equal(
      decodeReportReceipt({
        requestId: reportIntent().clientRequestId,
        operation: 'report',
        outcome: 'rejected',
        code,
      }).outcome,
      'rejected',
    );
  for (const code of reportUnavailableCodes) {
    assert.throws(() =>
      decodeReportReceipt({
        requestId: reportIntent().clientRequestId,
        operation: 'report',
        outcome: 'rejected',
        code,
      }),
    );
    assert.equal(
      decodeReportCapability({ ...allow(), status: 'unavailable', code })
        .status,
      'unavailable',
    );
  }
  for (const value of [
    { ...allow(), code: 'REPORTING_CLOSED' },
    { ...allow(), status: 'deny' },
    { ...deny('invented') },
    { ...allow(), evaluatedAt: '2026-10-07T00:00:00Z' },
  ])
    assert.throws(() => decodeReportCapability(value));
});
test('kind-discriminated progress caps weight nine, true-self/reporting vote exclusion, immutable final and exact UTC deadline', () => {
  assert.deepEqual(decodeReportProgress(reportProgress()), reportProgress());
  assert.throws(() =>
    decodeReportProgress({ ...reportProgress(), effectiveWeight: 4 }),
  );
  assert.deepEqual(
    decodeReportProgress({ ...juryProgress(), effectiveWeight: 9 }),
    { ...juryProgress(), effectiveWeight: 9 },
  );
  const jury = juryProgress().jury!;
  for (const patch of [
    { effectiveWeight: 10 },
    { reportCount: 6 },
    { jury: null },
    { hasReported: true },
    { isSelf: true },
    { authorId: otherId },
    { jury: { ...jury, deadline: '2026-10-09T00:00:00.000Z' } },
    { jury: { ...jury, keepVotes: 6 } },
    { jury: { ...jury, removeVotes: 6 } },
    { jury: { ...jury, state: 'settlement_pending' } },
    { jury: { ...jury, ownVote: 'keep' } },
  ])
    assert.throws(() => decodeReportProgress({ ...juryProgress(), ...patch }));
  const kept = {
    ...juryProgress(),
    jury: {
      ...jury,
      state: 'kept',
      keepVotes: 6,
      removeVotes: 5,
      voteCapability: deny('JURY_CLOSED'),
    },
  };
  assert.equal(decodeReportProgress(kept).kind, 'post');
  assert.throws(() =>
    decodeReportProgress({ ...kept, reportCapability: allow() }),
  );
  assert.throws(() =>
    decodeReportProgress({
      ...reportProgress(),
      reportCount: 1,
      effectiveWeight: 0,
    }),
  );
  assert.throws(() =>
    decodeReportProgress({
      ...reportProgress(),
      reportCount: 2,
      effectiveWeight: 3,
    }),
  );
  assert.throws(() =>
    decodeReportProgress({
      ...juryProgress(),
      reportCount: 2,
      effectiveWeight: 7,
    }),
  );
});
test('discussion status exposes disabled review honestly, never a fake reviewed result or jury', () => {
  const value = {
    kind: 'comment',
    id: otherId,
    reportCount: 1,
    hasReported: true,
    isSelf: false,
    reportCapability: deny('REPORT_ALREADY_REPORTED'),
    review: 'provider_disabled',
  };
  assert.deepEqual(decodeReportProgress(value), value);
  for (const patch of [
    { review: 'reviewed' },
    { review: null },
    { jury: null },
    { reportCount: 10 },
    { reportCount: 11 },
    { reportCapability: allow() },
  ])
    assert.throws(() => decodeReportProgress({ ...value, ...patch }));
});
