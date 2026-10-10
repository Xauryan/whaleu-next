import { z } from 'zod';
import { mediaDigestSchema } from '../../media/contracts.js';
import {
  catalogKeySchema,
  profileMediaId,
  PROFILE_MEDIA_PROTOCOL,
} from './contracts.js';
const variants = z.tuple([z.literal('thumb-v1'), z.literal('display-v1')]);
export const avatarSelectionSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('none') }),
  z.strictObject({ state: z.literal('unavailable') }),
  z.strictObject({
    state: z.literal('available'),
    appearanceId: profileMediaId,
    source: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('catalog'),
        catalogVersion: catalogKeySchema,
        itemId: catalogKeySchema,
      }),
      z.strictObject({ kind: z.literal('custom'), bindingId: profileMediaId }),
    ]),
    variants,
    width: z.number().int().min(1).max(2048),
    height: z.number().int().min(1).max(2048),
  }),
]);
export type AvatarSelection = z.infer<typeof avatarSelectionSchema>;
export const avatarCurrentSchema = z
  .strictObject({
    protocol: z.literal(PROFILE_MEDIA_PROTOCOL),
    profileId: profileMediaId.nullable(),
    revision: z.number().int().min(0).max(2147483647),
    avatar: avatarSelectionSchema,
  })
  .refine(
    (value) => value.profileId !== null || value.avatar.state !== 'available',
  );
export type AvatarCurrent = z.infer<typeof avatarCurrentSchema>;
export const avatarCatalogSchema = z.discriminatedUnion('availability', [
  z.strictObject({
    protocol: z.literal(PROFILE_MEDIA_PROTOCOL),
    availability: z.literal('unavailable'),
    catalogVersion: z.null(),
    items: z.tuple([]),
  }),
  z.strictObject({
    protocol: z.literal(PROFILE_MEDIA_PROTOCOL),
    availability: z.literal('available'),
    catalogVersion: catalogKeySchema,
    items: z
      .array(
        z.strictObject({
          itemId: catalogKeySchema,
          label: z
            .string()
            .min(1)
            .max(80)
            .refine((value) =>
              [...value].every(
                (character) =>
                  character.charCodeAt(0) >= 32 &&
                  character.charCodeAt(0) !== 127,
              ),
            ),
          contentHash: mediaDigestSchema,
        }),
      )
      .min(1)
      .max(91)
      .refine(
        (items) =>
          new Set(items.map((item) => item.itemId)).size === items.length,
      ),
  }),
]);
