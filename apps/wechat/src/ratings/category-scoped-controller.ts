import { ClientError, isRecord } from '../api/errors';
import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../community/controller';
import type { Clock } from '../platform/contracts';
import { systemClock } from '../platform/clock';
import type { CommunityRuntime } from '../community/runtime';
import { decodeCampusPage, type Campus } from '../profile/contract';
import { canonicalRatingText, invalidRating } from './contract';
import { ratingCategoryError } from './category-management-controller';
import {
  RATING_CATEGORY_SCOPED_DRAFT_BODY_BUDGET,
  ratingCategoryScopedRequestBodyBytes,
  decodeRatingCategoryScopedContext,
  decodeRatingCategoryScopedIntent,
  decodeRatingCategoryScopedPrepared,
  decodeRatingManagedCategories,
  decodeRatingManagedCategory,
  isRatingCategoryScopedOperation,
  matchRatingCategoryScopedPreparation,
  matchRatingCategoryScopedReceipt,
  ratingCategoryScopedOperations,
  type RatingCategoryNode,
  type RatingCategoryPlacement,
  type RatingCategoryScopedContext,
  type RatingCategoryScopedIntent,
  type RatingCategoryScopedOperation,
  type RatingCategoryScopedPreparation,
  type RatingCategoryState,
  type RatingCategorySystemOption,
  type RatingManagedCategory,
} from './category-scoped-contract';
import {
  decodeRatingCategoryScopedRoute,
  ratingCategoryScopedPath,
  ratingCategoryScopedQuery,
  type RatingCategoryScopedRoute,
} from './category-scoped-route';
import {
  ratingCommandLabels,
  runRatingCommand,
  settleRatingCommand,
} from './commands';
import {
  isRatingCategoryScopedIntent,
  type PendingRating,
  type RatingCommandReceipt,
} from './pending';
import { ratingNavigationKey } from './scoped-contract';

type PreviewField = RatingCategoryScopedPreparation['changes'][number]['field'];
const previewFieldLabels: Readonly<Record<PreviewField, string>> = {
  body: '本视图覆盖正文',
  base_body: '共享基础正文',
  effective_body: '该范围实际显示正文',
  visibility: '本视图显示状态',
  lifecycle: '共享生命周期',
  scope: '精确适用范围',
  order: '完整同级顺序',
  create: '新增分类',
};
const previewScopeLabel = (scope: string): string =>
  scope === 'global'
    ? '独立全局'
    : scope.startsWith('campus:')
      ? `校园 ${scope.slice(7)}`
      : scope;
function previewBody(value: string | null): string {
  if (value === null) return '无可用正文';
  if (value === '') return '（明确为空）';
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  if (!isRecord(parsed)) return value;
  const parts: string[] = [];
  if (typeof parsed.name === 'string') parts.push(`名称：${parsed.name}`);
  if (typeof parsed.description === 'string')
    parts.push(
      `简介：${parsed.description === '' ? '（明确为空）' : parsed.description}`,
    );
  if (isRecord(parsed.modes)) {
    for (const [field, label] of [
      ['name', '名称'],
      ['description', '简介'],
    ] as const) {
      const mode = parsed.modes[field];
      if (isRecord(mode) && (mode.mode === 'inherit' || mode.mode === 'set'))
        parts.push(
          `${label}模式：${mode.mode === 'inherit' ? '继承共享基础' : '单独覆盖'}`,
        );
    }
  }
  if (typeof parsed.applicable === 'boolean')
    parts.push(parsed.applicable ? '当前适用' : '当前不适用（保留的休眠视图）');
  if (typeof parsed.hidden === 'boolean')
    parts.push(parsed.hidden ? '当前隐藏' : '当前显示');
  return parts.length ? parts.join('；') : value;
}

function previewValue(
  field: PreviewField,
  value: string | null,
  status: RatingCategoryScopedPreparation['changes'][number]['beforeStatus'],
): string {
  if (status === 'unavailable')
    return '【不可用】正文已遮蔽，审核或来源暂不能确认；不是空字符串';
  if (status === 'absent') return '【原值不存在】本次新增';
  const body =
    field === 'body' || field === 'base_body' || field === 'effective_body';
  return `【可用】${body ? previewBody(value) : value === '' ? '（明确为空）' : value}`;
}

type LifecycleAction = 'enable' | 'disable' | 'archive' | 'restore';
type BatchAction = 'retain' | 'disable' | 'restore' | 'enable';
type Choice =
  | 'nameMode'
  | 'descriptionMode'
  | 'visibility'
  | 'lifecycleAction'
  | 'scopeKind'
  | 'propagation'
  | 'orderMode'
  | 'levelCount';
