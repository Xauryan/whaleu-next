import { ClientError } from '../api/errors';
import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import { canonicalRatingText, invalidRating } from './contract';
import { ratingError } from './controller';
import {
  ratingCommandLabels,
  runRatingCommand,
  settleRatingCommand,
} from './commands';
import {
  decodeRatingCategoryCreationIntent,
  decodeRatingCategoryManagementContext,
  decodeRatingCategoryManagementRoute,
  decodeRatingCategoryNodes,
  type RatingCategoryCreationNode,
  type RatingCategoryManagementContext,
  type RatingCategoryManagementRoute,
} from './category-management-contract';
import {
  isRatingCategoryCreationIntent,
  type PendingRating,
  type RatingCommandReceipt,
} from './pending';

export function ratingCategoryError(error: unknown): string {
  const code = error instanceof ClientError ? error.details.serverCode : null;
  const messages: Record<string, string> = {
    RATING_NOT_FOUND: '当前没有此范围的分类管理资格，或相应分类不可管理',
    RATING_UNAVAILABLE:
      '管理授权、来源、完整校区映射或目录版本暂不能确认，请稍后重试',
    CONTENT_REVIEW_UNAVAILABLE:
      '分类树的精确审核暂不能确认，待确认的原请求仍受保护',
    CONTENT_REJECTED: '分类树内容未通过审核，请重新核验后填写',
    SAFETY_ACTION_RESTRICTED: '当前账号暂不能提交分类申请',
  };
  return messages[code ?? ''] ?? ratingError(error);
}

export interface RatingCategoryEditorNode extends RatingCategoryCreationNode {
  readonly level: number;
}
export interface RatingCategoryManagementView extends CommunityView {
  readonly ready: boolean;
  readonly regionId: string | null;
  readonly campusIds: readonly string[];
  readonly parents: RatingCategoryManagementContext['parents'];
  readonly parentId: string | null;
  readonly parentName: string;
  readonly parentLevel: number;
  readonly nodes: readonly RatingCategoryEditorNode[];
  readonly creationConfirmation: boolean;
  readonly canCancelCategoryCreation: boolean;
  readonly cancelCategoryCreationConfirmation: boolean;
  readonly frozen: boolean;
  readonly recoveryOperation: string;
  readonly receiptStatus: string;
  readonly needsRefresh: boolean;
}
export const initialRatingCategoryManagementView =
  (): RatingCategoryManagementView => ({
    ...initialCommunityView(),
    ready: false,
    regionId: null,
    campusIds: [],
    parents: [],
    parentId: null,
    parentName: '',
    parentLevel: 0,
    nodes: [],
    creationConfirmation: false,
    canCancelCategoryCreation: false,
    cancelCategoryCreationConfirmation: false,
    frozen: false,
    recoveryOperation: '',
    receiptStatus: '',
    needsRefresh: false,
  });
interface Confirmation {
  readonly context: RatingCategoryManagementContext;
  readonly parent: RatingCategoryManagementContext['parents'][number] | null;
  readonly nodes: readonly RatingCategoryCreationNode[];
}
/** The authoritative grant and complete campus mapping come only from the management context.
 * Drafts and tokens never persist; recovery always precedes route/scope/permission reads. */
