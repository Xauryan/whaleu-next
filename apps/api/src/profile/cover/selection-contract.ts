import { z } from 'zod';
import { profileCoverMediaId, PROFILE_COVER_PROTOCOL } from './contracts.js';
const variants = z.tuple([z.literal('thumb-v1'), z.literal('display-v1')]);
export const coverSelectionSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('none') }),
  z.strictObject({ state: z.literal('unavailable') }),
  z.strictObject({
    state: z.literal('available'),
    appearanceId: profileCoverMediaId,
    source: z.strictObject({
      kind: z.literal('custom'),
      bindingId: profileCoverMediaId,
    }),
    variants,
    width: z.number().int().min(1).max(2048),
    height: z.number().int().min(1).max(2048),
  }),
]);
export type CoverSelection = z.infer<typeof coverSelectionSchema>;
export const coverCurrentSchema = z
  .strictObject({
    protocol: z.literal(PROFILE_COVER_PROTOCOL),
    profileId: profileCoverMediaId.nullable(),
    revision: z.number().int().min(0).max(2147483647),
    cover: coverSelectionSchema,
  })
  .refine(
    (value) => value.profileId !== null || value.cover.state !== 'available',
  );
export type CoverCurrent = z.infer<typeof coverCurrentSchema>;
