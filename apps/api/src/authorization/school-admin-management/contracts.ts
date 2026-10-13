import { z } from 'zod';
const id = z.uuid().transform((value) => value.toLowerCase());
const outputId = z.uuid().refine((value) => value === value.toLowerCase());
const version = z.string().regex(/^[a-f0-9]{64}$/);
export const schoolAdminManagementRequestIdSchema = z
  .uuidv4()
  .transform((value) => value.toLowerCase());
export const schoolAdminManagementQuerySchema = z.strictObject({
  targetProfileId: id,
});
const commandBase = {
  clientRequestId: schoolAdminManagementRequestIdSchema,
  targetProfileId: id,
  expectedStateVersion: version,
};
export const schoolAdminManagementCommandSchema = z.discriminatedUnion(
  'action',
  [
    z.strictObject({
      ...commandBase,
      action: z.literal('appoint'),
      regionId: id,
    }),
    z.strictObject({
      ...commandBase,
      action: z.literal('reassign'),
      regionId: id,
    }),
    z.strictObject({ ...commandBase, action: z.literal('revoke') }),
  ],
);
export type SchoolAdminManagementCommand = z.infer<
  typeof schoolAdminManagementCommandSchema
>;
const receiptBase = {
  requestId: z.uuidv4().refine((value) => value === value.toLowerCase()),
  targetProfileId: outputId,
  expectedStateVersion: version,
  action: z.enum(['appoint', 'reassign', 'revoke']),
  regionId: outputId.optional(),
};
export const schoolAdminManagementReceiptSchema = z
  .discriminatedUnion('outcome', [
    z.strictObject({
      ...receiptBase,
      outcome: z.literal('applied'),
      eventId: outputId,
      recordedAt: z.iso.datetime({ precision: 3 }),
      titleGranted: z.boolean(),
    }),
    z.strictObject({
      ...receiptBase,
      outcome: z.literal('unchanged'),
      eventId: outputId,
      recordedAt: z.iso.datetime({ precision: 3 }),
      titleGranted: z.boolean(),
    }),
    z.strictObject({
      ...receiptBase,
      outcome: z.literal('rejected'),
      code: z.enum([
        'SCHOOL_ADMIN_MANAGEMENT_STALE',
        'SCHOOL_ADMIN_MANAGEMENT_CANCELLED',
      ]),
    }),
  ])
  .refine((receipt) =>
    receipt.action === 'revoke'
      ? receipt.regionId === undefined
      : receipt.regionId !== undefined,
  );
export type SchoolAdminManagementReceipt = z.infer<
  typeof schoolAdminManagementReceiptSchema
>;
const region = z.strictObject({
  id: outputId,
  name: z.string().min(1).max(200),
});
export const schoolAdminManagementSchema = z.strictObject({
  target: z.strictObject({
    profileId: outputId,
    displayName: z.string().min(1).max(20),
  }),
  stateVersion: version,
  currentAssignment: z
    .strictObject({
      regionId: outputId,
      name: z.string().min(1).max(200),
      status: z.enum(['active', 'future', 'expired', 'unavailable']),
    })
    .nullable(),
  eligibility: z.strictObject({
    status: z.enum(['known', 'unavailable', 'unverified', 'protected']),
    reason: z.string().min(1).max(200).nullable(),
    regions: z.array(region).max(512),
    defaultRegionId: outputId.nullable(),
  }),
  actions: z.strictObject({
    appoint: z.boolean(),
    reassign: z.boolean(),
    revoke: z.boolean(),
  }),
});
export type SchoolAdminManagement = z.infer<typeof schoolAdminManagementSchema>;
export const schoolAdminManagementRecoverySchema = z.discriminatedUnion(
  'state',
  [
    z.strictObject({
      state: z.literal('recorded'),
      receipt: schoolAdminManagementReceiptSchema,
    }),
    z.strictObject({ state: z.literal('not_recorded') }),
  ],
);
export const schoolAdminManagementEmptyQuerySchema = z.strictObject({});
export const schoolAdminManagementEmptyBodySchema = z.union([
  z.undefined(),
  z.strictObject({}),
]);
