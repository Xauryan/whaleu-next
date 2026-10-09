import { z } from 'zod';
import {
  searchQuerySchema,
  searchQueryParametersSchema,
} from '../contracts.js';
import { semanticSearchHitSchema } from '../response-schema.js';

export const semanticSearchQuerySchema = searchQuerySchema.refine(
  (query) => query.cursor === undefined,
);
export const semanticSearchQueryParametersSchema =
  searchQueryParametersSchema.omit({ cursor: true });
export const semanticSearchPageSchema = z
  .strictObject({
    mode: z.literal('semantic'),
    indexStatus: z.literal('current'),
    ranking: z.literal('embedding-top32-reranked'),
    items: z.array(semanticSearchHitSchema).max(10),
  })
  .refine(
    (page) =>
      new Set(page.items.map((hit) => `${hit.kind}:${hit.contentId}`)).size ===
      page.items.length,
  )
  .meta({ id: 'CommunitySemanticSearchPage' });
export type SemanticSearchPage = z.infer<typeof semanticSearchPageSchema>;
