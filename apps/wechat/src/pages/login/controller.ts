import { currentSession } from '../../api/identity';
import { ClientError, clientError } from '../../api/errors';
import type { IdentityRuntime } from '../../auth/runtime';
import type { SessionInfo } from '../../auth/session-contract';
import { Cancellation } from '../../platform/contracts';

export interface LoginView {
  readonly configured: boolean;
  readonly busy: boolean;
  readonly signingIn: boolean;
  readonly hasLocalSession: boolean;
  readonly verified: boolean;
  readonly accountId: string;
  readonly sessionId: string;
  readonly expiresAt: string;
  readonly status: string;
  readonly error: string;
  readonly requestId: string;
}
export function initialLoginView(): LoginView {
  return {
    configured: false,
    busy: false,
    signingIn: false,
    hasLocalSession: false,
    verified: false,
    accountId: '',
    sessionId: '',
    expiresAt: '',
    status: '未登录',
    error: '',
    requestId: '',
  };
}
export function friendlyError(error: ClientError): string {
  const code = error.details.serverCode;
  if (code === 'AUTH_NOT_CONFIGURED')
    return '服务端尚未配置微信登录，请联系开发者完成配置';
  if (code === 'IDENTITY_PROVIDER_UNAVAILABLE')
    return '微信登录服务暂时不可用，请稍后重新登录';
  if (code === 'ACCOUNT_BLOCKED') return '当前账号不可登录，请联系支持人员';
  if (code === 'RATE_LIMITED') return '操作过于频繁，请稍后再试';
  if (code === 'LOGIN_REJECTED') return '本次微信登录凭证无效，请重新登录';
  const messages: Record<ClientError['kind'], string> = {
    configuration: '尚未配置已审核的 API 地址与微信登录环境',
    network: '网络连接失败；如刷新会话时中断，请重新登录',
    timeout: '操作超时；如刷新会话时中断，请重新登录',
    cancelled: '已取消本次操作',
    'stale-session': '登录状态已改变，请重新操作',
    'auth-required': '登录已失效，请重新登录',
    'auth-expired': '登录已过期，请重新登录',
    'phone-verification-required':
      '此操作需要手机号验证；当前构建尚未实现该功能',
    'content-audit-rejected': '内容未通过审核',
    forbidden: '当前账号没有此操作权限',
    storage:
      '设备登录存储不可用；本地凭证可能未能删除，请清理小程序缓存后重新登录',
    protocol: '服务返回的数据不符合约定，请稍后重新登录',
    business: '请求未被接受，请检查后重试',
    http: '服务暂时无法完成请求，请稍后再试',
  };
  return messages[error.kind];
}

