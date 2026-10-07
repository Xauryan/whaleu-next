import { ClientError, clientError } from '../api/errors';
import type { SessionTicket } from '../auth/session';
import { cancellable } from '../platform/cancellable';
import { Cancellation } from '../platform/contracts';
import type { CommunityRuntime } from './runtime';
export interface CommunityView {
  readonly hasSession: boolean;
  readonly configured: boolean;
  readonly busy: boolean;
  readonly error: string;
  readonly status: string;
}
export const initialCommunityView = (): CommunityView => ({
  hasSession: false,
  configured: false,
  busy: false,
  error: '',
  status: '等待加载',
});
export const reasonMessage = (code: string | null): string =>
  ({
    COMMUNITY_UNAVAILABLE: '社区授权与安全服务尚未就绪，请稍后重试',
    COMMUNITY_SCOPE_UNAVAILABLE: '此社区地区暂不可用，请重新选择校园',
    PHONE_VERIFICATION_REQUIRED: '需要已验证的手机号；当前版本尚未接入验证流程',
    STUDENT_VERIFICATION_REQUIRED:
      '此操作需要有效的学生认证；当前版本尚未接入认证流程',
    IDENTITY_CAMPUS_REQUIRED: '需要已认证的身份校区；浏览校区不能代替身份认证',
    COMMUNITY_ACTION_RESTRICTED: '当前账号暂不能执行此操作',
    AUTHOR_MODE_NOT_ALLOWED: '所选身份暂不可用，请自行确认身份选择后再发布',
    COMMENTS_DISABLED: '此帖暂不开放普通评论',
    CONTENT_REJECTED: '内容未通过安全审核，请修改后再提交',
    CONTENT_REVIEW_UNAVAILABLE: '内容审核服务尚未就绪，暂不能发布',
    MEDIA_NOT_READY: '图片尚未完成上传与审核，暂不能发布',
    MEDIA_UNAVAILABLE: '图片上传与审核服务尚未接入',
    POST_NOT_FOUND: '帖子不存在或当前不可查看',
    COMMENT_NOT_FOUND: '评论不存在或当前不可查看',
    POST_DELETED: '帖子已删除',
    REQUEST_CONFLICT: '此发布编号与原内容不一致，请保留原请求并查询结果',
    REQUEST_NOT_FOUND: '暂未查到回执；原请求仍可能完成，请稍后查询或重试原请求',
    ACCOUNT_BLOCKED: '账号访问受限，请重新验证登录',
    CAMPUS_NOT_FOUND: '此校园不存在，请重新选择',
  })[code ?? ''] ?? '操作暂不可用，请稍后重试';
