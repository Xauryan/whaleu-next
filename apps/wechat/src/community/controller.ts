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
    COMMUNITY_UNAVAILABLE: '此操作所需的服务端状态暂不能确认，请稍后重试',
    COMMUNITY_SCOPE_UNAVAILABLE:
      '当前社区范围不适用于此操作；切换浏览校园不会授予发布权限',
    PHONE_VERIFICATION_REQUIRED: '需要已验证的手机号；当前版本尚未接入验证流程',
    STUDENT_VERIFICATION_REQUIRED:
      '此操作需要有效的所属机构认证，不要求学号认证；认证办理尚未开放',
    IDENTITY_CAMPUS_REQUIRED:
      '需要确认身份校区；请进入身份校区页面明确选择，浏览校区不能代替',
    COMMUNITY_ACTION_RESTRICTED: '当前账号暂不能执行此操作',
    AUTHOR_MODE_NOT_ALLOWED: '所选身份暂不可用，请自行确认身份选择后再发布',
    COMMENTS_DISABLED: '此帖暂不开放普通评论',
    CONTENT_REJECTED: '内容未通过安全审核，请修改后再提交',
    CONTENT_REVIEW_UNAVAILABLE:
      '尚不能确认此内容的有效审核，暂不能发布；当前版本尚未开放审核提交流程',
    MEDIA_NOT_READY: '图片尚未完成上传与审核，暂不能发布',
    MEDIA_UNAVAILABLE: '图片上传与审核服务尚未接入',
    NOTICE_NOT_FOUND: '此更新不存在或不属于当前账号，请刷新列表',
    POST_NOT_FOUND: '帖子不存在或当前不可查看',
    POST_BLOCKED_BY_YOU: '你已屏蔽此用户，可在屏蔽列表中解除',
    BLOCK_TARGET_NOT_ALLOWED: '仅可屏蔽当前可查看的非本人公开身份内容',
    BLOCK_NOT_FOUND: '此屏蔽关系不存在或不属于当前账号',
    BLOCK_REVISION_CONFLICT: '屏蔽状态已变化，请刷新后再操作',
    SAFETY_UNAVAILABLE: '安全设置服务尚未就绪，请稍后重试',
    SAFETY_ACTION_RESTRICTED: '当前账号暂不能修改安全设置',
    SYSTEM_NOTICES_UNAVAILABLE: '系统通知服务尚未就绪，请稍后重试',
    REPORT_TARGET_UNAVAILABLE: '此内容当前不可查看，进度不可用',
    REPORT_SELF_NOT_ALLOWED: '不能举报自己的帖子、评论或回复',
    REPORT_ALREADY_REPORTED: '你已举报过此内容，每个账号只能举报一次',
    REPORTING_CLOSED: '此帖已经进入过陪审，不再接受新举报',
    REPORT_SCOPE_UNAVAILABLE: '当前管理权限的内容范围尚不能确认，举报暂不可用',
    AFFILIATION_VERIFICATION_REQUIRED:
      '此操作需要有效的所属机构认证，不要求学号认证',
    VERIFICATION_UNAVAILABLE: '手机号或所属机构认证状态暂不可用，请稍后重试',
    AUTHORIZATION_UNAVAILABLE: '当前授权状态暂不可用，请稍后重试',
    JURY_NOT_FOUND: '此陪审当前不可用，请重新查询进度',
    JURY_INELIGIBLE: '帖子作者和已举报此帖的人不能参与陪审',
    JURY_ALREADY_VOTED: '你已提交陪审意见，不能修改或撤回',
    JURY_CLOSED: '陪审已截止或结束，不能再提交意见',
    RATE_LIMITED: '操作过于频繁，请稍后重试',
    DISCUSSION_RESTART_REQUIRED: '讨论排序已变化，请重新加载，旧分页已清除',
    REPLY_NOT_FOUND: '回复不存在或当前不可查看',
    COMMENT_PIN_CONFLICT: '此帖已有置顶评论，请先取消原置顶后再选择另一条',
    COMMENT_PIN_FORBIDDEN: '只有帖子作者可以置顶根评论',
    COMMENT_NOT_FOUND: '评论不存在或当前不可查看',
    POST_DELETED: '帖子已删除',
    AUTHENTICATION_REQUIRED: '请先登录后参与',
    FORMATION_NOT_FOUND: '组队不存在或当前不可查看',
    FORMATION_FULL: '组队已满员',
    FORMATION_ALREADY_JOINED: '你已加入，每个账号仅占一个席位',
    FORMATION_UNAVAILABLE: '此组队暂不可加入或查看联系方式',
    FORMATION_MEMBERSHIP_REQUIRED: '仅当前有权查看本帖的组队成员可查看联系方式',
    FORMATION_MEMBERSHIP_NOT_FOUND:
      '暂未查到成员记录；原请求仍可能完成，请查询原回执',
    POLL_NOT_FOUND: '投票不存在或当前不可查看',
    POLL_EXPIRED: '投票已结束，不能再提交',
    POLL_ALREADY_VOTED: '你已投票，每人仅有一次且不能修改或撤回',
    POLL_OPTIONS_INVALID: '投票选项已失效，请重新加载',
    BALLOT_NOT_FOUND: '暂未查到你的投票；这不代表原请求不能完成',
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
  private readonly unsubscribeRootHide: () => void;
  private readonly unsubscribeSafety: () => void;
  constructor(
    protected readonly runtime: CommunityRuntime,
    private readonly initial: () => V,
    private readonly render: (view: V) => void,
  ) {
    this.unsubscribeRootHide =
      runtime.privateViews?.subscribe((accountId) => {
        // Named-block changes use their own scoped event, never the root-hide disposal path.
        if (accountId === undefined) this.dispose();
      }) ?? (() => undefined);
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
    this.unsubscribeSafety =
      runtime.safetyChanges?.subscribe((accountId) => {
        if (this.stopped || this.accountId() !== accountId) return;
        const previous = this.view;
        this.stop();
        this.view = initial();
        try {
          this.resetPrivate();
        } finally {
          this.update({
            hasSession: !!this.owner.credentials,
            configured: !!runtime.gateway,
            status: '安全状态已更新，正在重新核验内容',
          } as Partial<V>);
        }
        this.onSafetyInvalidated(previous);
      }) ?? (() => undefined);
    this.update({
      configured: !!runtime.gateway,
      hasSession: !!this.owner.credentials,
    } as Partial<V>);
  }
  protected resetPrivate(): void {}
  /** Read owners may reload after all of this controller's previous callbacks were invalidated. */
  protected onSafetyInvalidated(_previous: V): void {}
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
    this.unsubscribeRootHide();
    this.unsubscribeSafety();
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
