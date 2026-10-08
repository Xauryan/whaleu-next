import { z } from 'zod';
import { categorySchema } from '../contracts.js';
import type { PostView } from '../contracts.js';
import { textSchema } from '../text.js';
import { tradingSubtypeSchema } from '../trading/contracts.js';

// Validate controls before trimming: an invalid leading/trailing control must
// not disappear into a valid query. The bound applies to canonical codepoints.
export const searchTextSchema = textSchema(Number.MAX_SAFE_INTEGER)
  .transform((value) => value.trim())
  .refine((value) => [...value].length >= 1 && [...value].length <= 200);
const searchFields = {
  q: searchTextSchema,
  category: categorySchema.optional(),
  tradingSubtype: tradingSubtypeSchema.optional(),
  limit: z
    .string()
    .regex(/^(?:[1-9]|10)$/)
    .default('10')
    .transform(Number),
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .refine(
      (value) =>
        Buffer.from(value, 'base64url').toString('base64url') === value,
    )
    .optional(),
};
export const searchSelectorSchema = z.enum(['all', 'regional', 'global']);
export type SearchSelector = z.infer<typeof searchSelectorSchema>;
export const searchQuerySchema = z
  .union([
    z.strictObject({ spaceId: z.uuid(), ...searchFields }),
    z
      .strictObject({ scope: searchSelectorSchema, ...searchFields })
      .refine(
        (query) =>
          query.scope === 'regional' ||
          (query.category === undefined && query.tradingSubtype === undefined),
      ),
  ])
  .refine((query) => !query.tradingSubtype || query.category === 'trading');
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type SearchContinuation =
  | 'more'
  | 'scan_pending'
  | 'end'
  | 'login_required'
  | 'phone_verification_required';
export interface SearchPage {
  items: PostView[];
  nextCursor: string | null;
  continuation: SearchContinuation;
}
