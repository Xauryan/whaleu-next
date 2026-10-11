export * from '../../media/contracts-announcement.js';
import type { AnnouncementMediaSlot } from '../../media/contracts-announcement.js';
export type AnnouncementMediaBindings = z.infer<
  typeof announcementMediaBindingsSchema
>;
export type AnnouncementMediaChange =
  | { readonly action: 'keep' }
  | { readonly action: 'remove' }
  | { readonly action: 'replace'; readonly assetId: string };
export interface AnnouncementMediaMutation {
  readonly actorAccountId: string;
  readonly announcementId: string;
  readonly revision: number;
  readonly currentBindings: AnnouncementMediaBindings;
  readonly changes: z.infer<typeof announcementMediaChangesSchema>;
}
export type AnnouncementMediaDraftRetirement = Omit<
  AnnouncementMediaMutation,
  'changes'
>;
import { z } from 'zod';
import { announcementMediaSlotSchema } from '../../media/contracts-announcement.js';
import { mediaV2IdSchema } from '../../media/contracts-v2.js';
const optionalSlots = <T extends z.ZodType>(value: T) =>
  Object.fromEntries(
    announcementMediaSlotSchema.options.map((slot) => [slot, value.optional()]),
  ) as Record<AnnouncementMediaSlot, z.ZodOptional<T>>;
export const announcementMediaBindingsSchema = z
  .strictObject(optionalSlots(mediaV2IdSchema.nullable()))
  .superRefine((value, ctx) => {
    const ids = Object.values(value).filter((id) => id != null);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: 'custom',
        message: 'Announcement images must occupy distinct slots',
      });
  });
export const announcementMediaChangesSchema = z.strictObject(
  optionalSlots(
    z.discriminatedUnion('action', [
      z.strictObject({ action: z.literal('keep') }),
      z.strictObject({ action: z.literal('remove') }),
      z.strictObject({
        action: z.literal('replace'),
        assetId: mediaV2IdSchema,
      }),
    ]),
  ),
);
