import {
  ReportMutationController,
  type ReportMutationView,
} from '../src/community/report-controller';
import type { ReportGateway } from '../src/community/report-gateway';
import { PendingReportStore } from '../src/community/report-pending';
import { SafetyChanges } from '../src/community/safety-changes';
import type {
  ReportCapability,
  ReportIntent,
  ReportProgress,
  ReportReceipt,
  ReportOperation,
} from '../src/community/report-contract';
import {
  createdAt,
  otherId,
  postId,
  requestId,
  setup,
} from './community-helpers';
export const juryId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const allow = (): ReportCapability => ({
  status: 'allow',
  code: null,
  evaluatedAt: createdAt,
});
export const deny = (code: string): ReportCapability => ({
  status: 'deny',
  code,
  evaluatedAt: createdAt,
});
export const reportIntent = (): ReportIntent => ({
  operation: 'report',
  clientRequestId: requestId,
  target: { kind: 'post', id: postId },
});
export const voteIntent = (): ReportIntent => ({
  operation: 'vote',
  clientRequestId: requestId,
  postId,
  juryId,
  vote: 'keep',
});
export const reportReceipt = (
  intent: ReportIntent = reportIntent(),
): ReportReceipt => ({
  operation: intent.operation,
  requestId: intent.clientRequestId,
  outcome: 'accepted',
  receiptId: otherId,
});
export const reportProgress = (): Extract<
  ReportProgress,
  { kind: 'post' }
> => ({
  kind: 'post',
  id: postId,
  reportCount: 0,
  effectiveWeight: 0,
  hasReported: false,
  isSelf: false,
  reportCapability: allow(),
  jury: null,
});
export const juryProgress = (): Extract<ReportProgress, { kind: 'post' }> => ({
  ...reportProgress(),
  reportCount: 5,
  effectiveWeight: 5,
  reportCapability: deny('REPORTING_CLOSED'),
  jury: {
    juryId,
    state: 'pending',
    createdAt,
    deadline: '2026-10-08T00:00:00.000Z',
    keepVotes: 0,
    removeVotes: 0,
    ownVote: null,
    voteCapability: allow(),
  },
});
export function reportHarness(operation: ReportOperation = 'report') {
  const s = setup(),
    sent: ReportIntent[] = [],
    queried: string[] = [],
    views: ReportMutationView[] = [];
  const behavior: ReportGateway = {
    apply: async (intent) => reportReceipt(intent),
    receipt: async () =>
      reportReceipt(
        sent[sent.length - 1] ??
          (operation === 'report' ? reportIntent() : voteIntent()),
      ),
    progress: async () => reportProgress(),
  };
  const reports: ReportGateway = {
    apply: (...args) => {
      sent.push(args[0]);
      return behavior.apply(...args);
    },
    receipt: (...args) => {
      queried.push(args[0]);
      return behavior.receipt(...args);
    },
    progress: (...args) => behavior.progress(...args),
  };
  const runtime = {
    ...s.runtime,
    reports,
    pendingReports: new PendingReportStore(s.storage, 'synthetic', 'report'),
    pendingJuryVotes: new PendingReportStore(s.storage, 'synthetic', 'vote'),
    safetyChanges: new SafetyChanges(s.runtime.privateViews),
  };
  const controller = new ReportMutationController(runtime, operation, (view) =>
    views.push(view),
  );
  controller.load();
  return {
    ...s,
    runtime,
    behavior,
    controller,
    sent,
    queried,
    view: () => views[views.length - 1]!,
  };
}
