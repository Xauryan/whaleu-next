import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../../community/content-review/contracts.js';
import { categoryPlacementSchema } from '../category-management/scoped-contracts.js';
import {
  ratingNavigationSelectorSchema,
  ratingScopedCommandContextSchema,
  scopedDigest,
  scopedId,
} from '../scoped/contracts.js';

/** Frozen software limits. Synthetic operation cannot authorize external spend. */
export const ASSISTANCE_LIMITS = Object.freeze({
  requestBytes: 65_536,
  nativeReserveBytes: 1_024,
  nameScalars: 100,
  nameBytes: 400,
  outputEnvelopeBytes: 8_192,
  inputTokens: 512,
  outputTokens: 64,
  accountMinute: 2,
  accountDay: 20,
  accountActive: 1,
  globalActive: 32,
  workers: 4,
  claimBatch: 8,
  queueMs: 120_000,
  dispatchMs: 15_000,
  leaseMs: 30_000,
  reconcileMs: 3_000,
  attempts: 2,
  retentionMs: 1_800_000,
  cleanupBatch: 100,
  monetaryMinorUnits: 0,
});
export const ASSISTANCE_RUNTIME = Symbol('ASSISTANCE_RUNTIME');
export const ASSISTANCE_PROFILE = 'synthetic-rating-suggestion-v1' as const;
export const assistancePurposeSchema = z.enum([
  'category_description',
  'rating_publish_title',
]);
export type AssistancePurpose = z.infer<typeof assistancePurposeSchema>;
const unsafe = /[\u2028-\u202e\u2066-\u2069\ud800-\udfff]/u;
export function literalScalars(value: string): boolean {
  // The Unicode regexp treats valid surrogate pairs as a single scalar.
  return (
    value === value.trim() &&
    !unsafe.test(value) &&
    value.length > 0 &&
    [...value].every((scalar) => {
      const cp = scalar.codePointAt(0)!;
      return cp > 31 && (cp < 127 || cp > 159);
    })
  );
}
export const assistanceNameSchema = z
  .string()
  .refine(
    (v) =>
      literalScalars(v) && [...v].length <= 100 && Buffer.byteLength(v) <= 400,
  );
export const assistanceRequestIdSchema = z
  .uuidv4()
  .refine((v) => v === v.toLowerCase());
const common = {
  version: z.literal(1),
  requestId: assistanceRequestIdSchema,
  draftId: assistanceRequestIdSchema,
  inputRevision: z.number().int().min(0).max(2_147_483_647),
  selector: ratingNavigationSelectorSchema,
  context: ratingScopedCommandContextSchema,
};
const categoryCommon = {
  draftNodeKey: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  name: assistanceNameSchema,
  placement: categoryPlacementSchema,
  expectedSnapshot: scopedDigest,
};
export const categoryAssistancePayloadSchema = z.discriminatedUnion(
  'operation',
  [
    z.strictObject({
      ...categoryCommon,
      operation: z.literal('create_categories_scoped'),
      parentId: z.null(),
    }),
    z.strictObject({
      ...categoryCommon,
      operation: z.literal('create_system_category_scoped'),
      systemKey: z.string().regex(/^[a-z][a-z0-9_]{1,48}$/),
      levelCount: z.number().int().min(1).max(3),
    }),
  ],
);
export const assistanceRequestSchema = z
  .discriminatedUnion('purpose', [
    z.strictObject({
      ...common,
      purpose: z.literal('category_description'),
      payload: categoryAssistancePayloadSchema,
    }),
    z.strictObject({
      ...common,
      purpose: z.literal('rating_publish_title'),
      payload: z.strictObject({
        targetId: scopedId,
        expectedTargetRevision: scopedId,
        expectedCategoryRevision: scopedId,
        expectedSourceRevision: scopedId,
        destination: z.strictObject({
          spaceId: scopedId,
          category: z.literal('discussion'),
          authorMode: z.enum(['named', 'anonymous']),
        }),
      }),
    }),
  ])
  .refine(
    (v) => canonicalJson(v.selector) === canonicalJson(v.context.selector),
  )
  .refine(
    (v) =>
      Buffer.byteLength(JSON.stringify(v)) <= ASSISTANCE_LIMITS.requestBytes,
  );
