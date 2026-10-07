import { ClientError, clientError } from '../api/errors';
import type { SessionStore, SessionTicket } from '../auth/session';
import { cancellable } from '../platform/cancellable';
import { Cancellation } from '../platform/contracts';
import { friendlyError } from '../pages/login/controller';
import type { OwnProfile } from './contract';
import type { ProfileGateway } from './gateway';

export interface AccountView {
  readonly hasSession: boolean;
  readonly configured: boolean;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly loaded: boolean;
  readonly needsReload: boolean;
  readonly status: string;
  readonly error: string;
  readonly requestId: string;
}
export function initialAccountView(): AccountView {
  return {
    hasSession: false,
    configured: false,
    loading: false,
    saving: false,
    loaded: false,
    needsReload: false,
    status: '等待加载',
    error: '',
    requestId: '',
  };
}
/** Owns every read, draft and save by login epoch, not merely account ID. */
export abstract class OwnedController<V extends AccountView> {
  protected view: V;
  protected owner: SessionTicket;
  private generation = 0;
  private disposed = false;
  private cancellation: Cancellation | undefined;
  private unsubscribe: () => void;
  constructor(
    protected readonly sessions: SessionStore,
    protected readonly gateway: ProfileGateway | undefined,
    private readonly initial: () => V,
    private readonly render: (view: V) => void,
  ) {
    this.view = initial();
    this.owner = sessions.snapshot();
    this.unsubscribe = sessions.subscribe(() => {
      const current = sessions.snapshot();
      if (
        this.owner.epoch !== current.epoch ||
        this.owner.credentials?.accountId !== current.credentials?.accountId
      ) {
        this.stop();
        this.owner = current;
        this.resetPrivate();
        this.view = initial();
        this.update({
          hasSession: !!current.credentials,
          configured: !!gateway,
          status: '登录状态已改变，请重新加载',
          error: '原账号的资料与未保存编辑已清除',
        } as Partial<V>);
      }
    });
    this.update({
      hasSession: !!this.owner.credentials,
      configured: !!gateway,
    } as Partial<V>);
  }
  protected abstract resetPrivate(): void;
  protected update(patch: Partial<V>): void {
    if (this.disposed) return;
    this.view = Object.freeze({ ...this.view, ...patch });
    this.render(this.view);
  }
  protected editable(): boolean {
    if (
      this.disposed ||
      this.view.loading ||
      this.view.saving ||
      !this.view.loaded ||
      this.view.needsReload
    )
      return false;
    try {
      this.sessions.assertCurrent(this.owner);
      return !!this.owner.credentials;
    } catch {
      return false;
    }
  }
  protected checkProfile(profile: OwnProfile, previousRevision?: number): void {
    this.sessions.assertCurrent(this.owner);
    if (
      profile.accountId !== this.owner.credentials?.accountId ||
      (previousRevision !== undefined &&
        profile.revision !== previousRevision + 1)
    )
      throw new ClientError(
        'protocol',
        'Profile identity or revision mismatch',
      );
  }
  protected async perform<T>(
    mode: 'read' | 'save',
    work: (gateway: ProfileGateway, cancellation: Cancellation) => Promise<T>,
    apply: (result: T) => void,
  ): Promise<void> {
    if (
      this.disposed ||
      this.view.saving ||
      (mode === 'save' && !this.editable())
    )
      return;
    if (!this.gateway || !this.sessions.snapshot().credentials) {
      this.update({
        status: '无法加载',
        error: !this.gateway
          ? '当前构建尚未配置登录与 API 环境'
          : '请先登录，再加载个人资料',
      } as Partial<V>);
      return;
    }
    if (mode === 'read') this.stop();
    this.sessions.assertCurrent(this.owner);
    const generation = ++this.generation;
    let sent = this.sessions.snapshot();
    const cancellation = new Cancellation();
    this.cancellation = cancellation;
    this.update({
      loading: mode === 'read',
      saving: mode === 'save',
      status: mode === 'read' ? '正在加载' : '正在保存',
      error: '',
      requestId: '',
    } as Partial<V>);
    try {
      // Deferring work allows same-tick account change, page close or cancel to prevent dispatch.
      const pending = Promise.resolve().then(() => {
        this.sessions.assertCurrent(this.owner);
        if (cancellation.isCancelled)
          throw new ClientError('cancelled', 'Cancelled before dispatch');
        sent = this.sessions.snapshot();
        return work(this.gateway!, cancellation);
      });
      const result = await cancellable(pending, cancellation);
      if (!this.current(generation)) return;
      this.sessions.assertCurrent(this.owner);
      apply(result);
      this.update({
        loaded: true,
        needsReload: false,
        status: mode === 'read' ? '已加载' : '已保存',
      } as Partial<V>);
    } catch (error) {
      if (!this.current(generation)) return;
      const failure = clientError(error);
      if (
        failure.kind === 'auth-required' ||
        (failure.kind === 'forbidden' &&
          failure.details.httpStatus === 403 &&
          failure.details.serverCode === 'ACCOUNT_BLOCKED')
      ) {
        this.resetPrivate();
        this.view = this.initial();
        let message = friendlyError(failure);
        const current = this.sessions.snapshot();
        if (current.revision === sent.revision) {
          try {
            this.sessions.logoutIfCurrent(sent);
          } catch (error) {
            message = friendlyError(clientError(error));
          }
        } else {
          // A delayed old-token 401 must not erase a concurrently refreshed login.
          message = '登录凭证已更新，请重新加载验证当前会话';
        }
        this.update({
          configured: !!this.gateway,
          hasSession: !!this.sessions.snapshot().credentials,
          loaded: false,
          loading: false,
          saving: false,
          status: '请重新验证登录',
          error: message,
        } as Partial<V>);
        return;
      }
      const validCode = (code: string, status: number): boolean =>
        failure.kind !== 'protocol' &&
        failure.details.serverCode === code &&
        failure.details.httpStatus === status;
      const conflict = validCode('PROFILE_REVISION_CONFLICT', 409);
      const campusNotFound = validCode('CAMPUS_NOT_FOUND', 404);
      const expired = failure.kind === 'auth-expired';
      const uncertain =
        mode === 'save' &&
        !campusNotFound &&
        ['network', 'timeout', 'cancelled', 'protocol', 'http'].includes(
          failure.kind,
        );
      let message = friendlyError(failure);
      if (conflict)
        message =
          '资料已在其他页面或设备更新，请重新加载后再编辑；不会自动覆盖';
      else if (expired)
        message = '登录凭证已过期，请重新加载以刷新会话，再重新编辑保存';
      else if (uncertain)
        message = '保存结果尚未确认，请重新加载查看服务端状态后再编辑';
      else if (validCode('CAMPUS_UNAVAILABLE', 409))
        message = '该校园暂不可选择，请重新搜索其他校园';
      else if (campusNotFound) message = '该校园已不存在，请重新搜索';
      else if (validCode('BAD_REQUEST', 400))
        message = '填写内容未被接受，请检查后重试';
      this.update({
        needsReload: this.view.needsReload || conflict || uncertain || expired,
        status: conflict
          ? '存在更新冲突'
          : uncertain
            ? '保存结果待确认'
            : '操作未完成',
        error: message,
        requestId: failure.details.requestId ?? '',
      } as Partial<V>);
    } finally {
      if (this.current(generation)) {
        this.cancellation = undefined;
        this.update({ loading: false, saving: false } as Partial<V>);
      }
    }
  }
  cancelOperation(): void {
    if (this.disposed || (!this.view.loading && !this.view.saving)) return;
    const saving = this.view.saving;
    this.stop();
    this.update({
      loading: false,
      saving: false,
      needsReload: saving || this.view.needsReload,
      status: saving ? '保存结果待确认' : '已取消加载',
      error: saving ? '已停止等待；请求可能已保存，请重新加载确认' : '',
    } as Partial<V>);
  }
  /** Hidden pages retain neither another account's drafts nor pending render callbacks. */
  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.unsubscribe();
    this.resetPrivate();
    this.view = this.initial();
    this.render(this.view);
    this.disposed = true;
  }
  private current(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }
  private stop(): void {
    this.generation += 1;
    this.cancellation?.cancel();
    this.cancellation = undefined;
  }
}