export class RatingCategoryManagementController extends CommunityController<RatingCategoryManagementView> {
  private route: RatingCategoryManagementRoute | null = null;
  private context: RatingCategoryManagementContext | null = null;
  private confirmation: Confirmation | null = null;
  private pending: PendingRating | null = null;
  private nextKey = 1;
  private inactive = false;
  private readonly unsubscribeScope: () => void;
  private readonly unsubscribeBrowse: () => void;
  private readonly unsubscribeCatalog: () => void;
  constructor(
    runtime: CommunityRuntime,
    render: (view: RatingCategoryManagementView) => void,
  ) {
    super(runtime, initialRatingCategoryManagementView, render);
    const invalidate = (accountId?: string) => {
      if (accountId !== undefined && accountId !== this.accountId()) return;
      this.stop();
      this.resetPrivate();
      this.update({
        ...initialRatingCategoryManagementView(),
        configured: this.configured(),
        hasSession: !!this.accountId(),
        needsRefresh: true,
        status: '分类、授权或校区范围已变化，请重新核验；原请求仍受保护',
      });
    };
    this.unsubscribeScope =
      runtime.directoryScopeChanges?.subscribe(invalidate) ?? (() => undefined);
    this.unsubscribeBrowse =
      runtime.browsingScopeChanges?.subscribe(invalidate) ?? (() => undefined);
    this.unsubscribeCatalog =
      runtime.ratingCatalogChanges?.subscribe(() => invalidate()) ??
      (() => undefined);
    this.update({ configured: this.configured() });
  }
  private configured(): boolean {
    return (
      !!this.runtime.ratingCategoryManagement && !!this.runtime.pendingRatings
    );
  }
  protected override available(): boolean {
    if (this.inactive) return false;
    if (!this.configured() || !this.accountId()) {
      this.update({
        ready: false,
        error: this.accountId() ? '分类管理服务尚未配置' : '请先登录',
      });
      return false;
    }
    return true;
  }
  protected override resetPrivate(): void {
    this.context = null;
    this.confirmation = null;
    this.pending = null;
    this.nextKey = 1;
  }
  protected override onSafetyInvalidated(): void {
    this.update({
      configured: this.configured(),
      needsRefresh: true,
      status: '安全状态已变化，请重新核验分类创建资格；原请求仍受保护',
    });
  }
  private showPending(attempt: PendingRating): void {
    this.pending = attempt;
    this.context = null;
    this.confirmation = null;
    this.update({
      ready: false,
      nodes: [],
      parents: [],
      regionId: null,
      campusIds: [],
      parentId: null,
      parentName: '',
      parentLevel: 0,
      creationConfirmation: false,
      frozen: true,
      canCancelCategoryCreation: isRatingCategoryCreationIntent(attempt.intent),
      cancelCategoryCreationConfirmation: false,
      recoveryOperation: ratingCommandLabels[attempt.intent.operation],
      status: isRatingCategoryCreationIntent(attempt.intent)
        ? '原分类申请待确认，可查询、重试同一请求或明确撤销'
        : '原评分请求待确认，只能查询或重试同一请求',
    });
  }
  private journal(): boolean {
    if (!this.available()) return false;
    try {
      this.pending = this.runtime.pendingRatings!.load(this.accountId()!);
      if (this.pending) this.showPending(this.pending);
      return true;
    } catch (error) {
      this.commandError(error);
      return false;
    }
  }
  async load(raw: unknown = {}): Promise<void> {
    this.stop();
    this.resetPrivate();
    this.route = null;
    this.update({
      ...initialRatingCategoryManagementView(),
      configured: this.configured(),
      hasSession: !!this.accountId(),
    });
    if (!this.journal()) return;
    if (this.pending) {
      await this.recover();
      return;
    }
    try {
      this.route = decodeRatingCategoryManagementRoute(raw);
    } catch {
      this.update({ error: '分类管理链接无效，请从评分目录重新打开' });
      return;
    }
    const route = this.route;
    await this.run(
      async (cancel) => {
        const context = decodeRatingCategoryManagementContext(
          await this.runtime.ratingCategoryManagement!.context(
            route.regionId,
            cancel,
          ),
        );
        if (context.regionId !== route.regionId) invalidRating();
        return context;
      },
      (context) => {
        this.context = context;
        this.update({
          ready: true,
          regionId: context.regionId,
          campusIds: context.campusIds,
          parents: context.parents,
          nodes: [
            { key: 'n0', parentKey: null, name: '', description: '', level: 1 },
          ],
          status:
            '已核验当前管理资格与完整校区范围；提交仍需核验版本和整棵分类树的精确审核',
        });
      },
      (error) => {
        this.context = null;
        this.update({
          ready: false,
          nodes: [],
          campusIds: [],
          parents: [],
          needsRefresh: true,
          error: ratingCategoryError(error),
          status:
            '当前管理资格或完整校区映射暂不能确认；普通评分目录可继续单独使用',
        });
      },
    );
  }
  async reload(): Promise<void> {
    if (this.view.busy) return;
    if (this.view.frozen) await this.recover();
    else await this.load(this.route);
  }
  private editable(): boolean {
    return (
      !this.inactive &&
      this.view.ready &&
      !this.view.busy &&
      !this.view.frozen &&
      !!this.context &&
      !this.view.creationConfirmation
    );
  }
  setNodeText(key: string, field: 'name' | 'description', value: string): void {
    if (
      !this.editable() ||
      typeof value !== 'string' ||
      !['name', 'description'].includes(field)
    )
      return;
    this.update({
      nodes: this.view.nodes.map((node) =>
        node.key === key ? { ...node, [field]: value } : node,
      ),
      error: '',
    });
  }
  selectParent(id: string | null): void {
    if (!this.editable()) return;
    const parent =
      id === null
        ? null
        : this.context!.parents.find((entry) => entry.id === id);
    if (id !== null && !parent) return;
    const level = parent?.level ?? 0,
      shift = level - this.view.parentLevel;
    if (this.view.nodes.some((node) => node.level + shift > 3)) {
      this.update({
        error: '现有分类树超过此父分类下的三级上限，请先移除过深的子分类',
      });
      return;
    }
    this.update({
      parentId: parent?.id ?? null,
      parentName: parent?.name ?? '',
      parentLevel: level,
      nodes: this.view.nodes.map((node) => ({
        ...node,
        level: node.level + shift,
      })),
      error: '',
    });
  }
  addChild(key: string): void {
    if (!this.editable()) return;
    const parent = this.view.nodes.find((node) => node.key === key);
    if (!parent || parent.level >= 3 || this.view.nodes.length >= 32) return;
    this.update({
      nodes: [
        ...this.view.nodes,
        {
          key: `n${this.nextKey++}`,
          parentKey: parent.key,
          name: '',
          description: '',
          level: parent.level + 1,
        },
      ],
      error: '',
    });
  }
  removeNode(key: string): void {
    if (
      !this.editable() ||
      !this.view.nodes.some(
        (node) => node.key === key && node.parentKey !== null,
      )
    )
      return;
    const removed = new Set([key]);
    for (const node of this.view.nodes)
      if (node.parentKey && removed.has(node.parentKey)) removed.add(node.key);
    this.update({
      nodes: this.view.nodes.filter((node) => !removed.has(node.key)),
      error: '',
    });
  }
  requestCreate(): void {
    if (!this.editable()) return;
    try {
      const nodes = decodeRatingCategoryNodes(
        this.view.nodes.map(({ key, parentKey, name, description }) => ({
          key,
          parentKey,
          name: canonicalRatingText(name, 100),
          description: canonicalRatingText(description, 500, false),
        })),
      );
      const parent =
        this.view.parentId === null
          ? null
          : this.context!.parents.find(
              (entry) => entry.id === this.view.parentId,
            );
      if (this.view.parentId !== null && !parent) invalidRating();
      const levels = new Map<string, number>();
      const display = nodes.map((node) => {
        const level =
          node.parentKey === null
            ? (parent?.level ?? 0) + 1
            : levels.get(node.parentKey)! + 1;
        if (level > 3) invalidRating();
        levels.set(node.key, level);
        return { ...node, level };
      });
      this.confirmation = Object.freeze({
        context: this.context!,
        parent: parent ?? null,
        nodes,
      });
      this.update({ creationConfirmation: true, nodes: display, error: '' });
    } catch {
      this.update({
        error:
          '请为每个分类填写 1–100 字名称、至多 500 字说明；仅支持一棵 1–3 级普通分类树，最多 32 项',
      });
    }
  }
  dismissCreate(): void {
    this.stop();
    this.confirmation = null;
    this.update({ busy: false, creationConfirmation: false });
  }
  async confirmCreate(): Promise<void> {
    const confirmed = this.confirmation;
    if (
      this.inactive ||
      this.view.busy ||
      this.view.frozen ||
      !this.view.creationConfirmation ||
      !confirmed ||
      this.context !== confirmed.context ||
      !this.journal() ||
      this.pending
    )
      return;
    const owner = this.runtime.sessions.snapshot(),
      accountId = this.accountId()!;
    await this.run(
      async (cancel) => {
        const clientRequestId = await this.runtime.newRequestId();
        this.runtime.sessions.assertCurrent(owner);
        if (
          cancel.isCancelled ||
          this.confirmation !== confirmed ||
          this.context !== confirmed.context ||
          !this.view.creationConfirmation
        )
          throw new ClientError(
            'cancelled',
            'Cancelled before category persistence',
          );
        const intent = decodeRatingCategoryCreationIntent({
          operation: 'create_categories',
          payload: {
            clientRequestId,
            regionId: confirmed.context.regionId,
            expectedCatalogRevision: confirmed.context.catalogRevision,
            expectedScopeRevision: confirmed.context.scopeRevision,
            parentId: confirmed.parent?.id ?? null,
            expectedParentRevision: confirmed.parent?.revision ?? null,
            nodes: confirmed.nodes,
            assetIds: [],
          },
        });
        const attempt = this.runtime.pendingRatings!.freeze({
          version: 8,
          accountId,
          intent,
        });
        this.showPending(attempt);
        return runRatingCommand(this.runtime, attempt, cancel, true);
      },
      (receipt) => this.settle(receipt),
      (error) => this.commandError(error),
    );
  }
  private commandError(error: unknown): void {
    if (error instanceof ClientError && error.kind === 'storage') {
      this.context = null;
      this.confirmation = null;
      this.update({
        ready: false,
        nodes: [],
        parents: [],
        campusIds: [],
        parentId: null,
        parentName: '',
        parentLevel: 0,
        creationConfirmation: false,
        frozen: true,
        canCancelCategoryCreation: false,
        cancelCategoryCreationConfirmation: false,
      });
    }
    this.update({
      error: ratingCategoryError(error),
      status:
        this.pending || this.view.frozen
          ? '结果待确认；未查到回执或审核暂不可用都不会解除原请求保护'
          : '尚未发送，请检查输入或重新加载后确认',
    });
  }
  private settle(raw: RatingCommandReceipt): void {
    if (!this.pending || this.pending.accountId !== this.accountId())
      invalidRating();
    const receipt = settleRatingCommand(this.runtime, this.pending, raw);
    this.pending = null;
    this.context = null;
    this.confirmation = null;
    this.update({
      ready: false,
      nodes: [],
      parents: [],
      campusIds: [],
      regionId: null,
      parentId: null,
      parentName: '',
      parentLevel: 0,
      creationConfirmation: false,
      frozen: false,
      canCancelCategoryCreation: false,
      cancelCategoryCreationConfirmation: false,
      recoveryOperation: '',
      needsRefresh: true,
      receiptStatus:
        receipt.outcome === 'rejected'
          ? ratingCategoryError(
              new ClientError('business', 'Rejected', {
                serverCode: receipt.code,
              }),
            )
          : `${ratingCommandLabels[receipt.operation]}回执已确认；只代表历史操作`,
      status:
        '请返回评分目录重新读取当前内容；历史回执不代表分类目前可见或可管理',
      error: '',
    });
  }
  async recover(retry = false): Promise<void> {
    if (this.view.busy || !this.journal() || !this.pending) return;
    const attempt = this.pending;
    await this.run(
      (cancel) => runRatingCommand(this.runtime, attempt, cancel, retry),
      (receipt) => this.settle(receipt),
      (error) => this.commandError(error),
    );
  }
  requestCancelCategoryCreation(): void {
    if (
      !this.inactive &&
      !this.view.busy &&
      this.pending &&
      isRatingCategoryCreationIntent(this.pending.intent)
    )
      this.update({ cancelCategoryCreationConfirmation: true });
  }
  dismissCancelCategoryCreation(): void {
    this.update({ cancelCategoryCreationConfirmation: false });
  }
  async confirmCancelCategoryCreation(): Promise<void> {
    if (
      this.inactive ||
      this.view.busy ||
      !this.view.cancelCategoryCreationConfirmation ||
      !this.pending ||
      !isRatingCategoryCreationIntent(this.pending.intent) ||
      !this.available()
    )
      return;
    const attempt = this.pending,
      intent = this.pending.intent;
    this.update({ cancelCategoryCreationConfirmation: false });
    await this.run(
      async (cancel) => {
        if (attempt.accountId !== this.accountId())
          throw new ClientError('stale-session', 'Account changed');
        this.runtime.pendingRatings!.assertOriginal(attempt);
        return this.runtime.ratingCategoryManagement!.cancel(intent, cancel);
      },
      (receipt) => this.settle(receipt),
      (error) =>
        this.update({
          error: ratingCategoryError(error),
          status:
            '撤销结果待确认，请查询原回执或再次明确撤销；已发布结果优先，原请求仍受保护',
        }),
    );
  }
  override cancel(): void {
    this.stop();
    this.context = null;
    this.confirmation = null;
    this.update({
      busy: false,
      ready: false,
      nodes: [],
      parents: [],
      campusIds: [],
      regionId: null,
      parentId: null,
      parentName: '',
      parentLevel: 0,
      creationConfirmation: false,
      cancelCategoryCreationConfirmation: false,
      status: this.pending
        ? '已停止等待，原请求仍需恢复'
        : '已停止创建，请重新核验范围后填写',
    });
  }
  override dispose(): void {
    this.inactive = true;
    this.unsubscribeScope();
    this.unsubscribeBrowse();
    this.unsubscribeCatalog();
    super.dispose();
  }
}
