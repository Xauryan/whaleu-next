import { ClientError, isRecord } from '../api/errors';
import {
  CommunityController,
  communityError,
  initialCommunityView,
  type CommunityView,
} from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import {
  activityUuid,
  decodeActivityContext,
  decodeActivityDetail,
  decodeActivityPage,
  invalidActivity,
  type ActivityDetail,
  type ActivityPage,
  type ActivitySelection,
  type ActivitySummary,
  type ActivityWindow,
} from './contract';
export interface ActivityRoute {
  readonly regionId: string;
  readonly activityId: string;
}
export function decodeActivityRoute(value: unknown): ActivityRoute {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    !activityUuid(value.regionId) ||
    !activityUuid(value.activityId)
  )
    invalidActivity();
  return Object.freeze({
    regionId: value.regionId,
    activityId: value.activityId,
  });
}
export interface ActivityView extends CommunityView {
  readonly loaded: boolean;
  readonly regionId: string;
  readonly catalogRevision: string;
  readonly items: readonly ActivitySummary[];
  readonly detail: ActivityDetail | null;
  readonly window: ActivityWindow;
  readonly selection: ActivitySelection | null;
  readonly selectionMessage: string;
  readonly entryUnavailable: boolean;
  readonly pageNumber: number;
  readonly canNext: boolean;
  readonly canPrevious: boolean;
  readonly restartRequired: boolean;
  readonly renderKey: number;
}
export const initialActivityView = (): ActivityView => ({
  ...initialCommunityView(),
  loaded: false,
  regionId: '',
  catalogRevision: '',
  items: [],
  detail: null,
  window: 'entry',
  selection: null,
  selectionMessage: '',
  entryUnavailable: false,
  pageNumber: 0,
  canNext: false,
  canPrevious: false,
  restartRequired: false,
  renderKey: 0,
});
/** Member reads use fresh identity authority. The only durable data is in the separate minimal visit journal. */
export class ActivityController extends CommunityController<ActivityView> {
  private route: ActivityRoute | null = null;
  private inactive = false;
  private window: ActivityWindow = 'entry';
  private cursors: (string | null)[] = [null];
  private nextCursor: string | null = null;
  private index = 0;
  private catalog: string | null = null;
  private selection: ActivitySelection | null = null;
  private renderGeneration = 0;
  private entryAcknowledged = false;
  private readonly unsubscribeScope: () => void;
  constructor(
    runtime: CommunityRuntime,
    private readonly mode: 'list' | 'detail',
    render: (view: ActivityView) => void,
    private readonly onVisible?: (context: ActivityPage['context']) => void,
    private readonly onInvalidated?: () => void,
  ) {
    super(runtime, initialActivityView, render);
    this.unsubscribeScope =
      runtime.directoryScopeChanges?.subscribe((accountId) => {
        if (accountId !== undefined && accountId !== this.accountId()) return;
        this.clear();
        this.resetPaging();
        this.update({
          status: '身份校区已变化，请重新加载活动',
          error: '已清除旧活动；浏览校区不能授予活动访问权限',
        });
      }) ?? (() => undefined);
    this.update({ configured: !!runtime.activities });
  }
  protected override available(): boolean {
    if (this.inactive) return false;
    if (!this.runtime.activities || !this.accountId()) {
      this.update({
        configured: !!this.runtime.activities,
        error: this.runtime.activities
          ? '请先登录后查看校园活动'
          : '当前构建尚未配置活动服务',
        status: '活动暂不可用',
      });
      return false;
    }
    return true;
  }
  protected override stop(): void {
    super.stop();
    this.renderGeneration++;
    this.onInvalidated?.();
  }
  protected override resetPrivate(): void {
    this.resetPaging();
    this.entryAcknowledged = false;
  }
  protected override onSafetyInvalidated(): void {
    this.update({
      configured: !!this.runtime.activities,
      status: '安全状态已变化，请重新加载活动',
      error: '旧活动已清除',
    });
  }
  private resetPaging(): void {
    this.cursors = [null];
    this.nextCursor = null;
    this.index = 0;
    this.catalog = null;
    this.selection = null;
  }
  private clear(): void {
    this.stop();
    this.update({
      ...initialActivityView(),
      configured: !!this.runtime.activities,
      hasSession: !!this.accountId(),
      window: this.window,
    });
  }
  async load(route?: unknown): Promise<void> {
    if (this.view.busy || this.inactive) return;
    if (this.mode === 'detail') {
      try {
        this.route = decodeActivityRoute(route);
      } catch {
        this.route = null;
        this.clear();
        this.update({
          error: '活动链接无效，请返回活动列表',
          status: '无法打开活动',
        });
        return;
      }
    }
    await this.refresh();
  }
  async refresh(): Promise<void> {
    if (this.view.busy || this.inactive) return;
    this.resetPaging();
    await this.read(null, 0);
  }
  async chooseAll(): Promise<void> {
    if (this.mode !== 'list' || this.view.busy || this.inactive) return;
    this.window = 'all';
    await this.refresh();
  }
  async next(): Promise<void> {
    if (this.view.loaded && !this.view.busy && this.nextCursor)
      await this.read(this.nextCursor, this.index + 1);
  }
  async previous(): Promise<void> {
    if (this.view.loaded && !this.view.busy && this.index > 0)
      await this.read(this.cursors[this.index - 1]!, this.index - 1);
  }
  private async read(cursor: string | null, index: number): Promise<void> {
    this.clear();
    if (!this.available()) return;
    this.update({ status: '正在核验身份校区与活动访问权限' });
    await this.run(
      async (cancel) => {
        const context = decodeActivityContext(
          await this.runtime.activities!.context(cancel),
        );
        if (cancel.isCancelled)
          throw new ClientError('cancelled', 'Activity read replaced');
        if (this.mode === 'detail') {
          if (!this.route || this.route.regionId !== context.regionId)
            throw new ClientError('forbidden', 'Identity region changed', {
              serverCode: 'ACTIVITY_SCOPE_UNAVAILABLE',
            });
          const detail = decodeActivityDetail(
            await this.runtime.activities!.detail(
              context.regionId,
              this.route.activityId,
              cancel,
            ),
          );
          if (
            detail.id !== this.route.activityId ||
            detail.regionId !== context.regionId
          )
            invalidActivity();
          return { context, detail, page: null };
        }
        const page = decodeActivityPage(
          await this.runtime.activities!.list(
            context.regionId,
            this.window,
            cursor,
            cancel,
          ),
        );
        if (
          page.context.regionId !== context.regionId ||
          (this.window === 'all' && page.selection.kind !== 'all')
        )
          invalidActivity();
        return { context, detail: null, page };
      },
      ({ context, detail, page }) => {
        if (page) this.applyPage(page, cursor, index);
        else
          this.update({
            loaded: true,
            regionId: context.regionId,
            detail,
            renderKey: ++this.renderGeneration,
            status: '已核验当前活动详情',
          });
      },
      (error) => {
        this.clear();
        this.resetPaging();
        const code = error.details.serverCode,
          restart = code === 'DISCOVERY_RESTART_REQUIRED';
        const messages: Record<string, string> = {
          ACTIVITY_UNAVAILABLE:
            '活动目录资料尚未确认，暂不可用；这不代表没有活动',
          ACTIVITY_ENTRY_SELECTION_UNAVAILABLE:
            '首次进入的推荐依据尚不能确认；可明确选择查看全部活动',
          ACTIVITY_SCOPE_UNAVAILABLE:
            '当前身份校区不匹配，请返回活动列表重新加载',
          ACTIVITY_NOT_FOUND: '此活动不存在或当前不可查看',
        };
        this.update({
          restartRequired: restart,
          entryUnavailable: code === 'ACTIVITY_ENTRY_SELECTION_UNAVAILABLE',
          status: restart ? '活动分页已失效' : '活动暂不可用',
          error: restart
            ? '内容或访问依据已变化，请主动重新加载；旧分页已清除'
            : (messages[code ?? ''] ?? communityError(error)),
        });
      },
    );
  }
  private applyPage(
    page: ActivityPage,
    cursor: string | null,
    index: number,
  ): void {
    if (
      (page.nextCursor !== null &&
        (page.nextCursor === cursor ||
          page.nextCursor === page.pageCursor ||
          this.cursors.slice(0, index).includes(page.nextCursor))) ||
      (cursor !== null &&
        (page.pageCursor !== cursor ||
          this.catalog !== page.context.catalogRevision ||
          JSON.stringify(this.selection) !== JSON.stringify(page.selection)))
    )
      invalidActivity();
    this.catalog = page.context.catalogRevision;
    this.selection = page.selection;
    this.nextCursor = page.nextCursor;
    this.cursors = [...this.cursors.slice(0, index), page.pageCursor];
    this.index = index;
    this.update({
      loaded: true,
      regionId: page.context.regionId,
      catalogRevision: page.context.catalogRevision,
      items: page.items,
      selection: page.selection,
      selectionMessage:
        page.selection.kind === 'historical'
          ? '最近 10 条历史活动推荐，可切换查看全部'
          : page.selection.kind === 'recent'
            ? '首次进入推荐：最近 72 小时发布的活动'
            : '全部当前可查看活动',
      pageNumber: index + 1,
      canNext: page.nextCursor !== null,
      canPrevious: index > 0,
      renderKey: ++this.renderGeneration,
      status: !page.items.length
        ? '本次已确认的活动范围内暂无活动'
        : page.continuation === 'end'
          ? '已到本次浏览范围末尾'
          : '已加载当前页',
    });
  }
  /** Called only from the native setData completion callback; late or hidden callbacks cannot write. */
  visible(renderKey: number): void {
    if (
      this.mode !== 'list' ||
      this.inactive ||
      this.entryAcknowledged ||
      !this.view.loaded ||
      this.view.busy ||
      this.view.error ||
      !renderKey ||
      renderKey !== this.view.renderKey ||
      renderKey !== this.renderGeneration ||
      !this.accountId()
    )
      return;
    this.entryAcknowledged = true;
    this.onVisible?.({
      regionId: this.view.regionId,
      catalogRevision: this.view.catalogRevision,
    });
  }
  detailPath(id: string): string | null {
    if (
      this.inactive ||
      this.mode !== 'list' ||
      !this.view.loaded ||
      this.view.busy ||
      !this.accountId() ||
      !this.view.items.some((item) => item.id === id)
    )
      return null;
    return `/pages/activity-detail/activity-detail?regionId=${this.view.regionId}&activityId=${id}`;
  }
  override cancel(): void {
    this.clear();
    this.resetPaging();
    this.update({ status: '已停止读取，请重新加载' });
  }
  override dispose(): void {
    this.inactive = true;
    this.unsubscribeScope();
    super.dispose();
  }
}
