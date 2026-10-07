import {
  isTradingSubtype,
  type TradingSubtype,
} from '../../community/trading-contract';
import { ClientError } from '../../api/errors';
import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../../community/controller';
import type { OwnPublication, Post } from '../../community/contract';
import type { CommunityRuntime } from '../../community/runtime';
export interface MineView extends CommunityView {
  readonly tradingPosts: readonly Post[];
  readonly onlyTrading: boolean;
  readonly tradingSubtype: TradingSubtype | '';
  readonly tradingRecoveryPostId: string;
  readonly publications: readonly OwnPublication[];
  readonly formationRecoveryPostId: string;
  readonly ballotRecoveryPostId: string;
  readonly discussionRecoveryPostId: string;
  readonly discussionRecoveryRootCommentId: string;
  readonly loaded: boolean;
  readonly canLoadMore: boolean;
}
export const initialMineView = (): MineView => ({
  ...initialCommunityView(),
  tradingPosts: [],
  onlyTrading: false,
  tradingSubtype: '',
  tradingRecoveryPostId: '',
  publications: [],
  ballotRecoveryPostId: '',
  formationRecoveryPostId: '',
  discussionRecoveryPostId: '',
  discussionRecoveryRootCommentId: '',
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
      const interaction = this.runtime.pendingDiscussion.load(
        this.accountId()!,
      );
      this.update({
        tradingRecoveryPostId:
          this.runtime.pendingTrading.load(this.accountId()!)?.postId ?? '',
        discussionRecoveryPostId: interaction?.postId ?? '',
        discussionRecoveryRootCommentId: interaction?.rootCommentId ?? '',
        formationRecoveryPostId:
          this.runtime.pendingFormations.load(this.accountId()!)?.postId ?? '',
        ballotRecoveryPostId:
          this.runtime.pendingBallots.load(this.accountId()!)?.postId ?? '',
      });
    } catch {
      this.update({ error: '无法读取待确认的互动记录，请保留本机数据后重试' });
      return;
    }
    this.update({
      publications: [],
      tradingPosts: [],
      loaded: false,
      canLoadMore: false,
    });
    await this.read(false);
  }
  async setTradingOnly(onlyTrading: boolean): Promise<void> {
    this.update({ onlyTrading, tradingSubtype: '' });
    await this.load();
  }
  async setTradingSubtype(subtype: string): Promise<void> {
    if (
      !this.view.onlyTrading ||
      (subtype !== '' && !isTradingSubtype(subtype))
    )
      return;
    this.update({ tradingSubtype: subtype });
    await this.load();
  }
  async more(): Promise<void> {
    if (!this.available() || this.view.busy || !this.nextCursor) return;
    await this.read(true);
  }
  private async read(append: boolean): Promise<void> {
    const after = append ? this.nextCursor : null;
    await this.run(
      async (cancel) =>
        this.view.onlyTrading
          ? {
              kind: 'trading' as const,
              data: await this.runtime.gateway!.ownTrading(
                after,
                cancel,
                this.view.tradingSubtype || undefined,
              ),
            }
          : {
              kind: 'publications' as const,
              data: await this.runtime.gateway!.mine(after, cancel),
            },
      (response) => {
        if (response.kind === 'trading') {
          const result = response.data;
          if (after && result.nextCursor === after)
            throw new ClientError('protocol', 'Cursor did not advance');
          this.nextCursor = result.nextCursor;
          const items = append
            ? [...this.view.tradingPosts, ...result.items]
            : result.items;
          this.update({
            tradingPosts: [
              ...new Map(items.map((item) => [item.id, item])).values(),
            ],
            publications: [],
            canLoadMore: !!this.nextCursor,
            loaded: true,
            status: items.length
              ? '已加载当前可查看的我的交易（含急出）'
              : '暂无当前可查看的交易',
          });
          return;
        }
        const result = response.data;
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
        this.update({
          publications: [],
          tradingPosts: [],
          loaded: false,
          canLoadMore: false,
        }),
    );
  }
}
