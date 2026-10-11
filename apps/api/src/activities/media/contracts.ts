export * from '../../media/contracts-activity.js';
import type { ActivityMediaSlot } from '../../media/contracts-activity.js';
export type ActivityMediaBindings = z.infer<typeof activityMediaBindingsSchema>;
export type ActivityMediaChange =
  | { readonly action: 'keep' }
  | { readonly action: 'remove' }
  | { readonly action: 'replace'; readonly assetId: string };
export interface ActivityMediaMutation {
  readonly actorAccountId: string;
  readonly activityId: string;
  readonly revision: number;
  readonly currentBindings: ActivityMediaBindings;
  readonly changes: z.infer<typeof activityMediaChangesSchema>;
}
export type ActivityMediaDraftRetirement = Omit<
  ActivityMediaMutation,
  'changes'
>;
import { z } from 'zod';
import { activityMediaSlotSchema } from '../../media/contracts-activity.js';
import { mediaV2IdSchema } from '../../media/contracts-v2.js';
const optionalSlots = <T extends z.ZodType>(value: T) =>
  Object.fromEntries(
    activityMediaSlotSchema.options.map((slot) => [slot, value.optional()]),
  ) as Record<ActivityMediaSlot, z.ZodOptional<T>>;
export const activityMediaBindingsSchema = z
  .strictObject(optionalSlots(mediaV2IdSchema.nullable()))
  .superRefine((value, ctx) => {
    const ids = Object.values(value).filter((id) => id != null);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: 'custom',
        message: 'Activity images must occupy distinct slots',
      });
  });
export const activityMediaChangesSchema = z.strictObject(
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
