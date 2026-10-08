import { ClientError, clientError } from '../../api/errors';
import type { SessionTicket } from '../../auth/session';
import { cancellable } from '../../platform/cancellable';
import { Cancellation } from '../../platform/contracts';
import { communityError } from '../../community/controller';
import {
  decodeIdentityCampusReceipt,
  decodeIdentityCampusState,
  matchIdentityCampusReceipt,
  type IdentityCampusReceipt,
  type IdentityCampusState,
  type IdentityCampusSummary,
} from '../../identity-campus/contract';
import type { PendingIdentityCampus } from '../../identity-campus/pending';
import type { IdentityCampusRuntime } from '../../identity-campus/runtime';

export interface IdentityCampusView {
  readonly configured: boolean;
  readonly hasSession: boolean;
  readonly busy: boolean;
  readonly loaded: boolean;
  readonly frozen: boolean;
  readonly status: string;
  readonly error: string;
  readonly state: IdentityCampusState | null;
  readonly selectedId: string;
  readonly confirmation: IdentityCampusSummary | null;
  readonly eligibilityMessage: string;
  readonly receiptStatus: string;
}
export const initialIdentityCampusView = (): IdentityCampusView => ({
  configured: false,
  hasSession: false,
  busy: false,
  loaded: false,
  frozen: false,
  status: '身份校区尚未查询',
  error: '',
  state: null,
  selectedId: '',
  confirmation: null,
  eligibilityMessage: '',
  receiptStatus: '',
});
export function identityCampusStatus(state: IdentityCampusState): string {
  if (state.options.status === 'known' && state.options.items.length === 0)
    return '当前没有可选身份校区';
  switch (state.reason) {
    case 'current':
      return '已确认当前身份校区';
    case 'choice_required':
      return '请选择身份校区';
    case 'history_unknown':
      return `暂时无法确认当前身份校区记录${state.canSelect ? '；可根据当前有效认证重新选择' : ''}`;
    case 'inputs_changed':
      return '认证或校区信息已更新，请重新确认身份校区';
    case 'choice_no_longer_valid':
      return '原身份校区当前不再适用，请查询后重新选择';
    case 'affiliation_required':
      return '当前没有有效的所属机构认证；认证办理功能仍待接入';
    case 'affiliation_unavailable':
      return '暂时无法确认所属机构认证状态，请稍后重试';
    default:
      return '暂时无法确认可选校区，请稍后重试';
  }
}
function eligibility(state: IdentityCampusState): string {
  if (state.writeEligibility.phone === 'unverified')
    return '当前手机号验证未满足保存条件';
  if (state.writeEligibility.safety === 'restricted')
    return '当前账号暂不能更改身份校区';
  if (
    state.writeEligibility.phone === 'unavailable' ||
    state.writeEligibility.safety === 'unavailable'
  )
    return '暂时无法确认保存资格';
  if (!state.canSelect)
    return state.options.status === 'known' && !state.options.items.length
      ? '没有可确认的校区，请刷新或等待校区资料更新'
      : '暂时无法确认可选校区，请稍后重试';
  return '选中校区后仍需明确确认；这不会新增学校认证或管理权限';
}
function errorMessage(error: unknown): string {
  const failure = clientError(error);
  const messages: Record<string, string> = {
    IDENTITY_CAMPUS_REQUEST_NOT_FOUND:
      '暂未查到回执；原请求仍可能完成，请保留原请求并稍后查询或重试',
    IDENTITY_CAMPUS_REQUEST_CONFLICT:
      '此编号与原身份校区请求不一致，请保留原记录并查询结果',
    IDENTITY_CAMPUS_REVISION_CONFLICT:
      '当前依据已更新，请刷新后重新确认身份校区',
    IDENTITY_CAMPUS_NOT_ELIGIBLE: '原选择当前不可用，请先确认原请求结果',
    IDENTITY_CAMPUS_UNAVAILABLE: '暂时无法确认可选校区，请稍后重试',
    PHONE_VERIFICATION_REQUIRED: '当前手机号验证未满足保存条件',
    SAFETY_ACTION_RESTRICTED: '当前账号暂不能更改身份校区',
    SAFETY_UNAVAILABLE: '暂时无法确认保存资格',
  };
  return (
    (failure.kind !== 'protocol' &&
      messages[failure.details.serverCode ?? '']) ||
    communityError(failure)
  );
}
/** No cached authority and no send continuation: each confirmation owns one immutable account-bound intent. */
export class IdentityCampusController {
  private view = initialIdentityCampusView();
  private owner: SessionTicket;
  private generation = 0;
  private disposed = false;
  private cancellation: Cancellation | undefined;
  private pending: PendingIdentityCampus | null = null;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeVisibility: () => void;
  constructor(
    private readonly runtime: IdentityCampusRuntime,
    private readonly render: (view: IdentityCampusView) => void,
  ) {
    this.owner = runtime.sessions.snapshot();
    this.unsubscribe = runtime.sessions.subscribe(() => {
      const current = runtime.sessions.snapshot();
      if (
        current.epoch !== this.owner.epoch ||
        current.credentials?.accountId !== this.owner.credentials?.accountId
      ) {
        this.owner = current;
        this.clear('登录状态已改变，请重新查询');
      }
    });
    this.unsubscribeVisibility = runtime.privateViews.subscribe(() =>
      this.dispose(),
    );
    this.update({
      configured: !!runtime.gateway,
      hasSession: !!this.owner.credentials,
    });
  }
  private update(patch: Partial<IdentityCampusView>): void {
    if (this.disposed) return;
    this.view = Object.freeze({ ...this.view, ...patch });
    this.render(this.view);
  }
  private stop(): void {
    this.generation += 1;
    this.cancellation?.cancel();
    this.cancellation = undefined;
  }
  private clear(status: string): void {
    this.stop();
    this.pending = null;
    this.update({
      ...initialIdentityCampusView(),
      configured: !!this.runtime.gateway,
      hasSession: !!this.owner.credentials,
      status,
    });
  }
  private current(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }
  private available(): boolean {
    if (this.disposed) return false;
    if (!this.runtime.gateway || !this.owner.credentials) {
      this.update({
        error: !this.runtime.gateway
          ? '当前构建尚未配置登录与 API 环境'
          : '请先登录，再查询自己的身份校区',
      });
      return false;
    }
    this.runtime.sessions.assertCurrent(this.owner);
    return true;
  }
  private showPending(attempt: PendingIdentityCampus): void {
    this.pending = attempt;
    this.update({
      frozen: true,
      loaded: false,
      state: null,
      selectedId: '',
      confirmation: null,
      eligibilityMessage: '',
      status: '原身份校区请求结果待确认，请查询或重试完全相同的请求',
    });
  }
  private async run<T>(
    work: (cancel: Cancellation) => Promise<T>,
    apply: (value: T) => void,
    onError?: (error: ClientError) => void,
  ): Promise<void> {
    this.stop();
    const generation = this.generation,
      owner = this.owner,
      cancel = new Cancellation();
    this.cancellation = cancel;
    let sent = this.runtime.sessions.snapshot();
    this.update({ busy: true, error: '' });
    try {
      const result = await cancellable(
        Promise.resolve().then(() => {
          this.runtime.sessions.assertCurrent(owner);
          if (cancel.isCancelled)
            throw new ClientError('cancelled', 'Cancelled before dispatch');
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
      if (
        failure.kind === 'auth-required' ||
        (failure.kind === 'forbidden' &&
          failure.details.httpStatus === 403 &&
          failure.details.serverCode === 'ACCOUNT_BLOCKED')
      ) {
        this.clear('请重新验证登录，原请求仍保留在原账号下');
        try {
          this.runtime.sessions.logoutIfCurrent(sent);
        } catch {
          /* Never erase a replacement credential. */
        }
        this.update({ error: errorMessage(failure) });
        return;
      }
      this.update({
        error: errorMessage(failure),
        status: this.view.frozen
          ? '原身份校区请求仍待确认'
          : '身份校区状态未能确认',
      });
      try {
        onError?.(failure);
      } catch (storageError) {
        this.update({ frozen: true, error: errorMessage(storageError) });
      }
    } finally {
      if (this.current(generation)) {
        this.cancellation = undefined;
        this.update({ busy: false });
      }
    }
  }
  async load(receipt?: IdentityCampusReceipt, notice = ''): Promise<void> {
    if (this.disposed || this.view.busy) return;
    this.clear('正在查询当前身份校区');
    if (notice) this.update({ receiptStatus: notice });
    if (receipt)
      this.update({
        receiptStatus:
          '原请求已完成，正在重新查询当前状态；回执不代表当前校区仍有效',
      });
    if (!this.available()) return;
    try {
      const pending = this.runtime.pending.load(
        this.owner.credentials!.accountId,
      );
      if (pending) {
        this.showPending(pending);
        return;
      }
    } catch (error) {
      this.update({
        frozen: true,
        error: errorMessage(error),
        status: '无法读取原身份校区请求，禁止发送新请求',
      });
      return;
    }
    await this.run(
      (cancel) => this.runtime.gateway!.state(cancel),
      (raw) => {
        const state = decodeIdentityCampusState(raw);
        // A different page may have frozen an attempt during this read.
        const pending = this.runtime.pending.load(
          this.owner.credentials!.accountId,
        );
        if (pending) {
          this.showPending(pending);
          return;
        }
        this.update({
          loaded: true,
          state,
          selectedId: state.selectedCampus?.id ?? '',
          confirmation: null,
          status: identityCampusStatus(state),
          eligibilityMessage: eligibility(state),
          receiptStatus: receipt
            ? state.selection !== 'valid'
              ? '原请求已完成，但当前身份校区有效性尚不能确认，请以本次状态为准'
              : state.selectedCampus?.id !== receipt.campusId
                ? '原请求已完成，当前身份校区已被之后的选择替代'
                : '原请求已完成；本次查询另行确认了当前身份校区。返回草稿后请再次点击发送'
            : notice,
        });
      },
    );
  }
  choose(campusId: string): void {
    if (
      this.disposed ||
      this.view.busy ||
      this.view.frozen ||
      !this.view.state?.canSelect ||
      !this.view.state.options.items.some((item) => item.id === campusId)
    )
      return;
    this.update({ selectedId: campusId, confirmation: null, error: '' });
  }
  requestConfirmation(): void {
    if (
      this.disposed ||
      this.view.busy ||
      this.view.frozen ||
      !this.view.state?.canSelect
    )
      return;
    const chosen = this.view.state.options.items.find(
      (item) => item.id === this.view.selectedId,
    );
    if (chosen) this.update({ confirmation: chosen });
  }
  dismissConfirmation(): void {
    if (!this.view.busy && !this.disposed) this.update({ confirmation: null });
  }
  async confirm(): Promise<void> {
    if (
      this.view.busy ||
      this.view.frozen ||
      !this.view.confirmation ||
      !this.view.state?.canSelect ||
      !this.available()
    )
      return;
    const campusId = this.view.confirmation.id,
      expectedStateRevision = this.view.state.expectedStateRevision!,
      accountId = this.owner.credentials!.accountId,
      owner = this.owner;
    let followUp: IdentityCampusReceipt | 'conflict' | undefined;
    let followUpGeneration = -1;
    try {
      const old = this.runtime.pending.load(accountId);
      if (old) {
        this.showPending(old);
        return;
      }
    } catch (error) {
      this.update({ frozen: true, error: errorMessage(error) });
      return;
    }
    await this.run(
      async (cancel) => {
        const requestId = await this.runtime.newRequestId();
        this.runtime.sessions.assertCurrent(owner);
        if (cancel.isCancelled)
          throw new ClientError('cancelled', 'Cancelled before persistence');
        const pending = this.runtime.pending.freeze({
          version: 1,
          accountId,
          requestId,
          campusId,
          expectedStateRevision,
        });
        this.showPending(pending);
        return this.dispatch(pending, cancel);
      },
      (receipt) => {
        followUp = this.settle(receipt);
        followUpGeneration = this.generation;
      },
      (failure) => {
        if (this.pending && this.releaseConflict(this.pending, failure)) {
          followUp = 'conflict';
          followUpGeneration = this.generation;
        }
      },
    );
    if (followUp && this.current(followUpGeneration) && this.owner === owner) {
      await this.load(
        followUp === 'conflict' ? undefined : followUp,
        followUp === 'conflict'
          ? '原确认依据已变化，未保存；请依据刷新后的校区再次明确确认'
          : '',
      );
    }
  }
  private dispatch(
    attempt: PendingIdentityCampus,
    cancel: Cancellation,
  ): Promise<IdentityCampusReceipt> {
    this.runtime.sessions.assertCurrent(this.owner);
    if (attempt.accountId !== this.owner.credentials?.accountId)
      throw new ClientError('stale-session', 'Account changed');
    if (cancel.isCancelled)
      throw new ClientError('cancelled', 'Cancelled before dispatch');
    this.runtime.pending.assertOriginal(attempt);
    this.runtime.onSelectionChanged?.(attempt.accountId);
    return this.runtime.gateway!.select(
      {
        requestId: attempt.requestId,
        campusId: attempt.campusId,
        expectedStateRevision: attempt.expectedStateRevision,
      },
      cancel,
    );
  }
  private settle(raw: IdentityCampusReceipt): IdentityCampusReceipt {
    const receipt = decodeIdentityCampusReceipt(raw);
    if (
      !this.pending ||
      this.pending.accountId !== this.owner.credentials?.accountId
    )
      throw new ClientError(
        'protocol',
        'Missing original identity campus intent',
      );
    matchIdentityCampusReceipt(this.pending, receipt);
    this.runtime.onSelectionChanged?.(this.pending.accountId);
    this.runtime.pending.settle(this.pending, receipt);
    this.pending = null;
    this.update({ frozen: false, confirmation: null, state: null });
    return receipt;
  }
  private releaseConflict(
    attempt: PendingIdentityCampus,
    failure: ClientError,
  ): boolean {
    if (
      failure.kind === 'protocol' ||
      failure.details.httpStatus !== 409 ||
      failure.details.serverCode !== 'IDENTITY_CAMPUS_REVISION_CONFLICT'
    )
      return false;
    this.runtime.pending.rejectRevision(attempt, failure);
    this.pending = null;
    this.update({
      frozen: false,
      confirmation: null,
      selectedId: '',
      state: null,
      loaded: false,
    });
    return true;
  }
  async recover(retry = false): Promise<void> {
    if (this.view.busy || !this.available()) return;
    const owner = this.owner;
    let followUp: IdentityCampusReceipt | 'conflict' | undefined;
    let followUpGeneration = -1;
    try {
      const pending = this.runtime.pending.load(
        this.owner.credentials!.accountId,
      );
      if (!pending) {
        this.update({ error: '未找到原身份校区请求，请重新查询' });
        return;
      }
      this.showPending(pending);
      await this.run(
        (cancel) =>
          retry
            ? this.dispatch(pending, cancel)
            : this.runtime.gateway!.receipt(pending.requestId, cancel),
        (receipt) => {
          followUp = this.settle(receipt);
          followUpGeneration = this.generation;
        },
        (failure) => {
          if (retry && this.releaseConflict(pending, failure)) {
            followUp = 'conflict';
            followUpGeneration = this.generation;
          }
        },
      );
    } catch (error) {
      if (!this.disposed && this.owner === owner)
        this.update({ frozen: true, error: errorMessage(error) });
    }
    if (followUp && this.current(followUpGeneration) && this.owner === owner) {
      await this.load(
        followUp === 'conflict' ? undefined : followUp,
        followUp === 'conflict'
          ? '原确认依据已变化，未保存；请依据刷新后的校区再次明确确认'
          : '',
      );
    }
  }
  cancel(): void {
    if (this.disposed) return;
    this.clear('已停止等待结果；已发送的选择仍可能完成，未撤销');
    if (!this.available()) return;
    try {
      const pending = this.runtime.pending.load(
        this.owner.credentials!.accountId,
      );
      if (pending) {
        this.showPending(pending);
        this.update({ status: '已停止等待结果；原请求仍保留，请查询回执' });
      }
    } catch (error) {
      this.update({ frozen: true, error: errorMessage(error) });
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.clear('身份校区状态已清除');
    this.unsubscribe();
    this.unsubscribeVisibility();
    this.disposed = true;
  }
}
