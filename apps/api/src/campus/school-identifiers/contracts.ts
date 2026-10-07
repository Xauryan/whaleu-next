import { z } from 'zod';

const boundedText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value === value.trim(), {
      message: 'Surrounding whitespace is not a reviewed identifier',
    });
const timestamp = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
const review = {
  reviewedBy: boundedText(200),
  reviewedAt: timestamp,
  reviewNote: boundedText(2000),
};
export const schoolCodeSchema = z
  .string()
  .length(5)
  .regex(/^[0-9]{5}$/);
export const identifierSourceSchema = z.strictObject({
  id: boundedText(100),
  title: boundedText(500),
  publisher: boundedText(200),
  url: z.url({ protocol: /^https$/ }).max(2000),
  publishedOn: z.iso.date().nullable(),
  retrievedAt: timestamp,
  contentSha256: z
    .string()
    .length(64)
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
export const schoolIdentifierSchema = z
  .strictObject({
    institutionId: z.uuid(),
    schoolCode: schoolCodeSchema,
    moeCode: z
      .string()
      .length(10)
      .regex(/^4[12][0-9]{2}0[0-9]{5}$/),
    fiveDigitSourceId: boundedText(100),
    moeSourceId: boundedText(100),
    ...review,
  })
  .refine((value) => value.moeCode.slice(-5) === value.schoolCode, {
    message:
      'Reviewed higher-education MOE ten-digit and five-digit identifiers disagree',
  });
export const identifierAliasSchema = z
  .strictObject({
    scheme: z.enum([
      'moe-five-historical',
      'moe-ten-historical',
      'provincial-admissions',
      'institution-admissions',
      'research-institute',
      'other',
    ]),
    scope: boundedText(200),
    value: boundedText(200),
    institutionId: z.uuid(),
    validFrom: z.iso.date().nullable(),
    validTo: z.iso.date().nullable(),
    sourceId: boundedText(100),
    ...review,
  })
  .refine(
    (value) =>
      !value.validFrom || !value.validTo || value.validFrom <= value.validTo,
    { message: 'Invalid alias validity interval' },
  )
  .refine(
    (value) =>
      value.scheme !== 'moe-five-historical' || /^[0-9]{5}$/.test(value.value),
    { message: 'Invalid historical five-digit code' },
  )
  .refine(
    (value) =>
      value.scheme !== 'moe-ten-historical' || /^[0-9]{10}$/.test(value.value),
    { message: 'Invalid historical ten-digit code' },
  );
export const legacyRecordSchema = z.strictObject({
  sourceSystem: boundedText(200),
  legacyRecordId: boundedText(200),
});
export const legacyCrosswalkSchema = legacyRecordSchema.extend({
  institutionId: z.uuid(),
  sourceId: boundedText(100),
  ...review,
});
export const schoolIdentifierManifestSchema = z.strictObject({
  version: z.literal(1),
  sources: z.array(identifierSourceSchema).max(10000),
  mappings: z.array(schoolIdentifierSchema).max(10000),
  aliases: z.array(identifierAliasSchema).max(100000),
  legacyCrosswalks: z.array(legacyCrosswalkSchema).max(100000),
  // Source inventory is optional to assemble, but explicit even when empty.
  // An unmatched record is reported as unresolved, never guessed or discarded.
  legacyRecords: z.array(legacyRecordSchema).max(100000),
});
export type IdentifierSource = z.infer<typeof identifierSourceSchema>;
export type SchoolIdentifier = z.infer<typeof schoolIdentifierSchema>;
export type IdentifierAlias = z.infer<typeof identifierAliasSchema>;
export type LegacyCrosswalk = z.infer<typeof legacyCrosswalkSchema>;
export type LegacyRecord = z.infer<typeof legacyRecordSchema>;
export type SchoolIdentifierManifest = z.infer<
  typeof schoolIdentifierManifestSchema
>;
export interface IdentifierSnapshot {
  readonly institutionIds: readonly string[];
  readonly sources: readonly IdentifierSource[];
  readonly mappings: readonly SchoolIdentifier[];
  readonly aliases: readonly IdentifierAlias[];
  readonly legacyCrosswalks: readonly LegacyCrosswalk[];
}
