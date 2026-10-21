import type { SessionStore, SessionTicket } from '../auth/session';
import type { MediaView } from '../community/contract';
import type { WxApi, WxIntersectionObserver } from '../platform/wechat';
import type { MediaGalleryController } from './gallery-controller';
import type { MediaReadRuntime } from './runtime';

export interface FeedThumbnail {
  readonly localSrc: string;
  readonly viewId: string;
  readonly status: 'loading' | 'ready' | 'unavailable';
}
let readerSequence = 0;
export interface ThumbnailCard {
  readonly id: string;
  readonly images: readonly MediaView[];
}
interface Target {
  readonly post: ThumbnailCard;
  readonly observer: WxIntersectionObserver;
  visible: boolean;
  reader?: MediaGalleryController;
}
/** Viewport-only authenticated thumbnails. At most three files/readers are live;
 * every eviction revokes sources and waits for cleanup before a replacement read.
 * Detail remains the expanded viewer, so feed thumbnails never promote a cache. */
export class FeedThumbnails {
  private readonly targets = new Map<string, Target>();
  private readonly views: Record<string, FeedThumbnail> = {};
  private revision = 0;
  private scope = '';
  private disposed = false;
  private owner: SessionTicket;
  private releasing: Promise<void> = Promise.resolve();
  private loading: Promise<void> = Promise.resolve();
  private readonly unsubscribe: () => void;
  constructor(
    private readonly sessions: SessionStore,
    private readonly runtime: MediaReadRuntime | undefined,
    private readonly wx: Pick<WxApi, 'createIntersectionObserver' | 'nextTick'>,
    private readonly page: object,
    private readonly publish: (
      views: Readonly<Record<string, FeedThumbnail>>,
    ) => void,
  ) {
    this.owner = sessions.snapshot();
    this.unsubscribe = sessions.subscribe(() => {
      try {
        sessions.assertCurrent(this.owner);
      } catch {
        this.clear();
      }
    });
  }
  private active(): boolean {
    if (this.disposed || !this.owner.credentials) return false;
    try {
      this.sessions.assertCurrent(this.owner);
      return true;
    } catch {
      return false;
    }
  }
  render(posts: readonly ThumbnailCard[], scope: string): () => void {
    if (this.disposed) return () => undefined;
    if (scope !== this.scope) {
      this.clear();
      this.scope = scope;
    }
    const revision = ++this.revision;
    const desired = posts.filter((post) => post.images.length > 0);
    for (const [id, target] of this.targets) {
      const next = desired.find((post) => post.id === id);
      if (
        !next ||
        JSON.stringify(next.images[0]) !== JSON.stringify(target.post.images[0])
      )
        this.remove(id, target);
    }
    return () => {
      const attach = () => {
        if (
          revision !== this.revision ||
          !this.active() ||
          !this.runtime?.createGallery
        )
          return;
        for (const post of desired) {
          if (this.targets.has(post.id) || !this.wx.createIntersectionObserver)
            continue;
          try {
            const observer = this.wx.createIntersectionObserver(this.page, {
              thresholds: [0, Number.MIN_VALUE],
              initialRatio: 0,
            });
            const target: Target = { post, observer, visible: false };
            this.targets.set(post.id, target);
            observer
              .relativeToViewport()
              .observe(`#view-${post.id}`, ({ intersectionRatio }) => {
                if (!this.active() || this.targets.get(post.id) !== target)
                  return;
                target.visible =
                  Number.isFinite(intersectionRatio) && intersectionRatio > 0;
                if (!target.visible) this.release(post.id, target);
                this.fill();
              });
          } catch {
            const target = this.targets.get(post.id);
            if (target) this.remove(post.id, target);
          }
        }
      };
      try {
        if (this.wx.nextTick) this.wx.nextTick(attach);
        else attach();
      } catch {
        /* no native hook, no speculative read */
      }
    };
  }
  private fill(): void {
    if (!this.active()) return;
    let live = [...this.targets.values()].filter(
      (target) => target.reader,
    ).length;
    for (const [id, target] of this.targets) {
      if (live >= 3) break;
      if (!target.visible || target.reader) continue;
      const readerId = ++readerSequence;
      const reader = this.runtime?.createGallery?.((view) => {
        if (!this.active() || this.targets.get(id) !== target || !target.reader)
          return;
        const slot = view.slots[0];
        this.views[id] = slot
          ? {
              localSrc: slot.localSrc,
              viewId: `${readerId}:${slot.viewId}`,
              status: slot.status,
            }
          : {
              localSrc: '',
              viewId: '',
              status: view.status === 'loading' ? 'loading' : 'unavailable',
            };
        this.emit();
      });
      if (!reader) continue;
      target.reader = reader;
      live++;
      // Shared authenticated transport admits only two operations globally.
      // Feed reads are serial, leaving capacity for another page-local viewer.
      this.loading = reader.load(
        [target.post.images[0]!],
        Promise.all([this.releasing, this.loading]).then(() => undefined),
      );
    }
  }
  imageFailed(id: string, source: string, viewId: string): void {
    const current = this.views[id];
    if (!current || current.localSrc !== source || current.viewId !== viewId)
      return;
    this.targets
      .get(id)
      ?.reader?.imageFailed(0, source, viewId.slice(viewId.indexOf(':') + 1));
  }
  private release(id: string, target: Target): void {
    const reader = target.reader;
    delete target.reader;
    if (reader) {
      this.releasing = Promise.all([
        this.releasing,
        reader.clearAndWait(),
      ]).then(() => undefined);
      reader.dispose();
    }
    delete this.views[id];
    this.emit();
  }
  private remove(id: string, target: Target): void {
    this.targets.delete(id);
    try {
      target.observer.disconnect();
    } catch {
      /* best effort */
    }
    this.release(id, target);
  }
  clear(): void {
    this.revision++;
    for (const [id, target] of this.targets) this.remove(id, target);
  }
  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.clear();
  }
  private emit(): void {
    this.publish({ ...this.views });
  }
}
