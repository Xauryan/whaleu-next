import { ClientError } from '../api/errors';
import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import type { BrowsingHistoryStore, HistoryEntry } from './store';
export interface HistoryView extends CommunityView {
  readonly items: readonly {
    postId: string;
    summary: string;
    viewedAt: string;
  }[];
  readonly loaded: boolean;
  readonly page: number;
  readonly canMore: boolean;
  readonly canPrevious: boolean;
  readonly confirmClear: boolean;
}
export const initialHistoryView = (): HistoryView => ({
  ...initialCommunityView(),
  items: [],
  loaded: false,
  page: 1,
  canMore: false,
  canPrevious: false,
  confirmClear: false,
});
const PAGE_SIZE = 20;
export class BrowsingHistoryController extends CommunityController<HistoryView> {
  private entries: readonly HistoryEntry[] = [];
  constructor(
    runtime: CommunityRuntime,
    private readonly history: BrowsingHistoryStore,
    render: (view: HistoryView) => void,
  ) {
    super(runtime, initialHistoryView, render);
  }
  protected override resetPrivate(): void {
    this.entries = [];
  }
  protected override onSafetyInvalidated(): void {
    void this.load();
  }
  async load(): Promise<void> {
    await this.read(0, true);
  }
  async more(): Promise<void> {
    if (!this.view.busy && this.view.canMore)
      await this.read(this.view.page, false);
  }
  async previous(): Promise<void> {
    if (!this.view.busy && this.view.canPrevious)
      await this.read(this.view.page - 2, false);
  }
  private async read(page: number, reset: boolean): Promise<void> {
    if (!this.available()) return;
    this.update({ items: [], loaded: false, confirmClear: false });
    await this.run(
      async (cancel) => {
        const entries = reset ? this.history.list(this.owner) : this.entries;
        const items: HistoryView['items'][number][] = [];
        for (const entry of entries.slice(
          page * PAGE_SIZE,
          (page + 1) * PAGE_SIZE,
        )) {
          this.runtime.sessions.assertCurrent(this.owner);
          if (cancel.isCancelled)
            throw new ClientError('cancelled', 'Cancelled');
          try {
            const post = await this.runtime.gateway!.post(entry.postId, cancel);
            if (post.id !== entry.postId)
              throw new ClientError('protocol', 'Post mismatch');
            items.push({
              postId: post.id,
              summary: post.text.slice(0, 120) || '图片帖子',
              viewedAt: new Date(entry.viewedAt).toLocaleString(),
            });
          } catch (error) {
            // Only established current denial/nonexistence hides a row. Network/auth failures
            // clear the whole page rather than displaying cached sensitive previews.
            if (
              error instanceof ClientError &&
              (error.details.httpStatus === 404 ||
                [
                  'POST_NOT_FOUND',
                  'POST_DELETED',
                  'POST_BLOCKED_BY_YOU',
                ].includes(error.details.serverCode ?? ''))
            )
              continue;
            throw error;
          }
        }
        return { entries, items };
      },
      ({ entries, items }) => {
        this.entries = entries;
        this.update({
          items,
          loaded: true,
          page: page + 1,
          canMore: (page + 1) * PAGE_SIZE < entries.length,
          canPrevious: page > 0,
          status: '仅展示当前仍可查看的帖子',
        });
      },
      () => this.update({ items: [], loaded: false }),
    );
  }
  requestClear(): void {
    if (!this.view.busy && this.accountId())
      this.update({ confirmClear: true });
  }
  dismissClear(): void {
    this.update({ confirmClear: false });
  }
  clear(): void {
    if (!this.view.confirmClear || !this.accountId()) return;
    this.stop();
    this.entries = [];
    this.update({
      items: [],
      loaded: false,
      confirmClear: false,
      canMore: false,
      canPrevious: false,
    });
    try {
      this.history.clear();
      this.update({
        loaded: true,
        page: 1,
        status: '本机浏览记录已清空',
        error: '',
      });
    } catch {
      this.update({
        error: '本机存储清理失败，记录已停止显示；请重试清空。',
        status: '清理未完成',
      });
    }
  }
}
