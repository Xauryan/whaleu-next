import { z } from 'zod';

const id = z.uuid().transform((value) => value.toLowerCase());
const outputId = z.uuid().regex(/^[0-9a-f-]+$/);
const requestId = z.uuidv4().transform((value) => value.toLowerCase());
const timestamp = z.iso.datetime({ precision: 3 });
const revision = z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/);
const version = z.string().regex(/^[a-f0-9]{64}$/);
const reason = z.string().trim().min(1).max(255);

export const punishmentKindSchema = z.enum([
  'interaction_mute',
  'access_suspension',
]);
export type PunishmentKind = z.infer<typeof punishmentKindSchema>;
/** Semantic operations, never inferred from the HTTP method. Existing owner
 * eligibility and unknown baseline coverage remain independent requirements. */
export const safetyActionSchema = z.enum([
  'browse',
  'interaction',
  'private_self_service',
  'protective_cleanup',
  'passive_bookkeeping',
  'privileged_read',
  'noncontent_management',
  'content_management',
  'restricted_self_service',
  'guest',
]);
export type SafetyAction = z.infer<typeof safetyActionSchema>;
export const punishmentDurationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('permanent') }),
  z.strictObject({
    kind: z.literal('finite'),
    unit: z.enum(['minutes', 'hours', 'days']),
    value: z.number().int().positive().max(2147483647),
  }),
]);
export const punishmentSelectionSchema = z.strictObject({
  kind: punishmentKindSchema,
  duration: punishmentDurationSchema,
  reason,
  expectedRevision: revision,
});
export type PunishmentSelection = z.infer<typeof punishmentSelectionSchema>;
export const punishmentReferenceSchema = z.strictObject({
  punishmentId: id,
  kind: punishmentKindSchema,
  revision,
});
export const punishmentReferenceOutputSchema = punishmentReferenceSchema.extend(
  {
    punishmentId: outputId,
  },
);
export type PunishmentReference = z.infer<typeof punishmentReferenceSchema>;
export const punishmentStateSchema = z.enum([
  'active',
  'expired',
  'superseded',
  'released',
]);
export const punishmentViewSchema = z.strictObject({
  ...punishmentReferenceOutputSchema.shape,
  reason,
  startsAt: timestamp,
  endsAt: timestamp.nullable(),
  recordedAt: timestamp,
  state: punishmentStateSchema,
  terminal: z
    .strictObject({
      cause: z.enum([
        'expired',
        'superseded',
        'manually_released',
        'appeal_released',
      ]),
      effectiveAt: timestamp,
      reason: reason.nullable(),
    })
    .nullable(),
  canAppeal: z.boolean(),
  openAppealId: outputId.nullable(),
});
export type PunishmentView = z.infer<typeof punishmentViewSchema>;
export const punishmentStatusSchema = z.strictObject({
  coverage: z.enum(['complete', 'unavailable']),
  effective: z.enum([
    'clear',
    'interaction_mute',
    'access_suspension',
    'unavailable',
  ]),
  checkedAt: timestamp,
  current: z.array(punishmentViewSchema).max(2),
});
export type PunishmentStatus = z.infer<typeof punishmentStatusSchema>;
export const moderationPageQuerySchema = z.strictObject({
  cursor: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  limit: z
    .string()
    .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
    .default('20')
    .transform(Number),
});
export type ModerationPageQuery = z.infer<typeof moderationPageQuerySchema>;
const page = <T extends z.ZodType>(item: T) =>
  z.strictObject({
    items: z.array(item).max(50),
    nextCursor: z
      .string()
      .min(1)
      .max(1024)
      .regex(/^[A-Za-z0-9_-]+$/)
      .nullable(),
  });
export const punishmentPageSchema = page(punishmentViewSchema);
/** Management is addressed by an existing opaque punishment, never by an
 * arbitrary account ID. No public badge or anonymous author mapping is exposed. */
export const punishmentManagementViewSchema = punishmentViewSchema.extend({
  stateVersion: version,
  canRelease: z.boolean(),
});
export const punishmentManagementPageSchema = page(
  punishmentManagementViewSchema,
);
export const punishmentReleaseCommandSchema = z.strictObject({
  clientRequestId: requestId,
  action: z.literal('release'),
  punishment: punishmentReferenceSchema,
  expectedStateVersion: version,
  reason,
});
export type PunishmentReleaseCommand = z.infer<
  typeof punishmentReleaseCommandSchema
