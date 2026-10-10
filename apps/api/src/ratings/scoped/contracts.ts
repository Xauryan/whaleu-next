import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ratingCanonicalText,
  ratingTimeSchema,
  ratingRejectionSchema,
} from '../contracts.js';
import { ratingScopedOperations } from './protocol-registry.js';
export const scopedId = z
  .uuid()
  .refine((value) => value === value.toLowerCase());
export const scopedDigest = z.string().regex(/^[a-f0-9]{64}$/);
export const scopedToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const ratingNavigationSelectorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('global') }),
  z.strictObject({ kind: z.literal('campus'), campusId: scopedId }),
]);
export const ratingRandomCandidateSelectorSchema = z.discriminatedUnion(
  'kind',
  [
    z.strictObject({ kind: z.literal('global') }),
    z.strictObject({
      kind: z.literal('institution_with_global'),
      anchorCampusId: scopedId,
    }),
  ],
);
export type RatingNavigationSelector = z.infer<
  typeof ratingNavigationSelectorSchema
>;
export type RatingRandomCandidateSelector = z.infer<
  typeof ratingRandomCandidateSelectorSchema
>;
export function ratingScopedScopeKey(
  selector: RatingNavigationSelector,
): string {
  return selector.kind === 'global' ? 'global' : `campus:${selector.campusId}`;
}
export const ratingScopedContextRequestSchema = z.discriminatedUnion(
  'purpose',
  [
    z.strictObject({
      purpose: z.literal('read'),
      selector: ratingNavigationSelectorSchema,
      mode: z.enum(['public', 'admin_preview']),
    }),
    z.strictObject({
      purpose: z.literal('interact'),
      selector: ratingNavigationSelectorSchema,
      mode: z.literal('public'),
    }),
    z.strictObject({
      purpose: z.literal('create_target'),
      selector: ratingNavigationSelectorSchema,
      mode: z.literal('public'),
    }),
    z.strictObject({
      purpose: z.literal('edit_target'),
      selector: ratingNavigationSelectorSchema,
      mode: z.literal('public'),
    }),
    z.strictObject({
      purpose: z.literal('random'),
      selector: ratingRandomCandidateSelectorSchema,
      mode: z.literal('public'),
    }),
  ],
);
export type RatingScopedContextRequest = z.infer<
  typeof ratingScopedContextRequestSchema
>;
export const ratingScopedHeadSchema = z.strictObject({
  scopeKey: z
    .string()
    .refine((v) => v === 'global' || /^campus:[0-9a-f-]{36}$/.test(v)),
  catalogRevision: scopedId,
  headRevision: scopedId,
});
export const ratingScopedContextSchema = z
  .strictObject({
    protocolVersion: z.literal(2),
    id: scopedId,
    token: scopedToken,
    tokenDigest: scopedDigest,
    actorId: scopedId,
    sessionGeneration: scopedDigest,
    selector: z.union([
      ratingNavigationSelectorSchema,
      ratingRandomCandidateSelectorSchema,
    ]),
    purpose: z.enum([
      'read',
      'interact',
      'create_target',
      'edit_target',
      'random',
    ]),
    mode: z.enum(['public', 'admin_preview']),
    scopeRevision: scopedDigest,
    protocolGeneration: scopedId,
    heads: z.array(ratingScopedHeadSchema).min(1).max(1001),
    sourceDigest: scopedDigest,
    identityCampusId: scopedId.nullable(),
    issuedAt: ratingTimeSchema,
    expiresAt: ratingTimeSchema,
    capabilities: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(32),
  })
  .superRefine((v, c) => {
    if (
      createHash('sha256').update(v.token).digest('hex') !== v.tokenDigest ||
      Date.parse(v.expiresAt) <= Date.parse(v.issuedAt) ||
      Date.parse(v.expiresAt) - Date.parse(v.issuedAt) > 300000 ||
      !ratingScopedContextRequestSchema.safeParse({
        selector: v.selector,
        purpose: v.purpose,
        mode: v.mode,
      }).success ||
      new Set(v.heads.map((h) => h.scopeKey)).size !== v.heads.length
    )
      c.addIssue({ code: 'custom', message: 'Invalid exact scoped context' });
  });
export type RatingScopedContext = z.infer<typeof ratingScopedContextSchema>;
export const ratingScopedCommandContextSchema = z
  .strictObject({
    id: scopedId,
    tokenDigest: scopedDigest,
    token: scopedToken,
    selector: ratingNavigationSelectorSchema,
    scopeRevision: scopedDigest,
    protocolGeneration: scopedId,
    catalogRevision: scopedId,
    headRevision: scopedId,
    sourceDigest: scopedDigest,
  })
  .refine(
    (v) => createHash('sha256').update(v.token).digest('hex') === v.tokenDigest,
  );
