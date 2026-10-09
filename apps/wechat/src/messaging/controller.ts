import { ClientError, clientError } from '../api/errors';
import type { SessionTicket } from '../auth/session';
import { cancellable } from '../platform/cancellable';
import { Cancellation } from '../platform/contracts';
import { messagingError } from './errors';
import type { MessagingRuntime } from './runtime';
export interface BaseView {
  readonly busy: boolean;
  readonly loaded: boolean;
  readonly hasSession: boolean;
  readonly error: string;
  readonly status: string;
  readonly pending: boolean;
}
export const baseView = (): BaseView => ({
  busy: false,
  loaded: false,
  hasSession: false,
  error: '',
  status: '等待加载',
  pending: false,
});
export type Render<V> = (view: V, rendered?: () => void) => void;
/** One foreground request chain, guarded by login epoch, page generation and cancellation. */
export abstract class MessagingController<V extends BaseView> {
  protected view: V;
  protected owner: SessionTicket;
  protected active = true;
  private generation = 0;
  private cancellation: Cancellation | undefined;
  private timer: (() => void) | undefined;
  private failures = 0;
  private disposed = false;
  private pollingPaused = false;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeHide: () => void;
  private readonly unsubscribeSafety: () => void;
  constructor(
    protected readonly runtime: MessagingRuntime,
    private readonly initial: () => V,
    private readonly render: Render<V>,
  ) {
    this.owner = runtime.sessions.snapshot();
    this.view = initial();
    this.unsubscribe = runtime.sessions.subscribe(() => {
      const current = runtime.sessions.snapshot();
      if (
        current.epoch !== this.owner.epoch ||
        current.credentials?.accountId !== this.owner.credentials?.accountId
      ) {
        this.stop();
        this.active = false;
        this.owner = current;
        this.clearPrivate();
        this.view = initial();
        this.update({
          hasSession: !!current.credentials,
          status: '登录状态已改变，请重新进入；本地私信文字已清除',
        } as Partial<V>);
      }
    });
    this.unsubscribeHide =
      runtime.privateViews?.subscribe((accountId) => {
        if (accountId === undefined) this.hide();
      }) ?? (() => undefined);
    this.unsubscribeSafety =
      runtime.safetyChanges?.subscribe((accountId) => {
        if (accountId !== this.account() || this.disposed) return;
        this.stop();
        this.clearPrivate();
        this.view = this.initial();
        this.update({
          hasSession: !!this.account(),
          status: '安全状态已变化，正在重新核验',
        } as Partial<V>);
        this.invalidated();
      }) ?? (() => undefined);
    this.update({ hasSession: !!this.owner.credentials } as Partial<V>);
  }
  protected clearPrivate(): void {}
  protected invalidated(): void {}
  protected update(patch: Partial<V>, rendered?: () => void): void {
    if (this.disposed) return;
    this.view = Object.freeze({ ...this.view, ...patch });
    this.render(this.view, rendered);
  }
  protected account(): string | null {
    try {
      this.runtime.sessions.assertCurrent(this.owner);
      return this.owner.credentials?.accountId ?? null;
    } catch {
      return null;
    }
  }
  protected pending(): boolean {
    const account = this.account();
    return account ? !!this.runtime.pending.load(account) : false;
  }
  protected available(): boolean {
    if (this.disposed || !this.active) return false;
    try {
      this.runtime.assertStorage();
      if (!this.account())
        throw new ClientError('auth-required', 'Login required');
      if (!this.runtime.gateway)
        throw new ClientError(
          'configuration',
          'Private-message API not configured',
        );
      return true;
    } catch (e) {
      this.update({
        error: messagingError(e),
        status: '暂不可用',
        hasSession: !!this.account(),
      } as Partial<V>);
      return false;
    }
  }
  protected async run(
    work: (cancel: Cancellation, assertCurrent: () => void) => Promise<void>,
  ): Promise<boolean> {
    if (this.view.busy || !this.available()) return false;
    this.pollingPaused = false;
    this.timer?.();
    this.timer = undefined;
    const generation = ++this.generation,
      owner = this.owner,
      cancel = new Cancellation();
    this.cancellation = cancel;
    const assertCurrent = () => {
      this.runtime.sessions.assertCurrent(owner);
      if (
        this.disposed ||
        !this.active ||
        generation !== this.generation ||
        cancel.isCancelled
      )
        throw new ClientError('cancelled', 'Cancelled');
    };
    this.update({ busy: true, error: '' } as Partial<V>);
    let success = false;
    try {
      await cancellable(
        Promise.resolve().then(() => {
          assertCurrent();
          return work(cancel, assertCurrent);
        }),
        cancel,
      );
      assertCurrent();
      this.failures = 0;
      success = true;
    } catch (e) {
      try {
        assertCurrent();
        this.failures = Math.min(4, this.failures + 1);
        this.update({
          error: messagingError(e),
          status: '尚未确认，请重试',
        } as Partial<V>);
        if (clientError(e).kind === 'auth-required') {
          this.clearPrivate();
          this.view = this.initial();
          this.update({ status: '请重新登录' } as Partial<V>);
        }
      } catch {
        /* Stale continuation cannot render or dispatch. */
      }
    } finally {
      if (!this.disposed && this.active && generation === this.generation) {
        this.cancellation = undefined;
        let pending = true;
        try {
          pending = this.pending();
        } catch {
          this.update({
            error: '本地私信恢复记录不可读，已停止发送',
          } as Partial<V>);
        }
        this.update({ busy: false, pending } as Partial<V>);
      }
    }
    return success;
  }
  protected schedule(work: () => Promise<unknown>, milliseconds: number): void {
    this.timer?.();
    if (!this.active || this.disposed || this.pollingPaused || !this.account())
      return;
    this.timer = this.runtime.clock.schedule(
      () => {
        this.timer = undefined;
        if (this.active && !this.disposed) void work();
      },
      Math.min(60000, milliseconds * 2 ** this.failures),
    );
  }
  protected rendered(
    patch: Partial<V>,
    cancel: Cancellation,
    assertCurrent: () => void,
  ): Promise<void> {
    return cancellable(
      new Promise<void>((resolve) => {
        assertCurrent();
        this.update(patch, () => {
          try {
            assertCurrent();
            resolve();
          } catch {
            resolve();
          }
        });
      }),
      cancel,
    ).then(() => assertCurrent());
  }
  protected stop(): void {
    this.generation++;
    this.cancellation?.cancel();
    this.cancellation = undefined;
    this.timer?.();
    this.timer = undefined;
  }
  cancel(): void {
    this.pollingPaused = true;
    this.stop();
    let pending = true;
    try {
      pending = this.pending();
    } catch {
      this.update({
        error: '本地私信恢复记录不可读，已停止发送',
      } as Partial<V>);
    }
    this.update({
      busy: false,
      pending,
      status: '已停止等待；原请求仍可能完成，请到恢复页查询回执',
    } as Partial<V>);
  }
  hide(): void {
    this.stop();
    this.active = false;
    this.clearPrivate();
    this.view = this.initial();
    this.update({ hasSession: !!this.account() } as Partial<V>);
  }
  dispose(): void {
    if (this.disposed) return;
    this.hide();
    this.unsubscribe();
    this.unsubscribeHide();
    this.unsubscribeSafety();
    this.disposed = true;
  }
}
