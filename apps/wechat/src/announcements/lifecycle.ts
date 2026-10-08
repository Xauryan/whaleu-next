import { ClientError, clientError } from '../api/errors';
import type { SessionTicket } from '../auth/session';
import { communityError } from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import { cancellable } from '../platform/cancellable';
import { Cancellation } from '../platform/contracts';
export interface AnnouncementView {
  readonly configured: boolean;
  readonly hasSession: boolean;
  readonly busy: boolean;
  readonly status: string;
  readonly error: string;
}
export const initialAnnouncementView = (): AnnouncementView => ({
  configured: false,
  hasSession: false,
  busy: false,
  status: '',
  error: '',
});
export function announcementError(error: ClientError): string {
  const messages: Record<string, string> = {
    ANNOUNCEMENTS_UNAVAILABLE: '公告资料尚不能确认，暂不可用；这不代表没有公告',
    ANNOUNCEMENT_NOT_FOUND: '此公告不存在或当前不可查看',
    ANNOUNCEMENT_REVISION_CHANGED:
      '公告已变化，本次关闭尚未确认，请下次进入时重新核验',
    DISCOVERY_RESTART_REQUIRED: '公告已变化，请重新加载；旧分页已清除',
    CAMPUS_NOT_FOUND: '此浏览校区当前不可用，请重新选择',
  };
  return messages[error.details.serverCode ?? ''] ?? communityError(error);
}
/** Transient announcement bodies: callbacks are fenced by login epoch, scope and visible generation. */
export abstract class AnnouncementController<V extends AnnouncementView> {
  protected view: V;
  protected owner: SessionTicket;
  private generation = 0;
  private disposed = false;
  private cancellation: Cancellation | undefined;
  private readonly subscriptions: (() => void)[] = [];
  constructor(
    protected readonly runtime: CommunityRuntime,
    private readonly initial: () => V,
    private readonly render: (value: V) => void,
  ) {
    this.owner = runtime.sessions.snapshot();
    this.view = initial();
    this.subscriptions.push(
      runtime.sessions.subscribe(() => {
        const current = runtime.sessions.snapshot();
        if (
          current.epoch !== this.owner.epoch ||
          current.credentials?.accountId !== this.owner.credentials?.accountId
        ) {
          this.owner = current;
          this.invalidate('登录状态已变化，请重新打开公告');
        }
      }),
    );
    if (runtime.privateViews)
      this.subscriptions.push(
        runtime.privateViews.subscribe((accountId) => {
          if (accountId === undefined) this.dispose();
        }),
      );
    if (runtime.safetyChanges)
      this.subscriptions.push(
        runtime.safetyChanges.subscribe((accountId) => {
          if (accountId === this.owner.credentials?.accountId)
            this.invalidate('安全状态已变化，请重新打开公告');
        }),
      );
    if (runtime.browsingScopeChanges)
      this.subscriptions.push(
        runtime.browsingScopeChanges.subscribe((accountId) => {
          if (
            accountId === undefined ||
            accountId === this.owner.credentials?.accountId
          )
            this.invalidate('浏览校区已变化，请重新打开公告');
        }),
      );
    this.update({
      configured: !!runtime.announcements,
      hasSession: !!this.owner.credentials,
    } as Partial<V>);
  }
  protected reset(): void {}
  protected update(patch: Partial<V>): void {
    if (this.disposed) return;
    this.view = Object.freeze({ ...this.view, ...patch });
    this.render(this.view);
  }
  protected stop(): void {
    this.generation++;
    this.cancellation?.cancel();
    this.cancellation = undefined;
  }
  protected clear(status = ''): void {
    this.stop();
    this.view = this.initial();
    this.update({
      configured: !!this.runtime.announcements,
      hasSession: !!this.owner.credentials,
      status,
    } as Partial<V>);
  }
  private invalidate(status: string): void {
    this.stop();
    this.reset();
    this.clear(status);
  }
  protected current(): boolean {
    if (this.disposed) return false;
    try {
      this.runtime.sessions.assertCurrent(this.owner);
      return true;
    } catch {
      return false;
    }
  }
  protected available(requireLogin = false): boolean {
    if (!this.current()) return false;
    if (
      !this.runtime.announcements ||
      (requireLogin && !this.owner.credentials)
    ) {
      this.update({
        status:
          requireLogin && !this.owner.credentials ? '' : '公告服务尚未配置',
        error: '',
      } as Partial<V>);
      return false;
    }
    return true;
  }
  protected async run<T>(
    work: (cancel: Cancellation, assertCurrent: () => void) => Promise<T>,
    apply: (result: T) => void,
    failed?: (error: ClientError) => void,
  ): Promise<void> {
    if (!this.current()) return;
    this.stop();
    const generation = this.generation,
      owner = this.owner,
      cancel = new Cancellation();
    this.cancellation = cancel;
    const current = () =>
      this.current() && this.generation === generation && !cancel.isCancelled;
    const assertCurrent = () => {
      this.runtime.sessions.assertCurrent(owner);
      if (!current())
        throw new ClientError('cancelled', 'Announcement operation replaced');
    };
    this.update({ busy: true, error: '' } as Partial<V>);
    try {
      const result = await cancellable(
        Promise.resolve().then(() => {
          assertCurrent();
          return work(cancel, assertCurrent);
        }),
        cancel,
      );
      assertCurrent();
      apply(result);
    } catch (error) {
      if (!current()) return;
      const failure = clientError(error);
      this.update({
        status: '公告暂不可用',
        error: announcementError(failure),
      } as Partial<V>);
      failed?.(failure);
    } finally {
      if (current()) {
        this.cancellation = undefined;
        this.update({ busy: false } as Partial<V>);
      }
    }
  }
  cancel(): void {
    this.reset();
    this.clear('已停止读取，请重新打开公告');
  }
  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.reset();
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.view = this.initial();
    this.render(this.view);
    this.disposed = true;
  }
}
