import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  MEDIA_MAX_INPUT_BYTES,
  mediaDigestSchema,
  mediaMimeSchema,
  mediaVariantSchema,
} from './contracts.js';
import {
  mediaV2IdSchema,
  mediaGrantSchema,
  mediaUploadObservedSchema,
} from './contracts-v2.js';

export const CATEGORY_ICON_MEDIA_PROTOCOL =
  'ratings-category-icon-media-v1' as const;
export const prepareCategoryIconMediaSchema = z.strictObject({
  protocol: z.literal(CATEGORY_ICON_MEDIA_PROTOCOL),
  clientRequestId: mediaV2IdSchema,
  editScopeId: mediaV2IdSchema,
  scopeRevision: mediaDigestSchema,
  slot: z.literal('icon'),
  declaration: z.strictObject({
    mime: mediaMimeSchema,
    bytes: z.number().int().positive().max(MEDIA_MAX_INPUT_BYTES),
    sha256: mediaDigestSchema,
  }),
});
export type PrepareCategoryIconMediaInput = z.infer<
  typeof prepareCategoryIconMediaSchema
>;
export function categoryIconMediaRequestHash(
  actor: string,
  raw: unknown,
): string {
  const input = prepareCategoryIconMediaSchema.parse(raw);
  return createHash('sha256')
    .update('whaleu-ratings-category-icon-media-prepare:v1\n')
    .update(
      JSON.stringify({
        protocol: CATEGORY_ICON_MEDIA_PROTOCOL,
        actorAccountId: mediaV2IdSchema.parse(actor),
        clientRequestId: input.clientRequestId,
        editScopeId: input.editScopeId,
        scopeRevision: input.scopeRevision,
        slot: input.slot,
        declaration: {
          mime: input.declaration.mime,
          bytes: input.declaration.bytes,
          sha256: input.declaration.sha256,
        },
      }),
    )
    .digest('hex');
}
export const categoryIconMediaParentSchema = z.strictObject({
  ownerKind: z.literal('ratings'),
  resourceKind: z.literal('category_icon'),
  resourceId: mediaV2IdSchema,
  contentVersion: z.literal(1),
});
export type CategoryIconMediaParent = z.infer<
  typeof categoryIconMediaParentSchema
>;
export const categoryIconMediaDescriptorSchema = z.strictObject({
  protocol: z.literal(CATEGORY_ICON_MEDIA_PROTOCOL),
  kind: z.literal('ratings-category-icon-media'),
  categoryId: mediaV2IdSchema,
  contextId: mediaV2IdSchema,
  contextToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  appearanceId: mediaV2IdSchema,
  bindingId: mediaV2IdSchema,
  width: z.number().int().positive().max(2048),
  height: z.number().int().positive().max(2048),
  variants: z.tuple([z.literal('thumb-v1'), z.literal('display-v1')]),
});
export type CategoryIconMediaDescriptor = z.infer<
  typeof categoryIconMediaDescriptorSchema
>;
export const categoryIconMediaDeliverySchema = z.strictObject({
  categoryId: mediaV2IdSchema,
  appearanceId: mediaV2IdSchema,
  variant: mediaVariantSchema,
  contextId: mediaV2IdSchema,
  contextToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

const instant = z.number().int().positive().safe();
const base = {
  protocol: z.literal(CATEGORY_ICON_MEDIA_PROTOCOL),
  editScopeId: mediaV2IdSchema,
  intentId: mediaV2IdSchema,
  requestId: mediaV2IdSchema,
  requestHash: mediaDigestSchema,
  serverNow: instant,
};
export const categoryIconMediaStatusSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...base,
    status: z.literal('prepared'),
    editScopeId: mediaV2IdSchema,
    operationDeadlineAt: instant,
    upload: z.enum(['none', 'in_flight', 'reconcile_needed']),
  }),
  z.strictObject({
    ...base,
    status: z.literal('uploaded'),
    editScopeId: mediaV2IdSchema,
    operationDeadlineAt: instant,
  }),
  z.strictObject({
    ...base,
    status: z.literal('processing'),
    editScopeId: mediaV2IdSchema,
    operationDeadlineAt: instant,
    retryAfterMs: z.number().int().min(250).max(30000),
  }),
  z.strictObject({
    ...base,
    status: z.literal('ready_unbound'),
    editScopeId: mediaV2IdSchema,
    assetId: mediaV2IdSchema,
    readyRetentionUntil: instant,
    editExpiresAt: instant,
    bindBefore: instant,
    mediaProof: z.literal('current'),
  }),
  z.strictObject({
    ...base,
    status: z.literal('bound_history'),
    assetId: mediaV2IdSchema,
    bindingId: mediaV2IdSchema,
    appearanceId: mediaV2IdSchema,
    categoryId: mediaV2IdSchema,
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
export type CategoryIconMediaStatus = z.infer<
  typeof categoryIconMediaStatusSchema
>;
const request = {
  protocol: z.literal(CATEGORY_ICON_MEDIA_PROTOCOL),
  requestId: mediaV2IdSchema,
  serverNow: instant,
};
export const categoryIconMediaRecoverySchema = z.discriminatedUnion('state', [
  z.strictObject({
    ...request,
    state: z.literal('not_recorded'),
    requestHash: z.null(),
  }),
  z.strictObject({
    ...request,
    state: z.literal('recorded'),
    requestHash: mediaDigestSchema,
    status: categoryIconMediaStatusSchema,
  }),
  z.strictObject({
    ...request,
    state: z.literal('cancelled_before_prepare'),
    requestHash: mediaDigestSchema,
    reason: z.literal('cancelled'),
  }),
]);
export type CategoryIconMediaRecovery = z.infer<
  typeof categoryIconMediaRecoverySchema
>;
export const cancelCategoryIconMediaRequestSchema = z.strictObject({
  protocol: z.literal(CATEGORY_ICON_MEDIA_PROTOCOL),
  requestHash: mediaDigestSchema,
});
export const categoryIconMediaCancelSchema = z.discriminatedUnion('result', [
  z.strictObject({
    protocol: z.literal(CATEGORY_ICON_MEDIA_PROTOCOL),
    result: z.literal('cancelled'),
    status: categoryIconMediaStatusSchema.options[5].extend({
      reason: z.literal('cancelled'),
    }),
  }),
  z.strictObject({
    protocol: z.literal(CATEGORY_ICON_MEDIA_PROTOCOL),
    result: z.literal('already_terminal'),
    status: categoryIconMediaStatusSchema.options[5],
  }),
  z.strictObject({
    protocol: z.literal(CATEGORY_ICON_MEDIA_PROTOCOL),
    result: z.literal('bound_history'),
    status: categoryIconMediaStatusSchema.options[4],
  }),
]);
export type CategoryIconMediaCancel = z.infer<
  typeof categoryIconMediaCancelSchema
>;
export const categoryIconMediaGrantSchema = mediaGrantSchema
  .omit({ version: true })
  .extend({
    protocol: z.literal(CATEGORY_ICON_MEDIA_PROTOCOL),
    editScopeId: mediaV2IdSchema,
  });
export const categoryIconMediaUploadObservedSchema = mediaUploadObservedSchema
  .omit({ version: true })
  .extend({
    protocol: z.literal(CATEGORY_ICON_MEDIA_PROTOCOL),
    editScopeId: mediaV2IdSchema,
  });
