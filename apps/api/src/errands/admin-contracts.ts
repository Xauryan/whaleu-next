import { z } from 'zod';
import {
  errandCursorSchema,
  errandIdSchema,
  errandStateSchema,
  errandSummarySchema,
  errandText,
  errandTimeSchema,
} from './contracts.js';

const publicId = z.uuid().refine((value) => value === value.toLowerCase());
export const errandAdminStatusSchema = z.enum([
  'all',
  'pending',
  'accepted',
  'completed',
  'cancelled',
  'deleted',
]);
export const errandAdminQuerySchema = z.strictObject({
  regionId: errandIdSchema.optional(),
  status: errandAdminStatusSchema.default('all'),
  keyword: errandText(100, false).default(''),
  limit: z
    .union([
      z.number(),
      z
        .string()
        .regex(/^[1-9][0-9]?$/)
        .transform(Number),
    ])
    .pipe(z.number().int().min(1).max(50))
    .default(20),
  cursor: errandCursorSchema.optional(),
});
export const errandAdminParticipantSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('available'),
    profileId: publicId,
    displayName: z.string().min(1).max(200),
  }),
  z.strictObject({ status: z.literal('unavailable') }),
]);
export const errandAdminRegionSchema = z.discriminatedUnion('status', [
  z.strictObject({
    id: publicId,
    status: z.literal('available'),
    label: z
      .string()
      .min(1)
      .max(400)
      .refine((value) => [...value].length <= 200),
    active: z.boolean(),
  }),
  z.strictObject({ id: publicId, status: z.literal('unavailable') }),
]);
export const errandAdminOrderSchema = z
  .strictObject({
    id: publicId,
    revision: publicId,
    title: errandSummarySchema.shape.title,
    publicText: errandSummarySchema.shape.publicText,
    expectedTimeText: errandSummarySchema.shape.expectedTimeText,
    reward: errandSummarySchema.shape.reward,
    state: errandStateSchema,
    displayState: z.enum([
      'pending',
      'accepted',
      'completed',
      'cancelled',
      'deleted',
    ]),
    createdAt: errandTimeSchema,
    acceptedAt: errandTimeSchema.nullable(),
    completedAt: errandTimeSchema.nullable(),
    cancelledAt: errandTimeSchema.nullable(),
    deletedAt: errandTimeSchema.nullable(),
    // E1 did not collect a reason. Unavailable is not an invented empty reason.
    deletionReason: z
      .strictObject({ status: z.literal('unavailable') })
      .nullable(),
    publisher: errandAdminParticipantSchema,
    accepter: errandAdminParticipantSchema.nullable(),
    relation: z.enum(['publisher', 'accepter', 'none']),
    sourceRegion: errandAdminRegionSchema,
    targetRegion: errandAdminRegionSchema,
  })
  .refine(
    (value) =>
      value.displayState ===
        (value.deletedAt === null ? value.state : 'deleted') &&
      (value.deletionReason === null) === (value.deletedAt === null) &&
      (value.accepter === null) === (value.acceptedAt === null) &&
      (value.state !== 'pending' || value.acceptedAt === null) &&
      (!['accepted', 'completed'].includes(value.state) ||
        value.acceptedAt !== null) &&
      (value.state === 'completed') === (value.completedAt !== null) &&
      (value.state === 'cancelled') === (value.cancelledAt !== null) &&
      (value.relation !== 'accepter' || value.accepter !== null) &&
      (value.acceptedAt === null ||
        Date.parse(value.acceptedAt) >= Date.parse(value.createdAt)) &&
      (value.completedAt === null ||
        Date.parse(value.completedAt) >= Date.parse(value.acceptedAt!)) &&
      (value.cancelledAt === null ||
        Date.parse(value.cancelledAt) >=
          Date.parse(value.acceptedAt ?? value.createdAt)) &&
      (value.deletedAt === null ||
        Date.parse(value.deletedAt) >=
          Date.parse(
            value.completedAt ??
              value.cancelledAt ??
              value.acceptedAt ??
              value.createdAt,
          )),
  );
export const errandAdminTotalSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('known'),
    value: z
      .string()
      .max(100)
      .regex(/^(0|[1-9][0-9]*)$/),
  }),
  z.strictObject({ status: z.literal('unavailable') }),
]);
export const errandAdminPageSchema = z
  .strictObject({
    context: z.strictObject({
      regionId: publicId,
      management: z.enum(['fixed', 'global']),
      status: errandAdminStatusSchema,
      keyword: z.string().max(200),
      search: z.strictObject({
        matcher: z.literal('public-text-name-uuid-v1'),
        legacyNumericReferences: z.literal('unavailable'),
      }),
    }),
    items: z.array(errandAdminOrderSchema).max(50),
    continuation: z.enum(['more', 'end']),
    nextCursor: errandCursorSchema.nullable(),
    total: errandAdminTotalSchema,
  })
  .refine(
    (value) =>
      (value.continuation === 'end') === (value.nextCursor === null) &&
      new Set(value.items.map((item) => item.id)).size === value.items.length &&
      value.items.every(
        (item) => item.targetRegion.id === value.context.regionId,
      ),
  );
export type ErrandAdminQuery = z.infer<typeof errandAdminQuerySchema>;
export type ErrandAdminOrder = z.infer<typeof errandAdminOrderSchema>;
export type ErrandAdminParticipant = z.infer<
  typeof errandAdminParticipantSchema
>;
export type ErrandAdminPage = z.infer<typeof errandAdminPageSchema>;
