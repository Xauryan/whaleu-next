import { z } from 'zod';

export const MEDIA_POLICY_VERSION = 'media-static-v1' as const;
export const MEDIA_TRANSFORM_VERSION = 'static-reencode-v1' as const;
export const MEDIA_MAX_INPUT_BYTES = 5 * 1024 * 1024;
export const MEDIA_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
export const MEDIA_MAX_PIXELS = 24_000_000;
export const mediaIdSchema = z.uuid();
export const mediaDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const mediaMimeSchema = z.enum(['image/jpeg', 'image/png']);
export const mediaVariantSchema = z.enum(['thumb-v1', 'display-v1']);
export const mediaAudienceSchema = z.enum([
  'content-gated',
  'participant-private',
  'conversation-private',
]);
/** Future owners need a separately implemented and registered authorization port.
 * This union defines identity only; it never grants any owner access. */
export const mediaParentSchema = z.discriminatedUnion('ownerKind', [
  z.strictObject({
    ownerKind: z.literal('community'),
    resourceKind: z.enum(['post', 'comment', 'reply']),
    resourceId: mediaIdSchema,
    contentVersion: z.literal(1),
  }),
  z.strictObject({
    ownerKind: z.literal('messaging'),
    resourceKind: z.literal('message'),
    resourceId: mediaIdSchema,
    contentVersion: z.number().int().positive().safe(),
  }),
  z.strictObject({
    ownerKind: z.literal('errands'),
    resourceKind: z.literal('order'),
    resourceId: mediaIdSchema,
    contentVersion: z.number().int().positive().safe(),
  }),
]);
export type MediaParent = z.infer<typeof mediaParentSchema>;
export type MediaAudience = z.infer<typeof mediaAudienceSchema>;
export type MediaVariantName = z.infer<typeof mediaVariantSchema>;

/** An internal exact locator, never a request parameter or a public URL.
 * Provider adapters must reject locator namespaces they do not own. */
export const exactObjectSchema = z.strictObject({
  provider: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  environment: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  bucket: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/),
  key: z
    .string()
    .min(1)
    .max(1024)
    .refine((value) =>
      [...value].every(
        (character) =>
          character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ),
    ),
  version: z
    .string()
    .min(1)
    .max(1024)
    .refine((value) =>
      [...value].every(
        (character) =>
          character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ),
    ),
});
export type ExactObject = z.infer<typeof exactObjectSchema>;
const measuredImageSchema = z.strictObject({
  object: exactObjectSchema,
  sha256: mediaDigestSchema,
  mime: mediaMimeSchema,
  bytes: z.number().int().positive().max(MEDIA_MAX_INPUT_BYTES),
  width: z.number().int().positive().max(8192),
  height: z.number().int().positive().max(8192),
});
const variantSchema = measuredImageSchema.extend({ name: mediaVariantSchema });
export const mediaManifestSchema = z
  .strictObject({
    version: z.literal(1),
    policyVersion: z.literal(MEDIA_POLICY_VERSION),
    transformVersion: z.literal(MEDIA_TRANSFORM_VERSION),
    original: measuredImageSchema,
    variants: z.tuple([
      variantSchema.extend({ name: z.literal('thumb-v1') }),
      variantSchema.extend({ name: z.literal('display-v1') }),
    ]),
  })
  .superRefine((manifest, ctx) => {
    const { original, variants } = manifest;
    const objects = [original, ...variants];
    if (objects.some((image) => image.width * image.height > MEDIA_MAX_PIXELS))
      ctx.addIssue({ code: 'custom', message: 'Pixel budget exceeded' });
    if (
      variants.reduce((n, image) => n + image.bytes, 0) > MEDIA_MAX_OUTPUT_BYTES
    )
      ctx.addIssue({ code: 'custom', message: 'Output byte budget exceeded' });
    if (
      new Set(objects.map((image) => JSON.stringify(image.object))).size !== 3
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Objects must be independently immutable',
      });
    for (const image of variants) {
      const maximum = image.name === 'thumb-v1' ? 400 : 2048;
      if (
        Math.max(image.width, image.height) > maximum ||
        Math.max(image.width, image.height) >
          Math.max(original.width, original.height) ||
        image.width * image.height > original.width * original.height ||
        image.mime !== original.mime
      )
        ctx.addIssue({ code: 'custom', message: 'Invalid canonical variant' });
      if (
        image.object.provider !== original.object.provider ||
        image.object.environment !== original.object.environment
      )
        ctx.addIssue({ code: 'custom', message: 'Mixed storage environments' });
    }
  });
export type MediaManifest = z.infer<typeof mediaManifestSchema>;

/** S0 does not install these schemas as live HTTP routes. Only Community single
 * post image is preparable in S1. Expanded counts require owner acceptance. */
export const prepareMediaSchema = z.strictObject({
  clientRequestId: mediaIdSchema,
  purpose: z.literal('community-post-image'),
  draftId: mediaIdSchema,
  spaceId: mediaIdSchema,
  slot: z.literal('images'),
  ordinal: z.literal(0),
  declaration: z.strictObject({
    mime: mediaMimeSchema,
    bytes: z.number().int().positive().max(MEDIA_MAX_INPUT_BYTES),
  }),
});
export const mediaIntentCommandSchema = z.strictObject({
  intentId: mediaIdSchema,
});
export const mediaDeliveryRequestSchema = z.strictObject({
  bindingId: mediaIdSchema,
  variant: mediaVariantSchema,
});
export const mediaAttachmentDescriptorSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal('authenticated-media'),
  assetId: mediaIdSchema,
  bindingId: mediaIdSchema,
  width: z.number().int().positive().max(2048),
  height: z.number().int().positive().max(2048),
  variants: z.tuple([z.literal('thumb-v1'), z.literal('display-v1')]),
});
export type MediaAttachmentDescriptor = z.infer<
  typeof mediaAttachmentDescriptorSchema
>;

const mediaStatusBase = {
  intentId: mediaIdSchema,
  expiresAt: z.number().int().positive().safe(),
  reasonCode: z
    .enum([
      'MEDIA_REJECTED',
      'MEDIA_EXPIRED',
      'MEDIA_CANCELLED',
      'MEDIA_UNAVAILABLE',
    ])
    .nullable(),
  retryable: z.boolean(),
};
export const mediaIntentStatusSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...mediaStatusBase, status: z.literal('prepared') }),
  z.strictObject({ ...mediaStatusBase, status: z.literal('uploading') }),
  z.strictObject({ ...mediaStatusBase, status: z.literal('processing') }),
  z.strictObject({
    ...mediaStatusBase,
    status: z.literal('ready'),
    assetId: mediaIdSchema,
  }),
  z.strictObject({ ...mediaStatusBase, status: z.literal('rejected') }),
  z.strictObject({ ...mediaStatusBase, status: z.literal('expired') }),
  z.strictObject({ ...mediaStatusBase, status: z.literal('cancelled') }),
  z.strictObject({ ...mediaStatusBase, status: z.literal('unavailable') }),
]);
