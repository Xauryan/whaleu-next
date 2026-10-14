import { z } from 'zod';
import { textSchema } from '../text.js';

// Output/immutable evidence is already canonical; never normalize it while decoding.
const canonicalText = (maximum: number) =>
  z.string().refine((value) => {
    const result = textSchema(maximum).safeParse(value);
    return result.success && result.data === value;
  });

const id = z.uuid().refine((value) => value === value.toLowerCase());
const selector = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('global') }),
  z.strictObject({ kind: z.literal('campus'), campusId: id }),
]);
/** Client references are expectations, never a public-target capability. */
export const ratingTargetLinkReferenceSchema = z.strictObject({
  targetId: id,
  selector,
  expectedTargetRevision: id,
  expectedCategoryRevision: id,
  expectedSourceRevision: id,
});
export const ratingTargetLinkCapabilitySchema =
  ratingTargetLinkReferenceSchema.extend({
    systemKey: z.enum(['course', 'canteen']),
  });
export const ratingTargetLinkComponentSchema =
  ratingTargetLinkReferenceSchema.extend({
    kind: z.literal('rating_target_link'),
    label: canonicalText(12).refine(
      (value) =>
        value.trim() === value &&
        value.length > 0 &&
        ![...value].some((character) => {
          const code = character.codePointAt(0)!;
          return (
            code < 32 ||
            (code >= 127 && code <= 159) ||
            (code >= 0x2028 && code <= 0x202e) ||
            (code >= 0x2066 && code <= 0x2069)
          );
        }),
    ),
  });
/** Frozen write-time evidence. It is NEVER compared to a later display revision. */
export const ratingTargetBindingSchema = z
  .strictObject({
    version: z.literal(1),
    targetId: id,
    categoryId: id,
    targetRevision: id,
    definitionRevision: id,
    contentVersion: z.number().int().min(1),
    originSourceId: id,
    sourceId: id,
    sourceRevision: id,
    placementRevision: id,
    categoryRevision: id,
    catalogId: id,
    headRevision: id,
    protocolGeneration: id,
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    selector,
    originRegionId: id.nullable(),
    systemKey: z.enum(['course', 'canteen']),
    ancestry: z
      .array(z.strictObject({ categoryId: id, revision: id }))
      .min(1)
      .max(3),
  })
  .refine(
    (value) =>
      value.ancestry.at(-1)?.categoryId === value.categoryId &&
      value.ancestry.at(-1)?.revision === value.categoryRevision &&
      new Set(value.ancestry.map((node) => node.categoryId)).size ===
        value.ancestry.length,
  );
export const reviewedRatingTargetLinkSchema = z
  .strictObject({
    kind: z.literal('rating_target_link'),
    targetId: id,
    label: ratingTargetLinkComponentSchema.shape.label,
    binding: ratingTargetBindingSchema,
  })
  .refine((value) => value.targetId === value.binding.targetId);
export const ratingTargetLinkViewSchema = z.strictObject({
  kind: z.literal('rating_target_link'),
  label: ratingTargetLinkComponentSchema.shape.label,
  target: z.strictObject({
    id,
    name: canonicalText(100),
    locator: z.strictObject({ targetId: id, selector }),
  }),
});
export type RatingTargetLinkReference = z.infer<
  typeof ratingTargetLinkReferenceSchema
>;
export type RatingTargetLinkComponent = z.infer<
  typeof ratingTargetLinkComponentSchema
>;
export type RatingTargetBinding = z.infer<typeof ratingTargetBindingSchema>;
export type ReviewedRatingTargetLink = z.infer<
  typeof reviewedRatingTargetLinkSchema
>;
export type RatingTargetLinkView = z.infer<typeof ratingTargetLinkViewSchema>;
