import { ClientError } from '../../api/errors';
import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../../community/controller';
import type { OwnPublication } from '../../community/contract';
import type { CommunityRuntime } from '../../community/runtime';
export interface MineView extends CommunityView {
  readonly publications: readonly OwnPublication[];
  readonly ballotRecoveryPostId: string;
  readonly loaded: boolean;
  readonly canLoadMore: boolean;
}
export const initialMineView = (): MineView => ({
  ...initialCommunityView(),
  publications: [],
  ballotRecoveryPostId: '',
  loaded: false,
  canLoadMore: false,
});
export class MineController extends CommunityController<MineView> {
  private nextCursor: string | null = null;
  constructor(runtime: CommunityRuntime, render: (view: MineView) => void) {
    super(runtime, initialMineView, render);
  }
  protected override resetPrivate(): void {
    this.nextCursor = null;
  }
  async load(): Promise<void> {
    if (!this.available()) return;
    this.nextCursor = null;
    try {
      this.update({
        ballotRecoveryPostId:
          this.runtime.pendingBallots.load(this.accountId()!)?.postId ?? '',
      });
    } catch {
      this.update({ error: '无法读取待确认的投票记录，请保留本机数据后重试' });
      return;
    }
    this.update({ publications: [], loaded: false, canLoadMore: false });
    await this.read(false);
  }
  async more(): Promise<void> {
    if (!this.available() || this.view.busy || !this.nextCursor) return;
    await this.read(true);
  }
  private async read(append: boolean): Promise<void> {
    const after = append ? this.nextCursor : null;
    await this.run(
      (cancel) => this.runtime.gateway!.mine(after, cancel),
      (result) => {
        if (after && result.nextCursor === after)
          throw new ClientError('protocol', 'Cursor did not advance');
        this.nextCursor = result.nextCursor;
        const items = append
          ? [...this.view.publications, ...result.items]
          : result.items;
        this.update({
          publications: [
            ...new Map(items.map((item) => [item.id, item])).values(),
          ],
          canLoadMore: !!this.nextCursor,
          loaded: true,
          status: items.length ? '已加载发布记录' : '当前账号暂无发布记录',
        });
      },
      () =>
        this.update({ publications: [], loaded: false, canLoadMore: false }),
    );
  }
}
