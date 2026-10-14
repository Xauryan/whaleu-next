import { z } from 'zod';
export const SCHOOL_UID_MAX = 9223372036854775807n;
export const schoolCodeSchema = z.string().regex(/^[0-9]{5}$/);
export const schoolUidValueSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine(
    (value) =>
      /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= SCHOOL_UID_MAX,
  );
export const schoolUidInputSchema = z
  .string()
  .regex(/^[0-9]{1,19}$/)
  .refine(
    (value) =>
      /^[0-9]{1,19}$/.test(value) &&
      BigInt(value) > 0n &&
      BigInt(value) <= SCHOOL_UID_MAX,
  )
  .transform((value) => BigInt(value).toString());
export const formatSchoolUid = (value: string): string =>
  schoolUidValueSchema.parse(value).padStart(6, '0');
export const schoolUidSchoolSchema = z.strictObject({
  code: schoolCodeSchema,
  name: z.string().min(1).max(200),
});
export const schoolUidSchema = z.discriminatedUnion('status', [
  z
    .strictObject({
      status: z.literal('assigned'),
      school: schoolUidSchoolSchema,
      uid: schoolUidValueSchema,
      formattedUid: z.string(),
    })
    .refine(
      (value) =>
        schoolUidValueSchema.safeParse(value.uid).success &&
        value.formattedUid === value.uid.padStart(6, '0'),
    ),
  z.strictObject({ status: z.literal('unassigned') }),
  z.strictObject({ status: z.literal('unavailable') }),
]);
export type SchoolUid = z.infer<typeof schoolUidSchema>;
export const schoolUidLookupQuerySchema = z.strictObject({
  schoolCode: schoolCodeSchema,
  uid: schoolUidInputSchema,
});
export const schoolUidLookupSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('found'),
    target: z.strictObject({
      profileId: z.uuid().refine((value) => value === value.toLowerCase()),
      displayName: z.string().min(1).max(100),
    }),
  }),
  z.strictObject({ status: z.literal('unavailable') }),
]);
export type SchoolUidLookup = z.infer<typeof schoolUidLookupSchema>;
export const schoolUidEmptyQuerySchema = z.strictObject({});
