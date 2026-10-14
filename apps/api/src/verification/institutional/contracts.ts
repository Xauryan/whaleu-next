import { createHash } from 'node:crypto';
import { z } from 'zod';
export const INSTITUTIONAL_CONSENT =
  'institutional-verification-link/v1' as const;
export const INSTITUTIONAL_PURPOSE = 'institutional_verification' as const;
export const institutionalPrepareSchema = z.strictObject({
  requestId: z.uuid(),
  campusId: z.uuid(),
  capabilityVersion: z.string().regex(/^[a-f0-9]{64}$/),
  consent: z.literal(INSTITUTIONAL_CONSENT),
});
export type InstitutionalPrepare = z.infer<typeof institutionalPrepareSchema>;
export const institutionalHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const institutionalResponseSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (v) => Buffer.byteLength(v, 'utf8') <= 4096 && !/[\p{Cc}\p{Cf}]/u.test(v),
  );
export const institutionalCompleteSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('authorize'),
    requestHash: institutionalHashSchema,
    authorizationResponse: institutionalResponseSchema,
  }),
  z.strictObject({
    mode: z.literal('recover'),
    requestHash: institutionalHashSchema,
  }),
]);
export type InstitutionalComplete = z.infer<typeof institutionalCompleteSchema>;
export const institutionalCloseSchema = z.strictObject({
  requestHash: institutionalHashSchema,
});
export const institutionalCapabilitySchema = z.strictObject({
  campusId: z.uuid(),
  state: z.enum([
    'eligible',
    'not_applicable',
    'provider_unconfigured',
    'provider_unavailable',
    'account_restricted',
    'verification_conflict',
  ]),
  schoolName: z.string().nullable(),
  capabilityVersion: institutionalHashSchema.nullable(),
  consent: z.literal(INSTITUTIONAL_CONSENT).nullable(),
  purpose: z.literal(INSTITUTIONAL_PURPOSE),
  supportedFacts: z.array(z.enum(['affiliation', 'student_number'])).max(2),
});
export type InstitutionalCapability = z.infer<
  typeof institutionalCapabilitySchema
>;
export const institutionalContextSchema = z.strictObject({
  campusId: z.uuid(),
  capabilityVersion: institutionalHashSchema,
  consent: z.literal(INSTITUTIONAL_CONSENT),
});
const base = { requestId: z.uuid(), requestHash: institutionalHashSchema };
export const institutionalReceiptSchema = z.union([
  z.strictObject({
    ...base,
    state: z.literal('prepared'),
    context: institutionalContextSchema,
    expiresAt: z.string(),
  }),
  z.strictObject({
    ...base,
    state: z.literal('completed'),
    changedFacts: z.array(z.enum(['affiliation', 'student_number'])).max(2),
    uidOutcome: z.enum(['issued', 'retained', 'deferred_unavailable']),
    uidReason: z
      .enum(['inventory_unknown', 'account_history_unknown'])
      .nullable(),
  }),
  z.strictObject({
    ...base,
    state: z.enum([
      'processing',
      'outcome_unknown',
      'ready_to_finalize',
      'cancelled',
      'expired',
      'rejected',
      'challenge_required',
      'provider_unavailable',
      'conflict',
      'stale',
    ]),
  }),
  z.strictObject({
    requestId: z.uuid(),
    requestHash: z.null(),
    state: z.literal('not_recorded'),
  }),
]);
export type InstitutionalReceipt = z.infer<typeof institutionalReceiptSchema>;
export function institutionalRequestHash(
  account: string,
  input: InstitutionalPrepare,
): string {
  return createHash('sha256')
    .update(
      'whaleu:institutional-sso-command:v1\n' +
        [
          account,
          input.requestId,
          input.campusId,
          input.capabilityVersion,
          input.consent,
          INSTITUTIONAL_PURPOSE,
        ].join('\n'),
    )
    .digest('hex');
}
export const institutionalTerminalStates = new Set([
  'completed',
  'cancelled',
  'expired',
  'rejected',
  'challenge_required',
  'provider_unavailable',
  'conflict',
  'stale',
]);
