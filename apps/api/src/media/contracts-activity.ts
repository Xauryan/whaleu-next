import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  MEDIA_MAX_INPUT_BYTES,
  mediaDigestSchema,
  mediaMimeSchema,
} from './contracts.js';
import {
  mediaV2IdSchema,
  mediaGrantSchema,
  mediaUploadObservedSchema,
} from './contracts-v2.js';

export const ACTIVITY_MEDIA_PROTOCOL = 'activity-media-v1' as const;
export const activityMediaSlotSchema = z.enum([
  'cover',
  'gallery0',
  'gallery1',
  'gallery2',
  'gallery3',
  'gallery4',
  'gallery5',
  'gallery6',
  'gallery7',
  'gallery8',
]);
export type ActivityMediaSlot = z.infer<typeof activityMediaSlotSchema>;
export const prepareActivityMediaSchema = z.strictObject({
  protocol: z.literal(ACTIVITY_MEDIA_PROTOCOL),
  clientRequestId: mediaV2IdSchema,
  activityId: mediaV2IdSchema,
  slot: activityMediaSlotSchema,
  revision: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER - 1),
  declaration: z.strictObject({
    mime: mediaMimeSchema,
    bytes: z.number().int().positive().max(MEDIA_MAX_INPUT_BYTES),
    sha256: mediaDigestSchema,
  }),
});
export type PrepareActivityMediaInput = z.infer<
  typeof prepareActivityMediaSchema
>;
export function activityMediaRequestHash(actor: string, raw: unknown): string {
  const input = prepareActivityMediaSchema.parse(raw);
  return createHash('sha256')
    .update('whaleu-activity-media-prepare:v1\n')
    .update(
      JSON.stringify({
        protocol: ACTIVITY_MEDIA_PROTOCOL,
        actorAccountId: mediaV2IdSchema.parse(actor),
        clientRequestId: input.clientRequestId,
        activityId: input.activityId,
        slot: input.slot,
        revision: input.revision,
        declaration: {
          mime: input.declaration.mime,
          bytes: input.declaration.bytes,
          sha256: input.declaration.sha256,
        },
      }),
    )
    .digest('hex');
}
export const activityReferenceSchema = z.strictObject({
  activityId: mediaV2IdSchema,
  slot: activityMediaSlotSchema,
  revision: z.number().int().positive().safe(),
  bindingId: mediaV2IdSchema,
});
export type ActivityReference = z.infer<typeof activityReferenceSchema>;
export const activityDescriptorSchema = activityReferenceSchema.extend({
  protocol: z.literal(ACTIVITY_MEDIA_PROTOCOL),
  kind: z.literal('activity-media'),
  width: z.number().int().positive().max(2048),
  height: z.number().int().positive().max(2048),
  variants: z.tuple([z.literal('thumb-v1'), z.literal('display-v1')]),
});
export type ActivityDescriptor = z.infer<typeof activityDescriptorSchema>;
const instant = z.number().int().positive().safe();
const base = {
  protocol: z.literal(ACTIVITY_MEDIA_PROTOCOL),
  intentId: mediaV2IdSchema,
  requestId: mediaV2IdSchema,
  requestHash: mediaDigestSchema,
  serverNow: instant,
};
export const activityMediaStatusSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...base,
    status: z.literal('prepared'),
    operationDeadlineAt: instant,
    upload: z.enum(['none', 'in_flight', 'reconcile_needed']),
  }),
  z.strictObject({
    ...base,
    status: z.literal('uploaded'),
    operationDeadlineAt: instant,
  }),
  z.strictObject({
    ...base,
    status: z.literal('processing'),
    operationDeadlineAt: instant,
    retryAfterMs: z.number().int().min(250).max(30000),
  }),
  z.strictObject({
    ...base,
    status: z.literal('ready_unbound'),
    assetId: mediaV2IdSchema,
    bindBefore: instant,
    mediaProof: z.literal('current'),
  }),
  z.strictObject({
    ...base,
    status: z.literal('bound_history'),
    assetId: mediaV2IdSchema,
    bindingId: mediaV2IdSchema,
    attachmentState: z.enum(['active', 'detached']),
  }),
  z.strictObject({
    ...base,
    status: z.literal('terminal'),
    reason: z.enum(['cancelled', 'expired', 'rejected', 'deleted']),
    cleanup: z.enum(['pending', 'retained', 'confirmed']),
  }),
  z.strictObject({
    ...base,
    status: z.literal('unavailable'),
    reason: z.literal('MEDIA_UNAVAILABLE'),
    retryable: z.boolean(),
  }),
]);
export type ActivityMediaStatus = z.infer<typeof activityMediaStatusSchema>;
export const activityMediaRecoverySchema = z.discriminatedUnion('state', [
  z.strictObject({
    protocol: z.literal(ACTIVITY_MEDIA_PROTOCOL),
    requestId: mediaV2IdSchema,
    serverNow: instant,
    state: z.literal('not_recorded'),
    requestHash: z.null(),
  }),
  z.strictObject({
    protocol: z.literal(ACTIVITY_MEDIA_PROTOCOL),
    requestId: mediaV2IdSchema,
    serverNow: instant,
    state: z.literal('recorded'),
    requestHash: mediaDigestSchema,
    status: activityMediaStatusSchema,
  }),
  z.strictObject({
    protocol: z.literal(ACTIVITY_MEDIA_PROTOCOL),
    requestId: mediaV2IdSchema,
    serverNow: instant,
    state: z.literal('cancelled_before_prepare'),
    requestHash: mediaDigestSchema,
    reason: z.literal('cancelled'),
  }),
]);
export const cancelActivityMediaRequestSchema = z.strictObject({
  protocol: z.literal(ACTIVITY_MEDIA_PROTOCOL),
  requestHash: mediaDigestSchema,
});
export const activityMediaGrantSchema = mediaGrantSchema
  .omit({ version: true })
  .extend({ protocol: z.literal(ACTIVITY_MEDIA_PROTOCOL) });
export const activityMediaUploadObservedSchema = mediaUploadObservedSchema
  .omit({ version: true })
  .extend({ protocol: z.literal(ACTIVITY_MEDIA_PROTOCOL) });
