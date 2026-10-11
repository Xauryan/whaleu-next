import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../../community/content-review/contracts.js';
import {
  directoryKindSchema,
  directoryPlatformSchema,
  directorySearchSchema,
} from '../directory/contracts.js';
import {
  organizationMediaChangesSchema,
  organizationMediaBindingsSchema,
} from '../media/contracts.js';
export const organizationRequestIdSchema = z
  .uuidv4()
  .refine((v) => v === v.toLowerCase());
export const organizationIdSchema = z
  .uuid()
  .refine((v) => v === v.toLowerCase());
export const organizationRevisionSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 1);
export const organizationDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const organizationStateSchema = z.enum([
  'draft',
  'pending',
  'rejected',
  'approved',
]);
const plain = (max: number) =>
  z.string().refine(
    (v) =>
      Array.from(v).length <= max &&
      !Array.from(v).some((c) => {
        const p = c.codePointAt(0)!;
        return (
          (p < 32 && p !== 10) ||
          (p >= 127 && p <= 159) ||
          (p >= 0xd800 && p <= 0xdfff) ||
          (p >= 0x202a && p <= 0x202e) ||
          (p >= 0x2066 && p <= 0x2069)
        );
      }),
  );
export const organizationDataSchema = z
  .strictObject({
    kind: directoryKindSchema,
    platform: directoryPlatformSchema,
    categoryId: organizationIdSchema,
    name: plain(10).refine((v) => v.trim() === v && v.length > 0),
    introText: plain(1000),
    qqGroupNumber: z
      .string()
      .regex(/^[0-9]{5,16}$/)
      .nullable(),
  })
  .refine(
    (v) =>
      (v.platform === 'official') === (v.kind === 'official') &&
      (v.platform === 'qq'
        ? v.qqGroupNumber !== null
        : v.qqGroupNumber === null),
  );
export type OrganizationData = z.infer<typeof organizationDataSchema>;
const cas = {
  clientRequestId: organizationRequestIdSchema,
  expectedRevision: organizationRevisionSchema,
  expectedAuthorityVersion: organizationRevisionSchema,
};
export const createOrganizationSchema = z
  .strictObject({
    ...cas,
    action: z.literal('create'),
    organizationId: organizationRequestIdSchema,
    regionId: organizationIdSchema,
    data: organizationDataSchema,
  })
  .refine((v) => v.expectedRevision === 0 && v.expectedAuthorityVersion === 0);
export const saveOrganizationSchema = z.strictObject({
  ...cas,
  action: z.enum(['save', 'submit']),
  data: organizationDataSchema,
  mediaChanges: organizationMediaChangesSchema,
});
export const reviewOrganizationSchema = z
  .strictObject({
    ...cas,
    action: z.enum(['approve', 'reject']),
    reason: plain(500),
  })
  .refine((v) =>
    v.action === 'approve' ? v.reason === '' : v.reason.trim().length > 0,
  );
export const organizationMemberCommandSchema = z.strictObject({
  ...cas,
  action: z.enum(['add_admin', 'remove_admin', 'transfer_owner']),
  targetProfileId: organizationIdSchema,
});
export const organizationCommandSchema = z.union([
  createOrganizationSchema,
  saveOrganizationSchema,
  reviewOrganizationSchema,
  organizationMemberCommandSchema,
]);
export type OrganizationCommand = z.infer<typeof organizationCommandSchema>;
export type CreateOrganization = z.infer<typeof createOrganizationSchema>;
export type SaveOrganization = z.infer<typeof saveOrganizationSchema>;
export type ReviewOrganization = z.infer<typeof reviewOrganizationSchema>;
export type OrganizationMemberCommand = z.infer<
  typeof organizationMemberCommandSchema
