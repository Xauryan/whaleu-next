import { z } from 'zod';
import { mediaV2IdSchema } from './contracts-v2.js';
import { mediaDigestSchema } from './contracts.js';
export const campusToolMediaTargetSchema = z.strictObject({
  campusId: mediaV2IdSchema,
  catalogId: mediaV2IdSchema,
  entryId: mediaV2IdSchema,
  bindingId: mediaV2IdSchema,
});
export type CampusToolMediaTarget = z.infer<typeof campusToolMediaTargetSchema>;
export const campusToolMediaReferenceSchema =
  campusToolMediaTargetSchema.extend({
    entryRevision: mediaV2IdSchema,
    assetId: mediaV2IdSchema,
    manifestDigest: mediaDigestSchema,
  });
export type CampusToolMediaReference = z.infer<
  typeof campusToolMediaReferenceSchema
>;
export const campusToolMediaDescriptorSchema =
  campusToolMediaReferenceSchema.extend({
    protocol: z.literal('campus-tools-media-v1'),
    kind: z.literal('campus-tool'),
    width: z.number().int().positive().max(2048),
    height: z.number().int().positive().max(2048),
    variants: z.tuple([z.literal('thumb-v1'), z.literal('display-v1')]),
  });
