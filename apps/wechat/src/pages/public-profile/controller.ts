import { ClientError } from '../../api/errors';
import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../../community/controller';
import type { Post } from '../../community/contract';
import type { CommunityRuntime } from '../../community/runtime';
import {
  isTradingSubtype,
  type TradingSubtype,
} from '../../community/trading-contract';
import { isUuid } from '../../profile/contract';
import type {
  AvailableProfile,
  DiscoveryContinuation,
  DiscoveryCountStatus,
  ProfileUnavailable,
  PublicProfile,
} from '../../profile/discovery-contract';
import type { ProfileListKind } from '../../profile/discovery-gateway';
export interface PublicProfileView extends CommunityView {
  readonly profile: PublicProfile | null;
  readonly items: readonly Post[];
  readonly total: number | null;
  readonly totalStatus: DiscoveryCountStatus | null;
  readonly continuation: DiscoveryContinuation | null;
  readonly loaded: boolean;
  readonly noProfile: boolean;
  readonly selfEntry: boolean;
  readonly tab: ProfileListKind;
  readonly tradingSubtype: TradingSubtype | '';
  readonly canLoadMore: boolean;
  readonly canPrevious: boolean;
  readonly pageNumber: number;
}
export const initialPublicProfileView = (): PublicProfileView => ({
  ...initialCommunityView(),
  profile: null,
  items: [],
  total: null,
  totalStatus: null,
  continuation: null,
  loaded: false,
  noProfile: false,
  selfEntry: false,
  tab: 'posts',
  tradingSubtype: '',
  canLoadMore: false,
  canPrevious: false,
  pageNumber: 0,
});
/** No discovery snapshots or cursors are persisted; each read rechecks current policy. */
export class PublicProfileController extends CommunityController<PublicProfileView> {
  private nextCursor: string | null = null;
  private pageCursors: (string | null)[] = [null];
  private pageIndex = 0;
  constructor(
    runtime: CommunityRuntime,
    private targetProfileId: string | null,
    render: (view: PublicProfileView) => void,
  ) {
    super(runtime, initialPublicProfileView, render);
    this.update({ selfEntry: targetProfileId === null });
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
      profile: null,
      items: [],
      total: null,
      totalStatus: null,
      continuation: null,
      loaded: false,
      noProfile: false,
      selfEntry: this.targetProfileId === null,
      canLoadMore: false,
      canPrevious: false,
      pageNumber: 0,
      busy: false,
    });
  }
  async setTarget(profileId: string | null): Promise<void> {
    this.targetProfileId = profileId;
    this.update({ tab: 'posts', tradingSubtype: '' });
    await this.load();
  }
  async setTab(tab: string): Promise<void> {
    if (tab !== 'posts' && tab !== 'trading') return;
    this.update({ tab, tradingSubtype: '' });
    await this.load();
  }
  async setTradingSubtype(subtype: string): Promise<void> {
    if (
      this.view.tab !== 'trading' ||
      (subtype !== '' && !isTradingSubtype(subtype))
    )
      return;
    this.update({ tradingSubtype: subtype });
    await this.load();
  }
  async load(): Promise<void> {
    this.resetPrivate();
    await this.read(null, 0);
  }
  async more(): Promise<void> {
    if (this.view.busy || !this.view.loaded || !this.nextCursor) return;
    await this.read(this.nextCursor, this.pageIndex + 1);
  }
  private showUnavailable(profile: ProfileUnavailable): void {
    this.resetPrivate();
    this.update({
      profile,
      items: [],
      total: null,
      totalStatus: null,
      continuation: null,
      loaded: true,
      canLoadMore: false,
      status:
        profile.status === 'blocked_by_you'
          ? '你已拉黑此用户，可解除后重新查看'
          : '此主页当前不可查看',
    });
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
    const target = this.targetProfileId,
      tab = this.view.tab,
      subtype = this.view.tradingSubtype;
    this.clear();
    if (!this.available(target === null)) return;
    if (!this.runtime.discovery || (target !== null && !isUuid(target))) {
      this.update({
        error: '主页地址无效或公开主页服务尚未配置',
        status: '暂不可用',
      });
      return;
    }
    await this.run(
      async (cancel) => {
        const profileId =
          target ??
          (await this.runtime.discovery!.ownProfileRef(cancel)).profileId;
        if (profileId === null) return { kind: 'no_profile' as const };
        const profile = await this.runtime.discovery!.profile(
          profileId,
          cancel,
        );
        if (target === null && profile.status === 'available' && !profile.isOwn)
          throw new ClientError('protocol', 'Own public profile mismatch');
        if (profile.status !== 'available')
          return { kind: 'unavailable' as const, profile };
        if (profile.postsHidden) return { kind: 'hidden' as const, profile };
        const list = await this.runtime.discovery!.list(
          profileId,
          tab,
          after,
          cancel,
          subtype || undefined,
        );
        if (list.status === 'unavailable' || list.status === 'blocked_by_you')
          return { kind: 'unavailable' as const, profile: list };
        if (list.status === 'hidden')
          return { kind: 'hidden' as const, profile };
        if (
          list.nextCursor !== null &&
          (list.nextCursor === after ||
            this.pageCursors.slice(0, pageIndex).includes(list.nextCursor))
        )
          throw new ClientError('protocol', 'Discovery cursor did not advance');
        return { kind: 'available' as const, profile, list };
      },
      (result) => {
        if (result.kind === 'no_profile') {
          this.resetPrivate();
          this.update({
            loaded: true,
            noProfile: true,
            status: '当前账号尚无公开主页资料；可查看自己的发布或编辑资料',
          });
          return;
        }
        if (result.kind === 'unavailable') {
          this.showUnavailable(result.profile);
          return;
        }
        if (result.kind === 'hidden') {
          this.resetPrivate();
          const profile: AvailableProfile = {
            ...result.profile,
            postsHidden: true,
            postCount: 0,
            postCountStatus: 'known',
            tradeCount: 0,
            tradeCountStatus: 'known',
          };
          this.update({
            profile,
            loaded: true,
            total: null,
            status: '对方已隐藏主页帖子与交易；基本资料仍可查看',
          });
          return;
        }
        const { profile, list } = result;
        this.nextCursor = list.nextCursor;
        this.pageCursors = [...this.pageCursors.slice(0, pageIndex), after];
        this.pageIndex = pageIndex;
        const items = list.items;
        this.update({
          profile: {
            ...profile,
            ...(list.totalStatus !== 'known'
              ? {}
              : tab === 'posts'
                ? { postCount: list.total, postCountStatus: list.totalStatus }
                : !subtype
                  ? {
                      tradeCount: list.total,
                      tradeCountStatus: list.totalStatus,
                    }
                  : {}),
          },
          items,
          total: list.total,
          totalStatus: list.totalStatus,
          continuation: list.continuation,
          loaded: true,
          canLoadMore: !!list.nextCursor,
          canPrevious: pageIndex > 0,
          pageNumber: pageIndex + 1,
          status:
            list.continuation === 'scan_pending'
              ? list.items.length
                ? '已读取部分当前可查看内容，仍有历史待核验；请继续查看'
                : '本批暂无可查看内容，仍有历史待核验；请继续查看'
              : list.continuation === 'end'
                ? list.total === 0
                  ? '当前没有可展示的公开身份内容'
                  : '已到本次浏览末尾；刷新可重新查看最新内容'
                : '已读取当前可查看的公开身份内容',
        });
      },
      (error) => {
        this.resetPrivate();
        this.update({
          profile: null,
          items: [],
          total: null,
          totalStatus: null,
          continuation: null,
          loaded: false,
          canLoadMore: false,
          ...(error.details.serverCode === 'DISCOVERY_RESTART_REQUIRED'
            ? {
                status: '分页已失效或内容已变化，请重新加载',
                error: '旧分页已清除，请重新加载当前可查看的内容',
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
