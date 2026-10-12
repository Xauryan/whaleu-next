import { hotPostViewSchema } from '../hot/response-schema.js';
import { z } from 'zod';
import { tradingSubtypeSchema } from '../trading/contracts.js';
import { categorySchema } from '../contracts.js';
import type { PostView } from '../contracts.js';
export const pinIdSchema = z.uuid().transform((v) => v.toLowerCase());
export const pinRequestIdSchema = z.uuidv4().transform((v) => v.toLowerCase());
export const pinEmptyBodySchema = z.union([z.undefined(), z.strictObject({})]);
export const pinQuerySchema = z
  .strictObject({
    spaceId: pinIdSchema,
    category: categorySchema.optional(),
    tradingSubtype: tradingSubtypeSchema.optional(),
  })
  .refine((v) => !v.tradingSubtype || v.category === 'trading');
export const pinCommandSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    clientRequestId: pinRequestIdSchema,
    operation: z.literal('pin'),
    postId: pinIdSchema,
    durationHours: z.number().int().min(1).max(168).default(24),
    level: z.union([z.literal(1), z.literal(2)]).default(2),
  }),
  z.strictObject({
    clientRequestId: pinRequestIdSchema,
    operation: z.literal('unpin'),
    postId: pinIdSchema,
    pinId: pinIdSchema,
  }),
  z.strictObject({
    clientRequestId: pinRequestIdSchema,
    operation: z.literal('read'),
    postId: pinIdSchema,
    pinId: pinIdSchema,
  }),
]);
export const pinEmptySchema = z.strictObject({});
export type PinCommand = z.infer<typeof pinCommandSchema>;
export type PinQuery = z.infer<typeof pinQuerySchema>;
export type PinReceipt = {
  requestId: string;
  operation: PinCommand['operation'];
  postId: string;
} & (
  | { outcome: 'applied'; pinId: string; recordedAt: string }
  | {
      outcome: 'rejected';
      code: 'POST_PIN_CONFLICT' | 'POST_PIN_STALE' | 'POST_PIN_CANCELLED';
    }
);
export interface PinMetadata {
  pinId: string;
  postId: string;
  level: 1 | 2;
  pinnedAt: string;
  pinnedUntil: string;
  readState: 'unread' | 'read' | 'guest';
  readAt: string | null;
}
export interface PinPage {
  spaceId: string;
  status: 'available' | 'unavailable';
  items: { pin: PinMetadata; post: PostView }[];
}
export interface PinDetail {
  postId: string;
  status: 'available' | 'unavailable';
  pin: PinMetadata | null;
  canPin: boolean;
  canUnpin: boolean;
}

export const pinMetadataSchema = z.strictObject({
  pinId: z.uuid(),
  postId: z.uuid(),
  level: z.union([z.literal(1), z.literal(2)]),
  pinnedAt: z.iso.datetime(),
  pinnedUntil: z.iso.datetime(),
  readState: z.enum(['read', 'unread', 'guest']),
  readAt: z.iso.datetime().nullable(),
});
export const pinPageSchema = z.strictObject({
  spaceId: z.uuid(),
  status: z.enum(['available', 'unavailable']),
  items: z
    .array(
      z.strictObject({
        pin: pinMetadataSchema,
        post: hotPostViewSchema
          .extend({
            feedback: z
              .strictObject({
                authorSchool: z.string().nullable(),
                hasContacts: z.boolean(),
              })
              .optional(),
            allowAnonymousDm: z.boolean(),
          })
          .meta({ id: 'PinnedPostView' }),
      }),
    )
    .max(1),
});
export const pinDetailSchema = z.strictObject({
  postId: z.uuid(),
  status: z.enum(['available', 'unavailable']),
  pin: pinMetadataSchema.nullable(),
  canPin: z.boolean(),
  canUnpin: z.boolean(),
});
const receiptBase = {
  requestId: z.uuid(),
  operation: z.enum(['pin', 'unpin', 'read']),
  postId: z.uuid(),
};
export const pinReceiptSchema = z.union([
  z.strictObject({
    ...receiptBase,
    outcome: z.literal('applied'),
    pinId: z.uuid(),
    recordedAt: z.iso.datetime(),
  }),
  z.strictObject({
    ...receiptBase,
    outcome: z.literal('rejected'),
    code: z.enum(['POST_PIN_CONFLICT', 'POST_PIN_STALE', 'POST_PIN_CANCELLED']),
  }),
]);

/** Authority-only slot management: no content, author or read-state projection. */
export const pinSlotQuerySchema = z.strictObject({ spaceId: pinIdSchema });
export const pinSlotSchema = z.strictObject({
  spaceId: z.uuid(),
  status: z.enum(['available', 'unavailable']),
  canUnpin: z.boolean(),
  pin: z
    .strictObject({
      pinId: z.uuid(),
      postId: z.uuid(),
      level: z.union([z.literal(1), z.literal(2)]),
      pinnedUntil: z.iso.datetime(),
    })
    .nullable(),
});
export type PinSlot = z.infer<typeof pinSlotSchema>;
