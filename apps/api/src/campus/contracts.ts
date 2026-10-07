import { z } from 'zod';

const pageNumber = (maximum: number, fallback: string) =>
  z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .default(fallback)
    .transform(Number)
    .pipe(z.number().int().min(1).max(maximum));
const searchableText = z
  .string()
  .trim()
  .max(100)
  .refine((value) =>
    [...value].every((character) => {
      const code = character.codePointAt(0)!;
      return code >= 32 && code !== 127 && !(code >= 0xd800 && code <= 0xdfff);
    }),
  );
export const campusQuerySchema = z.strictObject({
  q: searchableText.optional(),
  district: searchableText.refine((value) => value.length > 0).optional(),
  page: pageNumber(10000, '1'),
  pageSize: pageNumber(100, '20'),
});
export type CampusQuery = z.infer<typeof campusQuerySchema>;
export interface Campus {
  readonly id: string;
  readonly institutionId: string;
  readonly institutionName: string;
  readonly fullName: string;
  readonly shortName: string | null;
  readonly district: string;
  readonly isActive: boolean;
}
export interface CampusPage {
  readonly items: Campus[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}
