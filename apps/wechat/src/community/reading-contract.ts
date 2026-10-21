import { findContentReferences } from '../content-references/text';
/** Feature-only versioned reader. The legacy DTO decoder remains exact and unchanged. */
import {
  exact,
  invalid,
  cursor,
  decodePost,
  decodeComment,
  type Post,
  type Comment,
} from './contract';
import { decodeReply, type Reply } from './discussion-contract';
import {
  decodeSourcePresentation,
  type SourcePresentation,
} from './text-source-read-contract';
import type { SourceKind } from './text-source-contract';
export type ReadingBody =
  | Readonly<{ classification: 'legacyPlain' }>
  | Readonly<{ classification: 'reviewedSource'; value: SourcePresentation }>;
export type ReadingPost = Post & {
  readonly readingBody?: ReadingBody;
  readonly readingUseReferences?: boolean;
};
export type ReadingReply = Reply & {
  readonly readingBody?: ReadingBody;
  readonly readingUseReferences?: boolean;
};
export type ReadingComment = Omit<Comment, 'replyPreview'> & {
  readonly readingBody?: ReadingBody;
  readonly readingUseReferences?: boolean;
  readonly replyPreview: {
    readonly items: readonly ReadingReply[];
    readonly nextCursor: string | null;
  };
};
export interface ReadingComments {
  readonly items: readonly ReadingComment[];
  readonly nextCursor: string | null;
}
export interface ReadingReplies {
  readonly items: readonly ReadingReply[];
  readonly nextCursor: string | null;
}
export interface ReadingContext {
  readonly comment: ReadingComment;
  readonly reply: ReadingReply | null;
  readonly replies: ReadingReplies;
}
function body(
  raw: unknown,
  kind: SourceKind,
  content: {
    id: string;
    text: string;
    postId?: string;
    rootCommentId?: string;
    images: readonly unknown[];
  },
): ReadingBody {
  if (typeof raw !== 'object' || raw === null) invalid();
  const value = raw as Record<string, unknown>;
  if (value.classification === 'legacyPlain') {
    exact(value, ['classification']);
    return Object.freeze({ classification: 'legacyPlain' });
  }
  exact(value, ['classification', 'value']);
  if (value.classification !== 'reviewedSource') invalid();
  const presentation = decodeSourcePresentation(value.value),
    source = presentation.source;
  if (
    source.classification !== 'reviewedSource' ||
    source.kind !== kind ||
    source.id !== content.id ||
    source.text !== content.text ||
    source.postId !== (kind === 'post' ? content.id : content.postId) ||
    source.rootCommentId !==
      (kind === 'post'
        ? null
        : kind === 'comment'
          ? content.id
          : content.rootCommentId) ||
    content.images.length !== 0
  )
    invalid();
  return Object.freeze({
    classification: 'reviewedSource',
    value: presentation,
  });
}
function sourcePresentationFields(readingBody: ReadingBody) {
  return {
    readingBody,
    // Existing current-capability reference UI owns actions; do not tokenize
    // formatted slices or interpret Markdown as native reference syntax.
    readingUseReferences:
      readingBody.classification === 'reviewedSource' &&
      readingBody.value.source.classification === 'reviewedSource' &&
      readingBody.value.source.textSource.format === 'plain' &&
      findContentReferences(readingBody.value.source.text).length > 0,
  };
}
function postNode(raw: unknown, detail = false): ReadingPost {
  exact(raw, ['content', 'body', ...(detail ? ['version'] : [])]);
  if (detail && raw.version !== 2) invalid();
  const content = decodePost(raw.content);
  return Object.freeze({
    ...content,
    ...sourcePresentationFields(body(raw.body, 'post', content)),
  });
}
function replyNode(raw: unknown, detail = false): ReadingReply {
  exact(raw, ['content', 'body', ...(detail ? ['version'] : [])]);
  if (detail && raw.version !== 2) invalid();
  const content = decodeReply(raw.content);
  return Object.freeze({
    ...content,
    ...sourcePresentationFields(body(raw.body, 'reply', content)),
  });
}
function commentNode(raw: unknown, detail = false): ReadingComment {
  exact(raw, [
    'content',
    'body',
    'replyPreviewBodies',
    ...(detail ? ['version'] : []),
  ]);
  if (detail && raw.version !== 2) invalid();
  const content = decodeComment(raw.content),
    previews = raw.replyPreviewBodies;
  if (
    !Array.isArray(previews) ||
    previews.length !== content.replyPreview.items.length
  )
    invalid();
  const byId = new Map<string, unknown>();
  for (const entry of previews) {
    exact(entry, ['id', 'body']);
    if (typeof entry.id !== 'string' || byId.has(entry.id)) invalid();
    byId.set(entry.id, entry.body);
  }
  const items = content.replyPreview.items.map((reply) => {
    if (
      !byId.has(reply.id) ||
      reply.postId !== content.postId ||
      reply.rootCommentId !== content.id
    )
      invalid();
    return Object.freeze({
      ...reply,
      ...sourcePresentationFields(body(byId.get(reply.id), 'reply', reply)),
    });
  });
  return Object.freeze({
    ...content,
    ...sourcePresentationFields(body(raw.body, 'comment', content)),
    replyPreview: Object.freeze({
      ...content.replyPreview,
      items: Object.freeze(items),
    }),
  });
}
export const decodeReadingPost = (raw: unknown): ReadingPost =>
  postNode(raw, true);
export const decodeReadingComment = (raw: unknown): ReadingComment =>
  commentNode(raw, true);
export const decodeReadingReply = (raw: unknown): ReadingReply =>
  replyNode(raw, true);
function page<T extends { id: string }>(
  raw: unknown,
  maximum: number,
  decode: (raw: unknown) => T,
): { readonly items: readonly T[]; readonly nextCursor: string | null } {
  exact(raw, ['version', 'items', 'nextCursor']);
  if (
    raw.version !== 2 ||
    !Array.isArray(raw.items) ||
    raw.items.length > maximum ||
    !cursor(raw.nextCursor)
  )
    invalid();
  const items = raw.items.map(decode);
  if (new Set(items.map((item) => item.id)).size !== items.length) invalid();
  return Object.freeze({
    items: Object.freeze(items),
    nextCursor: raw.nextCursor,
  });
}
export const decodeReadingComments = (raw: unknown): ReadingComments =>
  page(raw, 10, (value) => commentNode(value));
export const decodeReadingReplies = (raw: unknown): ReadingReplies =>
  page(raw, 50, (value) => replyNode(value));
export function decodeReadingContext(raw: unknown): ReadingContext {
  exact(raw, ['version', 'comment', 'reply', 'replies']);
  if (raw.version !== 2) invalid();
  exact(raw.replies, ['items', 'nextCursor']);
  if (raw.replies.nextCursor !== null) invalid();
  const comment = commentNode(raw.comment),
    reply = raw.reply === null ? null : replyNode(raw.reply),
    replies = page({ version: 2, ...raw.replies }, 50, (value) =>
      replyNode(value),
    );
  if (
    [...replies.items, ...(reply ? [reply] : [])].some(
      (item) =>
        item.postId !== comment.postId || item.rootCommentId !== comment.id,
    )
  )
    invalid();
  return Object.freeze({ comment, reply, replies });
}
