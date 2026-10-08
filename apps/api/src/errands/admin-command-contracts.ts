import { z } from 'zod';
import {
  errandIdSchema,
  errandCommandSchema,
  errandCursorSchema,
  errandText,
  errandTimeSchema,
} from './contracts.js';
import {
  errandAdminParticipantSchema,
  errandAdminTotalSchema,
} from './admin-contracts.js';
const id = z.uuid().refine((value) => value === value.toLowerCase());
export const errandRestrictionActionSchema = z.enum([
  'publish',
  'accept',
  'all',
]);
export const errandRestrictionDurationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('permanent') }),
  z.strictObject({
    kind: z.literal('finite'),
    unit: z.enum(['hours', 'days']),
    value: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
]);
export const adminDeleteErrandSchema = errandCommandSchema
  .extend({
    deleteReason: errandText(500, false).default(''),
    publisherRestriction: errandRestrictionDurationSchema
      .nullable()
      .default(null),
  })
  .refine(
    (value) =>
      value.publisherRestriction === null ||
      errandText(255).safeParse(value.deleteReason).success,
  );
export const restrictErrandAccepterSchema = errandCommandSchema.extend({
  reason: errandText(255),
  duration: errandRestrictionDurationSchema,
});
export const issueErrandRestrictionSchema = z.strictObject({
  clientRequestId: errandIdSchema,
  targetProfileId: errandIdSchema,
  action: errandRestrictionActionSchema,
  reason: errandText(255),
  duration: errandRestrictionDurationSchema,
});
export const releaseErrandRestrictionSchema = z.strictObject({
  clientRequestId: errandIdSchema,
  reason: errandText(255),
});
export const errandAdminOperationSchema = z.enum([
  'admin_delete',
  'restrict_accepter',
]);
export const errandAdminRejectionSchema = z.enum([
  'ERRAND_REVISION_CONFLICT',
  'ERRAND_STATE_CONFLICT',
  'ERRAND_USE_OWNER_COMMAND',
  'ERRAND_RESTRICTION_TARGET_PROTECTED',
]);
export const errandAdminReceiptSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    requestId: id,
    operation: errandAdminOperationSchema,
    outcome: z.literal('applied'),
    orderId: id,
    revision: id,
    occurredAt: errandTimeSchema,
  }),
  z.strictObject({
    requestId: id,
    operation: errandAdminOperationSchema,
    outcome: z.literal('rejected'),
    code: errandAdminRejectionSchema,
  }),
]);
export const errandRestrictionOperationSchema = z.enum(['issue', 'release']);
export const errandRestrictionRejectionSchema = z.enum([
  'ERRAND_RESTRICTION_TARGET_NOT_FOUND',
  'ERRAND_RESTRICTION_TARGET_PROTECTED',
  'ERRAND_RESTRICTION_NOT_FOUND',
  'ERRAND_RESTRICTION_NOT_ACTIVE',
]);
export const errandRestrictionReceiptSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    requestId: id,
    operation: errandRestrictionOperationSchema,
    outcome: z.literal('applied'),
    restrictionId: id,
    eventId: id,
    occurredAt: errandTimeSchema,
  }),
  z.strictObject({
    requestId: id,
    operation: errandRestrictionOperationSchema,
    outcome: z.literal('rejected'),
    code: errandRestrictionRejectionSchema,
  }),
]);
const pageInput = {
  limit: z
    .union([
      z.number(),
      z
        .string()
        .regex(/^[1-9][0-9]?$/)
        .transform(Number),
    ])
    .pipe(z.number().int().min(1).max(50))
    .default(20),
  cursor: errandCursorSchema.optional(),
};
export const errandRestrictionStateSchema = z.enum([
  'active',
  'released',
  'expired',
  'superseded',
]);
export const errandRestrictionsQuerySchema = z.strictObject({
  targetProfileId: errandIdSchema.optional(),
  action: errandRestrictionActionSchema.optional(),
  state: z
    .enum(['all', ...errandRestrictionStateSchema.options])
    .default('all'),
  ...pageInput,
});
export const errandRestrictionHistoryQuerySchema = z.strictObject(pageInput);
const operator = z.union([
  errandAdminParticipantSchema,
  z.strictObject({ status: z.literal('unknown') }),
]);
const historicalReason = z
  .string()
  .min(1)
  .max(1000)
  .refine((v) => [...v].length <= 500);
export const errandRestrictionViewSchema = z.strictObject({
  restrictionId: id,
  subject: errandAdminParticipantSchema,
  action: errandRestrictionActionSchema,
  reason: historicalReason,
  startsAt: errandTimeSchema,
  endsAt: errandTimeSchema.nullable(),
  state: errandRestrictionStateSchema,
  origin: z.enum(['local', 'baseline']),
  recordedAt: errandTimeSchema,
  operator,
  source: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('global') }),
    z.strictObject({ kind: z.literal('order'), orderId: id }),
    z.strictObject({ kind: z.literal('unknown') }),
  ]),
  terminal: z
    .union([
      z.strictObject({
        kind: z.literal('baseline_released'),
        effectiveAt: errandTimeSchema,
      }),
      z
        .strictObject({
          kind: z.enum(['manually_released', 'superseded']),
          eventId: id,
          effectiveAt: errandTimeSchema,
          reason: historicalReason.nullable(),
          replacementRestrictionId: id.nullable(),
        })
        .refine(
          (v) =>
            (v.kind === 'superseded') === (v.replacementRestrictionId !== null),
        ),
    ])
    .nullable(),
});
export const errandRestrictionEventSchema = z.strictObject({
  eventId: id,
  kind: z.enum([
    'issued',
    'manually_released',
    'superseded',
    'observed_baseline',
  ]),
  effectiveAt: errandTimeSchema,
  recordedAt: errandTimeSchema,
  reason: historicalReason.nullable(),
  operator,
  replacementRestrictionId: id.nullable(),
});
const continuation = {
  continuation: z.enum(['more', 'end']),
  nextCursor: errandCursorSchema.nullable(),
  historyCoverage: z.literal('unknown_before_boundary'),
};
export const errandRestrictionsPageSchema = z
  .strictObject({
    items: z.array(errandRestrictionViewSchema).max(50),
    ...continuation,
    recordedTotal: errandAdminTotalSchema,
  })
  .refine((v) => (v.continuation === 'end') === (v.nextCursor === null));
export const errandRestrictionHistorySchema = z
  .strictObject({
    restriction: errandRestrictionViewSchema,
    events: z.array(errandRestrictionEventSchema).max(50),
    ...continuation,
  })
  .refine((v) => (v.continuation === 'end') === (v.nextCursor === null));
export type AdminDeleteErrand = z.infer<typeof adminDeleteErrandSchema>;
export type RestrictErrandAccepter = z.infer<
  typeof restrictErrandAccepterSchema
>;
export type IssueErrandRestriction = z.infer<
  typeof issueErrandRestrictionSchema
>;
export type ReleaseErrandRestriction = z.infer<
  typeof releaseErrandRestrictionSchema
>;
export type ErrandAdminOperation = z.infer<typeof errandAdminOperationSchema>;
export type ErrandAdminReceipt = z.infer<typeof errandAdminReceiptSchema>;
export type ErrandRestrictionReceipt = z.infer<
  typeof errandRestrictionReceiptSchema
>;
export type ErrandRestrictionsQuery = z.infer<
  typeof errandRestrictionsQuerySchema
>;
export type ErrandRestrictionHistoryQuery = z.infer<
  typeof errandRestrictionHistoryQuerySchema
>;
