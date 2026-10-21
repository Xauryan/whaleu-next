import { z } from 'zod';

const uuid = z.uuid().transform((value) => value.toLowerCase());

export const referenceCodeSchema = z.string().regex(/^[1-9][0-9]{6,8}$/);
export const referenceTargetSchema = z.strictObject({
  kind: z.enum(['post', 'comment', 'reply']),
  targetId: uuid,
});
export const referenceResolveSchema = z.strictObject({
  code: referenceCodeSchema,
  viewSpaceId: uuid.optional(),
});
export const referenceLookupSchema = z.strictObject({
  targets: z.array(referenceTargetSchema).min(1).max(30),
  viewSpaceId: uuid.optional(),
});
export const referenceCapabilitySchema = z.strictObject({
  available: z.boolean(),
});
export const referenceDestinationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('post'),
    postId: z.uuid(),
    viewSpaceId: uuid.optional(),
  }),
  z.strictObject({
    kind: z.literal('comment'),
    postId: z.uuid(),
    rootCommentId: z.uuid(),
    viewSpaceId: uuid.optional(),
  }),
  z.strictObject({
    kind: z.literal('reply'),
    postId: z.uuid(),
    rootCommentId: z.uuid(),
    replyId: z.uuid(),
    viewSpaceId: uuid.optional(),
  }),
]);
export const referenceLookupResultSchema = z.strictObject({
  items: z
    .array(referenceTargetSchema.extend({ code: referenceCodeSchema }))
    .max(30),
});
export const referenceEmptyQuerySchema = z.strictObject({});
export const referenceEmptyBodySchema = z.union([
  z.undefined(),
  z.strictObject({}),
]);
export type ReferenceTarget = z.infer<typeof referenceTargetSchema>;
export type ReferenceResolve = z.infer<typeof referenceResolveSchema>;
export type ReferenceLookup = z.infer<typeof referenceLookupSchema>;
export type ReferenceDestination = z.infer<typeof referenceDestinationSchema>;
export type ReferenceLookupResult = z.infer<typeof referenceLookupResultSchema>;
export type ReferenceAllocation =
  { state: 'inactive' } | { state: 'allocated'; code: string };
