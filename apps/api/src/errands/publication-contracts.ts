import { z } from 'zod';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../community/content-review/contracts.js';
import { errandIdSchema, publishErrandSchema } from './contracts.js';

export const ERRAND_PUBLICATION_PROTOCOL = 'errand-publication-v2' as const;
const outputId = z.uuid().refine((value) => value === value.toLowerCase());
export const errandImageSlotSchema = z.enum([
  'public0',
  'public1',
  'public2',
  'private0',
  'private1',
  'private2',
]);
export const errandImageFactSchema = z.strictObject({
  slot: errandImageSlotSchema,
  assetId: errandIdSchema,
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const errandImageBindingSchema = errandImageFactSchema.extend({
  bindingId: errandIdSchema,
});
export const errandImageFactsSchema = z
  .array(errandImageFactSchema)
  .max(6)
  .refine(
    (v) =>
      new Set(v.map((x) => x.assetId)).size === v.length &&
      new Set(v.map((x) => x.slot)).size === v.length,
  );
const revision = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER - 1);
export const createErrandDraftSchema = z.strictObject({
  protocol: z.literal(ERRAND_PUBLICATION_PROTOCOL),
  draftId: errandIdSchema,
  targetRegionId: errandIdSchema,
});
export const errandDraftSchema = createErrandDraftSchema.extend({
  draftId: outputId,
  targetRegionId: outputId,
  revision,
  state: z.enum(['open', 'published', 'cancelled']),
  expiresAt: z.number().int().positive().safe(),
});
export const errandDraftCancellationSchema = z.union([
  errandDraftSchema,
  z.strictObject({
    protocol: z.literal(ERRAND_PUBLICATION_PROTOCOL),
    draftId: outputId,
    revision: z.literal(1),
    state: z.literal('cancelled_before_create'),
  }),
]);
export const publishErrandV2Schema = publishErrandSchema
  .omit({
    publicAssetIds: true,
    privateAssetIds: true,
  })
  .extend({
    protocol: z.literal(ERRAND_PUBLICATION_PROTOCOL),
    draftId: errandIdSchema,
    draftRevision: revision,
    publicMedia: z.array(errandImageFactSchema).max(3),
    privateMedia: z.array(errandImageFactSchema).max(3),
  })
  .superRefine((v, ctx) => {
    for (const audience of ['public', 'private'] as const) {
      const items = v[`${audience}Media`];
      if (
        items.some((x) => !x.slot.startsWith(audience)) ||
        items.map((x) => x.slot).join(',') !==
          items
            .map((x) => x.slot)
            .sort()
            .join(',') ||
        new Set(items.map((x) => x.slot)).size !== items.length
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Images require their exact ordered audience slots',
        });
    }
    if (
      new Set([...v.publicMedia, ...v.privateMedia].map((x) => x.assetId))
        .size !==
      v.publicMedia.length + v.privateMedia.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'An asset cannot occupy multiple image slots',
      });
  });
export const cancelErrandDraftSchema = z.strictObject({
  protocol: z.literal(ERRAND_PUBLICATION_PROTOCOL),
  expectedRevision: revision,
  // Null is valid only before any publication key is reserved. An uncertain
  // publication must carry its original identity; a missing receipt is not a fence.
  publication: z
    .strictObject({
      requestId: errandIdSchema,
      requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .nullable(),
});
export const prepareErrandPublicationSchema = publishErrandV2Schema;
export const errandPublicationPreparationSchema = z.strictObject({
  protocol: z.literal(ERRAND_PUBLICATION_PROTOCOL),
  requestId: outputId,
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  draftId: outputId,
  draftRevision: revision,
  reviewDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type PublishErrandV2 = z.infer<typeof publishErrandV2Schema>;
export type ErrandImageFact = z.infer<typeof errandImageFactSchema>;
export type ErrandImageBinding = z.infer<typeof errandImageBindingSchema>;
export type ErrandDraft = z.infer<typeof errandDraftSchema>;
export function errandPublicationHash(body: PublishErrandV2) {
  const { clientRequestId: _id, ...intent } = publishErrandV2Schema.parse(body);
  void _id;
  return createHash('sha256')
    .update(
      'whaleu:errand-command:v2\n' +
        canonicalJson({ operation: 'publish', intent }),
    )
    .digest('hex');
}