interface OrderEntry {
  readonly key: string;
  readonly label: string;
  readonly kind: 'existing' | 'new';
}
interface CategoryRow {
  readonly id: string;
  readonly label: string;
  readonly stateLabel: string;
  readonly unavailable: boolean;
}
interface NodeDraft extends RatingCategoryNode {
  readonly level: number;
}
interface PreviewView {
  readonly operationLabel: string;
  readonly validUntil: string;
  readonly lines: readonly string[];
  readonly changeCount: number;
  readonly from: number;
  readonly to: number;
  readonly canPrevious: boolean;
  readonly canNext: boolean;
}
export interface RatingCategoryScopedView extends CommunityView {
  readonly editorPage: boolean;
  readonly loaded: boolean;
  readonly scopeLabel: string;
  readonly viewCampusId: string | null;
  readonly frozen: boolean;
  readonly isCategoryPending: boolean;
  readonly recoveryOperation: string;
  readonly requestId: string;
  readonly receiptStatus: string;
  readonly needsRefresh: boolean;
  readonly categories: readonly CategoryRow[];
  readonly canMore: boolean;
  readonly categoryOffset: number;
  readonly canPreviousCategories: boolean;
  readonly filter: 'all' | RatingCategoryState;
  readonly detailId: string | null;
  readonly detailState: string;
  readonly detailVisibility: string;
  readonly detailSystemKey: string | null;
  readonly baseName: string;
  readonly baseDescription: string;
  readonly overrideName: string;
  readonly overrideDescription: string;
  readonly effectiveName: string;
  readonly effectiveDescription: string;
  readonly detailUnavailable: string;
  readonly history: readonly {
    readonly requestId: string;
    readonly occurredAt: string;
    readonly label: string;
  }[];
  readonly canMoreHistory: boolean;
  readonly operations: readonly {
    readonly operation: RatingCategoryScopedOperation;
    readonly label: string;
    readonly allowed: boolean;
    readonly reason: string;
  }[];
  readonly operation: RatingCategoryScopedOperation | '';
  readonly operationLabel: string;
  readonly name: string;
  readonly description: string;
  readonly nameMode: 'inherit' | 'set';
  readonly descriptionMode: 'inherit' | 'set';
  readonly visibility: 'shown' | 'hidden';
  readonly lifecycleAction: LifecycleAction;
  readonly lifecycleActions: readonly {
    readonly value: LifecycleAction;
    readonly label: string;
    readonly allowed: boolean;
  }[];
  readonly scopeKind: 'global' | 'campuses';
  readonly placementCampuses: readonly {
    readonly id: string;
    readonly label: string;
  }[];
  readonly propagation: 'self' | 'subtree';
  readonly orderMode: 'set' | 'inherit';
  readonly order: readonly OrderEntry[];
  readonly orderOffset: number;
  readonly orderCount: number;
  readonly canPreviousOrder: boolean;
  readonly canNextOrder: boolean;
  readonly nodes: readonly NodeDraft[];
  readonly batchChildren: readonly {
    readonly id: string;
    readonly label: string;
    readonly state: RatingCategoryState;
    readonly action: BatchAction;
  }[];
  readonly batchOffset: number;
  readonly canPreviousBatch: boolean;
  readonly canNextBatch: boolean;
  readonly systemKey: string;
  readonly levelCount: number;
  readonly systemOptions: readonly (RatingCategorySystemOption & {
    readonly available: boolean;
  })[];
  readonly pickerOpen: boolean;
  readonly pickerPurpose: 'view' | 'placement';
  readonly campusQuery: string;
  readonly campuses: readonly Campus[];
  readonly campusPage: number;
  readonly hasMoreCampuses: boolean;
  readonly preview: PreviewView | null;
  readonly cancelConfirmation: boolean;
}
export const initialRatingCategoryScopedView =
  (): RatingCategoryScopedView => ({
    ...initialCommunityView(),
    editorPage: false,
    loaded: false,
    scopeLabel: '请明确选择管理视图',
    viewCampusId: null,
    frozen: false,
    isCategoryPending: false,
    recoveryOperation: '',
    requestId: '',
    receiptStatus: '',
    needsRefresh: false,
    categories: [],
    canMore: false,
    categoryOffset: 0,
    canPreviousCategories: false,
    filter: 'all',
    detailId: null,
    detailState: '',
    detailVisibility: '',
    detailSystemKey: null,
    baseName: '',
    baseDescription: '',
    overrideName: '',
    overrideDescription: '',
    effectiveName: '',
    effectiveDescription: '',
    detailUnavailable: '',
    history: [],
    canMoreHistory: false,
    operations: [],
    operation: '',
    operationLabel: '',
    name: '',
    description: '',
    nameMode: 'inherit',
    descriptionMode: 'inherit',
    visibility: 'shown',
    lifecycleAction: 'disable',
    lifecycleActions: [],
    scopeKind: 'global',
    placementCampuses: [],
    propagation: 'self',
    orderMode: 'set',
    order: [],
    orderOffset: 0,
    orderCount: 0,
    canPreviousOrder: false,
    canNextOrder: false,
    nodes: [],
    batchChildren: [],
    batchOffset: 0,
    canPreviousBatch: false,
    canNextBatch: false,
    systemKey: '',
    levelCount: 1,
    systemOptions: [],
    pickerOpen: false,
    pickerPurpose: 'view',
    campusQuery: '',
    campuses: [],
    campusPage: 1,
    hasMoreCampuses: false,
    preview: null,
    cancelConfirmation: false,
  });
const stateLabels: Record<RatingCategoryState, string> = {
  enabled: '已启用',
  disabled: '已停用',
  archived: '已归档',
};
export function ratingCategoryScopedError(error: unknown): string {
  const code = error instanceof ClientError ? error.details.serverCode : null;
  const messages: Record<string, string> = {
    RATING_SCOPE_UNAVAILABLE:
      '完整管理来源、权限或校园映射暂不可用，请稍后重新核验',
    RATING_SCOPED_CONTEXT_CHANGED:
      '管理范围、来源或版本已变化；原请求须先确认关闭，再重新编辑',
    RATING_REVISION_CONFLICT:
      '分类版本已经变化，请查询原回执或取消原请求后重新核验',
    RATING_CATEGORY_CANCELLED: '原分类管理请求已取消',
    RATING_CATEGORY_SOURCE_UNRESOLVED:
      '分类来源存在未解决冲突。请先明确取消原请求，再统一各来源的共享基础文字和业务状态；身份映射、共享定义或基础元数据冲突须由可信来源裁决，不能按当前校园猜测。',
    CONTENT_REJECTED: '本次分类正文未通过审核，原请求已关闭后可重新编辑',
    CONTENT_REVIEW_UNAVAILABLE: '本次精确正文审核暂不可用，原请求仍受保护',
    REQUEST_NOT_FOUND: '暂未查到原回执；这不代表原请求已取消或失败',
    REQUEST_CONFLICT: '原编号与保存的意图不一致，请保留原请求并核验回执',
    CATEGORY_DRAFT_TOO_LARGE:
      '本次完整请求超过安全请求体预算（64 KiB 上限，预留 1 KiB），尚未保存或发送。完整同级集合和原子批次不能截断或拆分提交；可缩小新增内容或正文。若完整同级集合本身过大，请联系管理者处理。',
    CATEGORY_DRAFT_INVALID:
      '请检查必填名称（1–100 字）、简介（0–500 字）、非空校园集合与操作选项；新节点最多 32 项、总深度三级',
  };
  return messages[code ?? ''] ?? ratingCategoryError(error);
}
const unavailableText = '正文暂不可用';
const categoryLabel = (c: RatingManagedCategory): string =>
  c.blockedReason ? `分类 ${c.id}` : (c.name ?? `分类 ${c.id}`);
const sortCategories = (
  a: RatingManagedCategory,
  b: RatingManagedCategory,
): number =>
  a.ordinal.length - b.ordinal.length ||
  (a.ordinal < b.ordinal
    ? -1
    : a.ordinal > b.ordinal
      ? 1
      : a.id.localeCompare(b.id));

/** Private contexts and full mutation sets never enter native page data. The shared
 * journal precedes every current read; late callbacks cannot publish drafts across owners. */
