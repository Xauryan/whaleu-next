import { ClientError, clientError } from '../api/errors';
import type { SessionStore } from '../auth/session';
import { Cancellation } from '../platform/contracts';
import type { Campus } from '../profile/contract';
import type { ProfileGateway } from '../profile/gateway';
import type { SchoolConfigurationGateway } from '../school-configuration/gateway';
import {
  decodePostingPolicyInput,
  decodePostingPolicyRecovery,
  decodePostingPolicyView,
  invalidPostingPolicy,
  postingPolicyCategories,
  postingPolicyLabels,
  postingPolicyUuid,
} from './contract';
import type {
  PostingPolicyCategory,
  PostingPolicyInput,
  PostingPolicyView,
  PostingPolicyRecovery,
} from './contract';
import type { SchoolPostingPolicyGateway } from './gateway';
import {
  PostingPolicyJournal,
  type PendingPostingPolicyCommand,
} from './pending';

interface PostingPolicyForm {
  readonly relatedSyncEnabled: boolean;
  readonly unverifiedPostEnabled: boolean;
  readonly unverifiedCommentEnabled: boolean;
  readonly unverifiedCategories: readonly PostingPolicyCategory[];
  readonly expiryKind: 'policy_exempt' | 'at';
  readonly validUntil: string;
}
export interface SchoolPostingPolicyPageView {
  readonly busy: boolean;
  readonly loaded: boolean;
  readonly management: 'none' | 'fixed' | 'global';
  readonly regionId: string;
  readonly regionName: string;
  readonly revision: number;
  readonly sourceState: PostingPolicyView['state'] | '';
  readonly sourceLabel: string;
  readonly effectiveAt: string;
  readonly currentPolicySummary: string;
  readonly expiryLabel: string;
  readonly editable: boolean;
  readonly blocker: string;
  readonly form: PostingPolicyForm | null;
  readonly categories: readonly {
    key: PostingPolicyCategory;
    label: string;
    checked: boolean;
  }[];
  readonly pending: boolean;
  readonly pendingRequestId: string;
  readonly pendingRegionId: string;
  readonly pendingSummary: string;
  readonly storageBlocked: boolean;
  readonly campusQuery: string;
  readonly campuses: readonly Campus[];
  readonly status: string;
  readonly error: string;
}
export const initialSchoolPostingPolicyView =
  (): SchoolPostingPolicyPageView => ({
    busy: false,
    loaded: false,
    management: 'none',
    regionId: '',
    regionName: '',
    revision: 0,
    sourceState: '',
    sourceLabel: '',
    effectiveAt: '',
    currentPolicySummary: '',
    expiryLabel: '',
    editable: false,
    blocker: '',
    form: null,
    categories: [],
    pending: false,
    pendingRequestId: '',
    pendingRegionId: '',
    pendingSummary: '',
    storageBlocked: false,
    campusQuery: '',
    campuses: [],
    status: '',
    error: '',
  });
