import {
  AssistanceController,
  initialAssistanceView,
  type AssistanceView,
} from './assistance-controller';
import type { AssistanceInput } from './assistance-contract';
import { CategoryIconCoordinator } from './category-icon-coordinator';
import {
  CategoryIconReader,
  type CategoryIconReadView,
} from './category-icon-reader';
import {
  categoryIconDraftSlots,
  type CategoryIconSelection,
} from './category-icon-draft';
import {
  decodeRatingManagedIconCategories,
  decodeRatingManagedIconCategory,
  type RatingCategoryIconContext,
  type RatingCategoryIconPreparation,
  type RatingCategoryIconReceipt,
  type RatingManagedIconCategory,
  type CategoryIconState,
} from './category-icon-contract';
import {
  ratingCategoryIconRetirementCandidates,
  type RatingCategoryIconRetirementStatusRequest,
  type RatingCategoryIconRetirementStatus,
} from './category-icon-contract';
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
import { canonicalRatingText, invalidRating, ratingId } from './contract';
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
interface IconRetirementItem {
  readonly appearanceId: string;
  readonly state:
    | 'unknown'
    | 'cleanup_pending'
    | RatingCategoryIconRetirementStatus['items'][number]['state'];
}
interface IconRetirementView {
  readonly requestId: string;
  readonly status: string;
  readonly items: readonly {
    readonly appearanceId: string;
    readonly label: string;
    readonly canCleanup: boolean;
  }[];
  readonly count: number;
  readonly from: number;
  readonly to: number;
  readonly canPrevious: boolean;
  readonly canNext: boolean;
}
export interface RatingCategoryScopedView extends CommunityView {
  readonly assistance: AssistanceView;
  readonly iconEnabled: boolean;
  readonly iconFrozen: boolean;
  readonly iconProgress: number;
  readonly iconUploadStatus: string;
  readonly iconRead: CategoryIconReadView;
  readonly iconBaseLabel: string;
  readonly iconOverrideLabel: string;
  readonly iconEffectiveLabel: string;
  readonly iconRetirement: IconRetirementView | null;
  readonly iconRetirementRecoveryRequestId: string;
  readonly iconSlots: readonly {
    key: string;
    label: string;
    selection: CategoryIconSelection;
    status: string;
    canKeep: boolean;
    isOverride: boolean;
  }[];
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
    assistance: initialAssistanceView(),
    iconEnabled: false,
    iconFrozen: false,
    iconProgress: 0,
    iconUploadStatus: '',
    iconRead: { key: '', localSrc: '', state: 'idle' },
    iconBaseLabel: '',
    iconOverrideLabel: '',
    iconEffectiveLabel: '',
    iconSlots: [],
    iconRetirement: null,
    iconRetirementRecoveryRequestId: '',
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
  private readonly assistance: AssistanceController;
  private assistanceNodeKey: string | null = null;
  private route: RatingCategoryScopedRoute | null = null;
  private context:
    RatingCategoryScopedContext | RatingCategoryIconContext | null = null;
  private readonly iconChoices = new Map<string, CategoryIconSelection>();
  private readonly iconCoordinator: CategoryIconCoordinator;
  private readonly iconReader: CategoryIconReader;
  private iconPrepared: RatingCategoryIconPreparation | null = null;
  private iconPreviewOffset = 0;
  private iconRetirementScope: RatingCategoryIconRetirementStatusRequest | null =
    null;
  private iconRetirementItems: readonly IconRetirementItem[] = [];
  private iconRetirementOffset = 0;
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
    this.assistance = new AssistanceController(
      runtime,
      (assistance) => this.update({ assistance }),
      () => this.editable(),
      clock,
    );
    this.iconCoordinator = new CategoryIconCoordinator(runtime, clock, (view) =>
      this.update({
        iconProgress: view.progress,
        iconUploadStatus: view.status,
      }),
    );
    this.iconReader = new CategoryIconReader(
      runtime.sessions,
      runtime.ratingCategoryIconDownload,
      clock,
      (iconRead) => this.update({ iconRead }),
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
  protected override update(patch: Partial<RatingCategoryScopedView>): void {
    const changing = [
      'name',
      'description',
      'nodes',
      'scopeKind',
      'placementCampuses',
      'systemKey',
      'levelCount',
      'operation',
      'frozen',
      'iconFrozen',
    ] as const;
    if (
      this.assistance &&
      changing.some(
        (key) =>
          key in patch &&
          JSON.stringify(patch[key]) !== JSON.stringify(this.view[key]),
      )
    ) {
      this.assistance.invalidate();
      this.assistanceNodeKey = null;
    }
    super.update(patch);
  }
  async generateDescription(nodeKey?: string): Promise<void> {
    if (!this.editable() || !this.context || this.detail) return;
    const operation = this.view.operation;
    if (
      operation !== 'create_categories_scoped' &&
      operation !== 'create_system_category_scoped'
    )
      return;
    const node =
      operation === 'create_categories_scoped'
        ? this.view.nodes.find(
            (item) =>
              item.key === nodeKey &&
              item.parentKey === null &&
              item.level === 1,
          )
        : null;
    if (operation === 'create_categories_scoped' && !node) return;
    const name =
      operation === 'create_system_category_scoped'
        ? this.view.name
        : node!.name;
    try {
      const common = {
        draftNodeKey: node?.key ?? 'system_root',
        name: canonicalRatingText(name, 100),
        placement: this.placement(),
        expectedSnapshot: this.context.snapshotRevision,
      };
      const input: AssistanceInput = {
        purpose: 'category_description',
        selector: this.context.commandContext.selector,
        context: this.context.commandContext,
        payload:
          operation === 'create_categories_scoped'
            ? { ...common, operation, parentId: null }
            : {
                ...common,
                operation,
                systemKey: this.view.systemKey,
                levelCount: this.view.levelCount,
              },
      };
      this.assistanceNodeKey = node?.key ?? null;
      await this.assistance.generate(input);
    } catch (error) {
      this.failure(error);
    }
  }
  async adoptDescription(): Promise<void> {
    const nodeKey = this.assistanceNodeKey;
    await this.assistance.adopt((text) => {
      if (this.view.operation === 'create_system_category_scoped')
        this.setText('description', text);
      else if (nodeKey) this.setNodeText(nodeKey, 'description', text);
    });
  }
  recoverAssistance(): Promise<void> {
    return this.assistance.recover();
  }
  cancelAssistance(): Promise<void> {
    return this.assistance.cancel();
  }
  dismissAssistance(): void {
    this.assistance.dismiss();
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
    this.assistance?.invalidate();
    this.assistanceNodeKey = null;
    this.iconCoordinator?.hide();
    this.iconReader?.clear();
    this.iconChoices?.clear();
    this.iconPrepared = null;
    this.iconRetirementScope = null;
    this.iconRetirementItems = [];
    this.iconRetirementOffset = 0;
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
      if (
        this.runtime.pendingRatingCategoryIcon &&
        this.iconCoordinator.state()
      ) {
        this.showIconPending();
        return true;
      }
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
    this.assistance.refresh();
    // Recovery deliberately precedes route and current authority/source validation.
    if (!this.journal()) return;
    this.assistance.refresh();
    if (this.pending || this.view.iconFrozen) {
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
          context = this.runtime.ratingCategoryIcon
            ? (
                await this.runtime.ratingCategoryIcon.entryContext(
                  route.selector,
                  cancel,
                )
              ).context
            : decodeRatingCategoryScopedContext(
                await gateway.context(route.selector, cancel),
              );
        if (
          ratingNavigationKey(context.commandContext.selector) !==
            ratingNavigationKey(route.selector) ||
          Date.parse(context.expiresAt) <= this.clock.now()
        )
          invalidRating();
        const catalog =
          context.protocolVersion === 5
            ? decodeRatingManagedIconCategories(
                await this.runtime.ratingCategoryIcon!.categories(
                  context,
                  cancel,
                ),
              )
            : decodeRatingManagedCategories(
                await gateway.categories(context, cancel),
              );
        if (catalog.snapshotRevision !== context.snapshotRevision)
          invalidRating();
        const detail =
          route.categoryId === null
            ? null
            : context.protocolVersion === 5
              ? decodeRatingManagedIconCategory(
                  await this.runtime.ratingCategoryIcon!.category(
                    context,
                    route.categoryId,
                    cancel,
                  ),
                )
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
            options = (
              context.protocolVersion === 5
                ? await this.runtime.ratingCategoryIcon!.systemOptions(
                    context,
                    cancel,
                  )
                : await gateway.systemOptions(context, cancel)
            ).items;
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
          iconEnabled: context.protocolVersion === 5,
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
        this.showIconDetail();
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
    this.iconChoices.clear();
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
    this.refreshIconSlots();
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
    if (
      this.editable() &&
      this.view.iconEnabled &&
      this.detail &&
      this.context?.commandContext.selector.kind === 'campus'
    ) {
      this.iconChoices.set(
        `override:${this.detail.id}:${this.context.commandContext.selector.campusId}`,
        'inherit',
      );
      this.refreshIconSlots();
    }
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
    this.refreshIconSlots();
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
    for (const removedKey of removed)
      this.iconChoices.delete(`new:${removedKey}`);
    this.refreshIconSlots();
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
  private iconStateLabel(value: CategoryIconState): string {
    return value.state === 'image'
      ? '已设置图标'
      : value.state === 'absent'
        ? '明确无图'
        : value.state === 'inherit'
          ? '继承共享基础'
          : '不可用（不代表无图）';
  }
  private showIconDetail(): void {
    const detail = this.detail as RatingManagedIconCategory | null;
    if (!detail?.icon) return;
    this.update({
      iconBaseLabel: this.iconStateLabel(detail.icon.base),
      iconOverrideLabel:
        detail.icon.override.mode === 'inherit'
          ? '继承共享基础'
          : `本校园设置：${this.iconStateLabel(detail.icon.override.state)}`,
      iconEffectiveLabel: this.iconStateLabel(detail.icon.effective),
    });
  }
  private refreshIconSlots(): void {
    if (!this.view.iconEnabled) return;
    const operation = this.view.operation,
      detail = this.detail as RatingManagedIconCategory | null,
      campus = this.context?.commandContext.selector;
    const values: {
      key: string;
      label: string;
      selection: CategoryIconSelection;
      status: string;
      canKeep: boolean;
      isOverride: boolean;
    }[] = [];
    const add = (
      key: string,
      label: string,
      fallback: CategoryIconSelection,
      canKeep = false,
      isOverride = false,
    ) =>
      values.push({
        key,
        label,
        selection: this.iconChoices.get(key) ?? fallback,
        status: '尚未冻结',
        canKeep,
        isOverride,
      });
    if (
      operation === 'create_categories_scoped' ||
      operation === 'batch_update_subcategories_scoped'
    )
      for (const node of this.view.nodes)
        add(
          `new:${node.key}`,
          `节点 ${node.key} · ${node.name || '未填写名称'}`,
          'clear',
        );
    else if (operation === 'create_system_category_scoped')
      add('new:root', '系统根分类图标', 'clear');
    else if (operation === 'edit_category_base_scoped' && detail)
      add(`base:${detail.id}`, '共享基础图标', 'keep', true);
    else if (
      operation === 'set_category_override_scoped' &&
      detail &&
      campus?.kind === 'campus'
    ) {
      const value = detail.icon?.override;
      add(
        `override:${detail.id}:${campus.campusId}`,
        '本校园图标',
        value?.mode === 'set'
          ? value.state.state === 'absent'
            ? 'set-empty'
            : 'keep'
          : 'inherit',
        value?.mode === 'set',
        true,
      );
    }
    this.update({ iconSlots: values });
  }
  chooseIcon(key: string, selection: string): void {
    if (!this.editable() || !this.view.iconEnabled) return;
    const slot = this.view.iconSlots.find((s) => s.key === key);
    if (!slot) return;
    const allowed = slot.isOverride
      ? ['inherit', 'set-empty', 'replace', ...(slot.canKeep ? ['keep'] : [])]
      : ['clear', 'replace', ...(slot.canKeep ? ['keep'] : [])];
    if (!allowed.includes(selection)) return;
    this.iconChoices.set(key, selection as CategoryIconSelection);
    this.refreshIconSlots();
  }
  private showIconPending(): void {
    const state = this.iconCoordinator.state();
    if (!state) return;
    this.expiry?.();
    this.expiry = null;
    this.pending = null;
    this.prepared = null;
    this.context = null;
    this.detail = null;
    this.all = [];
    this.iconReader.clear();
    const text = state.command?.intent ?? state.uploads?.identity.textIntent;
    if (text) {
      const p = text.payload;
      this.route = {
        selector: text.context.selector,
        categoryId:
          'categoryId' in p
            ? p.categoryId
            : 'parentId' in p
              ? p.parentId
              : null,
      };
    }
    this.update({
      frozen: true,
      iconFrozen: true,
      iconEnabled: true,
      isCategoryPending: true,
      requestId: state.requestId,
      recoveryOperation: state.opaque
        ? '原分类图标请求'
        : ratingCommandLabels[state.operation],
      iconSlots:
        state.uploads?.identity.slots.map((slot) => ({
          key: slot.key,
          label: slot.nodeKey
            ? `节点 ${slot.nodeKey}`
            : slot.kind === 'base'
              ? '共享基础图标'
              : '本校园图标',
          selection: slot.selection,
          status:
            slot.selection !== 'replace'
              ? '无需上传'
              : (state.uploads!.members.find((m) => m.slotKey === slot.key)
                  ?.state ?? '等待选择原图'),
          canKeep: false,
          isOverride: slot.kind === 'override',
        })) ?? [],
      status: state.opaque
        ? '原账号请求已保留最小恢复信息；先核对业务回执，再关闭未完成的上传'
        : '文字、范围及全部图标槽位已冻结。逐个上传选定图标后核对同一笔完整变更。',
    });
  }
  private async prepareIconDraft(): Promise<void> {
    if (
      !this.editable() ||
      this.context?.protocolVersion !== 5 ||
      !this.view.operation
    )
      return;
    const context = this.context,
      generation = this.draftGeneration,
      owner = this.runtime.sessions.snapshot();
    await this.run(
      async (cancel) => {
        if (this.iconCoordinator.state())
          throw new ClientError(
            'storage',
            'Original Category icon request remains',
          );
        const requestId = await this.runtime.newRequestId(),
          draftRevision = await this.runtime.newRequestId();
        this.runtime.sessions.assertCurrent(owner);
        if (
          cancel.isCancelled ||
          generation !== this.draftGeneration ||
          context !== this.context
        )
          throw new ClientError('cancelled', 'Category draft changed');
        const text = this.makeIntent(requestId),
          choices = new Map(
            this.view.iconSlots.map((slot) => [slot.key, slot.selection]),
          ),
          slots = categoryIconDraftSlots(text, choices);
        this.iconCoordinator.start(
          text,
          context.mediaSnapshot,
          draftRevision,
          slots,
        );
        this.showIconPending();
        return slots.some((slot) => slot.selection === 'replace')
          ? null
          : this.iconCoordinator.prepare(cancel);
      },
      (result) => {
        if (result) {
          if ('outcome' in result) this.iconSettled(result);
          else this.acceptIconPreview(result);
        } else this.showIconPending();
      },
      (error) => this.failure(error),
    );
  }
  async uploadIcon(key: string): Promise<void> {
    if (this.view.busy || !this.view.iconFrozen) return;
    await this.run(
      (cancel) => this.iconCoordinator.append(key, cancel),
      () => {
        this.showIconPending();
        this.update({
          status: '该节点图标已就绪并释放本地文件；继续其他节点或核对完整预览',
        });
      },
      (error) => this.failure(error),
    );
  }
  private async prepareIconPending(): Promise<void> {
    if (this.view.busy) return;
    await this.run(
      (cancel) => this.iconCoordinator.prepare(cancel),
      (result) => {
        if ('outcome' in result) this.iconSettled(result);
        else this.acceptIconPreview(result);
      },
      (error) => this.failure(error),
    );
  }
  private acceptIconPreview(prepared: RatingCategoryIconPreparation): void {
    const command = this.iconCoordinator.state()?.command;
    if (!command) invalidRating();
    this.iconPrepared = prepared;
    this.expiry?.();
    this.expiry = this.clock.schedule(
      () => this.invalidate(),
      Math.max(0, Date.parse(prepared.expiresAt) - this.clock.now()),
    );
    this.showIconPreview(0);
    this.update({
      status:
        '全部正文和图标已准备，尚未发布。确认绑定完整预览摘要与所有影响范围。',
      error: '',
    });
  }
  private showIconPreview(offset: number): void {
    const p = this.iconPrepared,
      state = this.iconCoordinator.state();
    if (!p || !state) return;
    const entries = [
      ...p.affectedScopeKeys.map(
        (scope) => `影响范围：${previewScopeLabel(scope)}`,
      ),
      ...p.changes.map(
        (change) =>
          `${change.categoryId} · ${previewFieldLabels[change.field]} · ${change.scopeKeys.map(previewScopeLabel).join('、')}：${previewValue(change.field, change.before, change.beforeStatus)} → ${previewValue(change.field, change.after, change.afterStatus)}`,
      ),
      ...p.iconChanges.map(
        (change) =>
          `${change.categoryId} · ${change.kind === 'base' ? '共享基础图标' : `校园 ${change.campusId} 图标`}：${this.iconStateLabel(change.before)} → ${this.iconStateLabel(change.after)}`,
      ),
    ];
    this.iconPreviewOffset = Math.min(
      offset,
      Math.max(0, Math.floor((entries.length - 1) / 20) * 20),
    );
    this.update({
      preview: {
        operationLabel: ratingCommandLabels[state.operation],
        validUntil: p.expiresAt,
        lines: [
          p.summary,
          `完整预览摘要：${p.previewDigest}`,
          `涉及分类 ${p.categoryIds.length} 项、范围 ${p.affectedScopeKeys.length} 个、图标变更 ${p.changedIconCount} 项、受影响对象 ${p.affectedTargetCount} 个。`,
          ...entries.slice(this.iconPreviewOffset, this.iconPreviewOffset + 20),
        ],
        changeCount: entries.length,
        from: Math.min(this.iconPreviewOffset + 1, entries.length),
        to: Math.min(this.iconPreviewOffset + 20, entries.length),
        canPrevious: this.iconPreviewOffset > 0,
        canNext: this.iconPreviewOffset + 20 < entries.length,
      },
    });
  }
  private iconSettled(receipt: RatingCategoryIconReceipt | null): void {
    const prepared = this.iconPrepared;
    this.settling = true;
    try {
      if (receipt && receipt.outcome !== 'closed' && receipt.result.releaseId)
        this.runtime.ratingCatalogChanges?.publish({
          releaseId: receipt.result.releaseId,
          catalogs: [],
          scopedHeads: receipt.result.heads,
        });
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
      receiptStatus: receipt
        ? receipt.outcome === 'closed'
          ? '原分类请求已关闭，上传恢复义务已核验'
          : `${ratingCommandLabels[receipt.operation]}回执及图标绑定已确认`
        : '未提交的图标草稿与上传已确认关闭',
      status: '历史回执不代表当前可见性。重新加载后可开始新的变更。',
    });
    if (receipt?.outcome === 'applied')
      this.beginIconRetirement(receipt, prepared);
  }
  private beginIconRetirement(
    receipt: RatingCategoryIconReceipt,
    prepared: RatingCategoryIconPreparation | null,
  ): void {
    if (receipt.outcome !== 'applied') return;
    const ids =
      prepared?.requestId === receipt.requestId
        ? ratingCategoryIconRetirementCandidates(prepared)
        : [];
    this.iconRetirementScope =
      ids.length > 0 && ids.length <= 256
        ? { requestId: receipt.requestId, appearanceIds: ids }
        : { requestId: receipt.requestId };
    this.iconRetirementItems = ids.map((appearanceId) => ({
      appearanceId,
      state: 'unknown',
    }));
    this.iconRetirementOffset = 0;
    this.showIconRetirement(
      '原分类变更已应用。旧图尚未清理；请先查询，再明确选择可清理项。',
    );
  }
  private showIconRetirement(status?: string): void {
    const scope = this.iconRetirementScope;
    if (!scope) return;
    const labels: Record<IconRetirementItem['state'], string> = {
      unknown: '尚未核验',
      eligible: '当前可请求清理',
      held: '仍被引用或保留，暂不能清理',
      retired: '旧图引用已退役（不代表文件已物理删除）',
      cleanup_pending: '清理已排队，等待再次核验',
    };
    this.iconRetirementOffset = Math.min(
      this.iconRetirementOffset,
      Math.max(0, Math.floor((this.iconRetirementItems.length - 1) / 20) * 20),
    );
    const offset = this.iconRetirementOffset;
    this.update({
      iconRetirement: {
        requestId: scope.requestId,
        status:
          status ??
          this.view.iconRetirement?.status ??
          '查询此原请求的旧图状态',
        items: this.iconRetirementItems
          .slice(offset, offset + 20)
          .map((item) => ({
            appearanceId: item.appearanceId,
            label: labels[item.state],
            canCleanup: item.state === 'eligible',
          })),
        count: this.iconRetirementItems.length,
        from: Math.min(offset + 1, this.iconRetirementItems.length),
        to: Math.min(offset + 20, this.iconRetirementItems.length),
        canPrevious: offset > 0,
        canNext: offset + 20 < this.iconRetirementItems.length,
      },
    });
  }
  setIconRetirementRecoveryRequestId(value: string): void {
    if (!this.view.busy)
      this.update({ iconRetirementRecoveryRequestId: value.slice(0, 64) });
  }
  async recoverIconRetirement(rawRequestId?: string): Promise<void> {
    if (!this.available() || this.view.busy) return;
    if (!this.runtime.ratingCategoryIcon) {
      this.update({ error: '当前构建未配置分类图标恢复服务' });
      return;
    }
    const requestId = (
      rawRequestId ?? this.view.iconRetirementRecoveryRequestId
    ).trim();
    if (!ratingId(requestId)) {
      this.update({ error: '请填写原分类变更的完整请求编号' });
      return;
    }
    this.iconRetirementScope = { requestId };
    this.iconRetirementItems = [];
    this.iconRetirementOffset = 0;
    this.showIconRetirement(
      '先查询原分类回执，再核验原请求记录的旧图；不会重新提交分类变更。',
    );
    await this.inspectIconRetirement();
  }
  async inspectIconRetirement(): Promise<void> {
    if (!this.available() || this.view.busy || !this.iconRetirementScope)
      return;
    const scope = this.iconRetirementScope,
      status = this.view.status;
    await this.run(
      (cancel) =>
        this.iconCoordinator.inspectRetirement(scope, cancel, (receipt) =>
          this.update({
            receiptStatus: `原请求 ${receipt.requestId} 的分类变更已应用`,
          }),
        ),
      (result) => {
        this.iconRetirementItems = result.status.items;
        this.showIconRetirement(
          result.status.items.length
            ? '旧图状态已核验。只有标为可清理的项目可明确发起清理；分类原回执不变。'
            : '服务器未返回此原请求的旧图清理记录；这不表示文件已物理删除。',
        );
        this.update({
          receiptStatus: `原请求 ${result.receipt.requestId} 的分类变更已应用`,
          status,
        });
      },
      (error) => this.iconRetirementFailure(error, status),
    );
  }
  async cleanupIconRetirement(appearanceId: string): Promise<void> {
    if (!this.available() || this.view.busy || !this.iconRetirementScope)
      return;
    // The event may only select an exact, currently displayed eligible row.
    if (
      !this.view.iconRetirement?.items.some(
        (item) => item.appearanceId === appearanceId && item.canCleanup,
      )
    )
      return;
    const requestId = this.iconRetirementScope.requestId,
      status = this.view.status;
    await this.run(
      (cancel) =>
        this.iconCoordinator.cleanupRetirement(
          { requestId, appearanceIds: [appearanceId] },
          cancel,
        ),
      (result) => {
        const pending = new Set(result.appearanceIds);
        this.iconRetirementItems = this.iconRetirementItems.map((item) =>
          pending.has(item.appearanceId)
            ? { ...item, state: 'cleanup_pending' }
            : item,
        );
        this.showIconRetirement(
          '清理请求已排队。请再次查询；原分类回执不变，尚未确认文件已物理删除。',
        );
        this.update({ status });
      },
      (error) => this.iconRetirementFailure(error, status),
    );
  }
  private iconRetirementFailure(error: unknown, status: string): void {
    this.iconRetirementItems = this.iconRetirementItems.map((item) =>
      item.state === 'retired' ? item : { ...item, state: 'unknown' },
    );
    const code = error instanceof ClientError ? error.details.serverCode : null;
    const message =
      code === 'CATEGORY_ICON_RETIREMENT_HELD'
        ? '旧图仍被保留或状态已变化，请重新查询。'
        : code === 'CATEGORY_ICON_RETIREMENT_NOT_APPLIED'
          ? '原请求尚未确认应用，不能清理旧图。'
          : `旧图状态或清理结果暂不能确认：${ratingCategoryScopedError(error)}`;
    this.showIconRetirement(
      `${message} 原分类回执不变；已发送的清理仍可能排队，请查询同一原请求。`,
    );
    this.update({ status, error: '' });
  }
  pageIconRetirement(direction: number): void {
    if (
      this.view.busy ||
      (direction !== 1 && direction !== -1) ||
      !this.iconRetirementScope
    )
      return;
    this.iconRetirementOffset = Math.max(
      0,
      this.iconRetirementOffset + direction * 20,
    );
    this.showIconRetirement();
  }
  async openIcon(source: string): Promise<void> {
    if (
      this.view.busy ||
      this.context?.protocolVersion !== 5 ||
      !this.detail ||
      !this.runtime.ratingCategoryIconMedia
    )
      return;
    const context = this.context,
      detail = this.detail as RatingManagedIconCategory;
    const state =
      source === 'base'
        ? detail.icon.base
        : source === 'override'
          ? detail.icon.override.state
          : source === 'effective'
            ? detail.icon.effective
            : null;
    if (!state || state.state !== 'image' || !state.appearanceId) return;
    const appearanceId = state.appearanceId;
    await this.run(
      async (cancel) => {
        const owner = this.runtime.sessions.snapshot(),
          session = {
            current: () => {
              this.runtime.sessions.assertCurrent(owner);
              if (cancel.isCancelled)
                throw new ClientError('cancelled', 'Icon selection changed');
              return this.runtime.sessions.snapshot();
            },
          };
        const descriptor =
          await this.runtime.ratingCategoryIconMedia!.descriptor(
            detail.id,
            appearanceId,
            context.commandContext.id,
            context.commandContext.token,
            'management-preview',
            session,
            cancel,
          );
        session.current();
        await this.iconReader.open(source, descriptor, context);
      },
      () => undefined,
      (error) => this.failure(error),
    );
  }
  closeIcon(): void {
    this.iconReader.clear();
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
    this.assistance.invalidate();
    if (this.view.iconEnabled) {
      await this.prepareIconDraft();
      return;
    }
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
    if (this.iconPrepared) {
      if (!this.view.busy && (direction === 1 || direction === -1))
        this.showIconPreview(
          Math.max(0, this.iconPreviewOffset + direction * 20),
        );
      return;
    }
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
    this.iconPrepared = null;
    this.iconReader.clear();
    this.update({
      preview: null,
      status: '预览已关闭，原请求仍受保护；可恢复预览或明确取消原请求',
    });
  }
  async preparePending(): Promise<void> {
    if (this.view.iconFrozen) {
      await this.prepareIconPending();
      return;
    }
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
    if (this.view.iconFrozen) {
      if (this.view.busy || !this.iconPrepared) return;
      const prepared = this.iconPrepared;
      await this.run(
        (cancel) => this.iconCoordinator.commit(prepared, cancel),
        (receipt) => this.iconSettled(receipt),
        (error) => this.failure(error),
      );
      return;
    }
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
    let hasIconPending: boolean;
    try {
      hasIconPending =
        !!this.runtime.pendingRatingCategoryIcon &&
        !!this.iconCoordinator.state();
    } catch (error) {
      this.failure(error);
      return;
    }
    if (hasIconPending) {
      if (this.view.busy) return;
      this.showIconPending();
      await this.run(
        (cancel) => this.iconCoordinator.recover(cancel),
        (receipt) => {
          if (receipt) this.iconSettled(receipt);
          else {
            this.showIconPending();
            this.update({
              status:
                '暂未查到业务回执；原上传与请求仍保留，请继续原图或明确取消',
            });
          }
        },
        (error) => this.failure(error),
      );
      return;
    }
    if (this.view.busy || !this.journal() || !this.pending) return;
    const attempt = this.pending;
    await this.run(
      (cancel) => runRatingCommand(this.runtime, attempt, cancel, false),
      (receipt) => this.settle(receipt),
      (error) => this.failure(error),
    );
  }
  requestCancel(): void {
    if (this.view.iconFrozen && !this.view.busy) {
      this.update({ cancelConfirmation: true });
      return;
    }
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
    if (this.view.iconFrozen) {
      if (this.view.busy || !this.view.cancelConfirmation) return;
      this.iconPrepared = null;
      this.update({ cancelConfirmation: false, preview: null });
      await this.run(
        (cancel) => this.iconCoordinator.cancel(cancel),
        (receipt) => this.iconSettled(receipt),
        (error) => this.failure(error),
      );
      return;
    }
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
    if (
      this.view.iconFrozen &&
      error instanceof ClientError &&
      (error.details.httpStatus === 429 ||
        error.details.serverCode === 'MEDIA_RATE_LIMITED' ||
        error.details.serverCode === 'RATE_LIMITED')
    ) {
      this.update({
        error: '图标操作已限流，请等待限流窗口恢复后继续原请求。',
        status:
          '原草稿、上传编号和已完成图标均已保留。稍后可“查询原回执”核验，或“选择原图并上传此节点”继续；全部图标就绪后再恢复原意图并核对预览。等待不会延长原管理上下文和上传范围最多 5 分钟的有效期，原资格也可能更早失效；若已过期，须先明确取消并确认原请求关闭，再重新编辑。',
      });
      return;
    }
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
      if (this.runtime.pendingRatingCategoryIcon) {
        try {
          if (this.iconCoordinator.state()) this.showIconPending();
        } catch {
          this.update({
            iconFrozen: true,
            isCategoryPending: true,
            recoveryOperation: '原分类图标请求',
          });
        }
      }
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
        context.protocolVersion === 5
          ? this.runtime.ratingCategoryIcon!.history(
              context,
              categoryId,
              cursor,
              cancel,
            )
          : this.runtime.ratingCategoryScoped!.history(
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
    this.assistance.dispose();
    this.iconCoordinator.dispose();
    this.iconReader.dispose();
    for (const unsubscribe of this.unsubscriptions) unsubscribe();
    super.dispose();
  }
}
