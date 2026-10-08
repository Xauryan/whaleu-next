import { z } from 'zod';
import { categorySchema } from '../contracts.js';
import { hotPostViewSchema } from '../hot/response-schema.js';
import { tradingSubtypeSchema } from '../trading/contracts.js';
import { searchKindSchema } from './contracts.js';
import {
  SEARCH_SNIPPET_CODEPOINTS,
  SEARCH_SUMMARY_CODEPOINTS,
} from './snippet.js';

const uuid = z.uuid();
const publicAuthor = hotPostViewSchema.shape.author;
const searchAuthor = z.union([
  publicAuthor.options[0].extend({ avatar: z.null() }),
  publicAuthor.options[1].extend({ avatar: z.null() }),
]);
const boundedText = (maximum: number) =>
  z
    .string()
    .max(maximum * 2)
    .refine((value) => [...value].length <= maximum);
const base = {
  contentId: uuid,
  postId: uuid,
  space: z.strictObject({
    id: uuid,
    kind: z.enum(['regional', 'global']),
    name: z.string(),
  }),
  category: categorySchema,
  tradingSubtype: tradingSubtypeSchema.nullable(),
  tradingUrgency: z.enum(['normal', 'urgent']).nullable(),
  createdAt: z.iso.datetime({ precision: 6 }),
  // Public AuthorView is shared with the existing projection contract. Search
  // invokes only its author/persona owner, never the full post projection.
  author: searchAuthor,
  postSummary: boundedText(SEARCH_SUMMARY_CODEPOINTS),
  snippet: z
    .strictObject({
      segments: z
        .array(
          z.strictObject({
            text: boundedText(SEARCH_SNIPPET_CODEPOINTS).refine(
              (value) => value.length > 0,
            ),
            matched: z.boolean(),
          }),
        )
        .min(1)
        .max(SEARCH_SNIPPET_CODEPOINTS),
      truncatedBefore: z.boolean(),
      truncatedAfter: z.boolean(),
    })
    .refine(
      (snippet) =>
        snippet.segments.some((s) => s.matched) &&
        snippet.segments.reduce(
          (n, segment) => n + [...segment.text].length,
          0,
        ) <= SEARCH_SNIPPET_CODEPOINTS,
    ),
};
export const searchHitSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      ...base,
      kind: z.literal('post'),
      rootCommentId: z.null(),
      replyId: z.null(),
      target: z.strictObject({ kind: z.literal('post'), postId: uuid }),
    }),
    z.strictObject({
      ...base,
      kind: z.literal('comment'),
      rootCommentId: uuid,
      replyId: z.null(),
      target: z.strictObject({
        kind: z.literal('comment'),
        postId: uuid,
        rootCommentId: uuid,
      }),
    }),
    z.strictObject({
      ...base,
      kind: z.literal('reply'),
      rootCommentId: uuid,
      replyId: uuid,
      target: z.strictObject({
        kind: z.literal('reply'),
        postId: uuid,
        rootCommentId: uuid,
        replyId: uuid,
      }),
    }),
  ])
  .refine(
    (hit) =>
      hit.target.postId === hit.postId &&
      (hit.kind === 'post'
        ? hit.contentId === hit.postId
        : hit.target.rootCommentId === hit.rootCommentId &&
          (hit.kind === 'comment'
            ? hit.contentId === hit.rootCommentId
            : hit.contentId === hit.replyId &&
              hit.target.replyId === hit.replyId)) &&
      (hit.category === 'trading'
        ? hit.tradingSubtype !== null && hit.tradingUrgency !== null
        : hit.tradingSubtype === null && hit.tradingUrgency === null),
  )
  .meta({ id: 'CommunitySearchHit' });
export const searchPageSchema = z
  .strictObject({
    items: z.array(searchHitSchema).max(10),
    effectiveTypes: z.array(searchKindSchema).min(1).max(3),
    nextCursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .nullable(),
    continuation: z.enum([
      'more',
      'scan_pending',
      'end',
      'login_required',
      'phone_verification_required',
    ]),
  })
  .refine(
    (page) =>
      new Set(page.effectiveTypes).size === page.effectiveTypes.length &&
      new Set(page.items.map((item) => `${item.kind}:${item.contentId}`))
        .size === page.items.length &&
      page.items.every((item) => page.effectiveTypes.includes(item.kind)) &&
      (page.nextCursor !== null) ===
        (page.continuation === 'more' || page.continuation === 'scan_pending'),
  )
  .meta({ id: 'CommunitySearchPage' });
