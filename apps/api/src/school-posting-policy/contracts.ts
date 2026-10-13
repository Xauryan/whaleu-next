import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../community/content-review/contracts.js';

export const schoolPostingIdSchema = z
  .uuid()
  .refine((value) => value === value.toLowerCase());
export const schoolPostingRequestIdSchema = z
  .uuidv4()
  .refine((value) => value === value.toLowerCase());

/** Matches the ordinary regional exception consumed by RegionalCommunityPolicyService. */
export const schoolPostingCategories = [
  'discussion',
  'confession',
  'companions',
  'pets',
  'internships',
  'scenery',
  'dorms',
  'research',
  'deep_sea',
] as const;
export const schoolPostingCategorySchema = z.enum(schoolPostingCategories);
export const postingExpirySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('policy_exempt') }),
  z.strictObject({
    kind: z.literal('at'),
    validUntil: z.iso.datetime().refine((v) => Number.isFinite(Date.parse(v))),
  }),
]);
export const schoolPostingPolicySchema = z.strictObject({
  unverifiedPostEnabled: z.boolean(),
  unverifiedCommentEnabled: z.boolean(),
  unverifiedCategories: z
    .array(schoolPostingCategorySchema)
    .max(9)
    .refine((v) => new Set(v).size === v.length),
  expiry: postingExpirySchema,
});
export const saveSchoolPostingPolicyV1Schema = z.strictObject({
  clientRequestId: schoolPostingRequestIdSchema,
  // The original ledger uses PostgreSQL integer, not bigint.
  expectedRevision: z.number().int().min(0).max(2147483646),
  policy: schoolPostingPolicySchema,
});
export const schoolPostingPolicyV2Schema = schoolPostingPolicySchema.extend({
  relatedSyncEnabled: z.boolean(),
});
export const saveSchoolPostingPolicyV2Schema =
  saveSchoolPostingPolicyV1Schema.extend({
    version: z.literal(2),
    policy: schoolPostingPolicyV2Schema,
  });
export const saveSchoolPostingPolicySchema = z.union([
  saveSchoolPostingPolicyV1Schema,
  saveSchoolPostingPolicyV2Schema,
]);
export type SaveSchoolPostingPolicy = z.infer<
  typeof saveSchoolPostingPolicySchema
>;
export const schoolPostingDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const schoolPostingReceiptSchema = z.strictObject({
  requestId: schoolPostingRequestIdSchema,
  requestHash: schoolPostingDigestSchema,
  regionId: schoolPostingIdSchema,
  revision: z.number().int().min(1).max(2147483647),
  revisionId: schoolPostingIdSchema,
  outcome: z.literal('saved'),
});
export type SchoolPostingReceipt = z.infer<typeof schoolPostingReceiptSchema>;
export const schoolPostingRecoverySchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('not_recorded'),
    requestId: schoolPostingRequestIdSchema,
  }),
  z.strictObject({
    state: z.literal('recorded'),
    requestId: schoolPostingRequestIdSchema,
    receipt: schoolPostingReceiptSchema,
  }),
  z.strictObject({
    state: z.literal('cancelled'),
    requestId: schoolPostingRequestIdSchema,
    requestHash: schoolPostingDigestSchema,
  }),
]);
export const schoolPostingViewSchema = z.strictObject({
  context: z.strictObject({
    regionId: schoolPostingIdSchema,
    regionName: z.string(),
    management: z.enum(['fixed', 'global']),
  }),
  revision: z.number().int().min(0).max(2147483647),
  revisionId: schoolPostingIdSchema.nullable(),
  state: z.enum(['unconfigured', 'active', 'expired', 'unavailable']),
  editable: z.boolean(),
  blocker: z.enum(['untrusted_source', 'related_sync_unsupported']).nullable(),
  policy: schoolPostingPolicySchema
    .extend({
      effectiveAt: z.iso.datetime(),
      relatedSyncEnabled: z.boolean().optional(),
    })
    .nullable(),
});
export type SchoolPostingView = z.infer<typeof schoolPostingViewSchema>;
export const schoolPostingQuerySchema = z.strictObject({
  regionId: schoolPostingIdSchema.optional(),
});
export const postingEmptyQuerySchema = z.strictObject({});
export const postingEmptyBodySchema = z.union([
  z.undefined(),
  z.strictObject({}),
]);
export const postingCancelSchema = z.strictObject({
  requestHash: schoolPostingDigestSchema,
});
export function schoolPostingCommandHash(
  actorId: string,
  regionId: string,
  command: SaveSchoolPostingPolicy,
): string {
  return createHash('sha256')
    .update(
      'version' in command
        ? 'whaleu-school-posting-policy-command:v2\n'
        : 'whaleu-school-posting-policy-command:v1\n',
    )
    .update(
      canonicalJson({
        actorId,
        regionId,
        command: saveSchoolPostingPolicySchema.parse(command),
      }),
    )
    .digest('hex');
}