export type AssistanceRequest = z.infer<typeof assistanceRequestSchema>;
export type CategoryAssistanceRequest = Extract<
  AssistanceRequest,
  { purpose: 'category_description' }
>;
export type TitleAssistanceRequest = Extract<
  AssistanceRequest,
  { purpose: 'rating_publish_title' }
>;
export function assistanceIntentHash(request: AssistanceRequest): string {
  return createHash('sha256')
    .update('whaleu:ratings:assistance:intent:v1\n')
    .update(canonicalJson(assistanceRequestSchema.parse(request)))
    .digest('hex');
}
export const assistanceProviderInputSchema = z.strictObject({
  name: assistanceNameSchema,
  context: z.enum(['rating_category', 'course', 'canteen']),
});
export type AssistanceProviderInput = z.infer<
  typeof assistanceProviderInputSchema
>;
export function assistanceInputDigest(
  input: AssistanceProviderInput,
  sourceRevision: string,
): string {
  return createHash('sha256')
    .update('whaleu:ratings:assistance:input:v1\n')
    .update(
      canonicalJson({
        input: assistanceProviderInputSchema.parse(input),
        sourceRevision: scopedDigest.parse(sourceRevision),
        profile: ASSISTANCE_PROFILE,
        outputContract: 1,
      }),
    )
    .digest('hex');
}
export function validAssistanceOutput(
  purpose: AssistancePurpose,
  text: string,
): boolean {
  if (
    !literalScalars(text) ||
    /[<>`{}[\]]|https?:|www\.|[a-z][a-z0-9+.-]*:\/\//iu.test(text) ||
    /^["'“”‘’]|["'“”‘’]$/u.test(text)
  )
    return false;
  const length = [...text].length;
  return purpose === 'category_description'
    ? length >= 9 &&
        length <= 11 &&
        Buffer.byteLength(text) <= 44 &&
        !/[\p{P}]$/u.test(text)
    : length >= 1 &&
        length <= 12 &&
        Buffer.byteLength(text) <= 48 &&
        /[?？]$/u.test(text);
}
export const assistanceUsageSchema = z.strictObject({
  inputTokens: z.number().int().min(0).max(512),
  outputTokens: z.number().int().min(0).max(64),
  monetaryMinorUnits: z.literal(0),
});
export const assistanceOutcomeSchema = z.enum([
  'queued',
  'claimed',
  'dispatch_admitted',
  'generated',
  'unavailable',
  'rejected',
  'cancelled',
  'expired',
  'outcome_unknown',
]);
export const assistanceMetadataSchema = z.strictObject({
  version: z.literal(1),
  requestId: assistanceRequestIdSchema,
  purpose: assistancePurposeSchema,
  intentHash: scopedDigest,
  outcome: assistanceOutcomeSchema,
});
export type AssistanceMetadata = z.infer<typeof assistanceMetadataSchema>;
export const assistanceResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('unavailable') }),
  z
    .strictObject({
      status: z.literal('available'),
      version: z.literal(1),
      actorId: scopedId,
      requestId: assistanceRequestIdSchema,
      purpose: assistancePurposeSchema,
      draftId: assistanceRequestIdSchema,
      inputRevision: common.inputRevision,
      intentHash: scopedDigest,
      inputDigest: scopedDigest,
      resultId: assistanceRequestIdSchema,
      resultDigest: scopedDigest,
      profileRevision: z.literal(ASSISTANCE_PROFILE),
      outputContract: z.literal(1),
      text: z.string(),
      expiresAt: z.iso.datetime(),
    })
    .refine(
      (v) =>
        validAssistanceOutput(v.purpose, v.text) &&
        assistanceResultDigest(v.text) === v.resultDigest,
    ),
]);
export function assistanceResultDigest(text: string): string {
  return createHash('sha256')
    .update('whaleu:ratings:assistance:result:v1\n')
    .update(text)
    .digest('hex');
}
export const assistanceCancelSchema = z.strictObject({
  purpose: assistancePurposeSchema,
  intentHash: scopedDigest,
});
