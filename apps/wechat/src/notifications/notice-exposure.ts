import type { SessionTicket } from '../auth/session';
import type { CommunityRuntime } from '../community/runtime';
import type { Clock } from '../platform/contracts';
import type { WxApi, WxIntersectionObserver } from '../platform/wechat';
import { isUuid } from '../profile/contract';
import type { NoticeReadGuard } from './notice-read-guard';

export interface NoticeExposureRow {
  readonly key: string;
  readonly source: string;
  readonly noticeId: string;
  readonly unread: boolean;
  /** Exact source row content, including availability, body, identity and times. */
  readonly fingerprint: string;
}
export interface NoticeExposureCommit {
  /** IDs belong to this exact render, not merely a reused notice UUID. */
  readonly ids: ReadonlyMap<string, string>;
  readonly committed: () => void;
}
type Runtime = Pick<
  CommunityRuntime,
  | 'sessions'
  | 'privateViews'
  | 'safetyChanges'
  | 'browsingScopeChanges'
  | 'directoryScopeChanges'
>;
interface Target {
  readonly row: Readonly<NoticeExposureRow>;
  readonly observer: WxIntersectionObserver;
  stop: (() => void) | undefined;
  visible: boolean;
  interval: number;
}

/** Foreground-only evidence. No persistence, count inference, mark-all or replay. */
export class NoticeExposureObserver {
  private readonly owner: SessionTicket;
  private readonly unsubscribers: (() => void)[] = [];
  private readonly targets = new Map<string, Target>();
  private readonly attempted = new Set<string>();
  private revision = 0;
  private disposed = false;
  private invalidated = false;
  private occluded = false;
  private scope = '';
  private renderedSignature = '';
  private renderedIds: ReadonlyMap<string, string> = new Map();
  private dispatch: { revision: number; scope: string } | undefined;
  constructor(
    private readonly wx: Pick<WxApi, 'createIntersectionObserver' | 'nextTick'>,
    private readonly page: object,
    private readonly clock: Clock,
    private readonly runtime: Runtime,
    private readonly acknowledge: (
      row: Readonly<NoticeExposureRow>,
      guard: NoticeReadGuard,
    ) => Promise<void>,
    private readonly settled: () => void = () => undefined,
  ) {
    this.owner = runtime.sessions.snapshot();
    const invalidate = () => {
      this.invalidated = true;
      this.clear();
    };
    this.unsubscribers.push(
      runtime.sessions.subscribe(() => {
        if (!this.ownsSession()) invalidate();
      }),
    );
    this.unsubscribers.push(
      runtime.privateViews?.subscribe((accountId) => {
        if (
          accountId === undefined ||
          accountId === this.owner.credentials?.accountId
        )
          invalidate();
      }) ?? (() => undefined),
    );
    this.unsubscribers.push(
      runtime.safetyChanges?.subscribe((accountId) => {
        if (accountId === this.owner.credentials?.accountId) invalidate();
      }) ?? (() => undefined),
    );
    for (const changes of [
      runtime.browsingScopeChanges,
      runtime.directoryScopeChanges,
    ])
      this.unsubscribers.push(
        changes?.subscribe((accountId) => {
          if (
            accountId === undefined ||
            accountId === this.owner.credentials?.accountId
          )
            invalidate();
        }) ?? (() => undefined),
      );
  }
  private ownsSession(): boolean {
    const current = this.runtime.sessions.snapshot();
    return (
      !!this.owner.credentials &&
      current.epoch === this.owner.epoch &&
      current.credentials?.accountId === this.owner.credentials.accountId &&
      current.credentials?.sessionId === this.owner.credentials.sessionId
    );
  }
  private active(revision: number, scope: string): boolean {
    return (
      !this.disposed &&
      !this.invalidated &&
      !this.occluded &&
      this.ownsSession() &&
      revision === this.revision &&
      scope === this.scope
    );
  }
  /** Before every setData that changes the row/layout. Only its native commit arms observers. */
  render(
    rows: readonly NoticeExposureRow[],
    scope: string,
    ready: boolean,
    ownBusyRender = false,
  ): NoticeExposureCommit {
    const signature = JSON.stringify([scope, rows]);
    // The same row content may render its own disabled/busy state before dispatch.
    // No changed content, loading result, interaction reset or different scope qualifies.
    if (
      this.dispatch &&
      (ready || ownBusyRender) &&
      signature === this.renderedSignature &&
      this.active(this.dispatch.revision, this.dispatch.scope)
    )
      return { ids: this.renderedIds, committed: () => undefined };
    this.clear();
    this.scope = scope;
    this.renderedSignature = signature;
    const revision = this.revision;
    const ids = new Map<string, string>();
    const snapshot: Readonly<NoticeExposureRow>[] = [];
    const duplicates = new Set<string>();
    for (const row of rows) {
      if (ids.has(row.key)) duplicates.add(row.key);
      if (
        !/^[a-z][a-z0-9-]{0,31}$/.test(row.source) ||
        !isUuid(row.noticeId) ||
        row.key !== `${row.source}:${row.noticeId}`
      )
        continue;
      ids.set(row.key, `notice-${revision}-${row.source}-${row.noticeId}`);
      snapshot.push(Object.freeze({ ...row }));
    }
    this.renderedIds = ids;
    let committed = false;
    return {
      ids,
      committed: () => {
        if (committed || !ready || !scope || !this.active(revision, scope))
          return;
        committed = true;
        const attach = () => {
          if (
            !this.active(revision, scope) ||
            !this.wx.createIntersectionObserver
          )
            return;
          for (const row of snapshot) {
            if (
              !row.unread ||
              duplicates.has(row.key) ||
              this.attempted.has(row.key)
            )
              continue;
            let target: Target | undefined;
            try {
              const observer = this.wx.createIntersectionObserver(this.page, {
                thresholds: [0, 0.5],
                initialRatio: 0,
              });
              target = {
                row,
                observer,
                stop: undefined,
                visible: false,
                interval: 0,
              };
              const currentTarget = target;
              this.targets.set(row.key, target);
              observer
                .relativeToViewport()
                .observe(`#${ids.get(row.key)!}`, ({ intersectionRatio }) => {
                  if (
                    !this.active(revision, scope) ||
                    this.targets.get(row.key) !== currentTarget
                  )
                    return;
                  currentTarget.visible =
                    Number.isFinite(intersectionRatio) &&
                    intersectionRatio >= 0.5 &&
                    intersectionRatio <= 1;
                  if (!currentTarget.visible) {
                    currentTarget.interval++;
                    currentTarget.stop?.();
                    currentTarget.stop = undefined;
                  } else if (
                    !currentTarget.stop &&
                    !this.attempted.has(row.key)
                  ) {
                    const interval = ++currentTarget.interval;
                    const startedAt = this.clock.now();
                    currentTarget.stop = this.clock.schedule(() => {
                      currentTarget.stop = undefined;
                      // A microtask rechecks an interaction in the same native turn before dispatch.
                      void Promise.resolve()
                        .then(async () => {
                          if (
                            !this.active(revision, scope) ||
                            !currentTarget.visible ||
                            interval !== currentTarget.interval ||
                            this.clock.now() - startedAt < 1000 ||
                            this.targets.get(row.key) !== currentTarget ||
                            this.attempted.has(row.key)
                          )
                            return;
                          this.runtime.sessions.assertCurrent(this.owner);
                          if (this.dispatch) return;
                          const dispatch = { revision, scope };
                          this.dispatch = dispatch;
                          this.attempted.add(row.key);
                          for (const [key, other] of this.targets)
                            if (other !== currentTarget)
                              this.remove(key, other);
                          const guard = () =>
                            this.active(revision, scope) &&
                            this.targets.get(row.key) === currentTarget &&
                            currentTarget.visible &&
                            currentTarget.interval === interval;
                          try {
                            await this.acknowledge(row, guard);
                          } finally {
                            if (this.dispatch === dispatch)
                              this.dispatch = undefined;
                            if (!this.disposed && !this.invalidated)
                              this.settled();
                          }
                        })
                        .catch(() => {
                          // Only the owning reader can reconcile an outcome. Never retry from exposure.
                        });
                    }, 1000);
                  }
                });
            } catch {
              if (target) this.remove(row.key, target);
              // Missing or failing observation remains explicit-manual-only.
            }
          }
        };
        try {
          if (this.wx.nextTick) this.wx.nextTick(attach);
          else attach();
        } catch {
          // No render evidence means no read.
        }
      },
    };
  }
  /** Occlusion resets dwell; unoccluding still requires a new committed render. */
  setOccluded(occluded: boolean): void {
    this.occluded = occluded;
    this.clear();
  }
  clear(): void {
    this.revision++;
    for (const [key, target] of this.targets) this.remove(key, target);
  }
  private remove(key: string, target: Target): void {
    target.stop?.();
    target.visible = false;
    target.interval++;
    this.targets.delete(key);
    try {
      target.observer.disconnect();
    } catch {
      /* best effort */
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.unsubscribers.forEach((unsubscribe) => unsubscribe());
    this.attempted.clear();
  }
}
