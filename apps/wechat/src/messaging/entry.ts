import type { CommunityRuntime } from '../community/runtime';
import type { Comment, Post } from '../community/contract';
import type { Reply } from '../community/discussion-contract';
import type { WxApi } from '../platform/wechat';
import { decodeEntry, id, type Entry, type Mode } from './contract';
import type { DetailRoute } from './detail-controller';
import type { MessagingRuntime } from './runtime';
export const messagingRuntime = (
  runtime: CommunityRuntime | undefined,
): MessagingRuntime | undefined =>
  (
    runtime as
      (CommunityRuntime & { readonly messaging?: MessagingRuntime }) | undefined
  )?.messaging;
export function entryPath(entry: Entry, initiationMode: Mode): string {
  const checked = decodeEntry(entry);
  return (
    '/pages/private-message-detail/private-message-detail?' +
    Object.entries({ ...checked, initiationMode })
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('&')
  );
}
export function readDetailRoute(
  query: Record<string, string | undefined>,
): DetailRoute | null {
  try {
    if (query.conversationId)
      return id(query.conversationId)
        ? { conversationId: query.conversationId }
        : null;
    const initiationMode = query.initiationMode;
    if (initiationMode !== 'named' && initiationMode !== 'anonymous')
      return null;
    const entry =
      query.kind === 'profile'
        ? decodeEntry({ kind: 'profile', profileId: query.profileId })
        : query.kind === 'post'
          ? decodeEntry({ kind: 'post', postId: query.postId })
          : query.kind === 'comment'
            ? decodeEntry({
                kind: 'comment',
                postId: query.postId,
                commentId: query.commentId,
              })
            : decodeEntry({
                kind: 'reply',
                postId: query.postId,
                rootCommentId: query.rootCommentId,
                replyId: query.replyId,
              });
    return { entry, initiationMode };
  } catch {
    return null;
  }
}
/** Exact canonical source objects, never a display name, overlay ID, index or anonymous profile link. */
export function postEntry(
  post: Post,
  anonymousToNamed = false,
): { entry: Entry; mode: Mode } | null {
  if (post.viewer.isSelf) return null;
  if (
    anonymousToNamed &&
    (post.author.kind !== 'named' ||
      !(post as Post & { allowAnonymousDm?: boolean }).allowAnonymousDm)
  )
    return null;
  return {
    entry: { kind: 'post', postId: post.id },
    mode:
      post.author.kind === 'anonymous' || anonymousToNamed
        ? 'anonymous'
        : 'named',
  };
}
export function commentEntry(
  postId: string,
  comment: Comment,
): { entry: Entry; mode: Mode } | null {
  if (comment.viewer.isSelf || comment.postId !== postId) return null;
  return {
    entry: { kind: 'comment', postId, commentId: comment.id },
    mode: comment.author.kind,
  };
}
export function replyEntry(
  postId: string,
  rootCommentId: string,
  reply: Reply,
): { entry: Entry; mode: Mode } | null {
  if (
    reply.viewer.isSelf ||
    reply.postId !== postId ||
    reply.rootCommentId !== rootCommentId
  )
    return null;
  return {
    entry: { kind: 'reply', postId, rootCommentId, replyId: reply.id },
    mode: reply.author.kind,
  };
}
export class MessagingEntryNavigator {
  private busy = false;
  private disposed = false;
  private generation = 0;
  private readonly unsubscribe: () => void;
  constructor(
    private readonly native: Pick<WxApi, 'navigateTo'>,
    runtime: CommunityRuntime | undefined,
    private readonly failure: () => void,
  ) {
    let owner = runtime?.sessions.snapshot();
    this.unsubscribe =
      runtime?.sessions.subscribe(() => {
        const current = runtime.sessions.snapshot();
        if (
          current.epoch !== owner?.epoch ||
          current.credentials?.accountId !== owner?.credentials?.accountId
        ) {
          owner = current;
          this.generation++;
          this.busy = false;
        }
      }) ?? (() => undefined);
  }
  open(selection: { entry: Entry; mode: Mode } | null): void {
    if (!selection || this.busy || this.disposed) return;
    const generation = ++this.generation;
    const current = () => !this.disposed && generation === this.generation;
    try {
      const url = entryPath(selection.entry, selection.mode);
      if (!this.native.navigateTo) {
        this.failure();
        return;
      }
      this.busy = true;
      this.native.navigateTo({
        url,
        success: () => {
          if (current()) this.busy = false;
        },
        fail: () => {
          if (current()) {
            this.busy = false;
            this.failure();
          }
        },
      });
    } catch {
      if (current()) {
        this.busy = false;
        this.failure();
      }
    }
  }
  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.busy = false;
    this.unsubscribe();
  }
}