>;
export function organizationCommandHash(
  actorId: string,
  organizationId: string,
  command: OrganizationCommand,
) {
  return createHash('sha256')
    .update('whaleu-organization-command:v1\n')
    .update(
      canonicalJson({
        actorId,
        organizationId,
        command: organizationCommandSchema.parse(command),
      }),
    )
    .digest('hex');
}
export const organizationReceiptSchema = z.strictObject({
  requestId: organizationRequestIdSchema,
  requestHash: organizationDigestSchema,
  organizationId: organizationIdSchema,
  revision: organizationRevisionSchema.min(1),
  authorityVersion: organizationRevisionSchema.min(1),
  outcome: z.enum([
    'created',
    'saved',
    'submitted',
    'approved',
    'rejected',
    'admin_added',
    'admin_removed',
    'owner_transferred',
  ]),
  changed: z.boolean(),
});
export type OrganizationReceipt = z.infer<typeof organizationReceiptSchema>;
export const organizationRecoverySchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('not_recorded'),
    requestId: organizationRequestIdSchema,
  }),
  z.strictObject({
    state: z.literal('cancelled'),
    requestId: organizationRequestIdSchema,
    requestHash: organizationDigestSchema,
  }),
  z.strictObject({
    state: z.literal('recorded'),
    requestId: organizationRequestIdSchema,
    receipt: organizationReceiptSchema,
  }),
]);
export const organizationEmptyQuerySchema = z.strictObject({});
export const organizationEmptyBodySchema = z.union([
  z.undefined(),
  z.strictObject({}),
]);
export const organizationManagementQuerySchema = z.strictObject({
  regionId: organizationIdSchema.optional(),
});
export const organizationCancelSchema = z.strictObject({
  requestHash: organizationDigestSchema,
});
export const organizationLookupQuerySchema = z.strictObject({
  profileId: organizationIdSchema,
});
const limit = z
  .union([
    z.number(),
    z
      .string()
      .regex(/^[1-9][0-9]?$/)
      .transform(Number),
  ])
  .pipe(z.number().int().min(1).max(30))
  .default(20);
export const organizationListQuerySchema = z.strictObject({
  kind: directoryKindSchema.optional(),
  categoryId: organizationIdSchema.optional(),
  q: directorySearchSchema.optional(),
  limit,
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
});
export type OrganizationListQuery = z.infer<typeof organizationListQuerySchema>;
export const organizationListItemSchema = z.strictObject({
  source: z.literal('managed'),
  id: organizationIdSchema,
  regionId: organizationIdSchema,
  revision: organizationRevisionSchema.min(1),
  authorityVersion: organizationRevisionSchema.min(1),
  state: organizationStateSchema,
  data: organizationDataSchema,
  role: z.enum([
    'applicant',
    'organization_owner',
    'organization_admin',
    'school_admin',
    'super_admin',
    'reader',
  ]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type OrganizationListItem = z.infer<typeof organizationListItemSchema>;
export const organizationListSchema = z
  .strictObject({
    items: z.array(organizationListItemSchema).max(30),
    continuation: z.enum(['end', 'more']),
    nextCursor: z.string().nullable(),
  })
  .refine((v) => (v.continuation === 'end') === (v.nextCursor === null));
export const organizationPersonSchema = z.strictObject({
  profileId: organizationIdSchema,
  displayName: z.string().min(1).max(20),
});
export const organizationMemberSchema = z.strictObject({
  profile: z.union([organizationPersonSchema, z.null()]),
  role: z.enum(['organization_owner', 'organization_admin']),
  grantId: organizationIdSchema,
  validFrom: z.iso.datetime(),
  validUntil: z.iso.datetime().nullable(),
});
export const organizationDetailSchema = organizationListItemSchema.extend({
  mediaBindings: organizationMediaBindingsSchema,
  reviewReason: plain(500).nullable(),
  members: z.array(organizationMemberSchema).max(100),
  permissions: z.strictObject({
    edit: z.boolean(),
    submit: z.boolean(),
    review: z.boolean(),
    manageMembers: z.boolean(),
    transferOwner: z.boolean(),
  }),
});
export const organizationPublicDetailSchema = organizationListItemSchema.extend(
  {
    mediaBindings: organizationMediaBindingsSchema,
    management: z.strictObject({ available: z.boolean() }),
  },
);
