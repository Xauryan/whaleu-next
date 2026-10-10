import type { WxApi, WxIntersectionObserver } from '../platform/wechat';
import { ratingId } from './contract';
/** Only actual committed viewport observations admit thumbnail bytes. */
export class RatingCoverViewport {
  private readonly targets = new Map<string, WxIntersectionObserver>();
  private revision = 0;
  private disposed = false;
  constructor(
    private readonly wx: Pick<WxApi, 'createIntersectionObserver' | 'nextTick'>,
    private readonly page: object,
    private readonly visible: (id: string, visible: boolean) => void,
    private readonly unavailable: (id: string) => void,
  ) {}
  render(raw: readonly string[]): () => void {
    const ids = [...new Set(raw.filter(ratingId))],
      revision = ++this.revision;
    for (const [id, observer] of this.targets)
      if (!ids.includes(id)) {
        this.targets.delete(id);
        try {
          observer.disconnect();
        } catch {
          /* Local callback identity already revoked. */
        }
        this.visible(id, false);
      }
    return () => {
      const attach = () => {
        if (this.disposed || revision !== this.revision) return;
        for (const id of ids) {
          if (this.targets.has(id)) continue;
          if (!this.wx.createIntersectionObserver) {
            this.unavailable(id);
            continue;
          }
          try {
            const observer = this.wx.createIntersectionObserver(this.page, {
              thresholds: [0, Number.MIN_VALUE],
              initialRatio: 0,
            });
            this.targets.set(id, observer);
            observer
              .relativeToViewport()
              .observe(`#rating-cover-row-${id}`, ({ intersectionRatio }) => {
                if (this.disposed || this.targets.get(id) !== observer) return;
                this.visible(
                  id,
                  Number.isFinite(intersectionRatio) && intersectionRatio > 0,
                );
              });
          } catch {
            const observer = this.targets.get(id);
            this.targets.delete(id);
            try {
              observer?.disconnect();
            } catch {
              /* Revoked locally. */
            }
            this.unavailable(id);
          }
        }
      };
      try {
        if (this.wx.nextTick) this.wx.nextTick(attach);
        else attach();
      } catch {
        for (const id of ids) this.unavailable(id);
      }
    };
  }
  dispose(): void {
    this.disposed = true;
    ++this.revision;
    for (const observer of this.targets.values()) {
      try {
        observer.disconnect();
      } catch {
        /* Revoked locally. */
      }
    }
    this.targets.clear();
  }
}
