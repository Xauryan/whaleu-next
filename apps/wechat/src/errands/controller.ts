import { ClientError, isRecord } from '../api/errors';
import {
  CommunityController,
  communityError,
  initialCommunityView,
  type CommunityView,
} from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import type { Campus } from '../profile/contract';
import type { Cancellation } from '../platform/contracts';
import {
  decodeErrandContactHistory,
  decodeErrandDetail,
  decodeErrandIntent,
  decodeErrandPage,
  decodePublishErrand,
  errandId,
  invalidErrand,
  type ErrandContacts,
  type ErrandDetail,
  type ErrandIntent,
  type ErrandListQuery,
  type ErrandOperation,
  type ErrandReceipt,
  type ErrandRelation,
  type ErrandSummary,
} from './contract';
import type { PendingErrand } from './pending';
export type ErrandMode = 'list' | 'mine' | 'detail' | 'compose';
export interface ErrandForm {
  readonly title: string;
  readonly publicText: string;
  readonly privateText: string;
  readonly expectedTimeText: string;
  readonly reward: string;
  readonly wechat: string;
  readonly phone: string;
}
const emptyForm = (): ErrandForm => ({
  title: '',
  publicText: '',
  privateText: '',
  expectedTimeText: '',
  reward: '',
  wechat: '',
  phone: '',
});
const emptyContacts = (): ErrandContacts => ({ wechat: '', phone: '' });
export interface ErrandRoute {
  readonly orderId?: string;
  readonly regionId?: string;
  readonly relation?: ErrandRelation;
}
export function decodeErrandRoute(
  value: unknown,
  mode: ErrandMode,
): ErrandRoute {
  if (!isRecord(value)) invalidErrand();
  const keys =
    mode === 'detail'
      ? ['orderId']
      : mode === 'mine'
        ? ['relation']
        : ['regionId'];
  if (Object.keys(value).some((key) => !keys.includes(key))) invalidErrand();
  if (mode === 'detail') {
    if (!errandId(value.orderId)) invalidErrand();
    return Object.freeze({ orderId: value.orderId });
  }
  if (mode === 'mine') {
    if (
      value.relation !== undefined &&
      !['published', 'accepted'].includes(String(value.relation))
    )
      invalidErrand();
    return Object.freeze({
      relation: (value.relation ?? 'published') as ErrandRelation,
    });
  }
  if (value.regionId !== undefined && !errandId(value.regionId))
    invalidErrand();
  return Object.freeze(
    value.regionId ? { regionId: value.regionId as string } : {},
  );
}
export interface ErrandView extends CommunityView {
  readonly loaded: boolean;
  readonly regionId: string;
  readonly regionLabel: string;
  readonly campusQuery: string;
  readonly campuses: readonly Campus[];
  readonly items: readonly ErrandSummary[];
  readonly detail: ErrandDetail | null;
  readonly filter: ErrandListQuery['filter'];
  readonly sort: ErrandListQuery['sort'];
  readonly direction: ErrandListQuery['direction'];
  readonly relation: ErrandRelation;
  readonly discoveryMode: 'home' | 'own_only' | null;
  readonly canMore: boolean;
  readonly frozen: boolean;
  readonly recoveryOperation: string;
  readonly recoveryOrderId: string;
  readonly receiptStatus: string;
  readonly confirmedOrderId: string;
  readonly form: ErrandForm;
  readonly acceptModal: boolean;
  readonly contacts: ErrandContacts;
  readonly useLast: boolean;
  readonly historyStatus: string;
  readonly confirmAction: 'cancel' | 'complete' | 'delete' | null;
}
export const initialErrandView = (): ErrandView => ({
  ...initialCommunityView(),
  loaded: false,
  regionId: '',
  regionLabel: '',
  campusQuery: '',
  campuses: [],
  items: [],
  detail: null,
  filter: 'all',
  sort: 'created',
  direction: 'desc',
  relation: 'published',
  discoveryMode: null,
  canMore: false,
  frozen: false,
  recoveryOperation: '',
  recoveryOrderId: '',
  receiptStatus: '',
  confirmedOrderId: '',
  form: emptyForm(),
  acceptModal: false,
  contacts: emptyContacts(),
  useLast: false,
  historyStatus: '',
  confirmAction: null,
});
export function errandError(error: unknown): string {
  const code = error instanceof ClientError ? error.details.serverCode : null;
  return (
    (
      {
        ERRAND_NOT_FOUND: '订单不存在或当前不可查看',
        ERRAND_REVISION_CONFLICT: '订单已变化，请重新加载后确认操作',
        ERRAND_STATE_CONFLICT: '订单已被接走或已结束，请重新加载',
        ERRAND_ACTION_RESTRICTED:
          '当前账号的发布或接单暂受限制；自己的订单仍可按规则取消、完成或删除',
        ERRAND_SELF_ACCEPT: '不能接自己的订单',
        ERRAND_UNAVAILABLE: '订单所需的有效资料暂不能确认，请稍后重试',
        ERRAND_SCOPE_UNAVAILABLE: '目标地区暂不可用，请重新选择校园',
        CONTENT_REVIEW_UNAVAILABLE:
          '内容审核暂不可用；当前版本尚未开放审核提交流程，原发布请求仍保留',
      } as Record<string, string>
    )[code ?? ''] ?? communityError(error)
  );
}
const operationLabels: Record<ErrandOperation, string> = {
  publish: '发布',
  accept: '接单',
  cancel: '取消',
  complete: '完成',
  delete: '删除',
};
/** Every private render is owned by account/epoch, navigation and cancellation. Receipts never supply current contacts. */
export class ErrandController extends CommunityController<ErrandView> {
  private route: ErrandRoute = {};
  private inactive = false;
  private sequence = 0;
  private pending: PendingErrand | null = null;
  private nextCursor: string | null = null;
  private cursors = new Set<string>();
  private readonly unsubscribeScope: () => void;
  private readonly unsubscribeBrowse: () => void;
  constructor(
    runtime: CommunityRuntime,
    private readonly mode: ErrandMode,
    render: (view: ErrandView) => void,
  ) {
    super(runtime, initialErrandView, render);
    const invalidate = (accountId?: string) => {
      if (accountId !== undefined && accountId !== this.accountId()) return;
      this.sequence++;
      this.stop();
      this.resetPrivate();
      this.update({
        ...initialErrandView(),
        configured: !!runtime.errands,
        hasSession: !!this.accountId(),
        status: '身份或浏览校区已变化，请重新加载；已有订单关系由服务器核验',
      });
    };
    this.unsubscribeScope =
      runtime.directoryScopeChanges?.subscribe(invalidate) ?? (() => undefined);
    this.unsubscribeBrowse =
      runtime.browsingScopeChanges?.subscribe(invalidate) ?? (() => undefined);
    this.update({ configured: !!runtime.errands && !!runtime.pendingErrands });
  }
  protected override available(): boolean {
    if (this.inactive) return false;
    if (
      !this.runtime.errands ||
      !this.runtime.pendingErrands ||
      !this.accountId()
    ) {
      this.update({
        configured: !!this.runtime.errands && !!this.runtime.pendingErrands,
        error: !this.accountId()
          ? '请先登录后使用跑腿'
          : '当前构建尚未配置跑腿服务',
        status: '跑腿暂不可用',
      });
      return false;
    }
    return true;
  }
  protected override resetPrivate(): void {
    this.sequence++;
    this.pending = null;
    this.nextCursor = null;
    this.cursors.clear();
  }
  protected override onSafetyInvalidated(): void {
    this.update({
      status: '安全状态已变化，旧订单与联系方式已清除，请重新加载',
    });
  }
  private clearCurrent(): void {
    this.stop();
    this.nextCursor = null;
    this.cursors.clear();
    this.update({
      loaded: false,
      busy: false,
      items: [],
      detail: null,
      canMore: false,
      discoveryMode: null,
      acceptModal: false,
      contacts: emptyContacts(),
      useLast: false,
      historyStatus: '',
      confirmAction: null,
      error: '',
    });
  }
  private same(sequence: number): boolean {
    return !this.inactive && sequence === this.sequence && !!this.accountId();
  }
  private loadJournal(): boolean {
    if (!this.available()) return false;
    try {
      this.pending = this.runtime.pendingErrands!.load(this.accountId()!);
      if (this.pending) this.showPending(this.pending);
      return true;
    } catch (error) {
      this.update({
        frozen: true,
        error: errandError(error),
        status: '无法读取原跑腿请求，禁止新建请求',
      });
      return false;
    }
  }
  private showPending(attempt: PendingErrand): void {
    this.pending = attempt;
    this.update({
      frozen: true,
      recoveryOperation: operationLabels[attempt.intent.operation],
      recoveryOrderId:
        attempt.intent.operation === 'publish' ? '' : attempt.intent.orderId,
      status: '原操作结果待确认，仅可查询或重试原请求',
      form: emptyForm(),
      acceptModal: false,
      contacts: emptyContacts(),
      useLast: false,
      historyStatus: '',
      confirmAction: null,
    });
  }
  async load(raw: unknown = {}): Promise<void> {
    this.sequence++;
    const sequence = this.sequence;
    this.clearCurrent();
    this.update({
      form: emptyForm(),
      frozen: false,
      recoveryOperation: '',
      recoveryOrderId: '',
      receiptStatus: '',
      confirmedOrderId: '',
    });
    try {
      this.route = decodeErrandRoute(raw, this.mode);
    } catch {
      this.route = {};
      this.update({
        error: '跑腿链接无效，请返回列表',
        status: '无法打开跑腿',
      });
      return;
    }
    if (!this.loadJournal()) return;
    if (this.pending) await this.recover(false, false);
    if (!this.same(sequence)) return;
    if (this.mode === 'mine')
      this.update({ relation: this.route.relation ?? 'published' });
    if (this.mode === 'list' || this.mode === 'compose') {
      if (this.route.regionId)
        this.update({
          regionId: this.route.regionId,
          regionLabel: '链接指定的目标地区',
        });
      else {
        await this.run(
          async (cancel) => {
            if (!this.runtime.profiles)
              throw new ClientError(
                'configuration',
                'Profile service unavailable',
              );
            const profile = await this.runtime.profiles.profile(cancel);
            if (!profile.selectedCampus?.isActive) return null;
            const regions = await this.runtime.errands!.regions(
              profile.selectedCampus.id,
              cancel,
            );
            return regions[0] ?? null;
          },
          (target) =>
            this.update({
              regionId: target?.id ?? '',
              regionLabel: target?.label ?? '',
              status: target
                ? '已解析浏览校园的目标地区'
                : '请搜索并选择目标校园',
            }),
          (error) =>
            this.update({
              regionId: '',
              regionLabel: '',
              error: errandError(error),
            }),
        );
      }
    }
    if (this.same(sequence)) await this.refresh();
  }
  async reload(): Promise<void> {
    await this.load(this.route);
  }
  async refresh(): Promise<void> {
    if (this.inactive || this.view.busy) return;
    this.clearCurrent();
    if (!this.available()) return;
    if (this.mode === 'compose') {
      this.update({
        loaded: true,
        status: '文字跑腿：发布需有效身份与内容审核；可选择其他地区',
      });
      return;
    }
    if (this.mode === 'list' && !this.view.regionId) {
      this.update({ status: '请选择目标校园后查看订单' });
      return;
    }
    await this.fetch(false);
  }
  private async fetch(append: boolean): Promise<void> {
    const cursor = append ? this.nextCursor : null,
      regionId = this.view.regionId,
      relation = this.view.relation;
    const query: ErrandListQuery = {
      regionId,
      filter: this.view.filter,
      sort: this.view.sort,
      direction: this.view.direction,
    };
    if (!append)
      this.update({
        detail: null,
        items: [],
        loaded: false,
        canMore: false,
        contacts: emptyContacts(),
        acceptModal: false,
        confirmAction: null,
      });
    await this.run(
      async (cancel) => {
        if (this.mode === 'detail') {
          if (!this.route.orderId) invalidErrand();
          const detail = decodeErrandDetail(
            await this.runtime.errands!.detail(this.route.orderId, cancel),
          );
          if (detail.id !== this.route.orderId) invalidErrand();
          return { detail, page: null };
        }
        const page = decodeErrandPage(
          await (this.mode === 'mine'
            ? this.runtime.errands!.mine(relation, cursor, cancel)
            : this.runtime.errands!.list(query, cursor, cancel)),
        );
        if (
          (this.mode === 'mine' &&
            (page.context.kind !== 'own' ||
              page.context.relation !== relation)) ||
          (this.mode === 'list' &&
            (page.context.kind !== 'discovery' ||
              page.context.regionId !== regionId))
        )
          invalidErrand();
        return { detail: null, page };
      },
      ({ detail, page }) => {
        if (detail) {
          this.update({
            detail,
            loaded: true,
            status: '已核验当前订单；联系方式仅在进行中向双方显示',
          });
          return;
        }
        if (
          !page ||
          (page.nextCursor &&
            (page.nextCursor === cursor || this.cursors.has(page.nextCursor)))
        )
          invalidErrand();
        if (cursor) this.cursors.add(cursor);
        this.nextCursor = page.nextCursor;
        const items = new Map(
          (append ? this.view.items : []).map((item) => [item.id, item]),
        );
        for (const item of page.items) items.set(item.id, item);
        this.update({
          items: [...items.values()],
          loaded: true,
          canMore: page.nextCursor !== null,
          discoveryMode:
            page.context.kind === 'discovery'
              ? page.context.discoveryMode
              : null,
          status:
            page.continuation === 'end'
              ? '已到当前范围末尾'
              : '已加载订单，可继续浏览',
        });
      },
      (error) => {
        this.clearCurrent();
        this.update({
          error: errandError(error),
          status:
            error.details.serverCode === 'DISCOVERY_RESTART_REQUIRED'
              ? '分页已失效，请重新加载'
              : '订单暂不可用',
        });
      },
    );
  }
  async more(): Promise<void> {
    if (
      !this.view.busy &&
      this.view.loaded &&
      this.nextCursor &&
      this.available()
    )
      await this.fetch(true);
  }
  async choose(field: string, value: string): Promise<void> {
    if (
      this.inactive ||
      !(['filter', 'sort', 'direction', 'relation'] as string[]).includes(field)
    )
      return;
    const allowed: Record<string, readonly string[]> = {
      filter: ['all', 'pending'],
      sort: ['created', 'reward'],
      direction: ['asc', 'desc'],
      relation: ['published', 'accepted'],
    };
    if (!allowed[field]!.includes(value)) return;
    this.sequence++;
    this.clearCurrent();
    if (field === 'relation')
      this.route = { relation: value as ErrandRelation };
    this.update({ [field]: value });
    await this.refresh();
  }
  setCampusQuery(value: string): void {
    if (!this.view.busy && !this.inactive) this.update({ campusQuery: value });
  }
  async searchCampuses(): Promise<void> {
    if (this.view.busy || !this.available() || !this.runtime.profiles) return;
    this.update({ campuses: [] });
    await this.run(
      (cancel) =>
        this.runtime.profiles!.campuses(
          { q: this.view.campusQuery, district: '', page: 1, pageSize: 20 },
          cancel,
        ),
      (page) => this.update({ campuses: page.items }),
    );
  }
  async selectCampus(id: string): Promise<void> {
    if (
      this.view.busy ||
      this.view.frozen ||
      !this.available() ||
      !this.view.campuses.some((campus) => campus.id === id && campus.isActive)
    )
      return;
    this.sequence++;
    this.clearCurrent();
    this.update({ regionId: '', regionLabel: '' });
    await this.run(
      (cancel) => this.runtime.errands!.regions(id, cancel),
      (regions) => {
        const target = regions[0];
        if (!target)
          throw new ClientError('forbidden', 'Region unavailable', {
            serverCode: 'ERRAND_SCOPE_UNAVAILABLE',
          });
        this.route = { regionId: target.id };
        this.update({
          regionId: target.id,
          regionLabel: target.label,
          campuses: [],
        });
      },
      (error) => this.update({ error: errandError(error) }),
    );
    if (this.view.regionId) await this.refresh();
  }
  setForm(field: string, value: string): void {
    if (
      !this.inactive &&
      !this.view.busy &&
      !this.view.frozen &&
      Object.hasOwnProperty.call(emptyForm(), field)
    )
      this.update({ form: { ...this.view.form, [field]: value } });
  }
  usePublisherContacts(): void {
    if (
      this.inactive ||
      this.view.busy ||
      this.view.frozen ||
      !this.available()
    )
      return;
    try {
      const contacts = this.runtime.pendingErrands!.publisherContacts(
        this.accountId()!,
      );
      this.update({
        form: {
          ...this.view.form,
          wechat: contacts?.wechat ?? '',
          phone: contacts?.phone ?? '',
        },
        status: contacts
          ? '已填入此账号上次成功发布的联系方式'
          : '此账号尚无成功发布的联系方式',
      });
    } catch (error) {
      this.update({ error: errandError(error) });
    }
  }
  async publish(): Promise<void> {
    if (
      this.mode !== 'compose' ||
      !this.view.loaded ||
      !this.view.regionId ||
      this.view.busy ||
      this.view.frozen ||
      !this.available()
    )
      return;
    const form = this.view.form,
      regionId = this.view.regionId;
    // Validate before minting/persisting a request; this is only input validation, never review approval.
    try {
      decodePublishErrand({
        clientRequestId: '00000000-0000-4000-8000-000000000000',
        targetRegionId: regionId,
        title: form.title,
        publicText: form.publicText,
        privateText: form.privateText,
        expectedTimeText: form.expectedTimeText,
        reward: form.reward,
        publisherContacts: { wechat: form.wechat, phone: form.phone },
        publicAssetIds: [],
        privateAssetIds: [],
      });
    } catch {
      this.update({
        error:
          '请填写有效标题（50字）、公开描述（500字）、私密说明（200字）、时间说明（50字）、1–500元精确金额，以及微信和最多11位数字电话；不能提交图片',
      });
      return;
    }
    await this.start((clientRequestId) => ({
      operation: 'publish',
      payload: decodePublishErrand({
        clientRequestId,
        targetRegionId: regionId,
        title: form.title,
        publicText: form.publicText,
        privateText: form.privateText,
        expectedTimeText: form.expectedTimeText,
        reward: form.reward,
        publisherContacts: { wechat: form.wechat, phone: form.phone },
        publicAssetIds: [],
        privateAssetIds: [],
      }),
    }));
  }
  async openAccept(): Promise<void> {
    if (
      this.view.busy ||
      this.view.frozen ||
      !this.view.detail?.capabilities.accept ||
      !this.available()
    )
      return;
    this.update({
      acceptModal: true,
      contacts: emptyContacts(),
      useLast: false,
      historyStatus: '正在读取此账号上次接单联系方式',
      confirmAction: null,
    });
    await this.loadContacts();
  }
  private async loadContacts(): Promise<void> {
    const orderId = this.view.detail?.id;
    await this.run(
      (cancel) => this.runtime.errands!.contactHistory(cancel),
      (raw) => {
        if (!this.view.acceptModal || this.view.detail?.id !== orderId) return;
        const history = decodeErrandContactHistory(raw);
        this.update({
          contacts:
            history.status === 'available' ? history.contacts : emptyContacts(),
          useLast: history.status === 'available',
          historyStatus:
            history.status === 'available'
              ? '已填入上次成功接单的联系方式；本次成功接单后会记住新的填写'
              : '尚无上次联系方式，请填写至少一种',
        });
      },
      (error) =>
        this.update({
          contacts: emptyContacts(),
          useLast: false,
          historyStatus: '上次联系方式暂不可用，可手动填写',
          error: errandError(error),
        }),
    );
  }
  closeAccept(): void {
    this.stop();
    this.update({
      busy: false,
      acceptModal: false,
      contacts: emptyContacts(),
      useLast: false,
      historyStatus: '',
      error: '',
    });
  }
  async toggleLast(): Promise<void> {
    if (!this.view.acceptModal || this.view.busy || this.view.frozen) return;
    if (this.view.useLast) {
      this.update({
        contacts: emptyContacts(),
        useLast: false,
        historyStatus: '已清空，本次成功接单仍会保存新填写的联系方式',
      });
      return;
    }
    await this.loadContacts();
  }
  setContact(field: string, value: string): void {
    if (
      this.view.acceptModal &&
      !this.view.busy &&
      !this.view.frozen &&
      (field === 'wechat' || field === 'phone')
    )
      this.update({
        contacts: { ...this.view.contacts, [field]: value },
        useLast: false,
      });
  }
  async accept(): Promise<void> {
    const detail = this.view.detail,
      contacts = this.view.contacts;
    if (
      !this.view.acceptModal ||
      !detail?.capabilities.accept ||
      this.view.busy ||
      this.view.frozen ||
      !this.available()
    )
      return;
    let intent: ErrandIntent;
    try {
      intent = decodeErrandIntent({
        operation: 'accept',
        orderId: detail.id,
        payload: {
          clientRequestId: '00000000-0000-4000-8000-000000000000',
          expectedRevision: detail.revision,
          contacts,
        },
      });
    } catch {
      this.update({
        error: '至少填写微信或电话；微信最多50字，电话最多11位数字',
      });
      return;
    }
    this.closeAccept();
    await this.start((clientRequestId) =>
      decodeErrandIntent({
        ...intent,
        payload: { ...intent.payload, clientRequestId },
      }),
    );
  }
  confirm(action: string): void {
    if (
      this.view.busy ||
      this.view.frozen ||
      !this.view.detail ||
      !['cancel', 'complete', 'delete'].includes(action) ||
      !this.view.detail.capabilities[action as 'cancel' | 'complete' | 'delete']
    )
      return;
    this.update({
      confirmAction: action as 'cancel' | 'complete' | 'delete',
      acceptModal: false,
      contacts: emptyContacts(),
    });
  }
  dismissConfirmation(): void {
    this.update({ confirmAction: null });
  }
  async confirmCommand(): Promise<void> {
    const action = this.view.confirmAction,
      detail = this.view.detail;
    if (
      !action ||
      !detail?.capabilities[action] ||
      this.view.busy ||
      this.view.frozen ||
      !this.available()
    )
      return;
    this.update({ confirmAction: null });
    await this.start((clientRequestId) => ({
      operation: action,
      orderId: detail.id,
      payload: { clientRequestId, expectedRevision: detail.revision },
    }));
  }
  private async start(make: (id: string) => ErrandIntent): Promise<void> {
    if (!this.loadJournal() || this.pending) return;
    const accountId = this.accountId()!,
      owner = this.runtime.sessions.snapshot();
    let settled = false;
    await this.run(
      async (cancel) => {
        const id = await this.runtime.newRequestId();
        this.runtime.sessions.assertCurrent(owner);
        if (cancel.isCancelled)
          throw new ClientError('cancelled', 'Cancelled before persistence');
        const pending = this.runtime.pendingErrands!.freeze({
          version: 1,
          accountId,
          intent: make(id),
        });
        this.showPending(pending);
        this.update({ detail: null, items: [], loaded: false, canMore: false });
        return this.dispatch(pending, cancel);
      },
      (receipt) => {
        this.settle(receipt);
        settled = true;
      },
      (error) =>
        this.update({
          error: errandError(error),
          status: '结果尚未确认，请保留原请求并查询或重试',
        }),
    );
    if (settled && !this.inactive && this.accountId() === accountId)
      await this.refresh();
  }
  private dispatch(
    attempt: PendingErrand,
    cancel: Cancellation,
  ): Promise<ErrandReceipt> {
    if (attempt.accountId !== this.accountId())
      throw new ClientError('stale-session', 'Account changed');
    this.runtime.pendingErrands!.assertOriginal(attempt);
    return this.runtime.errands!.command(attempt.intent, cancel);
  }
  async recover(retry = false, refresh = true): Promise<void> {
    if (this.view.busy || !this.loadJournal() || !this.pending) return;
    const attempt = this.pending;
    let settled = false;
    this.update({
      detail: null,
      items: [],
      loaded: false,
      canMore: false,
      acceptModal: false,
      contacts: emptyContacts(),
      confirmAction: null,
    });
    await this.run(
      (cancel) =>
        retry
          ? this.dispatch(attempt, cancel)
          : this.runtime.errands!.receipt(
              attempt.intent.payload.clientRequestId,
              cancel,
            ),
      (receipt) => {
        this.settle(receipt);
        settled = true;
      },
      (error) =>
        this.update({
          frozen: true,
          error: errandError(error),
          status: '原请求仍待确认；未查到回执也不能新建替代请求',
        }),
    );
    if (
      settled &&
      refresh &&
      !this.inactive &&
      this.accountId() === attempt.accountId
    )
      await this.refresh();
  }
  private settle(receipt: ErrandReceipt): void {
    if (!this.pending || this.pending.accountId !== this.accountId())
      invalidErrand();
    const result = this.runtime.pendingErrands!.settle(this.pending, receipt);
    this.pending = null;
    this.update({
      frozen: false,
      recoveryOrderId: '',
      recoveryOperation: '',
      form: emptyForm(),
      contacts: emptyContacts(),
      detail: null,
      items: [],
      loaded: false,
      receiptStatus:
        result.outcome === 'applied'
          ? `${operationLabels[result.operation]}已确认；当前状态需重新读取`
          : errandError(
              new ClientError('forbidden', 'Rejected', {
                serverCode: result.code,
              }),
            ),
      confirmedOrderId: result.outcome === 'applied' ? result.orderId : '',
      status: '原请求已确认',
      error: '',
    });
  }
  detailPath(id: string): string | null {
    return !this.inactive &&
      !this.view.busy &&
      this.accountId() &&
      (this.view.items.some((item) => item.id === id) ||
        this.view.confirmedOrderId === id ||
        this.view.recoveryOrderId === id)
      ? `/pages/errand-detail/errand-detail?orderId=${id}`
      : null;
  }
  composePath(): string | null {
    return !this.inactive &&
      !this.view.busy &&
      this.accountId() &&
      this.view.regionId
      ? `/pages/errand-compose/errand-compose?regionId=${this.view.regionId}`
      : null;
  }
  override cancel(): void {
    this.sequence++;
    this.clearCurrent();
    this.update({
      form: emptyForm(),
      status: '已停止等待，旧联系方式已清除；已发送的请求仍可能完成',
    });
  }
  override dispose(): void {
    this.inactive = true;
    this.sequence++;
    this.unsubscribeScope();
    this.unsubscribeBrowse();
    super.dispose();
  }
}
