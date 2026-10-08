import { z } from 'zod';
import { categorySchema } from '../contracts.js';
import type { AuthorView, Category, CommunitySpace } from '../contracts.js';
import type { TradingSubtype } from '../trading/contracts.js';
import { textSchema } from '../text.js';
import { tradingSubtypeSchema } from '../trading/contracts.js';

// Validate controls before trimming: an invalid leading/trailing control must
// not disappear into a valid query. The bound applies to canonical codepoints.
export const searchTextSchema = textSchema(Number.MAX_SAFE_INTEGER)
  .transform((value) => value.trim())
  .refine((value) => [...value].length >= 1 && [...value].length <= 200);
export const searchKindSchema = z.enum(['post', 'comment', 'reply']);
export type SearchKind = z.infer<typeof searchKindSchema>;
export const searchTypeSchema = z.enum(['all', 'post', 'comment', 'reply']);
// UTC-only, microsecond-precision boundaries. Canonical strings preserve exact
// ordering without rounding through JavaScript Date's millisecond precision.
export const searchTimeSchema = z.iso
  .datetime()
  .refine(
    (value) =>
      !value.startsWith('0000-') &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value),
  )
  .transform((value) => {
    const [seconds, fraction = ''] = value.slice(0, -1).split('.');
    return `${seconds}.${fraction.padEnd(6, '0')}Z`;
  });
const searchFields = {
  type: searchTypeSchema.default('all'),
  from: searchTimeSchema.optional(),
  to: searchTimeSchema.optional(),
  postId: z
    .uuid()
    .transform((value) => value.toLowerCase())
    .optional(),
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
// OpenAPI serializes query parameters individually, so document the actual
// owner fields here; cross-parameter exclusivity remains the strict union below.
export const searchQueryParametersSchema = z.strictObject({
  spaceId: z.uuid().optional(),
  scope: searchSelectorSchema.optional(),
  ...searchFields,
});
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
  .refine((query) => !query.tradingSubtype || query.category === 'trading')
  .refine((query) => !query.from || !query.to || query.from < query.to);
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type SearchContinuation =
  | 'more'
  | 'scan_pending'
  | 'end'
  | 'login_required'
  | 'phone_verification_required';
export interface SearchSnippet {
  segments: { text: string; matched: boolean }[];
  truncatedBefore: boolean;
  truncatedAfter: boolean;
}
export type SearchTarget =
  | { kind: 'post'; postId: string }
  | { kind: 'comment'; postId: string; rootCommentId: string }
  | { kind: 'reply'; postId: string; rootCommentId: string; replyId: string };
interface SearchHitBase {
  contentId: string;
  postId: string;
  space: { id: string; kind: CommunitySpace['kind']; name: string };
  category: Category;
  tradingSubtype: TradingSubtype | null;
  tradingUrgency: 'normal' | 'urgent' | null;
  createdAt: string;
  author: AuthorView;
  postSummary: string;
  snippet: SearchSnippet;
}
export type SearchHit = SearchHitBase &
  (
    | {
        kind: 'post';
        rootCommentId: null;
        replyId: null;
        target: Extract<SearchTarget, { kind: 'post' }>;
      }
    | {
        kind: 'comment';
        rootCommentId: string;
        replyId: null;
        target: Extract<SearchTarget, { kind: 'comment' }>;
      }
    | {
        kind: 'reply';
        rootCommentId: string;
        replyId: string;
        target: Extract<SearchTarget, { kind: 'reply' }>;
      }
  );
export interface SearchPage {
  items: SearchHit[];
  effectiveTypes: SearchKind[];
  nextCursor: string | null;
  continuation: SearchContinuation;
}