export function communityError(error: unknown): string {
  const failure = clientError(error);
  if (failure.kind !== 'protocol' && failure.details.serverCode)
    return reasonMessage(failure.details.serverCode);
  switch (failure.kind) {
    case 'auth-required':
    case 'auth-expired':
      return '请先登录或重新验证登录';
    case 'storage':
      return '本地保存失败，已停止发送；请保留当前数据后重试';
    case 'configuration':
      return '当前构建尚未配置社区 API 或安全请求编号';
    case 'protocol':
      return '服务返回格式异常，未确认操作结果';
    case 'timeout':
    case 'network':
      return '网络暂不可用，请重试';
    case 'cancelled':
      return '已停止等待，已发送的操作仍可能完成';
    default:
      return '操作未完成，请重试';
  }
}
/** Owns every callback by account, login epoch and request generation, including same-account re-login. */
export abstract class CommunityController<V extends CommunityView> {
  protected view: V;
  protected owner: SessionTicket;
  private generation = 0;
  private stopped = false;
  private cancellation: Cancellation | undefined;
  private readonly unsubscribe: () => void;
  constructor(
    protected readonly runtime: CommunityRuntime,
    private readonly initial: () => V,
    private readonly render: (view: V) => void,
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
        this.owner = current;
        this.resetPrivate();
        this.view = initial();
        this.update({
          hasSession: !!current.credentials,
          configured: !!runtime.gateway,
          status: '登录状态已改变，请重新加载',
          error: '已清除当前页面；原账号待确认的发布仍保存在该账号下',
        } as Partial<V>);
      }
    });
    this.update({
      configured: !!runtime.gateway,
      hasSession: !!this.owner.credentials,
    } as Partial<V>);
  }
  protected resetPrivate(): void {}
  protected update(patch: Partial<V>): void {
    if (this.stopped) return;
    this.view = Object.freeze({ ...this.view, ...patch });
    this.render(this.view);
  }
  protected accountId(): string | null {
    try {
      this.runtime.sessions.assertCurrent(this.owner);
      return this.owner.credentials?.accountId ?? null;
    } catch {
      return null;
    }
  }
  protected available(requireLogin = true): boolean {
    if (this.stopped) return false;
    if (!this.runtime.gateway || (requireLogin && !this.accountId())) {
      this.update({
        error: !this.runtime.gateway
          ? '当前构建尚未配置社区 API 环境'
          : '请先登录后再使用此功能',
        status: '暂不可用',
      } as Partial<V>);
      return false;
    }
    return true;
  }
  protected async run<T>(
    work: (cancel: Cancellation) => Promise<T>,
    apply: (result: T) => void,
    onError?: (error: ClientError) => void,
  ): Promise<void> {
    if (this.stopped) return;
    this.stop();
    const generation = this.generation,
      owner = this.owner,
      cancel = new Cancellation();
    this.cancellation = cancel;
    let sent = this.runtime.sessions.snapshot();
    this.update({ busy: true, error: '' } as Partial<V>);
    try {
      const result = await cancellable(
        Promise.resolve().then(() => {
          this.runtime.sessions.assertCurrent(owner);
          if (cancel.isCancelled)
            throw new ClientError('cancelled', 'Cancelled');
          sent = this.runtime.sessions.snapshot();
          return work(cancel);
        }),
        cancel,
      );
      if (!this.current(generation)) return;
      this.runtime.sessions.assertCurrent(owner);
      apply(result);
    } catch (error) {
      if (!this.current(generation)) return;
      const failure = clientError(error);
      const terminal =
        failure.kind === 'auth-required' ||
        (failure.kind === 'forbidden' &&
          failure.details.serverCode === 'ACCOUNT_BLOCKED' &&
          failure.details.httpStatus === 403);
      if (terminal) {
        this.resetPrivate();
        this.view = this.initial();
        try {
          this.runtime.sessions.logoutIfCurrent(sent);
        } catch {
          /* A replacement login must survive. */
        }
        this.update({
          hasSession: !!this.runtime.sessions.snapshot().credentials,
          configured: !!this.runtime.gateway,
          busy: false,
          status: '请重新验证登录',
          error: communityError(failure),
        } as Partial<V>);
        return;
      }
      this.update({
        error: communityError(failure),
        status: '操作未完成',
      } as Partial<V>);
      onError?.(failure);
    } finally {
      if (this.current(generation)) {
        this.cancellation = undefined;
        this.update({ busy: false } as Partial<V>);
      }
    }
  }
  cancel(): void {
    this.stop();
    this.update({
      busy: false,
      status: '已停止等待',
      error: '已发送的操作仍可能完成；发布请查询原回执',
    } as Partial<V>);
  }
  dispose(): void {
    if (this.stopped) return;
    this.stop();
    this.unsubscribe();
    this.resetPrivate();
    this.view = this.initial();
    this.render(this.view);
    this.stopped = true;
  }
  protected stop(): void {
    this.generation += 1;
    this.cancellation?.cancel();
    this.cancellation = undefined;
  }
  private current(generation: number): boolean {
    return !this.stopped && generation === this.generation;
  }
}
