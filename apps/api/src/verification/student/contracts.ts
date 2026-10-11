import { z } from 'zod';
export const studentId = z.uuid().refine((id) => id === id.toLowerCase());
export const studentEmpty = z.strictObject({}).default({});
export const reserveStudentSchema = z.strictObject({
  clientRequestId: studentId,
  campusId: studentId,
});
export const studentEvidenceUploadSchema = z.strictObject({
  protocol: z.literal('verification-evidence-media-v1'),
  kind: z.literal('verification-evidence-upload'),
  assetId: studentId,
});
export const submitStudentSchema = z.strictObject({
  clientRequestId: studentId,
  expectedRevision: z.number().int().positive(),
  evidence: studentEvidenceUploadSchema,
});
export const withdrawStudentSchema = z.strictObject({
  clientRequestId: studentId,
  expectedRevision: z.number().int().positive(),
});
const reason = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (s) =>
      ![...s].some((c) => {
        const n = c.codePointAt(0)!;
        return n < 32 || n === 127;
      }),
  );
export const decideStudentSchema = z.discriminatedUnion('decision', [
  z.strictObject({
    clientRequestId: studentId,
    expectedRevision: z.number().int().positive(),
    decision: z.literal('approved'),
  }),
  z.strictObject({
    clientRequestId: studentId,
    expectedRevision: z.number().int().positive(),
    decision: z.literal('rejected'),
    reason,
  }),
]);
export const studentQueueSchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  cursor: studentId.optional(),
});
export type StudentApplicationState =
  'draft' | 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'expired';
export interface StudentApplicationRow {
  id: string;
  account_id: string;
  client_request_id: string;
  campus_id: string;
  institution_id: string;
  region_id: string;
  campus_version: string;
  revision: number;
  state: StudentApplicationState;
  evidence_id: string | null;
  evidence_revision: number | null;
  evidence_expires_at: Date | null;
  evidence_policy_ref: string | null;
  created_at: Date;
  submitted_at: Date | null;
  decision_id: string | null;
}
export interface StudentReceipt {
  requestId: string;
  applicationId: string;
  revision: number;
  state: StudentApplicationState;
}
export type ReserveStudent = z.infer<typeof reserveStudentSchema>;
export type SubmitStudent = z.infer<typeof submitStudentSchema>;
export type DecideStudent = z.infer<typeof decideStudentSchema>;
export type WithdrawStudent = z.infer<typeof withdrawStudentSchema>;

export const cancelStudentRequestSchema = z.strictObject({
  requestHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export const studentApplicationSchema = z.strictObject({
  id: studentId,
  revision: z.number().int().positive(),
  state: z.enum([
    'draft',
    'pending',
    'approved',
    'rejected',
    'withdrawn',
    'expired',
  ]),
  campusId: studentId,
  campusName: z.string().max(200),
  institutionName: z.string().max(200),
  regionId: studentId,
  profileId: studentId.nullable(),
  submittedAt: z.iso.datetime().nullable(),
  reason: z.string().max(200).nullable(),
  evidenceRevision: z.number().int().positive().nullable(),
  evidenceAvailable: z.boolean(),
  evidenceExpiresAt: z.iso.datetime().nullable(),
});
export const studentReceiptSchema = z.strictObject({
  requestId: studentId,
  applicationId: studentId,
  revision: z.number().int().positive(),
  state: z.enum([
    'draft',
    'pending',
    'approved',
    'rejected',
    'withdrawn',
    'expired',
  ]),
});
export const studentOwnSchema = z.strictObject({
  application: studentApplicationSchema.nullable(),
  canApply: z.boolean(),
});
export const studentRecoverySchema = z.strictObject({
  requestId: studentId,
  state: z.enum(['recorded', 'not_recorded', 'cancelled']),
  receipt: studentReceiptSchema.nullable(),
});
export const studentQueuePageSchema = z.strictObject({
  items: z.array(studentApplicationSchema).max(20),
  page: z.number().int().positive(),
  hasNext: z.boolean(),
  nextCursor: studentId.nullable(),
});
export const studentCapabilitiesSchema = z.strictObject({
  management: z.enum(['none', 'fixed', 'global']),
  region: z
    .strictObject({ id: studentId, name: z.string().max(200) })
    .nullable(),
});
export const studentNoticePageSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        id: studentId,
        kind: z.enum(['student_auth', 'auth_result']),
        outcome: z.enum(['pending', 'approved', 'rejected']),
        createdAt: z.iso.datetime(),
        read: z.boolean(),
        available: z.boolean(),
      }),
    )
    .max(20),
  page: z.number().int().positive(),
  hasNext: z.boolean(),
});
export const studentNoticeTargetSchema = z.strictObject({
  status: z.enum(['available', 'unavailable']),
  target: z
    .strictObject({ applicationId: studentId, regionId: studentId.nullable() })
    .nullable(),
});
