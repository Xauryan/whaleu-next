import type { Comment, Post } from '../community/contract';
import type { Reply } from '../community/discussion-contract';
import type { MediaAttachment } from './contracts';
import {
  initialGalleryView,
  type GalleryView,
  type MediaGalleryController,
} from './gallery-controller';
import type { MediaReadController } from './read-controller';
import type { MediaReadRuntime } from './runtime';

export interface DiscussionImageGroup {
  readonly kind: 'post' | 'comment' | 'reply';
  readonly id: string;
  readonly images: readonly MediaAttachment[];
}
export interface DiscussionGalleryView extends GalleryView {
  readonly groupKind: DiscussionImageGroup['kind'] | null;
  readonly groupId: string;
  readonly title: string;
}
export const initialDiscussionGalleryView = (): DiscussionGalleryView => ({
  ...initialGalleryView(),
  groupKind: null,
  groupId: '',
  title: '',
});

/** Metadata only: rows never create readers, leases, or their own file budget. */
export function discussionImageGroups(
  post: Post,
  comments: readonly Comment[],
  replies: readonly Reply[] = [],
): readonly DiscussionImageGroup[] {
  const groups: DiscussionImageGroup[] = [
    { kind: 'post', id: post.id, images: post.images },
    ...comments.map((comment) => ({
      kind: 'comment' as const,
      id: comment.id,
      images: comment.images,
    })),
    ...[
      ...comments.flatMap((comment) => comment.replyPreview.items),
      ...replies,
    ].map((reply) => ({
      kind: 'reply' as const,
      id: reply.id,
      images: reply.images,
    })),
  ];
  return [
    ...new Map(
      groups.map((group) => [`${group.kind}:${group.id}`, group]),
    ).values(),
  ];
}

/** Exactly one gallery from the app's shared transfer/lease registry per page.
 * Detail keeps its legacy single-post reader; only one reader is active at a time.
 * Switching revokes old sources and awaits cleanup without refreshing ownership. */
export class DiscussionGalleryController {
  private readonly gallery: MediaGalleryController | undefined;
  private selected: DiscussionImageGroup | null = null;
  private disposed = false;
  private releasing: Promise<void> = Promise.resolve();

  constructor(
    runtime: MediaReadRuntime | undefined,
    private readonly render: (view: DiscussionGalleryView) => void,
    private readonly postReader?: MediaReadController,
  ) {
    this.gallery = runtime?.createGallery?.((view) => this.publish(view));
  }

  select(group: DiscussionImageGroup): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.clear();
    if (
      !group.images.length ||
      group.images.length > (group.kind === 'post' ? 9 : 3)
    )
      return Promise.resolve();
    this.selected = { ...group, images: [...group.images] };
    if (group.kind === 'post' && group.images.length === 1 && this.postReader) {
      this.publish(initialGalleryView());
      return this.postReader.load(group.images[0]!, this.releasing);
    }
    if (this.gallery) return this.gallery.load(group.images, this.releasing);
    this.publish({ ...initialGalleryView(), status: 'unavailable' });
    return Promise.resolve();
  }

  /** A refresh, access loss, or removal must revoke the selected group even if
   * another row with the same UUID but a different resource kind is present. */
  reconcile(groups: readonly DiscussionImageGroup[] | null): void {
    if (!this.selected) return;
    const selected = this.selected;
    const current = groups?.find(
      (group) => group.kind === selected.kind && group.id === selected.id,
    );
    if (
      !current ||
      current.images.length !== selected.images.length ||
      current.images.some((image, index) => {
        const previous = selected.images[index];
        return (
          !previous ||
          image.bindingId !== previous.bindingId ||
          image.assetId !== previous.assetId ||
          image.width !== previous.width ||
          image.height !== previous.height
        );
      })
    )
      this.clear();
  }

  open(index: number): Promise<void> {
    return this.gallery?.open(index) ?? Promise.resolve();
  }
  window(start: number): Promise<void> {
    return this.gallery?.window(start) ?? Promise.resolve();
  }
  retry(index: number): Promise<void> {
    return this.gallery?.retry(index) ?? Promise.resolve();
  }
  close(): Promise<void> {
    return this.gallery?.close() ?? Promise.resolve();
  }
  imageFailed(index: number, source: string, viewId: string): void {
    this.gallery?.imageFailed(index, source, viewId);
  }
  clear(): void {
    this.selected = null;
    this.releasing = Promise.all([
      this.releasing,
      this.postReader?.clearAndWait(),
      this.gallery?.clearAndWait(),
    ]).then(() => undefined);
    if (!this.gallery) this.publish(initialGalleryView());
  }
  dispose(): void {
    this.disposed = true;
    this.clear();
    this.postReader?.dispose();
    if (this.gallery) this.gallery.dispose();
    else this.publish(initialGalleryView());
  }
  private publish(view: GalleryView): void {
    this.render({
      ...view,
      groupKind: this.selected?.kind ?? null,
      groupId: this.selected?.id ?? '',
      title: this.selected
        ? { post: '帖子图片', comment: '评论图片', reply: '回复图片' }[
            this.selected.kind
          ]
        : '',
    });
  }
}
