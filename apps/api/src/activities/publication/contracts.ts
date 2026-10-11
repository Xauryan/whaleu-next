import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../../community/content-review/contracts.js';
import {
  activityMediaBindingsSchema,
  activityMediaChangesSchema,
  activityMediaSlotSchema,
} from '../media/contracts.js';
export const publicationId = z.uuid().refine((v) => v === v.toLowerCase());
export const publicationKey = z.uuidv4().refine((v) => v === v.toLowerCase());
export const publicationRevision = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1);
export const publicationDigest = z.string().regex(/^[a-f0-9]{64}$/);
export const publicationPlain = (limit: number) =>
  z.string().refine(
    (v) =>
      Array.from(v).length <= limit &&
      !Array.from(v).some((c) => {
        const n = c.codePointAt(0)!;
        return (
          (n < 32 && n !== 10) ||
          (n >= 127 && n <= 159) ||
          (n >= 0xd800 && n <= 0xdfff) ||
          (n >= 0x202a && n <= 0x202e) ||
          (n >= 0x2066 && n <= 0x2069)
        );
      }),
  );
export const activityPublicationContentSchema = z.strictObject({
  title: publicationPlain(50),
  description: publicationPlain(1000),
  types: z
    .array(z.enum(['reward', 'online', 'offline']))
    .max(3)
    .refine((v) => new Set(v).size === v.length),
  activityTime: publicationPlain(200),
  activityLocation: publicationPlain(200),
  endAt: z.iso.datetime({ offset: true }).nullable(),
  showOrganizerQr: z.boolean(),
});
export type ActivityPublicationContent = z.infer<
  typeof activityPublicationContentSchema
>;
export function requirePublishableContent(raw: unknown) {
  return activityPublicationContentSchema
    .refine(
      (v) =>
        v.title.trim().length > 0 &&
        v.types.length > 0 &&
        (!v.types.includes('offline') ||
          (v.activityTime.trim().length > 0 &&
            v.activityLocation.trim().length > 0)),
    )
    .parse(raw);
}
export const activityOrganizerTargetSchema = z.strictObject({
  source: z.literal('managed'),
  organizationId: publicationId,
});
const cas = {
  clientRequestId: publicationKey,
  expectedRevision: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER - 1),
};
export const activityCreateDraftSchema = z
  .strictObject({
    ...cas,
    action: z.literal('create'),
    organization: activityOrganizerTargetSchema,
    organizationRevision: publicationRevision,
    content: activityPublicationContentSchema,
  })
  .refine((v) => v.expectedRevision === 0);
export const activitySaveDraftSchema = z
  .strictObject({
    ...cas,
    action: z.literal('save'),
    content: activityPublicationContentSchema,
    mediaChanges: activityMediaChangesSchema,
  })
  .refine((v) => v.expectedRevision > 0);
export const activityPublishDraftSchema = z
  .strictObject({ ...cas, action: z.enum(['publish', 'cancel_draft']) })
  .refine((v) => v.expectedRevision > 0);
export const activityPublicationCommandSchema = z.union([
  activityCreateDraftSchema,
  activitySaveDraftSchema,
  activityPublishDraftSchema,
]);
export type ActivityPublicationCommand = z.infer<
  typeof activityPublicationCommandSchema
>;
export const activityPublicationReceiptSchema = z.strictObject({
  requestId: publicationKey,
  requestHash: publicationDigest,
  activityId: publicationId,
  revision: publicationRevision,
  outcome: z.enum(['created', 'saved', 'published', 'draft_cancelled']),
});
export type ActivityPublicationReceipt = z.infer<
  typeof activityPublicationReceiptSchema
