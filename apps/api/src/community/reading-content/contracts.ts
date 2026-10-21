import { z } from 'zod';
import type { CommentView, PostView, ReplyView } from '../contracts.js';
import { hotPostViewSchema } from '../hot/response-schema.js';
import { textSourceReadV2Schema } from '../reading-formatting/reader.js';
import type { TextSourceReadV2 } from '../reading-formatting/reader.js';

/** This discriminator is server-owned. Missing/unknown evidence is an error,
 * not permission for a client to reinterpret text or retry a legacy reader. */
export type ReadingBody =
  | { classification: 'legacyPlain' }
  | { classification: 'reviewedSource'; value: TextSourceReadV2 };
export interface ReadingNode<T> {
  content: T;
  body: ReadingBody;
}
export interface ReadingCommentNode extends ReadingNode<CommentView> {
  replyPreviewBodies: { id: string; body: ReadingBody }[];
}
export type ReadingPostDetail = ReadingNode<PostView> & { version: 2 };
export type ReadingCommentDetail = ReadingCommentNode & { version: 2 };
export type ReadingReplyDetail = ReadingNode<ReplyView> & { version: 2 };
export interface ReadingPage<T> {
  version: 2;
  items: T[];
  nextCursor: string | null;
}
export interface ReadingContext {
  version: 2;
  comment: ReadingCommentNode;
  reply: ReadingNode<ReplyView> | null;
  replies: { items: ReadingNode<ReplyView>[]; nextCursor: null };
}
export const readingBodySchema = z.discriminatedUnion('classification', [
  z.strictObject({ classification: z.literal('legacyPlain') }),
  z.strictObject({
    classification: z.literal('reviewedSource'),
    value: textSourceReadV2Schema.refine(
      (value) => value.source.classification === 'reviewedSource',
      'Reviewed body requires canonical source evidence',
    ),
  }),
]);
// Exact legacy DTO projections. These schemas add no source keys to those DTOs.
export const readingPostContentSchema = hotPostViewSchema.safeExtend({
  allowAnonymousDm: z.boolean(),
  feedback: z
    .strictObject({
      authorSchool: z.string().nullable(),
      hasContacts: z.boolean(),
    })
    .optional(),
});
const count = z.number().int().nonnegative();
export const readingReplyContentSchema = z.strictObject({
  id: z.uuid(),
  postId: z.uuid(),
  rootCommentId: z.uuid(),
  target: z.union([
    z.strictObject({
      kind: z.enum(['comment', 'reply']),
      id: z.uuid(),
      status: z.literal('available'),
      author: hotPostViewSchema.shape.author,
    }),
    z.strictObject({ status: z.literal('unavailable') }),
  ]),
  text: z.string(),
  images: hotPostViewSchema.shape.images,
  author: hotPostViewSchema.shape.author,
  createdAt: z.string(),
  likeCount: count,
  viewer: z.strictObject({
    isSelf: z.boolean(),
    canDelete: z.boolean(),
    isLiked: z.boolean(),
  }),
});
export const readingCommentContentSchema = z.strictObject({
  id: z.uuid(),
  postId: z.uuid(),
  text: z.string(),
  images: hotPostViewSchema.shape.images,
  author: hotPostViewSchema.shape.author,
  createdAt: z.string(),
  likeCount: count,
  replyCount: count.nullable(),
  isPinned: z.boolean(),
  replyPreview: z.strictObject({
    items: z.array(readingReplyContentSchema),
    nextCursor: z.string().nullable(),
  }),
  viewer: z.strictObject({
    isSelf: z.boolean(),
    canDelete: z.boolean(),
    isLiked: z.boolean(),
    canPin: z.boolean(),
  }),
});
export function readingBodyMatches(
  body: ReadingBody,
  kind: 'post' | 'comment' | 'reply',
  content: {
    id: string;
    text: string;
    postId?: string;
    rootCommentId?: string;
  },
): boolean {
  if (body.classification === 'legacyPlain') return true;
  const source = body.value.source;
  return (
    source.classification === 'reviewedSource' &&
    source.kind === kind &&
    source.id === content.id &&
    source.text === content.text &&
    source.postId === (kind === 'post' ? content.id : content.postId) &&
    source.rootCommentId ===
      (kind === 'post'
        ? null
        : kind === 'comment'
          ? content.id
          : content.rootCommentId)
  );
}
const mismatch = {
  code: 'custom' as const,
  message: 'Source identity must match exact canonical content',
};
export const readingPostNodeSchema = z
  .strictObject({ content: readingPostContentSchema, body: readingBodySchema })
  .superRefine((node, ctx) => {
    if (!readingBodyMatches(node.body, 'post', node.content))
      ctx.addIssue(mismatch);
  });
export const readingReplyNodeSchema = z
  .strictObject({ content: readingReplyContentSchema, body: readingBodySchema })
  .superRefine((node, ctx) => {
    if (!readingBodyMatches(node.body, 'reply', node.content))
      ctx.addIssue(mismatch);
  });
export const readingCommentNodeSchema = z
  .strictObject({
    content: readingCommentContentSchema,
    body: readingBodySchema,
    replyPreviewBodies: z.array(
      z.strictObject({ id: z.uuid(), body: readingBodySchema }),
    ),
  })
  .superRefine((node, ctx) => {
    if (!readingBodyMatches(node.body, 'comment', node.content))
      ctx.addIssue(mismatch);
    const previews = node.content.replyPreview.items;
    if (
      node.replyPreviewBodies.length !== previews.length ||
      new Set(node.replyPreviewBodies.map((item) => item.id)).size !==
        previews.length ||
      new Set(previews.map((item) => item.id)).size !== previews.length ||
      previews.some((content) => {
        const item = node.replyPreviewBodies.find(
          (body) => body.id === content.id,
        );
        return (
          content.postId !== node.content.postId ||
          content.rootCommentId !== node.content.id ||
          !item ||
          !readingBodyMatches(item.body, 'reply', content)
        );
      })
    )
      ctx.addIssue(mismatch);
  });
export const readingPostDetailSchema = readingPostNodeSchema.safeExtend({
  version: z.literal(2),
});
export const readingCommentDetailSchema = readingCommentNodeSchema.safeExtend({
  version: z.literal(2),
});
export const readingReplyDetailSchema = readingReplyNodeSchema.safeExtend({
  version: z.literal(2),
});
export const readingCommentsPageSchema = z.strictObject({
  version: z.literal(2),
  items: z.array(readingCommentNodeSchema),
  nextCursor: z.string().nullable(),
});
export const readingRepliesPageSchema = z.strictObject({
  version: z.literal(2),
  items: z.array(readingReplyNodeSchema),
  nextCursor: z.string().nullable(),
});
export const readingContextSchema = z
  .strictObject({
    version: z.literal(2),
    comment: readingCommentNodeSchema,
    reply: readingReplyNodeSchema.nullable(),
    replies: z.strictObject({
      items: z.array(readingReplyNodeSchema),
      nextCursor: z.null(),
    }),
  })
  .superRefine((value, ctx) => {
    for (const item of [
      ...value.replies.items,
      ...(value.reply ? [value.reply] : []),
    ])
      if (
        item.content.postId !== value.comment.content.postId ||
        item.content.rootCommentId !== value.comment.content.id
      )
        ctx.addIssue(mismatch);
  });