>;
export const punishmentReleaseReceiptSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    requestId: outputId,
    action: z.literal('release'),
    punishment: punishmentReferenceOutputSchema,
    outcome: z.literal('applied'),
    eventId: outputId,
    recordedAt: timestamp,
  }),
  z.strictObject({
    requestId: outputId,
    action: z.literal('release'),
    punishment: punishmentReferenceOutputSchema,
    outcome: z.literal('rejected'),
    code: z.enum(['SAFETY_MODERATION_STALE', 'SAFETY_MODERATION_CANCELLED']),
  }),
]);
export type PunishmentReleaseReceipt = z.infer<
  typeof punishmentReleaseReceiptSchema
>;
export const appealSubmitCommandSchema = z.strictObject({
  clientRequestId: requestId,
  action: z.literal('submit_appeal'),
  punishment: punishmentReferenceSchema,
  text: z.string().trim().min(1).max(4000),
});
export type AppealSubmitCommand = z.infer<typeof appealSubmitCommandSchema>;
export const appealSubmitReceiptSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    requestId: outputId,
    action: z.literal('submit_appeal'),
    punishment: punishmentReferenceOutputSchema,
    outcome: z.literal('applied'),
    appealId: outputId,
    recordedAt: timestamp,
    reusedOpenCase: z.boolean(),
  }),
  z.strictObject({
    requestId: outputId,
    action: z.literal('submit_appeal'),
    punishment: punishmentReferenceOutputSchema,
    outcome: z.literal('rejected'),
    code: z.enum(['SAFETY_MODERATION_STALE', 'SAFETY_MODERATION_CANCELLED']),
  }),
]);
export type AppealSubmitReceipt = z.infer<typeof appealSubmitReceiptSchema>;
export const appealDecisionSchema = z.enum([
  'upheld',
  'released',
  'closed_no_longer_effective',
]);
export const appealViewSchema = z.strictObject({
  appealId: outputId,
  punishment: punishmentViewSchema,
  text: z.string().min(1).max(4000),
  submittedAt: timestamp,
  state: z.enum(['pending', 'decided']),
  decision: z
    .strictObject({
      outcome: appealDecisionSchema,
      reason,
      recordedAt: timestamp,
    })
    .nullable(),
});
export type AppealView = z.infer<typeof appealViewSchema>;
export const appealPageSchema = page(appealViewSchema);
export const appealManagementViewSchema = appealViewSchema.extend({
  stateVersion: version,
  canDecide: z.boolean(),
});
export const appealManagementPageSchema = page(appealManagementViewSchema);
export const appealDecisionCommandSchema = z.strictObject({
  clientRequestId: requestId,
  action: z.literal('decide_appeal'),
  appealId: id,
  expectedStateVersion: version,
  decision: appealDecisionSchema,
  reason,
});
export type AppealDecisionCommand = z.infer<typeof appealDecisionCommandSchema>;
export const appealDecisionReceiptSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    requestId: outputId,
    action: z.literal('decide_appeal'),
    appealId: outputId,
    outcome: z.literal('applied'),
    decision: appealDecisionSchema,
    eventId: outputId,
    recordedAt: timestamp,
  }),
  z.strictObject({
    requestId: outputId,
    action: z.literal('decide_appeal'),
    appealId: outputId,
    outcome: z.literal('rejected'),
    code: z.enum(['SAFETY_MODERATION_STALE', 'SAFETY_MODERATION_CANCELLED']),
  }),
]);
export type AppealDecisionReceipt = z.infer<typeof appealDecisionReceiptSchema>;
export const moderationRecoverySchema = <T extends z.ZodType>(receipt: T) =>
  z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('recorded'), receipt }),
    z.strictObject({ state: z.literal('not_recorded') }),
  ]);
export const moderationIdSchema = id;
export const moderationRequestIdSchema = requestId;
export const moderationEmptyQuerySchema = z.strictObject({});
