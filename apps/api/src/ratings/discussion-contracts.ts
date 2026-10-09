import { z } from 'zod';
import {
  ratingPublicIdSchema as id,
  ratingIdSchema,
  ratingText,
  ratingAuthorSchema,
  ratingCommentSchema,
  ratingTimeSchema,
  ratingCursorSchema,
  ratingRejectionSchema,
  ratingCommentQuerySchema,
} from './contracts.js';
export const ratingReplyQuerySchema = ratingCommentQuerySchema.omit({
  sort: true,
  order: true,
});
export const ratingReplyPositionQuerySchema = ratingReplyQuerySchema.omit({
  cursor: true,
});
export const createRatingReplySchema = z.strictObject({
  clientRequestId: ratingIdSchema,
  regionId: id.nullable(),
  targetId: id,
  expectedTargetRevision: id,
  expectedRootRevision: id,
  replyTo: z.strictObject({ replyId: id, expectedRevision: id }).nullable(),
  authorMode: z.enum(['named', 'anonymous']),
  body: ratingText(500),
  assetIds: z.tuple([]),
});
export const deleteRatingReplySchema = z.strictObject({
  clientRequestId: ratingIdSchema,
  regionId: id.nullable(),
  targetId: id,
  rootId: id,
  expectedTargetRevision: id,
  expectedRootRevision: id,
  expectedRevision: id,
});
const context = z.strictObject({
  regionId: id.nullable(),
  catalogRevision: id,
  targetId: id,
  rootId: id,
});
export const ratingDiscussionSchema = z
  .strictObject({
    context,
    root: ratingCommentSchema,
    allowedActions: z.strictObject({
      createReply: z.boolean(),
      authorModes: z
        .array(z.enum(['named', 'anonymous']))
        .min(1)
        .max(2)
        .refine((m) => m[0] === 'named' && new Set(m).size === m.length),
    }),
  })
  .refine(
    (x) =>
      x.root.id === x.context.rootId && x.root.targetId === x.context.targetId,
  );
const outputBody = z.string().refine((s) => {
  const p = ratingText(500).safeParse(s);
  return p.success && p.data === s;
});
export const ratingReplySchema = z
  .strictObject({
    id,
    targetId: id,
    rootId: id,
    revision: id,
    createdAt: ratingTimeSchema,
    body: outputBody,
    author: ratingAuthorSchema,
    isMine: z.boolean(),
    allowedActions: z.strictObject({ reply: z.boolean(), delete: z.boolean() }),
    replyTo: z.union([
      z.strictObject({ kind: z.literal('root') }),
      z.strictObject({
        kind: z.literal('reply'),
        status: z.literal('available'),
        replyId: id,
        revision: id,
        author: ratingAuthorSchema,
      }),
      z.strictObject({
        kind: z.literal('reply'),
        status: z.literal('unavailable'),
      }),
    ]),
  })
  .refine(
    (x) =>
      (!x.allowedActions.delete || x.isMine) &&
      (x.author.mode !== 'anonymous' || x.author.targetId === x.targetId) &&
      (x.replyTo.kind !== 'reply' ||
        x.replyTo.status !== 'available' ||
        (x.replyTo.replyId !== x.id &&
          (x.replyTo.author.mode !== 'anonymous' ||
            x.replyTo.author.targetId === x.targetId))),
  );
export const ratingReplyPageContextSchema = context.extend({
  order: z.literal('oldest'),
});
export const ratingReplyPageSchema = z
  .strictObject({
    context: ratingReplyPageContextSchema,
    items: z.array(ratingReplySchema).max(50),
    nextCursor: ratingCursorSchema.nullable(),
    continuation: z.enum(['more', 'scan', 'end']),
  })
  .refine(
    (p) =>
      (p.nextCursor === null) === (p.continuation === 'end') &&
      new Set(p.items.map((i) => i.id)).size === p.items.length &&
      p.items.every(
        (i) =>
          i.targetId === p.context.targetId && i.rootId === p.context.rootId,
      ),
  );
export const ratingReplyPositionSchema = z
  .strictObject({
    context: ratingReplyPageContextSchema,
    anchorReplyId: id,
    page: ratingReplyPageSchema,
  })
  .refine(
    (p) =>
      JSON.stringify(p.context) === JSON.stringify(p.page.context) &&
      p.page.items[0]?.id === p.anchorReplyId,
  );
export const ratingReplyOperationSchema = z.enum([
  'create_reply',
  'delete_reply',
]);
export const ratingReplyReceiptSchema = z.discriminatedUnion('outcome', [
  z
    .strictObject({
      requestId: id,
      operation: ratingReplyOperationSchema,
      outcome: z.enum(['applied', 'noop']),
      targetId: id,
      rootId: id,
      replyId: id,
      revision: id,
      occurredAt: ratingTimeSchema,
    })
    .refine((r) => r.operation !== 'create_reply' || r.outcome !== 'noop'),
  z.strictObject({
    requestId: id,
    operation: ratingReplyOperationSchema,
    outcome: z.literal('rejected'),
    code: ratingRejectionSchema,
  }),
]);
export type CreateRatingReply = z.infer<typeof createRatingReplySchema>;
export type DeleteRatingReply = z.infer<typeof deleteRatingReplySchema>;
export type RatingReply = z.infer<typeof ratingReplySchema>;
export type RatingReplyQuery = z.infer<typeof ratingReplyQuerySchema>;
export type RatingReplyReceipt = z.infer<typeof ratingReplyReceiptSchema>;
export type RatingReplyOperation = z.infer<typeof ratingReplyOperationSchema>;