/** View models never contain access tokens, refresh tokens, codes, or profile guesses. */
export class LoginController {
  private view = initialLoginView();
  private generation = 0;
  private disposed = false;
  private verifiedEpoch: number | undefined;
  private logoutPending = false;
  private cancellation: Cancellation | undefined;
  constructor(
    private readonly runtime: IdentityRuntime,
    private readonly render: (view: LoginView) => void,
  ) {
    const hasLocalSession = !!runtime.sessions.snapshot().credentials;
    this.update({
      configured: !!runtime.auth && !!runtime.api,
      hasLocalSession,
      status: hasLocalSession ? '已恢复本地登录，等待服务验证' : '未登录',
      ...(runtime.startupError
        ? { error: friendlyError(runtime.startupError) }
        : {}),
    });
  }
  /** A business page may have invalidated login while this page was hidden. */
  syncSession(): void {
    if (this.disposed || this.view.busy) return;
    const session = this.runtime.sessions.snapshot();
    const credentials = session.credentials;
    if (
      this.view.hasLocalSession !== !!credentials ||
      (this.view.verified &&
        (this.verifiedEpoch !== session.epoch ||
          this.view.accountId !== credentials?.accountId ||
          this.view.sessionId !== credentials?.sessionId))
    )
      this.showChangedSession();
    else if (this.view.verified && credentials)
      this.update({ expiresAt: new Date(credentials.expiresAt).toISOString() });
  }
  async login(): Promise<void> {
    if (this.disposed || this.view.busy) return;
    if (!this.runtime.auth || !this.runtime.api) {
      this.update({
        error: friendlyError(
          new ClientError('configuration', 'Not configured'),
        ),
      });
      return;
    }
    const generation = ++this.generation;
    const cancellation = new Cancellation();
    this.cancellation = cancellation;
    this.update({
      ...this.clearedIdentity(),
      busy: true,
      signingIn: true,
      hasLocalSession: false,
      status: '正在通过微信登录',
      error: '',
      requestId: '',
    });
    let epoch = this.runtime.sessions.snapshot().epoch;
    try {
      const pending = this.runtime.auth.login(cancellation);
      epoch = this.runtime.sessions.snapshot().epoch;
      await pending;
      if (!this.current(generation)) return;
      this.assertEpoch(epoch);
      this.update({
        hasLocalSession: true,
        signingIn: false,
        status: '正在验证会话',
      });
      const info = await this.runtime.api.request(currentSession, {
        cancellation,
      });
      if (this.current(generation)) this.showSession(info, epoch);
    } catch (error) {
      this.showFailure(generation, error, epoch);
    } finally {
      this.finish(generation);
    }
  }
  async checkSession(): Promise<void> {
    if (this.disposed || this.view.busy || !this.runtime.api) return;
    const generation = ++this.generation;
    const epoch = this.runtime.sessions.snapshot().epoch;
    const cancellation = new Cancellation();
    this.cancellation = cancellation;
    this.update({
      ...this.clearedIdentity(),
      busy: true,
      status: '正在验证会话',
      error: '',
      requestId: '',
    });
    try {
      const info = await this.runtime.api.request(currentSession, {
        cancellation,
      });
      if (this.current(generation)) this.showSession(info, epoch);
    } catch (error) {
      this.showFailure(generation, error, epoch);
    } finally {
      this.finish(generation);
    }
  }
  async logout(): Promise<void> {
    if (this.disposed || this.logoutPending) return;
    this.logoutPending = true;
    const generation = ++this.generation;
    this.cancellation?.cancel();
    this.cancellation = undefined;
    this.update({
      ...this.clearedIdentity(),
      busy: true,
      signingIn: false,
      hasLocalSession: false,
      status: '正在退出登录',
      error: '',
      requestId: '',
    });
    let epoch = this.runtime.sessions.snapshot().epoch;
    try {
      if (this.runtime.auth) {
        const pending = this.runtime.auth.logout();
        epoch = this.runtime.sessions.snapshot().epoch;
        await pending;
      } else {
        this.runtime.sessions.logout();
        epoch = this.runtime.sessions.snapshot().epoch;
      }
      if (this.current(generation)) {
        this.assertEpoch(epoch);
        this.update({ status: '已退出登录' });
      }
    } catch (error) {
      if (this.current(generation)) {
        if (this.runtime.sessions.snapshot().epoch !== epoch) {
          this.showChangedSession();
          return;
        }
        const failure = clientError(error);
        this.update({
          status: '已清除本次内存登录；退出确认未完成',
          error:
            failure.kind === 'storage'
              ? friendlyError(failure)
              : '服务端退出结果未确认，请勿将其视为已撤销服务端会话',
          requestId: failure.details.requestId ?? '',
        });
      }
    } finally {
      this.logoutPending = false;
      this.finish(generation);
    }
  }
  /** Closing the page cancels its work without undoing an already-established login. */
  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.cancellation?.cancel();
  }
  private current(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }
  private clearedIdentity(): Pick<
    LoginView,
    'verified' | 'accountId' | 'sessionId' | 'expiresAt'
  > {
    return { verified: false, accountId: '', sessionId: '', expiresAt: '' };
  }
  private assertEpoch(epoch: number): void {
    if (this.runtime.sessions.snapshot().epoch !== epoch)
      throw new ClientError('stale-session', 'The login session changed');
  }
  private showChangedSession(): void {
    const hasLocalSession = !!this.runtime.sessions.snapshot().credentials;
    this.update({
      ...this.clearedIdentity(),
      hasLocalSession,
      status: hasLocalSession
        ? '登录状态已改变，请验证当前会话'
        : '登录已清除，请重新登录',
      error: hasLocalSession
        ? '原操作已过期，请验证当前会话'
        : '原操作已结束，请重新登录',
      requestId: '',
    });
  }
  private showSession(info: SessionInfo, epoch: number): void {
    this.assertEpoch(epoch);
    const current = this.runtime.sessions.snapshot().credentials;
    if (
      !current ||
      info.accountId !== current.accountId ||
      info.sessionId !== current.sessionId
    ) {
      this.runtime.sessions.logoutIfCurrent(this.runtime.sessions.snapshot());
      throw new ClientError(
        'protocol',
        'Session identity does not match credentials',
      );
    }
    this.verifiedEpoch = epoch;
    this.update({
      verified: true,
      hasLocalSession: true,
      accountId: info.accountId,
      sessionId: info.sessionId,
      expiresAt: new Date(info.expiresAt).toISOString(),
      status: '会话有效',
      error: '',
    });
  }
  private showFailure(generation: number, error: unknown, epoch: number): void {
    if (!this.current(generation)) return;
    const failure = clientError(error);
    const current = this.runtime.sessions.snapshot();
    if (current.epoch !== epoch) {
      // The same failed save can clear memory while persisted data remains. Preserve
      // the recovery warning unless a newer live login has replaced this operation.
      if (failure.kind === 'storage' && !current.credentials) {
        this.update({
          ...this.clearedIdentity(),
          hasLocalSession: false,
          status: '本次内存登录已清除，设备存储需要处理',
          error: friendlyError(failure),
          requestId: '',
        });
        return;
      }
      this.showChangedSession();
      return;
    }
    if (
      failure.kind === 'auth-required' ||
      failure.kind === 'auth-expired' ||
      failure.details.serverCode === 'ACCOUNT_BLOCKED'
    ) {
      try {
        this.runtime.sessions.logoutIfCurrent(this.runtime.sessions.snapshot());
      } catch (storageError) {
        this.update({
          ...this.clearedIdentity(),
          hasLocalSession: false,
          status: '本次内存登录已清除，设备存储需要处理',
          error: friendlyError(clientError(storageError)),
          requestId: '',
        });
        return;
      }
    }
    const hasLocalSession = !!this.runtime.sessions.snapshot().credentials;
    this.update({
      ...this.clearedIdentity(),
      hasLocalSession,
      status: hasLocalSession ? '会话尚未验证' : '未登录',
      error: friendlyError(failure),
      requestId: failure.details.requestId ?? '',
    });
  }
  private finish(generation: number): void {
    if (!this.current(generation)) return;
    this.cancellation = undefined;
    this.update({
      busy: false,
      signingIn: false,
      hasLocalSession: !!this.runtime.sessions.snapshot().credentials,
    });
  }
  private update(patch: Partial<LoginView>): void {
    if (this.disposed) return;
    this.view = Object.freeze({ ...this.view, ...patch });
    this.render(this.view);
  }
}
