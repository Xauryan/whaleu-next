import type { NoticeReadGuard } from './notice-read-guard';
import type { ApiClient } from '../api/client';
import type { CommunityRuntime } from '../community/runtime';
import { SystemNoticesController } from '../pages/system-notices/controller';
import { FeedbackNoticesController } from '../pages/feedback-notices/controller';
import { ErrandNoticesController } from '../errands/notices';
import { StudentNoticesReader } from './student-notices';
import { systemNoticeSummary } from './system-summary';
export type SystemSource = 'system' | 'errand' | 'verification' | 'feedback';
export interface SystemTimelineItem {
  readonly key: string;
  readonly source: SystemSource;
  readonly noticeId: string;
  readonly createdAt: string;
  readonly readAt: string | null;
  readonly summary: string;
  readonly kind: string;
}
interface SourceState {
  readonly source: SystemSource;
  readonly loaded: boolean;
  readonly busy: boolean;
  readonly error: string;
  readonly canMore: boolean;
  readonly hasSession: boolean;
  readonly hasUnread: boolean;
  readonly items: readonly SystemTimelineItem[];
}
export interface SystemTimelineView {
  readonly items: readonly SystemTimelineItem[];
  readonly sources: readonly SourceState[];
  readonly loaded: boolean;
  readonly busy: boolean;
  readonly hasSession: boolean;
  readonly error: string;
  readonly unreadCount: null;
  readonly hasUnread: boolean;
  readonly canLoadMore: boolean;
}
export const initialSystemTimelineView = (): SystemTimelineView => ({
  items: [],
  sources: [],
  loaded: false,
  busy: false,
  hasSession: false,
  error: '',
  unreadCount: null,
  hasUnread: false,
  canLoadMore: false,
});
/** UI aggregation only. Each owner reader retains its own cursor, authority and receipts. */
export class SystemTimelineController {
  private readonly states = new Map<SystemSource, SourceState>();
  private readonly readers: Record<
    SystemSource,
    {
      load(): Promise<void>;
      more(): Promise<void>;
      dispose(): void;
      cancel(): void;
    }
  >;
  private readonly system: SystemNoticesController;
  private readonly errand: ErrandNoticesController;
  private readonly feedback: FeedbackNoticesController;
  private readonly verification: StudentNoticesReader;
  private disposed = false;
  private actionSource: SystemSource | null = null;
  private actionGeneration = 0;
  private readonly unsubscribers: (() => void)[] = [];
  private view = initialSystemTimelineView();
  constructor(
    runtime: CommunityRuntime,
    render: (view: SystemTimelineView) => void,
    api?: ApiClient,
    private readonly navigate: (url: string) => Promise<void> = async () =>
      undefined,
  ) {
    this.render = render;
    const clear = () => {
      this.actionGeneration++;
      this.actionSource = null;
      this.states.clear();
      this.view = initialSystemTimelineView();
      this.render(this.view);
    };
    // Register before owner readers, so no intermediate callback can retain another owner's rows.
    let owner = runtime.sessions.snapshot();
    this.unsubscribers.push(
      runtime.sessions.subscribe(() => {
        const next = runtime.sessions.snapshot();
        if (
          next.epoch !== owner.epoch ||
          next.credentials?.accountId !== owner.credentials?.accountId
        )
          clear();
        owner = next;
      }),
    );
    this.unsubscribers.push(
      runtime.safetyChanges?.subscribe((accountId) => {
        if (accountId === owner.credentials?.accountId) clear();
      }) ?? (() => undefined),
    );
    this.unsubscribers.push(
      runtime.privateViews?.subscribe((accountId) => {
        if (accountId === undefined) this.dispose();
      }) ?? (() => undefined),
    );

    this.system = new SystemNoticesController(runtime, (v) =>
      this.accept(
        'system',
        v,
        v.items.map((i) => ({
          ...i,
          key: `system:${i.noticeId}`,
          source: 'system',
          summary: systemNoticeSummary(i),
        })),
        v.canLoadMore,
      ),
    );
    this.errand = new ErrandNoticesController(runtime, (v) =>
      this.accept(
        'errand',
        v,
        v.items.map((i) => ({
          ...i,
          key: `errand:${i.noticeId}`,
          source: 'errand',
          summary:
            i.kind === 'accepted'
              ? '跑腿订单已被接单'
              : i.kind === 'completed'
                ? '跑腿订单已完成'
                : i.kind === 'admin_deleted'
                  ? '跑腿订单已被移除'
                  : i.kind === 'feature_restricted'
                    ? '跑腿使用权限已更新'
                    : '跑腿限制已解除',
        })),
        v.canMore,
      ),
    );
    this.feedback = new FeedbackNoticesController(
      runtime,
      (v) =>
        this.accept(
          'feedback',
          v,
          v.items.map((i) => ({
            ...i,
            key: `feedback:${i.noticeId}`,
            source: 'feedback',
            summary: '收到新的用户反馈',
          })),
          v.canLoadMore,
        ),
      this.navigate,
    );
    this.verification = new StudentNoticesReader(runtime, api, (v) =>
      this.accept(
        'verification',
        v,
        v.items.map((i) => ({
          key: `verification:${i.id}`,
          source: 'verification',
          noticeId: i.id,
          kind: i.kind,
          createdAt: i.createdAt,
          readAt: i.read ? i.createdAt : null,
          summary:
            i.outcome === 'approved'
              ? '校园认证已通过'
              : i.outcome === 'rejected'
                ? '校园认证未通过'
                : '校园认证待处理',
        })),
        v.canMore,
      ),
    );
    this.readers = {
      system: this.system,
      errand: this.errand,
      verification: this.verification,
      feedback: this.feedback,
    };
  }
  private readonly render: (view: SystemTimelineView) => void;
  private accept(
    source: SystemSource,
    state: {
      loaded: boolean;
      busy: boolean;
      error: string;
      hasSession: boolean;
      unreadCount?: number;
    },
    items: readonly SystemTimelineItem[],
    canMore: boolean,
  ): void {
    if (this.disposed) return;
    this.states.set(source, {
      source,
      ...state,
      items: state.loaded ? items : [],
      hasUnread:
        state.loaded &&
        (state.unreadCount !== undefined
          ? state.unreadCount > 0
          : items.some((item) => item.readAt === null)),
      canMore,
    });
    const sources = [...this.states.values()];
    const merged = sources
      .flatMap((s) => s.items)
      .sort(
        (a, b) =>
          Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
          (b.createdAt.match(/\.(\d+)Z$/)?.[1] ?? '')
            .padEnd(9, '0')
            .localeCompare(
              (a.createdAt.match(/\.(\d+)Z$/)?.[1] ?? '').padEnd(9, '0'),
            ) ||
          a.key.localeCompare(b.key),
      );
    this.view = {
      items: merged,
      sources,
      loaded: sources.some((s) => s.loaded),
      busy: sources.some((s) => s.busy),
      hasSession: sources.some((s) => s.hasSession),
      error:
        this.actionSource === source && state.error
          ? state.error
          : this.view.error,
      unreadCount: null,
      hasUnread: sources.some((source) => source.hasUnread),
      canLoadMore: sources.some((s) => s.canMore),
    };
    this.render(this.view);
  }
  snapshot(): SystemTimelineView {
    return this.view;
  }
  async load(): Promise<void> {
    if (this.disposed) return;
    this.actionGeneration++;
    this.actionSource = null;
    this.states.clear();
    this.view = initialSystemTimelineView();
    this.render(this.view);
    await Promise.all(Object.values(this.readers).map((r) => r.load()));
  }
  async more(): Promise<void> {
    if (!this.disposed)
      await Promise.all(Object.values(this.readers).map((r) => r.more()));
  }
  async open(key: string): Promise<void> {
    if (this.disposed || this.view.busy) return;
    const item = this.view.items.find((row) => row.key === key);
    if (!item) return;
    const generation = ++this.actionGeneration;
    this.actionSource = item.source;
    this.view = { ...this.view, error: '' };
    this.render(this.view);
    try {
      if (item.source === 'feedback') await this.feedback.open(item.noticeId);
      else if (item.source === 'verification')
        await this.verification.open(item.noticeId, this.navigate);
      else if (item.source === 'errand') {
        const path = this.errand.orderPath(item.noticeId);
        if (path) await this.navigate(path);
      }
    } finally {
      if (generation === this.actionGeneration) this.actionSource = null;
    }
  }
  async acknowledge(key: string, guard?: NoticeReadGuard): Promise<void> {
    if (this.disposed || this.view.busy) return;
    const item = this.view.items.find((i) => i.key === key);
    if (!item || item.readAt !== null) return;
    const generation = ++this.actionGeneration;
    this.actionSource = item.source;
    this.view = { ...this.view, error: '' };
    this.render(this.view);
    try {
      if (item.source === 'system')
        await this.system.acknowledge(item.noticeId, guard);
      else if (item.source === 'errand')
        await this.errand.read(item.noticeId, guard);
      else if (item.source === 'verification')
        await this.verification.acknowledge(item.noticeId, guard);
      else await this.feedback.acknowledge(item.noticeId, guard);
    } finally {
      if (generation === this.actionGeneration) this.actionSource = null;
    }
  }
  cancel(): void {
    this.actionGeneration++;
    this.actionSource = null;
    Object.values(this.readers).forEach((r) => r.cancel());
  }
  dispose(): void {
    this.disposed = true;
    this.actionGeneration++;
    this.actionSource = null;
    this.unsubscribers.forEach((unsubscribe) => unsubscribe());
    Object.values(this.readers).forEach((r) => r.dispose());
    this.states.clear();
    this.view = initialSystemTimelineView();
    this.render(this.view);
  }
}
