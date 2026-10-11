export * from '../../media/contracts-organization.js';
import type { OrganizationMediaSlot } from '../../media/contracts-organization.js';
export type OrganizationMediaBindings = z.infer<
  typeof organizationMediaBindingsSchema
>;
export type OrganizationMediaChange =
  | { readonly action: 'keep' }
  | { readonly action: 'remove' }
  | { readonly action: 'replace'; readonly assetId: string };
export interface OrganizationMediaMutation {
  readonly actorAccountId: string;
  readonly organizationId: string;
  readonly applicationRevision: number;
  readonly currentBindings: OrganizationMediaBindings;
  readonly changes: z.infer<typeof organizationMediaChangesSchema>;
}
import { z } from 'zod';
import { organizationMediaSlotSchema } from '../../media/contracts-organization.js';
import { mediaV2IdSchema } from '../../media/contracts-v2.js';
const optionalSlots = <T extends z.ZodType>(value: T) =>
  Object.fromEntries(
    organizationMediaSlotSchema.options.map((slot) => [slot, value.optional()]),
  ) as Record<OrganizationMediaSlot, z.ZodOptional<T>>;
export const organizationMediaBindingsSchema = z.strictObject(
  optionalSlots(mediaV2IdSchema.nullable()),
);
export const organizationMediaChangesSchema = z.strictObject(
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
