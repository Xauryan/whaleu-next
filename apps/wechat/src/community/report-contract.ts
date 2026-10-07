import { isRecord } from '../api/errors';
import { isUuid } from '../profile/contract';
import { exact, invalid, uuid4 } from './contract';

export interface ReportTarget {
  readonly kind: 'post' | 'comment' | 'reply';
  readonly id: string;
}
export type JuryVote = 'keep' | 'remove';
export type ReportOperation = 'report' | 'vote';
export type ReportIntent = { readonly clientRequestId: string } & (
  | { readonly operation: 'report'; readonly target: ReportTarget }
  | {
      readonly operation: 'vote';
      readonly postId: string;
      readonly juryId: string;
      readonly vote: JuryVote;
    }
);
export const reportRejectionCodes = [
  'REPORT_TARGET_UNAVAILABLE',
  'REPORT_SELF_NOT_ALLOWED',
  'REPORT_ALREADY_REPORTED',
  'REPORTING_CLOSED',
  'PHONE_VERIFICATION_REQUIRED',
  'AFFILIATION_VERIFICATION_REQUIRED',
  'SAFETY_ACTION_RESTRICTED',
  'JURY_NOT_FOUND',
  'JURY_INELIGIBLE',
  'JURY_ALREADY_VOTED',
  'JURY_CLOSED',
] as const;
export const reportUnavailableCodes = [
  'REPORT_SCOPE_UNAVAILABLE',
  'VERIFICATION_UNAVAILABLE',
  'SAFETY_UNAVAILABLE',
  'AUTHORIZATION_UNAVAILABLE',
] as const;
export type ReportReceipt = {
  readonly requestId: string;
  readonly operation: ReportOperation;
} & (
  | { readonly outcome: 'accepted'; readonly receiptId: string }
  | {
      readonly outcome: 'rejected';
      readonly code: (typeof reportRejectionCodes)[number];
    }
);
export interface ReportCapability {
  readonly status: 'allow' | 'deny' | 'unavailable';
  readonly code: string | null;
  readonly evaluatedAt: string;
}
export interface PostJury {
  readonly juryId: string;
  readonly state: 'pending' | 'settlement_pending' | 'kept';
  readonly createdAt: string;
  readonly deadline: string;
  readonly keepVotes: number;
  readonly removeVotes: number;
  readonly ownVote: JuryVote | null;
  readonly voteCapability: ReportCapability;
}
interface ProgressBase {
  readonly id: string;
  readonly reportCount: number;
  readonly hasReported: boolean;
  readonly isSelf: boolean;
  readonly reportCapability: ReportCapability;
}
export type ReportProgress = ProgressBase &
  (
    | {
        readonly kind: 'post';
        readonly effectiveWeight: number;
        readonly jury: PostJury | null;
      }
    | {
        readonly kind: 'comment' | 'reply';
        readonly review: 'provider_disabled' | null;
      }
  );
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const count = (value: unknown, max: number): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= max;
export function decodeReportTarget(value: unknown): ReportTarget {
  exact(value, ['kind', 'id']);
  if (
    !['post', 'comment', 'reply'].includes(value.kind as string) ||
    !isUuid(value.id)
  )
    invalid();
  return Object.freeze({
    kind: value.kind as ReportTarget['kind'],
    id: value.id,
  });
}
export function decodeReportIntent(value: unknown): ReportIntent {
  if (!isRecord(value) || !uuid4(value.clientRequestId)) invalid();
  if (value.operation === 'report') {
    exact(value, ['clientRequestId', 'operation', 'target']);
    return Object.freeze({
      clientRequestId: value.clientRequestId as string,
      operation: 'report',
      target: decodeReportTarget(value.target),
    });
  }
  exact(value, ['clientRequestId', 'operation', 'postId', 'juryId', 'vote']);
  if (
    value.operation !== 'vote' ||
    !isUuid(value.postId) ||
    !isUuid(value.juryId) ||
    !['keep', 'remove'].includes(value.vote as string)
  )
    invalid();
  return Object.freeze({
    clientRequestId: value.clientRequestId as string,
    operation: 'vote',
    postId: value.postId,
    juryId: value.juryId,
    vote: value.vote as JuryVote,
  });
}
export function decodeReportReceipt(value: unknown): ReportReceipt {
  if (
    !isRecord(value) ||
    !uuid4(value.requestId) ||
    !['report', 'vote'].includes(value.operation as string)
  )
    invalid();
  const operation = value.operation as ReportOperation;
  if (value.outcome === 'accepted') {
    exact(value, ['requestId', 'operation', 'outcome', 'receiptId']);
    if (!isUuid(value.receiptId)) invalid();
    return Object.freeze({
      requestId: value.requestId as string,
      operation,
      outcome: 'accepted',
      receiptId: value.receiptId,
    });
  }
  exact(value, ['requestId', 'operation', 'outcome', 'code']);
  if (
    value.outcome !== 'rejected' ||
    !(reportRejectionCodes as readonly unknown[]).includes(value.code)
  )
    invalid();
  return Object.freeze({
    requestId: value.requestId as string,
    operation,
    outcome: 'rejected',
    code: value.code as (typeof reportRejectionCodes)[number],
  });
}
export function matchReportReceipt(
  intent: ReportIntent,
  receipt: ReportReceipt,
): void {
  if (
    intent.clientRequestId !== receipt.requestId ||
    intent.operation !== receipt.operation
  )
    invalid();
}
export function decodeReportCapability(value: unknown): ReportCapability {
  exact(value, ['status', 'code', 'evaluatedAt']);
  if (!timestamp(value.evaluatedAt)) invalid();
  if (value.status === 'allow') {
    if (value.code !== null) invalid();
  } else if (value.status === 'deny') {
    if (
      !(reportRejectionCodes as readonly unknown[]).includes(value.code) ||
      value.code === 'REPORT_TARGET_UNAVAILABLE' ||
      value.code === 'JURY_NOT_FOUND'
    )
      invalid();
  } else if (value.status === 'unavailable') {
    if (!(reportUnavailableCodes as readonly unknown[]).includes(value.code))
      invalid();
  } else invalid();
  return Object.freeze({
    status: value.status as ReportCapability['status'],
    code: value.code as string | null,
    evaluatedAt: value.evaluatedAt,
  });
}
function decodeJury(value: unknown): PostJury {
  exact(value, [
    'juryId',
    'state',
    'createdAt',
    'deadline',
    'keepVotes',
    'removeVotes',
    'ownVote',
    'voteCapability',
  ]);
  if (
    !isUuid(value.juryId) ||
    !['pending', 'settlement_pending', 'kept'].includes(
      value.state as string,
    ) ||
    !timestamp(value.createdAt) ||
    !timestamp(value.deadline) ||
    Date.parse(value.deadline) - Date.parse(value.createdAt) !== 86_400_000 ||
    !count(value.keepVotes, 6) ||
    !count(value.removeVotes, 5) ||
    value.keepVotes + value.removeVotes > 11 ||
    ![null, 'keep', 'remove'].includes(value.ownVote as null) ||
    (value.ownVote === 'keep' && value.keepVotes === 0) ||
    (value.ownVote === 'remove' && value.removeVotes === 0)
  )
    invalid();
  const voteCapability = decodeReportCapability(value.voteCapability);
  if (
    (value.state !== 'pending' || value.ownVote !== null) &&
    voteCapability.status === 'allow'
  )
    invalid();
  if (
    value.state !== 'kept' &&
    (value.keepVotes >= 6 || value.removeVotes >= 6)
  )
    invalid();
  if (value.state === 'kept' && value.removeVotes > value.keepVotes) invalid();
  return Object.freeze({
    juryId: value.juryId,
    state: value.state as PostJury['state'],
    createdAt: value.createdAt,
    deadline: value.deadline,
    keepVotes: value.keepVotes,
    removeVotes: value.removeVotes,
    ownVote: value.ownVote as JuryVote | null,
    voteCapability,
  });
}
export function decodeReportProgress(value: unknown): ReportProgress {
  if (!isRecord(value)) invalid();
  const post = value.kind === 'post';
  exact(value, [
    'kind',
    'id',
    'reportCount',
    'hasReported',
    'isSelf',
    'reportCapability',
    ...(post ? ['effectiveWeight', 'jury'] : ['review']),
  ]);
  const target = decodeReportTarget({ kind: value.kind, id: value.id });
  if (
    !count(value.reportCount, post ? 5 : 9) ||
    typeof value.hasReported !== 'boolean' ||
    typeof value.isSelf !== 'boolean' ||
    (value.hasReported && (value.reportCount === 0 || value.isSelf))
  )
    invalid();
  const reportCapability = decodeReportCapability(value.reportCapability);
  if (
    (value.hasReported || value.isSelf) &&
    reportCapability.status === 'allow'
  )
    invalid();
  const base = {
    id: target.id,
    reportCount: value.reportCount,
    hasReported: value.hasReported,
    isSelf: value.isSelf,
    reportCapability,
  };
  if (post) {
    if (
      !count(value.effectiveWeight, 9) ||
      (value.effectiveWeight !== value.reportCount &&
        (value.reportCount === 0 ||
          value.effectiveWeight !== value.reportCount + 4))
    )
      invalid();
    const jury = value.jury === null ? null : decodeJury(value.jury);
    if (
      value.effectiveWeight >= 5 !== (jury !== null) ||
      (jury && reportCapability.status === 'allow') ||
      (jury &&
        (value.isSelf || value.hasReported) &&
        (jury.ownVote !== null || jury.voteCapability.status === 'allow'))
    )
      invalid();
    return Object.freeze({
      ...base,
      kind: 'post',
      effectiveWeight: value.effectiveWeight,
      jury,
    });
  }
  if (
    ![null, 'provider_disabled'].includes(value.review as null) ||
    (value.reportCount === 0) !== (value.review === null)
  )
    invalid();
  return Object.freeze({
    ...base,
    kind: target.kind as 'comment' | 'reply',
    review: value.review as 'provider_disabled' | null,
  });
}