const category = {
  clientRequestId: scopedId,
  categoryId: scopedId,
  expectedCategoryRevision: scopedId,
};
const target = {
  ...category,
  targetId: scopedId,
  expectedTargetRevision: scopedId,
};
const body = {
  authorMode: z.enum(['named', 'anonymous']),
  body: ratingCanonicalText(500),
  assetIds: z.tuple([]),
};
const definition = {
  ...category,
  name: ratingCanonicalText(100),
  description: ratingCanonicalText(500, false),
  assetIds: z.tuple([]),
};
const like = {
  ...target,
  rootId: scopedId,
  expectedRevision: scopedId,
  expectedLikeRevision: scopedId,
  liked: z.boolean(),
};
const base = {
  protocolVersion: z.literal(2),
  context: ratingScopedCommandContextSchema,
};
export const ratingScopedIntentSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    ...base,
    operation: z.literal('set_score_scoped'),
    payload: z.strictObject({
      ...target,
      expectedRevision: scopedId.nullable(),
      score: z.number().int().min(1).max(5),
    }),
  }),
  z.strictObject({
    ...base,
    operation: z.literal('create_comment_scoped'),
    payload: z.strictObject({ ...target, ...body }),
  }),
  z.strictObject({
    ...base,
    operation: z.literal('create_reply_scoped'),
    payload: z.strictObject({
      ...target,
      ...body,
      rootId: scopedId,
      expectedRootRevision: scopedId,
      replyTo: z
        .strictObject({ replyId: scopedId, expectedRevision: scopedId })
        .nullable(),
    }),
  }),
  z.strictObject({
    ...base,
    operation: z.literal('set_comment_like_scoped'),
    payload: z.strictObject(like),
  }),
  z.strictObject({
    ...base,
    operation: z.literal('set_reply_like_scoped'),
    payload: z.strictObject({
      ...like,
      replyId: scopedId,
      expectedRootRevision: scopedId,
    }),
  }),
  z.strictObject({
    ...base,
    operation: z.literal('set_target_subscription_scoped'),
    payload: z.strictObject({
      ...target,
      expectedSubscriptionRevision: scopedId,
      subscribed: z.boolean(),
    }),
  }),
  z.strictObject({
    ...base,
    operation: z.literal('create_target_scoped'),
    payload: z.strictObject(definition),
  }),
  z.strictObject({
    ...base,
    operation: z.literal('edit_target_scoped'),
    payload: z.strictObject({
      ...definition,
      ...target,
      expectedDefinitionRevision: scopedId,
      expectedContentVersion: z.number().int().min(1).max(2147483646),
    }),
  }),
]);
export type RatingScopedIntent = z.infer<typeof ratingScopedIntentSchema>;
export const ratingScopedClosureSchema = z.union([
  ratingRejectionSchema,
  z.enum([
    'RATING_SCOPED_CONTEXT_CHANGED',
    'RATING_CREATION_CANCELLED',
    'RATING_EDIT_CANCELLED',
  ]),
]);
const result = {
  targetId: scopedId,
  revision: scopedId,
  occurredAt: ratingTimeSchema,
};
const resultSchemas = {
  set_score_scoped: z.strictObject({ ...result, subjectId: scopedId }),
  create_comment_scoped: z.strictObject({ ...result, subjectId: scopedId }),
  create_reply_scoped: z.strictObject({
    ...result,
    rootId: scopedId,
    replyId: scopedId,
  }),
  set_comment_like_scoped: z.strictObject({
    ...result,
    rootId: scopedId,
    replyId: z.null(),
    liked: z.boolean(),
  }),
  set_reply_like_scoped: z.strictObject({
    ...result,
    rootId: scopedId,
    replyId: scopedId,
    liked: z.boolean(),
  }),
  set_target_subscription_scoped: z.strictObject({
    ...result,
    subscribed: z.boolean(),
  }),
  create_target_scoped: z.strictObject({
    ...result,
    catalogRevision: scopedId,
  }),
  edit_target_scoped: z.strictObject({
    ...result,
    definitionRevision: scopedId,
    contentVersion: z.number().int().min(1).max(2147483647),
  }),
};
export const ratingScopedReceiptSchema = z.union([
  z.strictObject({
    protocolVersion: z.literal(2),
    requestId: scopedId,
    operation: z.enum(ratingScopedOperations),
    intentHash: scopedDigest,
    outcome: z.literal('closed'),
    code: ratingScopedClosureSchema,
  }),
  z
    .strictObject({
      protocolVersion: z.literal(2),
      requestId: scopedId,
      operation: z.enum(ratingScopedOperations),
      intentHash: scopedDigest,
      outcome: z.enum(['applied', 'noop']),
      result: z.unknown(),
    })
    .superRefine((v, c) => {
      if (!resultSchemas[v.operation].safeParse(v.result).success)
        c.addIssue({
          code: 'custom',
          message: 'Exact operation result required',
        });
    }),
]);
export type RatingScopedReceipt = z.infer<typeof ratingScopedReceiptSchema>;
export const ratingScopedPreparationSchema = z.strictObject({
  intent: ratingScopedIntentSchema,
  contextRevision: scopedToken,
  targetId: scopedId,
  targetRevision: scopedId,
  definitionRevision: scopedId,
  contentVersion: z.number().int().min(1).max(2147483647),
  validUntil: ratingTimeSchema,
});
export const ratingScopedLocatorSchema = z
  .strictObject({
    selector: ratingNavigationSelectorSchema,
    targetId: scopedId,
    rootId: scopedId.nullable(),
    replyId: scopedId.nullable(),
    protocolGeneration: scopedId,
  })
  .refine((v) => v.replyId === null || v.rootId !== null);
export const ratingScopedReadQuerySchema = z.strictObject({
  contextId: scopedId,
  contextToken: scopedToken,
});
export const ratingScopedPageQuerySchema = ratingScopedReadQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: scopedToken.optional(),
});
export const ratingScopedCategoryQuerySchema =
  ratingScopedPageQuerySchema.extend({ parentId: scopedId.optional() });
export const ratingScopedTargetQuerySchema = ratingScopedPageQuerySchema.extend(
  { categoryId: scopedId },
);
export const ratingScopedCommentQuerySchema =
  ratingScopedPageQuerySchema.extend({
    sort: z.enum(['time', 'likes']).optional(),
    order: z.enum(['asc', 'desc']).optional(),
  });