export class RatingCategoryScopedController extends CommunityController<RatingCategoryScopedView> {
  private route: RatingCategoryScopedRoute | null = null;
  private context: RatingCategoryScopedContext | null = null;
  private all: readonly RatingManagedCategory[] = [];
  private detail: RatingManagedCategory | null = null;
  private pending: PendingRating | null = null;
  private prepared: RatingCategoryScopedPreparation | null = null;
  private systemOptions: readonly RatingCategorySystemOption[] = [];
  private order: readonly OrderEntry[] = [];
  private readonly batchActions = new Map<string, BatchAction>();
  private historyCursor: string | null = null;
  private readonly seenHistory = new Set<string>();
  private nextNode = 1;
  private draftGeneration = 0;
  private inactive = false;
  private settling = false;
  private expiry: (() => void) | null = null;
  private readonly unsubscriptions: readonly (() => void)[];
  constructor(
    runtime: CommunityRuntime,
    render: (view: RatingCategoryScopedView) => void,
    private readonly editorPage = false,
    private readonly clock: Clock = systemClock,
  ) {
    super(
      runtime,
      () => ({ ...initialRatingCategoryScopedView(), editorPage }),
      render,
    );
    const invalidate = (accountId?: string) => {
      if (accountId !== undefined && accountId !== this.accountId()) return;
      this.invalidate();
    };
    this.unsubscriptions = [
      runtime.directoryScopeChanges?.subscribe(invalidate),
      runtime.browsingScopeChanges?.subscribe(invalidate),
      runtime.ratingCatalogChanges?.subscribe(() => {
        if (!this.settling) this.invalidate();
      }),
    ].filter((v): v is () => void => !!v);
    this.update({ editorPage, configured: this.configured() });
  }
  private configured(): boolean {
    return !!this.runtime.ratingCategoryScoped && !!this.runtime.pendingRatings;
  }
  protected override available(): boolean {
    if (this.inactive) return false;
    if (!this.accountId() || !this.configured()) {
      this.update({
        error: this.accountId() ? '分类管理服务尚未配置' : '请先登录',
        configured: this.configured(),
        hasSession: !!this.accountId(),
      });
      return false;
    }
    return true;
  }
  protected override resetPrivate(): void {
    this.expiry?.();
    this.expiry = null;
    this.context = null;
    this.all = [];
    this.detail = null;
    this.pending = null;
    this.prepared = null;
    this.systemOptions = [];
    this.order = [];
    this.batchActions.clear();
    this.historyCursor = null;
    this.seenHistory.clear();
    this.nextNode = 1;
    this.draftGeneration++;
  }
  protected override onSafetyInvalidated(): void {
    this.update({
      editorPage: this.editorPage,
      configured: this.configured(),
      needsRefresh: true,
      status: '安全状态已改变，请重新核验；原请求仍受保护',
    });
  }
  private invalidate(): void {
    this.stop();
    this.resetPrivate();
    this.update({
      ...initialRatingCategoryScopedView(),
      editorPage: this.editorPage,
      configured: this.configured(),
      hasSession: !!this.accountId(),
      needsRefresh: true,
      status:
        '分类、身份或范围已变化，已清空草稿与预览；请重新核验，原请求仍受保护',
    });
  }
  snapshotRoute(): Readonly<Record<string, string>> | null {
    return this.route ? ratingCategoryScopedQuery(this.route) : null;
  }
  private journal(): boolean {
    if (!this.available()) return false;
    try {
      const pending = this.runtime.pendingRatings!.load(this.accountId()!);
      this.pending = pending;
      if (pending) this.showPending(pending);
      return true;
    } catch (error) {
      this.failure(error);
      return false;
    }
  }
  private showPending(attempt: PendingRating): void {
    this.expiry?.();
    this.expiry = null;
    this.pending = attempt;
    this.context = null;
    this.all = [];
    this.detail = null;
    this.prepared = null;
    this.order = [];
    this.batchActions.clear();
    this.draftGeneration++;
    const category = isRatingCategoryScopedIntent(attempt.intent);
    if (category) {
      const payload = attempt.intent.payload;
      this.route = {
        selector: attempt.intent.context.selector,
        categoryId:
          'categoryId' in payload
            ? payload.categoryId
            : 'parentId' in payload
              ? payload.parentId
              : null,
      };
    }
    this.update({
      ...initialRatingCategoryScopedView(),
      editorPage: this.editorPage,
      configured: this.configured(),
      hasSession: !!this.accountId(),
      busy: this.view.busy,
      frozen: true,
      isCategoryPending: category,
      recoveryOperation: ratingCommandLabels[attempt.intent.operation],
      requestId: attempt.intent.payload.clientRequestId,
      scopeLabel: category
        ? attempt.intent.context.selector.kind === 'global'
          ? '原请求：独立全局'
          : '原请求：精确校园'
        : '原评分请求',
      viewCampusId:
        category && attempt.intent.context.selector.kind === 'campus'
          ? attempt.intent.context.selector.campusId
          : null,
      status: '原请求待确认；请查询回执或恢复原意图预览，确认后才会提交',
    });
  }
  async load(raw: unknown): Promise<void> {
    this.stop();
    this.resetPrivate();
    this.route = null;
    this.update({
      ...initialRatingCategoryScopedView(),
      editorPage: this.editorPage,
      configured: this.configured(),
      hasSession: !!this.accountId(),
    });
    // Recovery deliberately precedes route and current authority/source validation.
    if (!this.journal()) return;
    if (this.pending) {
      await this.recover();
      return;
    }
    try {
      this.route = decodeRatingCategoryScopedRoute(raw);
    } catch {
      this.update({ error: '管理链接无效，请从明确的校园或独立全局入口打开' });
      return;
    }
    const route = this.route;
    this.update({
      scopeLabel:
        route.selector.kind === 'global'
          ? '独立全局管理视图'
          : '精确校园管理视图',
      viewCampusId:
        route.selector.kind === 'campus' ? route.selector.campusId : null,
    });
    await this.run(
      async (cancel) => {
        const gateway = this.runtime.ratingCategoryScoped!,
          context = decodeRatingCategoryScopedContext(
            await gateway.context(route.selector, cancel),
          );
        if (
          ratingNavigationKey(context.commandContext.selector) !==
            ratingNavigationKey(route.selector) ||
          Date.parse(context.expiresAt) <= this.clock.now()
        )
          invalidRating();
        const catalog = decodeRatingManagedCategories(
          await gateway.categories(context, cancel),
        );
        if (catalog.snapshotRevision !== context.snapshotRevision)
          invalidRating();
        const detail =
          route.categoryId === null
            ? null
            : decodeRatingManagedCategory(
                await gateway.category(context, route.categoryId, cancel),
              );
        if (
          detail &&
          (!catalog.items.some(
            (c) => c.id === detail.id && c.revision === detail.revision,
          ) ||
            detail.id !== route.categoryId)
        )
          invalidRating();
        let options: readonly RatingCategorySystemOption[] = [];
        let optionsUnavailable = false;
        if (
          context.operations.includes('create_system_category_scoped') ||
          detail?.systemKey
        ) {
          try {
            options = (await gateway.systemOptions(context, cancel)).items;
          } catch (error) {
            if (
              cancel.isCancelled ||
              !(error instanceof ClientError) ||
              (error.kind !== 'network' && error.kind !== 'timeout')
            )
              throw error;
            optionsUnavailable = true;
          }
        }
        if (Date.parse(context.expiresAt) <= this.clock.now())
          throw new ClientError(
            'business',
            'Management context expired during read',
            {
              serverCode: 'RATING_SCOPED_CONTEXT_CHANGED',
            },
          );
        return { context, catalog, detail, options, optionsUnavailable };
      },
      ({ context, catalog, detail, options, optionsUnavailable }) => {
        this.context = context;
        this.all = catalog.items;
        this.detail = detail;
        this.systemOptions = options;
        this.expiry = this.clock.schedule(
          () => this.invalidate(),
          Math.max(0, Date.parse(context.expiresAt) - this.clock.now()),
        );
        this.update({
          loaded: true,
          needsRefresh: false,
          systemOptions: options.map((option) => ({
            ...option,
            available: true,
          })),
          status: optionsUnavailable
            ? '管理范围已核验；系统注册选项暂不可用，普通文字管理可单独使用'
            : '当前管理范围已核验；任何变更都需准备预览后明确确认',
        });
        this.showCategories();
        this.showDetail();
        this.showOperations();
      },
      (error) => {
        this.context = null;
        this.all = [];
        this.detail = null;
        this.update({
          loaded: false,
          needsRefresh: true,
          error: ratingCategoryScopedError(error),
          status:
            '管理授权、来源、完整校园映射或当前审核暂不能确认；不会把未知状态当空目录',
        });
      },
    );
  }
  async reload(): Promise<void> {
    if (this.view.busy) return;
    if (this.view.frozen) {
      await this.recover();
      return;
    }
    await this.load(
      this.route ? ratingCategoryScopedQuery(this.route) : { scope: 'global' },
    );
  }
  private children(parentId: string | null): readonly RatingManagedCategory[] {
    return this.all.filter((c) => c.parentId === parentId).sort(sortCategories);
  }
  private showCategories(offset = 0): void {
    const filtered = this.children(this.route?.categoryId ?? null).filter(
      (c) => this.view.filter === 'all' || c.businessState === this.view.filter,
    );
    this.update({
      categories: filtered.slice(offset, offset + 50).map((c) => ({
        id: c.id,
        label: categoryLabel(c),
        stateLabel: `${stateLabels[c.businessState]} · ${c.hidden ? '当前视图隐藏' : '当前视图显示'}`,
        unavailable: !!c.blockedReason || c.name === null,
      })),
      canMore: filtered.length > offset + 50,
      categoryOffset: offset,
      canPreviousCategories: offset > 0,
    });
  }
  filter(value: string): void {
    if (!this.editable()) return;
    if (
      value !== 'all' &&
      value !== 'enabled' &&
      value !== 'disabled' &&
      value !== 'archived'
    )
      return;
    this.update({ filter: value });
    this.showCategories();
  }
  more(): void {
    if (this.editable() && this.view.canMore)
      this.showCategories(this.view.categoryOffset + 50);
  }
  previousCategories(): void {
    if (this.editable())
      this.showCategories(Math.max(0, this.view.categoryOffset - 50));
  }
  private showDetail(): void {
    const d = this.detail;
    if (!d) return;
    const unavailable = !!d.blockedReason;
    this.update({
      detailId: d.id,
      detailState: stateLabels[d.businessState],
      detailVisibility: d.hidden ? '当前视图隐藏' : '当前视图显示',
      detailSystemKey: d.systemKey,
      baseName: unavailable ? unavailableText : (d.baseName ?? unavailableText),
      baseDescription: unavailable
        ? unavailableText
        : (d.baseDescription ?? unavailableText),
      overrideName: unavailable
        ? unavailableText
        : d.override.name.mode === 'inherit'
          ? '继承共享基础'
          : d.override.name.value,
      overrideDescription: unavailable
        ? unavailableText
        : d.override.description.mode === 'inherit'
          ? '继承共享基础'
          : d.override.description.value === ''
            ? '明确覆盖为空'
            : d.override.description.value,
      effectiveName: unavailable
        ? unavailableText
        : (d.name ?? unavailableText),
      effectiveDescription: unavailable
        ? unavailableText
        : (d.description ?? unavailableText),
      detailUnavailable: d.blockedReason
        ? `当前正文不可用：${d.blockedReason}。可以在服务端允许的编辑操作中输入全新文字修正。`
        : '',
    });
  }
  private showOperations(): void {
    const context = this.context,
      detail = this.detail;
    if (!context) return;
    this.update({
      operations: ratingCategoryScopedOperations.map((operation) => {
        const isCreate = operation === 'create_categories_scoped',
          system = operation === 'create_system_category_scoped',
          reorder = operation === 'reorder_categories_scoped';
        const shapeAllowed = system
          ? !detail
          : isCreate
            ? !detail || detail.level < 3
            : reorder
              ? true
              : operation === 'batch_update_subcategories_scoped'
                ? !!detail && detail.level < 3
                : !!detail;
        const campusAllowed =
          operation !== 'set_category_override_scoped' ||
          context.commandContext.selector.kind === 'campus';
        const globalAllowed =
          context.canManageGlobal ||
          (!system && operation !== 'set_category_scope_scoped');
        const allowed =
          globalAllowed &&
          context.operations.includes(operation) &&
          shapeAllowed &&
          campusAllowed;
        return {
          operation,
          label: ratingCommandLabels[operation],
          allowed,
          reason: allowed
            ? ''
            : !globalAllowed
              ? '需要全局管理资格'
              : !context.operations.includes(operation)
                ? '当前管理范围未开放'
                : !campusAllowed
                  ? '请明确选择校园'
                  : '当前层级不适用',
        };
      }),
    });
  }
  private editable(): boolean {
    return (
      !this.inactive &&
      !this.view.busy &&
      !this.view.frozen &&
      this.view.loaded &&
      !!this.context &&
      !!this.accountId()
    );
  }
  selectOperation(raw: string): void {
    if (
      !this.editable() ||
      !isRatingCategoryScopedOperation(raw) ||
      !this.view.operations.some(
        (entry) => entry.operation === raw && entry.allowed,
      )
    )
      return;
    this.draftGeneration++;
    this.nextNode = 1;
    this.batchActions.clear();
    this.prepared = null;
    const d = this.detail,
      selector = this.context!.commandContext.selector;
    const currentScopes = d?.scopeKeys ?? [ratingNavigationKey(selector)];
    const campusIds = currentScopes
      .filter((scope) => scope.startsWith('campus:'))
      .map((scope) => scope.slice(7));
    const children =
      raw === 'reorder_categories_scoped'
        ? this.children(d?.parentId ?? null)
        : raw === 'batch_update_subcategories_scoped'
          ? this.children(d!.id)
          : [];
    this.order = children.map((c) => ({
      key: c.id,
      label: categoryLabel(c),
      kind: 'existing',
    }));
    const initialNode: NodeDraft = {
      key: 'n0',
      parentKey: null,
      name: '',
      description: '',
      level: (d?.level ?? 0) + 1,
    };
    this.update({
      operation: raw,
      operationLabel: ratingCommandLabels[raw],
      name: d && !d.blockedReason ? (d.baseName ?? '') : '',
      description: d && !d.blockedReason ? (d.baseDescription ?? '') : '',
      nameMode: d?.override.name.mode ?? 'inherit',
      descriptionMode: d?.override.description.mode ?? 'inherit',
      visibility: d?.hidden ? 'hidden' : 'shown',
      lifecycleAction:
        d?.businessState === 'archived'
          ? 'restore'
          : d?.businessState === 'disabled'
            ? 'enable'
            : 'disable',
      lifecycleActions: [
        {
          value: 'enable',
          label: '启用此分类',
          allowed: d?.businessState === 'disabled',
        },
        {
          value: 'disable',
          label: '停用此分类',
          allowed:
            d?.businessState === 'enabled' &&
            (!d.systemKey ||
              this.systemOptions.some(
                (o) => o.systemKey === d.systemKey && o.allowDisable,
              )),
        },
        {
          value: 'archive',
          label: '归档此分类（保留身份与历史）',
          allowed: !!d && !d.systemKey && d.businessState !== 'archived',
        },
        {
          value: 'restore',
          label: '从归档恢复到停用',
          allowed: !!d && !d.systemKey && d.businessState === 'archived',
        },
      ],
      scopeKind: currentScopes.includes('global') ? 'global' : 'campuses',
      placementCampuses: campusIds.map((id) => ({ id, label: id })),
      propagation: 'self',
      orderMode: 'set',
      nodes: raw === 'create_categories_scoped' ? [initialNode] : [],
      systemKey: '',
      levelCount: 1,
      preview: null,
      error: '',
      orderOffset: 0,
      batchOffset: 0,
    });
    if (raw === 'set_category_override_scoped' && d && !d.blockedReason)
      this.update({
        name:
          d.override.name.mode === 'set'
            ? d.override.name.value
            : (d.baseName ?? ''),
        description:
          d.override.description.mode === 'set'
            ? d.override.description.value
            : (d.baseDescription ?? ''),
      });
    this.showOrder();
    this.showBatch();
  }
  setText(field: string, value: string): void {
    if (
      !this.editable() ||
      typeof value !== 'string' ||
      (field !== 'name' && field !== 'description')
    )
      return;
    this.update({ [field]: value, error: '' });
  }
  choose(field: string, value: string): void {
    if (!this.editable()) return;
    const allowed: Record<Choice, readonly string[]> = {
      nameMode: ['inherit', 'set'],
      descriptionMode: ['inherit', 'set'],
      visibility: ['shown', 'hidden'],
      lifecycleAction: ['enable', 'disable', 'archive', 'restore'],
      scopeKind: ['global', 'campuses'],
      propagation: ['self', 'subtree'],
      orderMode: ['set', 'inherit'],
      levelCount: ['1', '2', '3'],
    };
    if (!(field in allowed) || !allowed[field as Choice].includes(value))
      return;
    if (
      field === 'lifecycleAction' &&
      !this.view.lifecycleActions.some(
        (item) => item.value === value && item.allowed,
      )
    )
      return;
    if (
      field === 'scopeKind' &&
      value === 'global' &&
      !this.context!.canManageGlobal
    ) {
      this.update({ error: '当前授权不包含独立全局创建或范围替换' });
      return;
    }
    this.update({
      [field]: field === 'levelCount' ? Number(value) : value,
      error: '',
    } as Partial<RatingCategoryScopedView>);
  }
  resetOverride(): void {
    if (this.editable())
      this.update({
        nameMode: 'inherit',
        descriptionMode: 'inherit',
        name: '',
        description: '',
      });
  }
  selectSystemKey(value: string): void {
    if (
      !this.editable() ||
      !this.systemOptions.some((option) => option.systemKey === value)
    )
      return;
    this.update({ systemKey: value, levelCount: 1, error: '' });
  }
  setNodeText(key: string, field: string, value: string): void {
    if (
      !this.editable() ||
      typeof value !== 'string' ||
      (field !== 'name' && field !== 'description')
    )
      return;
    this.update({
      nodes: this.view.nodes.map((node) =>
        node.key === key ? { ...node, [field]: value } : node,
      ),
      error: '',
    });
    if (field === 'name') {
      this.order = this.order.map((entry) =>
        entry.kind === 'new' && entry.key === key
          ? { ...entry, label: value || key }
          : entry,
      );
      this.showOrder();
    }
  }
  addNode(parentKey: string | null = null): void {
    if (
      !this.editable() ||
      ![
        'create_categories_scoped',
        'batch_update_subcategories_scoped',
      ].includes(this.view.operation) ||
      this.view.nodes.length >= 32
    )
      return;
    const batch = this.view.operation === 'batch_update_subcategories_scoped';
    if (batch && parentKey !== null) return;
    const parent =
      parentKey === null
        ? null
        : this.view.nodes.find((node) => node.key === parentKey);
    if (parentKey !== null && !parent) return;
    if (!batch && parentKey === null && this.view.nodes.length) return;
    const depth = parent ? parent.level + 1 : (this.detail?.level ?? 0) + 1;
    if (depth > 3) return;
    const node: NodeDraft = {
      key: `n${this.nextNode++}`,
      parentKey,
      name: '',
      description: '',
      level: depth,
    };
    this.update({ nodes: [...this.view.nodes, node], error: '' });
    if (batch) {
      this.order = [
        ...this.order,
        { key: node.key, label: node.key, kind: 'new' },
      ];
      this.showOrder();
    }
  }
  removeNode(key: string): void {
    if (!this.editable()) return;
    const removed = new Set([key]);
    for (const node of this.view.nodes)
      if (node.parentKey && removed.has(node.parentKey)) removed.add(node.key);
    this.update({
      nodes: this.view.nodes.filter((node) => !removed.has(node.key)),
      error: '',
    });
    this.order = this.order.filter(
      (entry) => entry.kind !== 'new' || !removed.has(entry.key),
    );
    this.showOrder();
  }
  private showOrder(offset = this.view.orderOffset): void {
    const safe = Math.min(
      Math.max(0, offset),
      Math.max(0, Math.floor((this.order.length - 1) / 50) * 50),
    );
    this.update({
      order: this.order.slice(safe, safe + 50),
      orderOffset: safe,
      orderCount: this.order.length,
      canPreviousOrder: safe > 0,
      canNextOrder: safe + 50 < this.order.length,
    });
  }
  pageOrder(direction: number): void {
    if ((direction === 1 || direction === -1) && this.editable())
      this.showOrder(this.view.orderOffset + direction * 50);
  }
  move(key: string, direction: string): void {
    if (!this.editable() || (direction !== 'up' && direction !== 'down'))
      return;
    const index = this.order.findIndex((entry) => entry.key === key),
      next = index + (direction === 'up' ? -1 : 1);
    if (index < 0 || next < 0 || next >= this.order.length) return;
    const order = [...this.order];
    [order[index], order[next]] = [order[next]!, order[index]!];
    this.order = order;
    this.showOrder();
  }
  private showBatch(offset = this.view.batchOffset): void {
    const children = this.detail ? this.children(this.detail.id) : [];
    this.update({
      batchChildren: children.slice(offset, offset + 50).map((c) => ({
        id: c.id,
        label: categoryLabel(c),
        state: c.businessState,
        action: this.batchActions.get(c.id) ?? 'retain',
      })),
      batchOffset: offset,
      canPreviousBatch: offset > 0,
      canNextBatch: offset + 50 < children.length,
    });
  }
  pageBatch(direction: number): void {
    if ((direction === 1 || direction === -1) && this.editable())
      this.showBatch(Math.max(0, this.view.batchOffset + direction * 50));
  }
  batchAction(id: string, raw: string): void {
    if (
      !this.editable() ||
      this.view.operation !== 'batch_update_subcategories_scoped' ||
      !['retain', 'disable', 'restore', 'enable'].includes(raw)
    )
      return;
    const child = this.children(this.detail!.id).find((c) => c.id === id);
    if (!child) return;
    if (
      (raw === 'disable' && child.businessState !== 'enabled') ||
      (raw === 'restore' && child.businessState !== 'archived') ||
      (raw === 'enable' && child.businessState !== 'disabled')
    )
      return;
    this.batchActions.set(id, raw as BatchAction);
    this.showBatch();
  }
  discardDraft(): void {
    if (!this.editable()) return;
    this.draftGeneration++;
    this.order = [];
    this.batchActions.clear();
    this.update({
      operation: '',
      operationLabel: '',
      name: '',
      description: '',
      nodes: [],
      order: [],
      batchChildren: [],
      placementCampuses: [],
      systemKey: '',
      preview: null,
      status: '未保存的本地改动已清空，未创建服务端请求',
    });
  }
  private placement(): RatingCategoryPlacement {
    return this.view.scopeKind === 'global'
      ? { kind: 'global' }
      : {
          kind: 'campuses',
          campusIds: this.view.placementCampuses.map((c) => c.id).sort(),
        };
  }
  private makeIntent(requestId: string): RatingCategoryScopedIntent {
    const context = this.context;
    if (!context || !this.view.operation) invalidRating();
    if (Date.parse(context.expiresAt) <= this.clock.now())
      throw new ClientError('business', 'Management context expired', {
        serverCode: 'RATING_SCOPED_CONTEXT_CHANGED',
      });
    const common = {
        clientRequestId: requestId,
        expectedSnapshot: context.snapshotRevision,
      },
      category = { ...common, categoryId: this.detail?.id };
    const nodes = this.view.nodes.map(
      ({ key, parentKey, name, description }) => ({
        key,
        parentKey,
        name: canonicalRatingText(name, 100),
        description: canonicalRatingText(description, 500, false),
      }),
    );
    const body = () => ({
      name: canonicalRatingText(this.view.name, 100),
      description: canonicalRatingText(this.view.description, 500, false),
    });
    let payload: unknown;
    switch (this.view.operation) {
      case 'create_categories_scoped':
        payload = {
          ...common,
          parentId: this.detail?.id ?? null,
          placement: this.placement(),
          nodes,
        };
        break;
      case 'edit_category_base_scoped':
        payload = { ...category, ...body() };
        break;
      case 'set_category_override_scoped':
        payload = {
          ...category,
          name:
            this.view.nameMode === 'inherit'
              ? { mode: 'inherit' }
              : {
                  mode: 'set',
                  value: canonicalRatingText(this.view.name, 100),
                },
          description:
            this.view.descriptionMode === 'inherit'
              ? { mode: 'inherit' }
              : {
                  mode: 'set',
                  value: canonicalRatingText(this.view.description, 500, false),
                },
        };
        break;
      case 'set_category_visibility_scoped':
        payload = { ...category, hidden: this.view.visibility === 'hidden' };
        break;
      case 'reorder_categories_scoped':
        payload = {
          ...common,
          parentId: this.detail?.parentId ?? null,
          action: this.view.orderMode,
          orderedIds:
            this.view.orderMode === 'inherit'
              ? []
              : this.order.map((entry) => entry.key),
        };
        break;
      case 'set_category_scope_scoped':
        payload = {
          ...category,
          placement: this.placement(),
          propagation: this.view.propagation,
        };
        break;
      case 'set_category_lifecycle_scoped': {
        const action = this.view.lifecycleAction;
        if (
          !this.view.lifecycleActions.some(
            (entry) => entry.value === action && entry.allowed,
          )
        )
          invalidRating();
        payload = {
          ...category,
          state:
            action === 'enable'
              ? 'enabled'
              : action === 'archive'
                ? 'archived'
                : 'disabled',
          restore: action === 'restore',
        };
        break;
      }
      case 'batch_update_subcategories_scoped': {
        const selected = (action: BatchAction) =>
          [...this.batchActions]
            .filter(([, value]) => value === action)
            .map(([id]) => id)
            .sort();
        payload = {
          ...common,
          parentId: this.detail?.id,
          addNodes: nodes,
          disableIds: selected('disable'),
          restoreIds: selected('restore'),
          enableIds: selected('enable'),
          orderedChildren: this.order.map((entry) =>
            entry.kind === 'existing'
              ? { kind: 'existing', id: entry.key }
              : { kind: 'new', key: entry.key },
          ),
        };
        break;
      }
      case 'create_system_category_scoped': {
        const option = this.systemOptions.find(
          (item) => item.systemKey === this.view.systemKey,
        );
        if (!option || this.view.levelCount > option.maximumDepth)
          invalidRating();
        payload = {
          ...common,
          ...body(),
          systemKey: this.view.systemKey,
          placement: this.placement(),
          levelCount: this.view.levelCount,
        };
        break;
      }
    }
    return decodeRatingCategoryScopedIntent({
      protocolVersion: 2,
      context: context.commandContext,
      operation: this.view.operation,
      payload,
    });
  }
  async prepare(): Promise<void> {
    if (!this.editable() || !this.view.operation) return;
    // Check the single slot again immediately before issuing a new ID.
    const context = this.context,
      generation = this.draftGeneration,
      owner = this.runtime.sessions.snapshot(),
      accountId = this.accountId()!;
    try {
      if (this.runtime.pendingRatings!.load(accountId)) {
        this.journal();
        return;
      }
    } catch (error) {
      this.failure(error);
      return;
    }
    await this.run(
      async (cancel) => {
        const requestId = await this.runtime.newRequestId();
        this.runtime.sessions.assertCurrent(owner);
        if (
          cancel.isCancelled ||
          generation !== this.draftGeneration ||
          context !== this.context
        )
          throw new ClientError(
            'cancelled',
            'Draft changed before persistence',
          );
        let intent: RatingCategoryScopedIntent;
        try {
          intent = this.makeIntent(requestId);
        } catch (error) {
          if (error instanceof ClientError && error.kind === 'protocol')
            throw new ClientError('business', 'Invalid category draft', {
              serverCode: 'CATEGORY_DRAFT_INVALID',
            });
          throw error;
        }
        if (
          ratingCategoryScopedRequestBodyBytes(intent).maximum >
          RATING_CATEGORY_SCOPED_DRAFT_BODY_BUDGET
        )
          throw new ClientError(
            'business',
            'Complete category request exceeds the safe body budget',
            {
              serverCode: 'CATEGORY_DRAFT_TOO_LARGE',
            },
          );
        const attempt = this.runtime.pendingRatings!.freeze({
          version: 10,
          accountId,
          intent,
        });
        this.showPending(attempt);
        const result = decodeRatingCategoryScopedPrepared(
          await this.runtime.ratingCategoryScoped!.prepare(intent, cancel),
        );
        if ('outcome' in result)
          matchRatingCategoryScopedReceipt(intent, result);
        else matchRatingCategoryScopedPreparation(intent, result);
        return result;
      },
      (result) => {
        if ('outcome' in result) this.settle(result);
        else this.acceptPreview(result);
      },
      (error) => this.failure(error),
    );
  }
  private acceptPreview(prepared: RatingCategoryScopedPreparation): void {
    if (!this.pending || !isRatingCategoryScopedIntent(this.pending.intent))
      invalidRating();
    matchRatingCategoryScopedPreparation(this.pending.intent, prepared);
    this.expiry?.();
    this.expiry = this.clock.schedule(
      () => this.invalidate(),
      Math.max(0, Date.parse(prepared.expiresAt) - this.clock.now()),
    );
    this.prepared = prepared;
    this.showPreview(0);
    this.update({
      status: '原请求已准备，尚未提交。请核对全部影响范围与变更摘要后确认',
      error: '',
    });
  }
  private showPreview(offset: number): void {
    const p = this.prepared;
    if (!p || !this.pending) return;
    const lines = [
      p.summary,
      `完整预览摘要：${p.previewDigest}`,
      `涉及分类 ${p.categoryIds.length} 项、范围 ${p.affectedScopeKeys.length} 个、来源变更 ${p.changedSourceCount} 项、受影响评分对象 ${p.affectedTargetCount} 个。`,
      ...p.affectedScopeKeys.map(
        (scope) => `影响范围：${previewScopeLabel(scope)}`,
      ),
      ...p.changes
        .slice(offset, offset + 20)
        .map(
          (change) =>
            `${change.categoryId} · ${previewFieldLabels[change.field]} · ${change.scopeKeys.map(previewScopeLabel).join('、')}：变更前${previewValue(change.field, change.before, change.beforeStatus)} → 变更后${previewValue(change.field, change.after, change.afterStatus)}`,
        ),
    ];
    this.update({
      preview: {
        operationLabel: ratingCommandLabels[this.pending.intent.operation],
        validUntil: p.expiresAt,
        lines,
        changeCount: p.changes.length,
        from: Math.min(offset + 1, p.changes.length),
        to: Math.min(offset + 20, p.changes.length),
        canPrevious: offset > 0,
        canNext: offset + 20 < p.changes.length,
      },
    });
  }
  pagePreview(direction: number): void {
    if (
      (direction === 1 || direction === -1) &&
      !this.view.busy &&
      this.view.preview
    )
      this.showPreview(
        Math.max(0, this.view.preview.from - 1 + direction * 20),
      );
  }
  closePreview(): void {
    if (this.view.busy) return;
    this.prepared = null;
    this.update({
      preview: null,
      status: '预览已关闭，原请求仍受保护；可恢复预览或明确取消原请求',
    });
  }
  async preparePending(): Promise<void> {
    if (
      this.view.busy ||
      !this.journal() ||
      !this.pending ||
      !isRatingCategoryScopedIntent(this.pending.intent)
    )
      return;
    const attempt = this.pending,
      intent = this.pending.intent;
    await this.run(
      async (cancel) => {
        this.runtime.pendingRatings!.assertOriginal(attempt);
        const result = decodeRatingCategoryScopedPrepared(
          await this.runtime.ratingCategoryScoped!.prepare(intent, cancel),
        );
        if ('outcome' in result)
          matchRatingCategoryScopedReceipt(intent, result);
        else matchRatingCategoryScopedPreparation(intent, result);
        return result;
      },
      (result) => {
        if ('outcome' in result) this.settle(result);
        else this.acceptPreview(result);
      },
      (error) => this.failure(error),
    );
  }
  async commit(): Promise<void> {
    if (
      this.inactive ||
      this.view.busy ||
      !this.view.preview ||
      !this.prepared ||
      !this.pending ||
      !isRatingCategoryScopedIntent(this.pending.intent) ||
      !this.available()
    )
      return;
    const attempt = this.pending,
      intent = this.pending.intent,
      prepared = this.prepared;
    if (Date.parse(prepared.expiresAt) <= this.clock.now()) {
      this.prepared = null;
      this.update({
        preview: null,
        error: '这份预览已过期，请恢复原请求预览后重新确认',
      });
      return;
    }
    await this.run(
      async (cancel) => {
        this.runtime.pendingRatings!.assertOriginal(attempt);
        return this.runtime.ratingCategoryScoped!.commit(
          intent,
          prepared,
          cancel,
        );
      },
      (receipt) => this.settle(receipt),
      (error) => this.failure(error),
    );
  }
  async recover(): Promise<void> {
    if (this.view.busy || !this.journal() || !this.pending) return;
    const attempt = this.pending;
    await this.run(
      (cancel) => runRatingCommand(this.runtime, attempt, cancel, false),
      (receipt) => this.settle(receipt),
      (error) => this.failure(error),
    );
  }
  requestCancel(): void {
    if (
      !this.inactive &&
      !this.view.busy &&
      this.pending &&
      isRatingCategoryScopedIntent(this.pending.intent)
    )
      this.update({ cancelConfirmation: true });
  }
  dismissCancel(): void {
    if (!this.view.busy) this.update({ cancelConfirmation: false });
  }
  async confirmCancel(): Promise<void> {
    if (
      this.view.busy ||
      !this.view.cancelConfirmation ||
      !this.pending ||
      !isRatingCategoryScopedIntent(this.pending.intent) ||
      !this.available()
    )
      return;
    const attempt = this.pending,
      intent = this.pending.intent;
    this.prepared = null;
    this.update({ cancelConfirmation: false, preview: null });
    await this.run(
      async (cancel) => {
        this.runtime.pendingRatings!.assertOriginal(attempt);
        return this.runtime.ratingCategoryScoped!.cancel(intent, cancel);
      },
      (receipt) => this.settle(receipt),
      (error) => this.failure(error),
    );
  }
  private settle(raw: RatingCommandReceipt): void {
    const pending = this.pending;
    if (!pending || pending.accountId !== this.accountId()) invalidRating();
    this.settling = true;
    let receipt: RatingCommandReceipt;
    try {
      receipt = settleRatingCommand(this.runtime, pending, raw);
    } finally {
      this.settling = false;
    }
    this.resetPrivate();
    this.update({
      ...initialRatingCategoryScopedView(),
      editorPage: this.editorPage,
      configured: this.configured(),
      hasSession: !!this.accountId(),
      needsRefresh: true,
      receiptStatus:
        receipt.outcome === 'closed' || receipt.outcome === 'rejected'
          ? ratingCategoryScopedError(
              new ClientError('business', 'Original request closed', {
                serverCode: receipt.code,
              }),
            )
          : `${ratingCommandLabels[receipt.operation]}回执已确认`,
      status: '历史回执不代表当前可见性或管理资格。重新加载后可发起新的变更。',
    });
  }
  private failure(error: unknown): void {
    const storage = error instanceof ClientError && error.kind === 'storage';
    if (storage) {
      this.context = null;
      this.all = [];
      this.detail = null;
      this.prepared = null;
      this.order = [];
      this.batchActions.clear();
      this.update({
        ...initialRatingCategoryScopedView(),
        editorPage: this.editorPage,
        configured: this.configured(),
        hasSession: !!this.accountId(),
        frozen: true,
      });
    }
    this.update({
      error: ratingCategoryScopedError(error),
      status:
        this.pending || this.view.frozen
          ? '结果待确认；原请求与编号保留，不能修改后换编号重发'
          : '尚未发送；检查输入或重新核验范围后再准备',
    });
  }
  async history(more = false): Promise<void> {
    if (
      !this.editable() ||
      !this.detail ||
      !this.context ||
      (more && !this.historyCursor)
    )
      return;
    const context = this.context,
      categoryId = this.detail.id,
      cursor = more ? this.historyCursor : null;
    await this.run(
      (cancel) =>
        this.runtime.ratingCategoryScoped!.history(
          context,
          categoryId,
          cursor,
          cancel,
        ),
      (result) => {
        if (!more) {
          this.seenHistory.clear();
          this.update({ history: [] });
        }
        for (const item of result.items) {
          if (this.seenHistory.has(item.requestId)) invalidRating();
          this.seenHistory.add(item.requestId);
        }
        this.historyCursor = result.nextCursor;
        this.update({
          history: [
            ...result.items.map((item) => ({
              requestId: item.requestId,
              occurredAt: item.occurredAt,
              label: `${ratingCommandLabels[item.operation]} · ${item.outcome}`,
            })),
          ],
          canMoreHistory: result.nextCursor !== null,
        });
      },
      (error) => this.failure(error),
    );
  }
  async openCampusPicker(
    purpose: 'view' | 'placement' = 'view',
  ): Promise<void> {
    if (!this.available() || this.view.busy || this.view.frozen) return;
    if (purpose === 'placement' && !this.editable()) return;
    this.update({
      pickerOpen: true,
      pickerPurpose: purpose,
      campusQuery: '',
      campuses: [],
      hasMoreCampuses: false,
    });
    await this.searchCampuses(1);
  }
  setCampusQuery(value: string): void {
    if (!this.view.pickerOpen) return;
    this.stop();
    this.update({
      busy: false,
      campusQuery: value,
      campuses: [],
      hasMoreCampuses: false,
    });
  }
  async searchCampuses(page = 1): Promise<void> {
    if (
      !this.available() ||
      !this.view.pickerOpen ||
      !this.runtime.profiles ||
      !Number.isSafeInteger(page) ||
      page < 1
    )
      return;
    const q = this.view.campusQuery.trim();
    await this.run(
      (cancel) =>
        this.runtime.profiles!.campuses(
          { page, pageSize: 20, q, district: '' },
          cancel,
        ),
      (raw) => {
        const result = decodeCampusPage(raw);
        this.update({
          campuses: result.items,
          campusPage: page,
          hasMoreCampuses: page * result.pageSize < result.total,
        });
      },
    );
  }
  closeCampusPicker(): void {
    this.stop();
    this.update({
      busy: false,
      pickerOpen: false,
      campuses: [],
      campusQuery: '',
      hasMoreCampuses: false,
    });
  }
  async selectCampus(id: string | null): Promise<void> {
    if (this.inactive || this.view.busy || this.view.frozen) return;
    const campus =
      id === null
        ? null
        : this.view.campuses.find((c) => c.id === id && c.isActive);
    if (id !== null && !campus) return;
    if (
      this.view.pickerOpen &&
      this.view.pickerPurpose === 'placement' &&
      campus
    ) {
      if (
        !this.context ||
        (!this.context.canManageGlobal &&
          !this.context.campusIds.includes(campus.id))
      ) {
        this.update({ error: '当前管理授权不包含这个校园' });
        return;
      }
      if (!this.view.placementCampuses.some((c) => c.id === campus.id))
        this.update({
          scopeKind: 'campuses',
          placementCampuses: [
            ...this.view.placementCampuses,
            { id: campus.id, label: campus.fullName },
          ].sort((a, b) => a.id.localeCompare(b.id)),
          error: '',
        });
      return;
    }
    await this.load(
      id === null ? { scope: 'global' } : { scope: 'campus', campusId: id },
    );
  }
  removePlacementCampus(id: string): void {
    if (this.editable())
      this.update({
        placementCampuses: this.view.placementCampuses.filter(
          (c) => c.id !== id,
        ),
      });
  }
  navigationPath(categoryId: string | null, editor = false): string | null {
    if (
      !this.editable() ||
      !this.route ||
      (categoryId !== null && !this.all.some((c) => c.id === categoryId))
    )
      return null;
    return ratingCategoryScopedPath(
      { selector: this.route.selector, categoryId },
      editor,
    );
  }
  currentEditorPath(): string | null {
    return this.navigationPath(this.route?.categoryId ?? null, true);
  }
  catalogPath(): string | null {
    if (!this.route)
      return '/pages/rating-scoped/rating-scoped?mode=catalog&scope=global';
    return `/pages/rating-scoped/rating-scoped?mode=catalog&${Object.entries(
      ratingCategoryScopedQuery({
        selector: this.route.selector,
        categoryId: null,
      }),
    )
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('&')}`;
  }
  override cancel(): void {
    this.stop();
    this.resetPrivate();
    this.update({
      ...initialRatingCategoryScopedView(),
      editorPage: this.editorPage,
      configured: this.configured(),
      hasSession: !!this.accountId(),
      needsRefresh: true,
      status: '已停止等待并清空本地草稿；已保存的原请求仍需查询或取消',
    });
  }
  override dispose(): void {
    if (this.inactive) return;
    this.inactive = true;
    for (const unsubscribe of this.unsubscriptions) unsubscribe();
    super.dispose();
  }
}
