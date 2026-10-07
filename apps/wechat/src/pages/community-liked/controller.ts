import { ClientError } from '../../api/errors';
import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../../community/controller';
import type { CommunityRuntime } from '../../community/runtime';
import type { LikedItem } from '../../profile/discovery-contract';
export interface LikedView extends CommunityView {
  readonly items: readonly LikedItem[];
  readonly visibleLikedCount: number | null;
  readonly loaded: boolean;
  readonly canLoadMore: boolean;
  readonly canPrevious: boolean;
  readonly pageNumber: number;
}
export const initialLikedView = (): LikedView => ({
  ...initialCommunityView(),
  items: [],
  visibleLikedCount: null,
  loaded: false,
  canLoadMore: false,
  canPrevious: false,
  pageNumber: 0,
});
export class LikedController extends CommunityController<LikedView> {
  private nextCursor: string | null = null;
  private pageCursors: (string | null)[] = [null];
  private pageIndex = 0;
  constructor(runtime: CommunityRuntime, render: (view: LikedView) => void) {
    super(runtime, initialLikedView, render);
  }
  protected override resetPrivate(): void {
    this.nextCursor = null;
    this.pageCursors = [null];
    this.pageIndex = 0;
  }
  protected override onSafetyInvalidated(): void {
    void this.load();
  }
  private clear(): void {
    this.stop();
    this.nextCursor = null;
    this.update({
      items: [],
      visibleLikedCount: null,
      loaded: false,
      canLoadMore: false,
      canPrevious: false,
      pageNumber: 0,
      busy: false,
    });
  }
  async load(): Promise<void> {
    this.resetPrivate();
    await this.read(null, 0);
  }
  async more(): Promise<void> {
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
    this.clear();
    if (!this.available()) return;
    if (!this.runtime.discovery) {
      this.update({ error: '当前构建尚未配置点赞历史服务' });
      return;
    }
    await this.run(
      (cancel) => this.runtime.discovery!.liked(after, cancel),
      (result) => {
        if (after && result.nextCursor === after)
          throw new ClientError('protocol', 'Liked cursor did not advance');
        this.nextCursor = result.nextCursor;
        this.pageCursors = [...this.pageCursors.slice(0, pageIndex), after];
        this.pageIndex = pageIndex;
        // Retain only navigation cursors: previous bodies cannot survive remote policy changes.
        const items = result.items;
        this.update({
          items,
          visibleLikedCount: result.visibleLikedCount,
          loaded: true,
          canLoadMore: !!result.nextCursor,
          canPrevious: pageIndex > 0,
          pageNumber: pageIndex + 1,
          status:
            '仅显示当前仍可查看的帖子、评论与回复；翻页会重新核验内容，重新点赞后的新位置请刷新查看',
        });
      },
      (error) => {
        this.resetPrivate();
        this.update({
          items: [],
          visibleLikedCount: null,
          loaded: false,
          canLoadMore: false,
          ...(error.details.serverCode === 'DISCOVERY_RESTART_REQUIRED'
            ? {
                status: '点赞历史已变化，请重新加载',
                error: '旧分页已清除，请重新加载当前可查看的点赞',
              }
            : {}),
        });
      },
    );
  }
  override cancel(): void {
    this.resetPrivate();
    this.clear();
    this.update({ status: '已停止加载', error: '' });
  }
}
