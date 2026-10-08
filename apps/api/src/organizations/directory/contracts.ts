import { z } from 'zod';

export const directoryIdSchema = z
  .uuid()
  .transform((value) => value.toLowerCase());
const publicId = z.uuid().refine((value) => value === value.toLowerCase());
export const directoryKindSchema = z.enum(['school', 'org', 'official']);
export const directoryPlatformSchema = z.enum(['qq', 'wechat', 'official']);
export const directoryAccentSchema = z.enum([
  'green',
  'orange',
  'red',
  'yellow',
  'lilac',
  'purple',
  'coral',
  'cyan',
]);
export const directoryCursorSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const limit = z
  .union([
    z.number(),
    z
      .string()
      .regex(/^[1-9][0-9]?$/)
      .transform(Number),
  ])
  .pipe(z.number().int().min(1).max(50))
  .default(20);
export const directorySearchSchema = z
  .string()
  .refine(
    (value) =>
      !Array.from(value).some((character) => {
        const point = character.codePointAt(0)!;
        return point <= 31 || (point >= 127 && point <= 159);
      }) && !/[\uD800-\uDFFF]/u.test(value),
  )
  .trim()
  .refine(
    (value) =>
      Array.from(value).length >= 1 &&
      Array.from(value).length <= 100 &&
      Buffer.byteLength(value, 'utf8') <= 400,
  );
export const directoryEmptyQuerySchema = z.strictObject({});
export const directoryEmptyBodySchema = z.union([
  z.undefined(),
  z.strictObject({}),
]);
export const directoryCategoryQuerySchema = z.strictObject({
  kind: directoryKindSchema,
  limit,
  cursor: directoryCursorSchema.optional(),
});
export const directoryEntryQuerySchema = z
  .strictObject({
    kind: directoryKindSchema,
    categoryId: directoryIdSchema.optional(),
    q: directorySearchSchema.optional(),
    limit,
    cursor: directoryCursorSchema.optional(),
  })
  .refine((query) => query.categoryId !== undefined || query.q !== undefined);
export const directoryContextSchema = z.strictObject({ regionId: publicId });
export const directoryCategorySchema = z.strictObject({
  id: publicId,
  kind: directoryKindSchema,
  name: z.string().min(1),
  description: z.string(),
  accent: directoryAccentSchema,
});
export const directoryMediaSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('absent'), value: z.null() }),
  z.strictObject({ status: z.literal('unavailable'), value: z.null() }),
]);
const notApplicable = z.strictObject({
  status: z.literal('not_applicable'),
  value: z.null(),
});
export const directoryBadgeSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('known'),
    value: z.enum(['normal', 'official', 'partner']).nullable(),
  }),
  z.strictObject({ status: z.literal('unavailable'), value: z.null() }),
]);
const summaryShape = {
  id: publicId,
  categoryId: publicId,
  kind: directoryKindSchema,
  platform: directoryPlatformSchema,
  name: z.string().min(1),
  introPreview: z.string(),
  badge: directoryBadgeSchema,
  avatar: directoryMediaSchema,
};
export const directorySummarySchema = z.strictObject(summaryShape);
const qqNumber = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('known'),
    value: z
      .string()
      .regex(/^[0-9]{5,16}$/)
      .nullable(),
  }),
  z.strictObject({ status: z.literal('unavailable'), value: z.null() }),
]);
const detailShape = {
  ...summaryShape,
  introText: z.string(),
  introImages: z.discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('known'),
      items: z.array(z.never()).length(0),
    }),
    z.strictObject({ status: z.literal('unavailable'), items: z.null() }),
  ]),
  mainQr: directoryMediaSchema,
  createdAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime().nullable(),
  visits: z.strictObject({ status: z.literal('unavailable'), value: z.null() }),
  managers: z.strictObject({
    status: z.literal('unavailable'),
    items: z.null(),
  }),
  management: z.strictObject({ status: z.literal('unavailable') }),
};
export const directoryDetailSchema = z.discriminatedUnion('platform', [
  z.strictObject({
    ...detailShape,
    platform: z.literal('qq'),
    qqGroupNumber: qqNumber,
    managerWechatImage: notApplicable,
    linkedOfficialAccountQr: directoryMediaSchema,
  }),
  z.strictObject({
    ...detailShape,
    platform: z.literal('wechat'),
    qqGroupNumber: notApplicable,
    managerWechatImage: directoryMediaSchema,
    linkedOfficialAccountQr: directoryMediaSchema,
  }),
  z.strictObject({
    ...detailShape,
    platform: z.literal('official'),
    qqGroupNumber: notApplicable,
    managerWechatImage: notApplicable,
    linkedOfficialAccountQr: notApplicable,
  }),
]);
function page<T extends z.ZodType>(item: T) {
  return z
    .strictObject({
      items: z.array(item).max(50),
      continuation: z.enum(['more', 'end']),
      nextCursor: directoryCursorSchema.nullable(),
    })
    .refine(
      (value) => (value.continuation === 'end') === (value.nextCursor === null),
    )
    .refine((value) => value.continuation === 'end' || value.items.length > 0);
}
export const directoryCategoryPageSchema = page(directoryCategorySchema);
export const directoryEntryPageSchema = page(directorySummarySchema);
export type DirectoryKind = z.infer<typeof directoryKindSchema>;
export type DirectoryCategoryQuery = z.infer<
  typeof directoryCategoryQuerySchema
>;
export type DirectoryEntryQuery = z.infer<typeof directoryEntryQuerySchema>;
export type DirectoryCategory = z.infer<typeof directoryCategorySchema>;
export type DirectorySummary = z.infer<typeof directorySummarySchema>;
export type DirectoryDetail = z.infer<typeof directoryDetailSchema>;
export type DirectoryCategoryPage = z.infer<typeof directoryCategoryPageSchema>;
export type DirectoryEntryPage = z.infer<typeof directoryEntryPageSchema>;