>;
export const activityPublicationRecoverySchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('not_recorded'),
    requestId: publicationKey,
  }),
  z.strictObject({
    state: z.literal('cancelled'),
    requestId: publicationKey,
    requestHash: publicationDigest,
  }),
  z.strictObject({
    state: z.literal('pending'),
    requestId: publicationKey,
    requestHash: publicationDigest,
    review: z.enum(['pending', 'ready', 'rejected', 'unavailable']),
  }),
  z.strictObject({
    state: z.literal('recorded'),
    requestId: publicationKey,
    receipt: activityPublicationReceiptSchema,
  }),
]);
export const activityPublicationResultSchema = z.union([
  activityPublicationReceiptSchema,
  activityPublicationRecoverySchema,
]);
export const activityDraftSchema = z.strictObject({
  source: z.literal('native'),
  id: publicationId,
  regionId: publicationId,
  organization: activityOrganizerTargetSchema,
  organizationRevision: publicationRevision,
  revision: publicationRevision,
  state: z.enum(['draft', 'published', 'cancelled']),
  content: activityPublicationContentSchema,
  mediaBindings: activityMediaBindingsSchema,
});
export const activityOrganizerSchema = z.strictObject({
  source: z.literal('managed'),
  organizationId: publicationId,
  revision: publicationRevision,
  name: publicationPlain(10),
  kind: z.enum(['school', 'org', 'official']),
  role: z.enum(['organization_owner', 'organization_admin']),
});
export const publicationQuerySchema = z.strictObject({
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
  limit: z
    .union([
      z.number(),
      z
        .string()
        .regex(/^[1-9][0-9]?$/)
        .transform(Number),
    ])
    .pipe(z.number().int().min(1).max(20))
    .default(20),
});
export type PublicationQuery = z.infer<typeof publicationQuerySchema>;
export const activityOrganizerPageSchema = z.strictObject({
  regionId: publicationId,
  items: z.array(activityOrganizerSchema).max(20),
  nextCursor: z.string().nullable(),
});
export const activityNativeItemSchema = z.strictObject({
  source: z.literal('native'),
  id: publicationId,
  regionId: publicationId,
  revision: publicationRevision,
  organization: activityOrganizerTargetSchema,
  organizerLabel: publicationPlain(10),
  content: activityPublicationContentSchema,
  mediaBindings: activityMediaBindingsSchema,
  createdAt: z.iso.datetime({ offset: true }),
  organizerQr: z.union([
    z.strictObject({ status: z.literal('disabled') }),
    z.strictObject({ status: z.literal('unavailable') }),
    z.strictObject({
      status: z.literal('available'),
      organizationId: publicationId,
      applicationRevision: publicationRevision,
      slot: z.literal('mainQr'),
      bindingId: publicationId,
    }),
  ]),
});
export const activityNativePageSchema = z.strictObject({
  source: z.literal('native'),
  regionId: publicationId,
  items: z.array(activityNativeItemSchema).max(20),
  nextCursor: z.string().nullable(),
});
export const activityReviewEnvelopeSchema = z
  .strictObject({
    version: z.literal(1),
    purpose: z.literal('publish_activity'),
    accountId: publicationId,
    activityId: publicationId,
    draftRevision: publicationRevision,
    organization: activityOrganizerTargetSchema,
    organizationRevision: publicationRevision,
    authorityVersion: z.string().min(1).max(128),
    regionId: publicationId,
    organizerLabel: publicationPlain(10),
    content: activityPublicationContentSchema,
    media: z
      .array(
        z.strictObject({
          slot: activityMediaSlotSchema,
          assetId: publicationId,
          manifestDigest: publicationDigest,
        }),
      )
      .min(1)
      .max(10),
    organizerQr: z
      .strictObject({
        organizationId: publicationId,
        applicationRevision: publicationRevision,
        slot: z.literal('mainQr'),
        bindingId: publicationId,
        assetId: publicationId,
        manifestDigest: publicationDigest,
      })
      .nullable(),
  })
  .refine(
    (v) =>
      v.media[0]?.slot === 'cover' &&
      new Set(v.media.map((m) => m.slot)).size === v.media.length &&
      new Set(v.media.map((m) => m.assetId)).size === v.media.length &&
      v.content.showOrganizerQr === (v.organizerQr !== null),
  );
export type ActivityReviewEnvelope = z.infer<
  typeof activityReviewEnvelopeSchema
>;
export function publicationCommandHash(
  actorId: string,
  activityId: string,
  command: ActivityPublicationCommand,
) {
  return createHash('sha256')
    .update('whaleu-activity-command:v1\n')
    .update(
      canonicalJson({
        actorId,
        activityId,
        command: activityPublicationCommandSchema.parse(command),
      }),
    )
    .digest('hex');
}
export function activityReviewDigest(envelope: ActivityReviewEnvelope) {
  return createHash('sha256')
    .update('whaleu-activity-review:v1\n')
    .update(canonicalJson(activityReviewEnvelopeSchema.parse(envelope)))
    .digest('hex');
}
