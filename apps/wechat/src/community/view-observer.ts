import type { SessionTicket } from '../auth/session';
import type { Clock } from '../platform/contracts';
import type { WxApi, WxIntersectionObserver } from '../platform/wechat';
import { isUuid } from '../profile/contract';

export interface ViewObservationSink {
  captureOwner(): SessionTicket;
  canPresent(owner: SessionTicket): boolean;
  canObserve(owner: SessionTicket): boolean;
  observe(
    kind: 'list_exposure' | 'detail_visit',
    postId: string,
    owner: SessionTicket,
  ): void;
  subscribeInvalidation(listener: () => void): () => void;
}
interface Target {
  readonly observer: WxIntersectionObserver;
  stopTimer: (() => void) | undefined;
  visible: boolean;
  reported: boolean;
}
/** One instance per page show. Native viewport evidence, never a fetch callback, produces events. */
export class ViewObserver {
  private disposed = false;
  private renderRevision = 0;
  private scope = '';
  private desired: readonly string[] = [];
  private committed = false;
  private readonly owner: SessionTicket;
  private readonly targets = new Map<string, Target>();
  private detailReported = false;
  private readonly unsubscribe: () => void;
  constructor(
    private readonly wx: Pick<WxApi, 'createIntersectionObserver' | 'nextTick'>,
    private readonly page: object,
    private readonly clock: Clock,
    private readonly sink: ViewObservationSink,
    private readonly kind: 'list_exposure' | 'detail_visit',
  ) {
    this.owner = sink.captureOwner();
    this.unsubscribe = sink.subscribeInvalidation(() => {
      if (!this.active()) {
        this.clearTargets();
        return;
      }
      // Readiness changes do not reset an already qualified visible interval.
      for (const [postId, target] of this.targets) {
        target.stopTimer?.();
        target.stopTimer = undefined;
        this.qualify(postId, target);
      }
      this.attach();
    });
  }
  /** Call before setData; invoke its callback only after that render commits. */
  render(postIds: readonly string[], scope = ''): () => void {
    const ids = postIds.filter(isUuid);
    if (this.disposed) return () => undefined;
    if (scope !== this.scope) this.clearTargets();
    this.scope = scope;
    const revision = ++this.renderRevision;
    this.desired = ids;
    this.committed = false;
    for (const [id, target] of this.targets)
      if (!ids.includes(id)) this.remove(id, target);
    return () => {
      if (revision !== this.renderRevision || this.disposed) return;
      this.committed = true;
      const attach = () => {
        if (revision === this.renderRevision) this.attach();
      };
      try {
        if (this.wx.nextTick) this.wx.nextTick(attach);
        else attach();
      } catch {
        /* Missing/failed native rendering hooks cannot break browsing. */
      }
    };
  }
  private active(): boolean {
    return !this.disposed && this.sink.canPresent(this.owner);
  }
  private qualify(postId: string, target: Target): void {
    if (
      !this.active() ||
      this.targets.get(postId) !== target ||
      !target.visible ||
      !this.sink.canObserve(this.owner)
    )
      return;
    if (this.kind === 'detail_visit') {
      if (this.detailReported) return;
      this.detailReported = true;
      this.sink.observe(this.kind, postId, this.owner);
    } else if (!target.reported && !target.stopTimer) {
      target.stopTimer = this.clock.schedule(() => {
        target.stopTimer = undefined;
        if (
          !this.active() ||
          this.targets.get(postId) !== target ||
          !target.visible ||
          target.reported ||
          !this.sink.canObserve(this.owner)
        )
          return;
        target.reported = true;
        this.sink.observe(this.kind, postId, this.owner);
      }, 1000);
    }
  }
  private attach(): void {
    if (
      !this.committed ||
      !this.active() ||
      !this.wx.createIntersectionObserver
    )
      return;
    for (const postId of this.desired) {
      if (
        this.targets.has(postId) ||
        (this.kind === 'detail_visit' && this.detailReported)
      )
        continue;
      try {
        const observer = this.wx.createIntersectionObserver(this.page, {
          thresholds:
            this.kind === 'list_exposure' ? [0, 0.5] : [0, Number.MIN_VALUE],
          initialRatio: 0,
        });
        const target: Target = {
          observer,
          stopTimer: undefined,
          visible: false,
          reported: false,
        };
        this.targets.set(postId, target);
        observer
          .relativeToViewport()
          .observe(`#view-${postId}`, ({ intersectionRatio }) => {
            if (!this.active() || this.targets.get(postId) !== target) return;
            target.visible =
              Number.isFinite(intersectionRatio) &&
              (this.kind === 'list_exposure'
                ? intersectionRatio >= 0.5
                : intersectionRatio > 0);
            if (!target.visible) {
              target.stopTimer?.();
              target.stopTimer = undefined;
              target.reported = false;
            } else this.qualify(postId, target);
          });
      } catch {
        const target = this.targets.get(postId);
        if (target) this.remove(postId, target);
      }
    }
  }
  private remove(id: string, target: Target): void {
    target.stopTimer?.();
    try {
      target.observer.disconnect();
    } catch {
      /* best effort */
    }
    this.targets.delete(id);
  }
  private clearTargets(): void {
    for (const [id, target] of this.targets) this.remove(id, target);
  }
  clear(): void {
    this.renderRevision += 1;
    this.desired = [];
    this.committed = false;
    this.clearTargets();
  }
  dispose(): void {
    this.disposed = true;
    this.clear();
    this.unsubscribe();
  }
}
