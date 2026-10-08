import { ClientError } from '../../api/errors';
import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../../community/controller';
import type { Post } from '../../community/contract';
import {
  decodeHotIntent,
  isHotRange,
  type HotContinuation,
  type HotIntent,
  type HotRange,
} from '../../community/hot-contract';
import type { CommunityRuntime } from '../../community/runtime';

export interface HotView extends CommunityView {
  readonly selectedSpaceId: string;
  readonly range: HotRange;
  readonly space: Post['space'] | null;
  readonly posts: readonly Post[];
  readonly continuation: HotContinuation | null;
  readonly loaded: boolean;
  readonly restartRequired: boolean;
  readonly canNext: boolean;
  readonly canPrevious: boolean;
}
export const initialHotView = (): HotView => ({
  ...initialCommunityView(),
  selectedSpaceId: '',
  range: 'day',
  space: null,
  posts: [],
  continuation: null,
  loaded: false,
  restartRequired: false,
  canNext: false,
  canPrevious: false,
});
const MAX_CURSOR_TRAIL = 32;
/** Current cards only. Previous stores bounded navigation inputs, never card snapshots. */
export class HotController extends CommunityController<HotView> {
  private selected: HotIntent | null = null;
  private nextCursor: string | null = null;
  private pageCursors: (string | null)[] = [null];
  private pageIndex = 0;
  constructor(runtime: CommunityRuntime, render: (view: HotView) => void) {
    super(runtime, initialHotView, render);
  }
  private resetPaging(): void {
    this.nextCursor = null;
    this.pageCursors = [null];
    this.pageIndex = 0;
  }
  protected override resetPrivate(): void {
    this.selected = null;
    this.resetPaging();
  }
  protected override onSafetyInvalidated(previous: HotView): void {
    if (previous.selectedSpaceId)
      void this.load({
        spaceId: previous.selectedSpaceId,
        range: previous.range,
      });
  }
  snapshot(): HotIntent | null {
    try {
      this.runtime.sessions.assertCurrent(this.owner);
      return this.selected;
    } catch {
      return null;
    }
  }
  private clearPage(): void {
    this.stop();
    this.nextCursor = null;
    this.update({
      space: null,
      posts: [],
      continuation: null,
      loaded: false,
      restartRequired: false,
      canNext: false,
      canPrevious: false,
      busy: false,
      error: '',
    });
  }
  async load(route: unknown): Promise<void> {
    this.clearPage();
    this.resetPrivate();
    try {
      this.selected = decodeHotIntent(route);
    } catch {
      this.update({
        ...initialHotView(),
        hasSession: !!this.owner.credentials,
        configured: !!this.runtime.hot,
        error: '热门范围无效，请返回社区重新选择入口',
        status: '热门范围不可用',
      });
      return;
    }
    this.update({
      selectedSpaceId: this.selected.spaceId,
      range: this.selected.range,
    });
    await this.read(null, 0);
  }
  async setRange(range: string): Promise<void> {
    if (!this.selected || !isHotRange(range) || range === this.selected.range)
      return;
    await this.load({ spaceId: this.selected.spaceId, range });
  }
  async refresh(): Promise<void> {
    // Coalesce repeated taps; scope/range replacement deliberately cancels an old request.
    if (this.view.busy) return;
    this.resetPaging();
    await this.read(null, 0);
  }
  async next(): Promise<void> {
    if (this.view.busy || !this.view.loaded || !this.nextCursor) return;
    await this.read(this.nextCursor, this.pageIndex + 1);
  }
  async previous(): Promise<void> {
    if (
      this.view.busy ||
      !this.view.loaded ||
      !this.view.canPrevious ||
      this.pageIndex < 1
    )
      return;
    await this.read(this.pageCursors[this.pageIndex - 1]!, this.pageIndex - 1);
  }
  private async read(after: string | null, pageIndex: number): Promise<void> {
    const selected = this.selected;
    this.clearPage();
    if (!selected) return;
    if (!this.runtime.hot) {
      this.update({
        configured: false,
        error: '当前构建尚未配置热门服务',
        status: '热门暂不可用',
      });
      return;
    }
    this.update({ configured: true, status: '正在核验当前可查看的热门帖子' });
    await this.run(
      (cancel) => this.runtime.hot!.hot(selected, after, cancel),
      (page) => {
        if (
          page.nextCursor !== null &&
          (page.nextCursor === after ||
            this.pageCursors.slice(0, pageIndex).includes(page.nextCursor))
        )
          throw new ClientError('protocol', 'Hot cursor did not advance');
        this.nextCursor = page.nextCursor;
        // Discard the old forward branch on Previous; a live successor may stay or change.
        this.pageCursors = [...this.pageCursors.slice(0, pageIndex), after];
        this.pageIndex = pageIndex;
        if (this.pageCursors.length > MAX_CURSOR_TRAIL) {
          this.pageCursors.shift();
          this.pageIndex--;
        }
        this.update({
          posts: page.items,
          // No cached names or inferred topology; an empty current page stays unnamed.
          space: page.items[0]?.space ?? null,
          continuation: page.continuation,
          loaded: true,
          canNext: !!page.nextCursor,
          canPrevious: this.pageIndex > 0,
          status:
            page.continuation === 'scan_pending'
              ? '本批尚未查完，请继续查看'
              : page.continuation === 'login_required'
                ? '登录后可继续查看；登录后请刷新热门'
                : page.continuation === 'phone_verification_required'
                  ? '继续查看需要手机号验证；当前版本尚未接入验证流程'
                  : page.continuation === 'end'
                    ? !after && !page.items.length
                      ? '当前范围暂无符合条件的可查看热门帖子'
                      : '已到本次浏览末尾'
                    : '已加载当前可查看的热门帖子',
        });
      },
      (error) => {
        this.resetPaging();
        const restart =
          error.details.serverCode === 'DISCOVERY_RESTART_REQUIRED' ||
          (after !== null && error.details.serverCode === 'BAD_REQUEST');
        this.update({
          space: null,
          posts: [],
          continuation: null,
          loaded: false,
          canNext: false,
          canPrevious: false,
          restartRequired: restart,
          ...(restart
            ? {
                status: '分页已失效，请刷新热门',
                error: '旧分页已清除，请刷新当前可查看的帖子',
              }
            : error.details.serverCode === 'HOT_FEED_UNAVAILABLE'
              ? {
                  status: '热门暂不可用',
                  error: '热门服务尚未启用或暂不能确认，请稍后重试',
                }
              : {}),
        });
      },
    );
  }
  override cancel(): void {
    this.resetPaging();
    this.clearPage();
    this.update({ status: '已停止加载，可刷新热门', error: '' });
  }
}