interface Operation {
  readonly cancel: Cancellation;
  readonly actorId: string;
  assertCurrent(): void;
}
const sourceLabels = {
  unconfigured: '未配置',
  active: '当前生效',
  expired: '已过期',
  unavailable: '来源不可用',
};
/** All asynchronous continuations are bound to one page generation and login epoch. */
export class SchoolPostingPolicyController {
  private generation = 0;
  private cancellation = new Cancellation();
  private disposed = false;
  private readonly unsubscribe: () => void;
  private view = initialSchoolPostingPolicyView();
  private current: PostingPolicyView | null = null;
  private pending: PendingPostingPolicyCommand | null = null;
  constructor(
    private readonly sessions: SessionStore,
    private readonly gateway: SchoolPostingPolicyGateway,
    private readonly schools: Pick<
      SchoolConfigurationGateway,
      'capabilities' | 'public'
    >,
    private readonly profiles: Pick<ProfileGateway, 'campuses'>,
    private readonly journal: PostingPolicyJournal,
    private readonly newRequestId: () => Promise<string>,
    private readonly render: (view: SchoolPostingPolicyPageView) => void,
    private readonly now: () => number = Date.now,
  ) {
    let ticket = sessions.snapshot();
    this.unsubscribe = sessions.subscribe(() => {
      const next = sessions.snapshot();
      if (
        ticket.epoch !== next.epoch ||
        ticket.credentials?.accountId !== next.credentials?.accountId
      ) {
        ticket = next;
        this.reset();
        this.update({ error: '登录账号已变化，请重新读取发帖权限配置' });
      }
    });
  }
  private update(patch: Partial<SchoolPostingPolicyPageView>) {
    if (this.disposed) return;
    this.view = { ...this.view, ...patch };
    this.render(this.view);
  }
  private reset() {
    this.generation++;
    this.cancellation.cancel();
    this.cancellation = new Cancellation();
    this.current = null;
    this.pending = null;
    this.view = initialSchoolPostingPolicyView();
    if (!this.disposed) this.render(this.view);
  }
  private clearProjection() {
    this.current = null;
    this.update({
      loaded: false,
      editable: false,
      form: null,
      categories: [],
      sourceState: '',
      sourceLabel: '',
      effectiveAt: '',
      currentPolicySummary: '',
      expiryLabel: '',
      blocker: '',
      revision: 0,
    });
  }
  private async run<T>(
    work: (operation: Operation) => Promise<T>,
    show: (result: T) => void,
  ) {
    if (this.disposed || this.view.busy) return;
    const generation = this.generation,
      ticket = this.sessions.snapshot(),
      cancel = this.cancellation;
    const assertCurrent = () => {
      this.sessions.assertCurrent(ticket);
      if (this.disposed || generation !== this.generation || cancel.isCancelled)
        throw new ClientError(
          'cancelled',
          'Posting policy page is no longer current',
        );
    };
    this.update({ busy: true, error: '' });
    try {
      if (!ticket.credentials)
        throw new ClientError('auth-required', 'Login is required');
      const result = await work({
        cancel,
        actorId: ticket.credentials.accountId,
        assertCurrent,
      });
      assertCurrent();
      show(result);
    } catch (error) {
      if (!this.disposed && generation === this.generation) this.fail(error);
    } finally {
      if (!this.disposed && generation === this.generation)
        this.update({ busy: false });
    }
  }
  private showPending() {
    const pending = this.pending;
    if (!pending) return;
    const policy = pending.command.policy;
    this.update({
      pending: true,
      pendingRequestId: pending.command.clientRequestId,
      pendingRegionId: pending.regionId,
      pendingSummary: `基于版本 ${pending.command.expectedRevision}；未认证发帖${policy.unverifiedPostEnabled ? '开启' : '关闭'}；未认证评论${policy.unverifiedCommentEnabled ? '开启' : '关闭'}；分类：${policy.unverifiedCategories.map((key) => postingPolicyLabels[key]).join('、') || '无'}；关联学校同步${policy.relatedSyncEnabled === true ? '开启' : policy.relatedSyncEnabled === false ? '关闭' : '保持旧版请求'}；有效期：${policy.expiry.kind === 'at' ? policy.expiry.validUntil : '政策豁免，不设到期时间'}`,
      status: '有一笔原保存请求待确认，请先查询结果或取消原请求',
    });
  }
  async load(regionId: string | null = null) {
    if (this.disposed || this.view.busy || this.pending) return;
    this.reset();
    await this.run(
      async (operation) => {
        this.pending = this.journal.read(operation.actorId);
        if (this.pending) {
          this.update({ regionId: this.pending.regionId });
          this.showPending();
          return null;
        }
        if (regionId !== null) postingPolicyUuid(regionId);
        const capabilities = await this.schools.capabilities(operation.cancel);
        operation.assertCurrent();
        this.update({
          management: capabilities.management,
          regionId: regionId ?? '',
        });
        if (capabilities.management === 'none') {
          this.update({ status: '当前账号没有学校发帖权限管理权限' });
          return null;
        }
        if (capabilities.management === 'global' && regionId === null) {
          this.update({ status: '请明确选择要管理的学校' });
          return null;
        }
        const result = decodePostingPolicyView(
          await this.gateway.management(regionId, operation.cancel),
        );
        operation.assertCurrent();
        if (
          result.context.management !== capabilities.management ||
          (capabilities.management === 'fixed' &&
            result.context.regionId !== capabilities.region?.id) ||
          (regionId !== null && result.context.regionId !== regionId)
        )
          invalidPostingPolicy();
        return result;
      },
      (result) => {
        if (result) this.show(result);
      },
    );
  }
  private show(result: PostingPolicyView) {
    this.current = result;
    const policy = result.policy;
    const form: PostingPolicyForm | null = result.editable
      ? Object.freeze({
          relatedSyncEnabled: policy?.relatedSyncEnabled ?? false,
          unverifiedPostEnabled: policy?.unverifiedPostEnabled ?? false,
          unverifiedCommentEnabled: policy?.unverifiedCommentEnabled ?? false,
          unverifiedCategories: Object.freeze([
            ...(policy?.unverifiedCategories ?? []),
          ]),
          expiryKind: policy?.expiry.kind ?? 'at',
          validUntil:
            policy?.expiry.kind === 'at' ? policy.expiry.validUntil : '',
        })
      : null;
    this.update({
      loaded: true,
      regionId: result.context.regionId,
      regionName: result.context.regionName,
      management: result.context.management,
      revision: result.revision,
      sourceState: result.state,
      sourceLabel: sourceLabels[result.state],
      editable: result.editable,
      form,
      categories: form ? this.categoryRows(form) : [],
      effectiveAt: policy?.effectiveAt ?? '',
      currentPolicySummary: policy
        ? `关联学校同步：${policy.relatedSyncEnabled ? '开启' : '关闭'}；未认证发帖：${policy.unverifiedPostEnabled ? '开启' : '关闭'}；未认证评论：${policy.unverifiedCommentEnabled ? '开启' : '关闭'}；发帖分类：${policy.unverifiedCategories.map((key) => postingPolicyLabels[key]).join('、') || '无'}`
        : '',
      expiryLabel: policy
        ? policy.expiry.kind === 'at'
          ? policy.expiry.validUntil
          : '政策豁免，不设到期时间'
        : '',
      blocker:
        result.blocker === 'related_sync_unsupported'
          ? '现有配置启用了关联学校同步，本页不支持修改。请先由授权配置流程处理同步策略。'
          : result.blocker === 'untrusted_source'
            ? '配置来源不可信或不完整，当前只读；不能把未知状态当作已允许未认证用户发帖。'
            : '',
      campuses: [],
      status:
        result.state === 'expired'
          ? '原策略已过期。需要明确选择新的有效期并保存，才能发布新版本。'
          : result.state === 'unconfigured'
            ? '尚未配置例外策略；下面的关闭状态只是新表单默认值，当前不会授予未认证发布权限。'
            : '保存会再次验证当前管理权限、来源和版本。',
    });
  }
  private categoryRows(form: PostingPolicyForm) {
    return postingPolicyCategories.map((key) => ({
      key,
      label: postingPolicyLabels[key],
      checked: form.unverifiedCategories.includes(key),
    }));
  }
  private canEdit() {
    return (
      !this.disposed &&
      !this.view.busy &&
      !this.pending &&
      !this.view.storageBlocked &&
      this.current?.editable === true &&
      this.view.form !== null
    );
  }
  setSwitch(field: string, value: boolean) {
    if (
      !this.canEdit() ||
      (field !== 'unverifiedPostEnabled' &&
        field !== 'unverifiedCommentEnabled' &&
        field !== 'relatedSyncEnabled')
    )
      return;
    this.update({
      form: Object.freeze({ ...this.view.form!, [field]: value }),
    });
  }
  setCategories(values: readonly string[]) {
    if (
      !this.canEdit() ||
      new Set(values).size !== values.length ||
      values.some(
        (key) => !(postingPolicyCategories as readonly string[]).includes(key),
      )
    )
      return;
    const form = Object.freeze({
      ...this.view.form!,
      unverifiedCategories: Object.freeze([
        ...values,
      ] as PostingPolicyCategory[]),
    });
    this.update({ form, categories: this.categoryRows(form) });
  }
  setExpiryKind(kind: string) {
    if (!this.canEdit() || (kind !== 'at' && kind !== 'policy_exempt')) return;
    this.update({
      form: Object.freeze({ ...this.view.form!, expiryKind: kind }),
    });
  }
  setValidUntil(value: string) {
    if (!this.canEdit()) return;
    this.update({
      form: Object.freeze({ ...this.view.form!, validUntil: value }),
    });
  }
  setCampusQuery(value: string) {
    if (
      this.disposed ||
      this.view.busy ||
      this.pending ||
      this.view.storageBlocked
    )
      return;
    this.update({ campusQuery: value, campuses: [] });
  }
  async searchCampuses() {
    if (
      this.view.management !== 'global' ||
      this.pending ||
      this.view.storageBlocked
    )
      return;
    const q = this.view.campusQuery.trim();
    await this.run(
      (operation) =>
        this.profiles.campuses(
          { q, district: '', page: 1, pageSize: 20 },
          operation.cancel,
        ),
      (page) =>
        this.update({
          campuses: page.items,
          status:
            page.total > 20
              ? '仅显示前20项，请缩小搜索范围'
              : '请选择目标学校的有效校区',
        }),
    );
  }
  async chooseCampus(campusId: string) {
    if (
      this.disposed ||
      this.view.busy ||
      this.view.management !== 'global' ||
      this.pending ||
      this.view.storageBlocked ||
      !this.view.campuses.some(
        (campus) => campus.id === campusId && campus.isActive,
      )
    )
      return;
    this.clearProjection();
    this.update({ regionId: '', regionName: '' });
    await this.run(
      async (operation) => {
        const scope = await this.schools.public(campusId, operation.cancel);
        operation.assertCurrent();
        if (scope.context.campusId !== campusId) invalidPostingPolicy();
        if (!scope.context.region)
          throw new ClientError(
            'business',
            'No active school management region',
          );
        const result = decodePostingPolicyView(
          await this.gateway.management(
            scope.context.region.id,
            operation.cancel,
          ),
        );
        operation.assertCurrent();
        if (
          result.context.management !== 'global' ||
          result.context.regionId !== scope.context.region.id
        )
          invalidPostingPolicy();
        return result;
      },
      (result) => this.show(result),
    );
  }
  async save() {
    if (!this.canEdit() || !this.current || !this.view.form) return;
    const form = this.view.form,
      regionId = this.current.context.regionId,
      expectedRevision = this.current.revision;
    let policy: PostingPolicyInput;
    try {
      policy = decodePostingPolicyInput(
        {
          relatedSyncEnabled: form.relatedSyncEnabled,
          unverifiedPostEnabled: form.unverifiedPostEnabled,
          unverifiedCommentEnabled: form.unverifiedCommentEnabled,
          unverifiedCategories: form.unverifiedCategories,
          expiry:
            form.expiryKind === 'at'
              ? { kind: 'at', validUntil: form.validUntil }
              : { kind: 'policy_exempt' },
        },
        2,
      );
      if (
        policy.expiry.kind === 'at' &&
        Date.parse(policy.expiry.validUntil) <= this.now()
      )
        throw new Error('Expired');
    } catch {
      this.update({
        error:
          '请选择允许的分类；到期时间须是未来的 ISO UTC 时间，例如 2027-01-01T00:00:00Z，或明确选择政策豁免。',
      });
      return;
    }
    await this.run(
      async (operation) => {
        const requestId = await this.newRequestId();
        operation.assertCurrent();
        const pending = this.journal.write(operation.actorId, regionId, {
          version: 2,
          clientRequestId: requestId,
          expectedRevision,
          policy,
        });
        this.pending = pending;
        this.showPending();
        const receipt = await this.gateway.save(
          regionId,
          pending.command,
          operation.cancel,
        );
        operation.assertCurrent();
        return {
          state: 'recorded',
          requestId: pending.command.clientRequestId,
          receipt,
        } as const;
      },
      (result) => this.settle(this.pending!, result),
    );
  }
  async recover(retry = false) {
    const pending = this.pending;
    if (!pending || this.view.storageBlocked) return;
    await this.run(
      async (operation) => {
        if (operation.actorId !== pending.actorId) invalidPostingPolicy();
        const result = decodePostingPolicyRecovery(
          await this.gateway.recover(
            pending.command.clientRequestId,
            operation.cancel,
          ),
        );
        operation.assertCurrent();
        if (result.requestId !== pending.command.clientRequestId)
          invalidPostingPolicy();
        if (result.state !== 'not_recorded' || !retry) return result;
        // Explicit retry alone sends the original immutable command. No rebase or new key.
        const receipt = await this.gateway.save(
          pending.regionId,
          pending.command,
          operation.cancel,
        );
        operation.assertCurrent();
        return {
          state: 'recorded',
          requestId: pending.command.clientRequestId,
          receipt,
        } as const;
      },
      (result) => this.settle(pending, result),
    );
  }
  async cancelPending() {
    const pending = this.pending;
    if (!pending || this.view.storageBlocked) return;
    await this.run(
      async (operation) => {
        if (operation.actorId !== pending.actorId) invalidPostingPolicy();
        return this.gateway.cancel(
          pending.command.clientRequestId,
          pending.requestHash,
          operation.cancel,
        );
      },
      (result) => this.settle(pending, result),
    );
  }
  private settle(
    pending: PendingPostingPolicyCommand,
    raw: PostingPolicyRecovery,
  ) {
    const result = decodePostingPolicyRecovery(raw);
    if (
      result.requestId !== pending.command.clientRequestId ||
      this.pending?.requestHash !== pending.requestHash
    )
      invalidPostingPolicy();
    if (result.state === 'not_recorded') {
      this.update({
        status:
          '暂未查到结果，这不代表原请求已取消。可明确同键重试，或请求取消原保存。',
      });
      return;
    }
    if (result.state === 'recorded')
      this.journal.settle(pending, result.receipt);
    else this.journal.cancel(pending, result.requestId, result.requestHash);
    this.pending = null;
    this.clearProjection();
    this.update({
      pending: false,
      pendingRequestId: '',
      pendingRegionId: '',
      pendingSummary: '',
      status:
        result.state === 'recorded'
          ? `原请求已保存为版本 ${result.receipt.revision}。请重新读取当前配置；历史回执不会覆盖当前版本。`
          : '原请求已取消。请重新读取当前配置后再编辑。',
    });
  }
  async refresh() {
    if (this.pending || this.disposed || this.view.busy) return;
    await this.load(this.view.regionId || null);
  }
  private fail(error: unknown) {
    const failure = clientError(error),
      code = failure.details.serverCode;
    const permission =
      ['forbidden', 'auth-required', 'auth-expired', 'stale-session'].includes(
        failure.kind,
      ) || code === 'AUTHORIZATION_REQUIRED';
    if (
      permission ||
      code === 'SCHOOL_POSTING_POLICY_SOURCE_UNRESOLVED' ||
      code === 'SCHOOL_POSTING_POLICY_UNAVAILABLE'
    )
      this.clearProjection();
    if (failure.kind === 'storage') {
      // A write/readback can fail after persistence. Never silently replace that operation.
      this.clearProjection();
      this.update({ storageBlocked: true });
    }
    this.update({
      pending: this.pending !== null,
      error: permission
        ? '当前管理权限或登录状态已失效。已有原请求仍可在正确账号下查询。'
        : code === 'SCHOOL_POSTING_POLICY_REVISION_CONFLICT'
          ? '配置版本已更新。请先取消原请求，再重新读取并明确编辑；不会自动覆盖新版本。'
          : code === 'SCHOOL_POSTING_POLICY_REQUEST_CONFLICT'
            ? '原请求标识与服务端记录冲突，已停止保存；请查询原请求结果。'
            : code === 'SCHOOL_POSTING_POLICY_SOURCE_UNRESOLVED'
              ? '当前策略来源不可确认或包含不支持的同步设置，禁止覆盖。请查询并处理原请求。'
              : failure.kind === 'storage'
                ? '本地原请求记录无法安全读取或结清，已停止新建与重试。请重新打开页面恢复，勿清除应用数据。'
                : this.pending
                  ? '原保存结果尚未确认。请查询原请求；离开页面或刷新不会自动取消服务端请求。'
                  : '当前配置暂不可用，请重新读取。',
      status: '',
    });
  }
  dispose() {
    if (this.disposed) return;
    this.reset();
    this.disposed = true;
    this.unsubscribe();
  }
}
