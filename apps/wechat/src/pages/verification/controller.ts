import { ClientError, clientError } from '../../api/errors';
import type { SessionStore, SessionTicket } from '../../auth/session';
import type { PrivateViewLifecycle } from '../../identity-privacy/overlay';
import { cancellable } from '../../platform/cancellable';
import { Cancellation } from '../../platform/contracts';
import {
  decodeVerificationSummary,
  type ApplicationStatus,
  type FactStatus,
  type VerificationSummary,
} from '../../verification/contract';
import type { VerificationGateway } from '../../verification/gateway';
import { friendlyError } from '../login/controller';

export interface VerificationRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}
export interface VerificationView {
  readonly configured: boolean;
  readonly hasSession: boolean;
  readonly loading: boolean;
  readonly loaded: boolean;
  readonly status: string;
  readonly error: string;
  readonly requestId: string;
  readonly rows: readonly VerificationRow[];
}
export const initialVerificationView = (): VerificationView => ({
  configured: false,
  hasSession: false,
  loading: false,
  loaded: false,
  status: '认证状态尚未查询',
  error: '',
  requestId: '',
  rows: [],
});
const factLabels: Record<FactStatus, string> = {
  verified: '已验证',
  unverified: '未验证',
  unavailable: '状态未知或暂不可用',
  expired: '已过期',
  revoked: '已撤销',
};
const factDetails: Record<FactStatus, string> = {
  verified: '服务端确认存在当前有效的验证记录',
  unverified: '服务端确认当前没有有效的验证记录',
  unavailable: '尚无可信的当前记录，或暂时无法确认；这不等于未验证',
  expired: '原验证已过有效期，不代表当前仍有效',
  revoked: '原验证已被撤销，不代表当前仍有效',
};
const applicationLabels: Record<ApplicationStatus, string> = {
  none: '暂无待处理申请',
  pending: '等待审核',
  rejected: '申请未通过',
  unavailable: '申请状态未知或暂不可用',
};
const applicationDetails: Record<ApplicationStatus, string> = {
  none: '服务端确认当前没有待处理申请；不据此判断历史申请或认证结果',
  pending: '提交或等待审核不代表已经通过认证',
  rejected: '本页仅展示状态，重新申请功能尚未开放',
  unavailable: '尚无法确认申请记录，不能据此判断审核结果',
};
function rows(summary: VerificationSummary): readonly VerificationRow[] {
  const entries = [
    ['affiliation', '学生归属认证'],
    ['studentNumber', '学号验证'],
    ['phone', '手机号归属验证'],
  ] as const;
  return Object.freeze([
    ...entries.map(([key, label]) => {
      const status = summary[key].status;
      let detail = factDetails[status];
      if (
        key === 'studentNumber' &&
        summary.affiliation.status === 'verified' &&
        status === 'unverified'
      )
        detail = '学生归属已验证，但未建立有效的学号验证；两项状态分别确认';
      if (key === 'phone') detail += '；手机号与学生身份分别验证';
      return Object.freeze({ key, label, value: factLabels[status], detail });
    }),
    Object.freeze({
      key: 'application',
      label: '认证申请',
      value: applicationLabels[summary.application.status],
      detail: applicationDetails[summary.application.status],
    }),
  ]);
}
/** Each read is bound to the account/login epoch; no private values or status cache are persisted. */
export class VerificationController {
  private view = initialVerificationView();
  private owner: SessionTicket;
  private generation = 0;
  private disposed = false;
  private suspended = false;
  private cancellation: Cancellation | undefined;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeVisibility: () => void;
  constructor(
    private readonly sessions: SessionStore,
    private readonly gateway: VerificationGateway | undefined,
    private readonly render: (view: VerificationView) => void,
    lifecycle: PrivateViewLifecycle,
  ) {
    this.owner = sessions.snapshot();
    this.unsubscribe = sessions.subscribe(() => {
      const current = sessions.snapshot();
      if (
        current.epoch !== this.owner.epoch ||
        current.credentials?.accountId !== this.owner.credentials?.accountId
      ) {
        this.owner = current;
        this.clear('登录状态已改变，请重新查询');
      }
    });
    this.unsubscribeVisibility = lifecycle.subscribe(() => {
      this.suspended = true;
      this.clear('已离开前台，认证状态已清除');
    });
    this.update({
      configured: !!gateway,
      hasSession: !!this.owner.credentials,
    });
  }
  async load(): Promise<void> {
    // One active read per page. Repeated taps cannot send duplicate requests.
    if (this.disposed || this.suspended || this.view.loading) return;
    this.clear('正在查询认证状态');
    if (!this.gateway || !this.owner.credentials) {
      this.update({
        status: '尚未查询认证状态',
        error: !this.gateway
          ? '当前构建尚未配置登录与 API 环境'
          : '请先登录，再查询自己的认证状态',
      });
      return;
    }
    const generation = this.generation;
    const owner = this.owner;
    let sent = this.sessions.snapshot();
    const cancellation = new Cancellation();
    this.cancellation = cancellation;
    this.update({ loading: true });
    try {
      const pending = Promise.resolve().then(() => {
        this.sessions.assertCurrent(owner);
        if (cancellation.isCancelled)
          throw new ClientError('cancelled', 'Cancelled before dispatch');
        sent = this.sessions.snapshot();
        return this.gateway!.summary(cancellation);
      });
      const result = await cancellable(pending, cancellation);
      if (!this.current(generation)) return;
      this.sessions.assertCurrent(owner);
      // Recheck the boundary even for a future alternate gateway implementation.
      const summary = decodeVerificationSummary(result);
      this.update({
        loaded: true,
        rows: rows(summary),
        status: '已取得本次查询结果',
      });
    } catch (error) {
      if (!this.current(generation)) return;
      const failure = clientError(error);
      let message = friendlyError(failure);
      if (
        failure.kind === 'auth-required' ||
        (failure.kind === 'forbidden' &&
          failure.details.httpStatus === 403 &&
          failure.details.serverCode === 'ACCOUNT_BLOCKED')
      ) {
        if (this.sessions.snapshot().revision === sent.revision) {
          try {
            this.sessions.logoutIfCurrent(sent);
          } catch (storageError) {
            message = friendlyError(clientError(storageError));
          }
        } else {
          message = '登录凭证已更新，请重新查询以验证当前会话';
        }
      }
      this.update({
        hasSession: !!this.sessions.snapshot().credentials,
        loaded: false,
        loading: false,
        rows: [],
        status: '认证状态未能确认',
        error: message,
        requestId: failure.details.requestId ?? '',
      });
    } finally {
      if (this.current(generation)) {
        this.cancellation = undefined;
        this.update({ loading: false });
      }
    }
  }
  cancel(): void {
    if (this.disposed || !this.view.loading) return;
    this.clear('已取消查询，认证状态尚未确认');
  }
  dispose(): void {
    if (this.disposed) return;
    this.clear('认证状态已清除');
    this.unsubscribe();
    this.unsubscribeVisibility();
    this.disposed = true;
  }
  private clear(status: string): void {
    this.generation += 1;
    this.cancellation?.cancel();
    this.cancellation = undefined;
    this.update({
      ...initialVerificationView(),
      configured: !!this.gateway,
      hasSession: !!this.owner.credentials,
      status,
    });
  }
  private current(generation: number): boolean {
    return !this.disposed && !this.suspended && generation === this.generation;
  }
  private update(patch: Partial<VerificationView>): void {
    if (this.disposed) return;
    this.view = Object.freeze({ ...this.view, ...patch });
    this.render(this.view);
  }
}
