import type { WxApi } from '../platform/wechat';
/** Page-local latch; only current controller-derived routes may be dispatched. */
export class AnnouncementNavigator {
  private pending = false;
  private disposed = false;
  private generation = 0;
  constructor(
    private readonly native: Pick<WxApi, 'navigateTo'>,
    private readonly failure: () => void,
  ) {}
  open(path: string | null): void {
    if (!path || this.pending || this.disposed) return;
    if (!this.native.navigateTo) {
      this.failure();
      return;
    }
    this.pending = true;
    const generation = ++this.generation;
    const finish = (failed = false) => {
      if (this.disposed || generation !== this.generation) return;
      this.pending = false;
      if (failed) this.failure();
    };
    try {
      this.native.navigateTo({
        url: path,
        success: () => finish(),
        fail: () => finish(true),
      });
    } catch {
      finish(true);
    }
  }
  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.pending = false;
  }
}
