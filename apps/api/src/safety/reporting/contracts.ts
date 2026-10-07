import { z } from 'zod';
// Reports remain content-only. Expanding named block sources must never
// implicitly add a report target domain or moderation authority.
export const reportTargetSchema = z.strictObject({
  kind: z.enum(['post', 'comment', 'reply']),
  id: z.uuid().transform((id) => id.toLowerCase()),
});
export const reportRequestSchema = z.strictObject({
  clientRequestId: z.uuidv4().transform((x) => x.toLowerCase()),
  target: reportTargetSchema,
});
export const juryVoteSchema = z.strictObject({
  clientRequestId: z.uuidv4().transform((x) => x.toLowerCase()),
  postId: z.uuid().transform((x) => x.toLowerCase()),
  juryId: z.uuid().transform((x) => x.toLowerCase()),
  vote: z.enum(['keep', 'remove']),
});
export type ReportTarget = z.infer<typeof reportTargetSchema>;
export type ReportRequest = z.infer<typeof reportRequestSchema>;
export type JuryVoteRequest = z.infer<typeof juryVoteSchema>;
export const terminalReportCodes = [
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
export type ReportRejectionCode = (typeof terminalReportCodes)[number];
export const capabilityUnavailableCodes = [
  'REPORT_SCOPE_UNAVAILABLE',
  'VERIFICATION_UNAVAILABLE',
  'SAFETY_UNAVAILABLE',
  'AUTHORIZATION_UNAVAILABLE',
] as const;
export type ReportCapability =
  | { status: 'allow'; code: null; evaluatedAt: string }
  | {
      status: 'deny';
      code: Exclude<
        ReportRejectionCode,
        'REPORT_TARGET_UNAVAILABLE' | 'JURY_NOT_FOUND'
      >;
      evaluatedAt: string;
    }
  | {
      status: 'unavailable';
      code: (typeof capabilityUnavailableCodes)[number];
      evaluatedAt: string;
    };
export type ReportReceipt = {
  requestId: string;
  operation: 'report' | 'vote';
} & (
  | { outcome: 'accepted'; receiptId: string }
  | { outcome: 'rejected'; code: ReportRejectionCode }
);
export interface JuryProgress {
  juryId: string;
  state: 'pending' | 'settlement_pending' | 'kept';
  createdAt: string;
  deadline: string;
  keepVotes: number;
  removeVotes: number;
  ownVote: 'keep' | 'remove' | null;
  voteCapability: ReportCapability;
}
export type ReportProgress = {
  id: string;
  reportCount: number;
  hasReported: boolean;
  isSelf: boolean;
  reportCapability: ReportCapability;
} & (
  | { kind: 'post'; effectiveWeight: number; jury: JuryProgress | null }
  | { kind: 'comment' | 'reply'; review: 'provider_disabled' | null }
);
