import {
  isTradingSubtype,
  type TradingSubtype,
} from '../../community/trading-contract';
import { ClientError } from '../../api/errors';
import type { Campus } from '../../profile/contract';
import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../../community/controller';
import {
  isCategory,
  type Category,
  type CommunitySpace,
  type Continuation,
  type Post,
} from '../../community/contract';
import type { CommunityRuntime } from '../../community/runtime';
export interface FeedView extends CommunityView {
  readonly campuses: readonly Campus[];
  readonly campusName: string;
  readonly campusId: string;
  readonly query: string;
  readonly space: CommunitySpace | null;
  readonly globalSpaces: readonly CommunitySpace[];
  readonly category: Category | 'all';
  readonly tradingSubtype: TradingSubtype | '';
  readonly posts: readonly Post[];
  readonly continuation: Continuation;
  readonly canLoadMore: boolean;
  readonly loaded: boolean;
}
export const initialFeedView = (): FeedView => ({
  ...initialCommunityView(),
  campuses: [],
  campusName: '',
  campusId: '',
  query: '',
  space: null,
  globalSpaces: [],
  category: 'all',
  tradingSubtype: '',
  posts: [],
  continuation: 'end',
  canLoadMore: false,
  loaded: false,
});
export class FeedController extends CommunityController<FeedView> {
  private nextCursor: string | null = null;
  private regional: CommunitySpace | null = null;
  constructor(runtime: CommunityRuntime, render: (view: FeedView) => void) {
    super(runtime, initialFeedView, render);
  }
  protected override resetPrivate(): void {
    this.nextCursor = null;
    this.regional = null;
  }
  setQuery(query: string): void {
    this.update({ query });
  }
  async load(): Promise<void> {
    if (!this.available(false) || !this.runtime.profiles) return;
    const owner = this.owner;
    this.nextCursor = null;
    this.regional = null;
    this.update({
      posts: [],
      space: null,
      loaded: false,
      globalSpaces: [],
      canLoadMore: false,
    });
    await this.run(
      async (cancel) => {
        const profiles = this.runtime.profiles!;
        const [catalog, profile] = await Promise.all([
          profiles.campuses(
            { q: '', district: '', page: 1, pageSize: 100 },
            cancel,
          ),
          this.accountId() ? profiles.profile(cancel) : Promise.resolve(null),
        ]);
        if (profile && profile.accountId !== this.accountId())
          throw new ClientError('protocol', 'Profile owner mismatch');
        const campus = profile?.selectedCampus ?? null;
        const spaces = campus
          ? await this.runtime.gateway!.spaces(campus.id, cancel)
          : null;
        const space = spaces?.regional?.isActive ? spaces.regional : null;
        this.runtime.sessions.assertCurrent(owner);
        if (cancel.isCancelled)
          throw new ClientError('cancelled', 'Scope lookup was replaced');
        this.regional = spaces?.regional ?? null;
        this.update({
          campuses: catalog.items,
          campusName: campus?.fullName ?? '',
          campusId: campus?.id ?? '',
          space,
          globalSpaces: spaces?.global.filter((item) => item.isActive) ?? [],
          category: 'all',
          tradingSubtype: '',
          status: space
            ? '已解析社区地区，正在加载帖子'
            : '尚未解析可用社区地区',
        });
        const feed = space
          ? await this.runtime.gateway!.feed({ spaceId: space.id }, cancel)
          : null;
        return { catalog, campus, spaces, space, feed };
      },
      (result) => {
        this.regional = result.spaces?.regional ?? null;
        this.nextCursor = result.feed?.nextCursor ?? null;
        this.update({
          campuses: result.catalog.items,
          campusName: result.campus?.fullName ?? '',
          campusId: result.campus?.id ?? '',
          globalSpaces:
            result.spaces?.global.filter((item) => item.isActive) ?? [],
          space: result.space,
          category: 'all',
          tradingSubtype: '',
          posts: result.feed?.items ?? [],
          continuation: result.feed?.continuation ?? 'end',
          canLoadMore: !!this.nextCursor,
          loaded: true,
          status: result.space
            ? '已加载地区社区'
            : result.campus
              ? '此校园尚未配置可用的社区地区'
              : '请选择浏览校园，校区偏好不代表身份认证',
        });
      },
    );
  }
  async search(): Promise<void> {
    if (!this.available(false) || !this.runtime.profiles) return;
    const query = this.view.query;
    await this.run(
      (cancel) =>
        this.runtime.profiles!.campuses(
          { q: query, district: '', page: 1, pageSize: 100 },
          cancel,
        ),
      (result) =>
        this.update({
          campuses: result.items,
          status: result.items.length ? '请选择浏览校园' : '未找到校园',
        }),
    );
  }
  async chooseCampus(campusId: string): Promise<void> {
    if (!this.available(false)) return;
    const campus = this.view.campuses.find((item) => item.id === campusId);
    if (!campus?.isActive) return;
    const owner = this.owner;
    this.nextCursor = null;
    this.regional = null;
    this.update({
      campusId,
      campusName: campus.fullName,
      space: null,
      posts: [],
      globalSpaces: [],
      category: 'all',
      tradingSubtype: '',
      loaded: false,
      canLoadMore: false,
    });
    await this.run(
      async (cancel) => {
        const spaces = await this.runtime.gateway!.spaces(campusId, cancel);
        const space = spaces.regional?.isActive ? spaces.regional : null;
        this.runtime.sessions.assertCurrent(owner);
        if (cancel.isCancelled)
          throw new ClientError('cancelled', 'Scope lookup was replaced');
        this.regional = spaces.regional;
        this.update({
          space,
          globalSpaces: spaces.global.filter((item) => item.isActive),
          status: space
            ? '已解析社区地区，正在加载帖子'
            : '尚未解析可用社区地区',
        });
        const feed = space
          ? await this.runtime.gateway!.feed({ spaceId: space.id }, cancel)
          : null;
        return { spaces, space, feed };
      },
      (result) => {
        this.regional = result.spaces.regional;
        this.nextCursor = result.feed?.nextCursor ?? null;
        this.update({
          space: result.space,
          globalSpaces: result.spaces.global.filter((item) => item.isActive),
          posts: result.feed?.items ?? [],
          continuation: result.feed?.continuation ?? 'end',
          canLoadMore: !!this.nextCursor,
          loaded: true,
          status: result.space
            ? '已切换浏览地区；未改变认证或个人校区偏好'
            : '此校园尚未配置可用的社区地区，可主动选择全站社区',
        });
      },
    );
  }
  async chooseGlobal(spaceId: string): Promise<void> {
    const space = this.view.globalSpaces.find(
      (item) => item.id === spaceId && item.isActive,
    );
    if (!space) return;
    this.update({ space, category: 'discussion', tradingSubtype: '' });
    await this.refresh();
  }
  async chooseRegional(): Promise<void> {
    if (!this.regional?.isActive) return;
    this.update({ space: this.regional, category: 'all', tradingSubtype: '' });
    await this.refresh();
  }
  async setCategory(category: string): Promise<void> {
    if (
      (category !== 'all' && !isCategory(category)) ||
      !this.view.space ||
      (this.view.space.kind === 'global' && category !== 'discussion')
    )
      return;
    this.update({ category, tradingSubtype: '' });
    await this.refresh();
  }
  async setTradingSubtype(subtype: string): Promise<void> {
    if (
      this.view.category !== 'trading' ||
      (subtype !== '' && !isTradingSubtype(subtype))
    )
      return;
    this.update({ tradingSubtype: subtype });
    await this.refresh();
  }
  async refresh(): Promise<void> {
    if (!this.available(false) || !this.view.space) return;
    this.nextCursor = null;
    this.update({ posts: [], loaded: false, canLoadMore: false });
    await this.read(false);
  }
  async more(): Promise<void> {
    if (
      this.view.busy ||
      !this.nextCursor ||
      this.view.continuation !== 'available' ||
      !this.available()
    )
      return;
    await this.read(true);
  }
  private async read(append: boolean): Promise<void> {
    const space = this.view.space;
    if (!space) return;
    const category = this.view.category,
      after = append ? this.nextCursor : null;
    await this.run(
      (cancel) =>
        this.runtime.gateway!.feed(
          {
            spaceId: space.id,
            ...(category !== 'all' ? { category } : {}),
            ...(category === 'trading' && this.view.tradingSubtype
              ? { tradingSubtype: this.view.tradingSubtype }
              : {}),
            ...(after ? { cursor: after } : {}),
          },
          cancel,
        ),
      (result) => {
        if (after && result.nextCursor === after)
          throw new ClientError('protocol', 'Cursor did not advance');
        this.nextCursor = result.nextCursor;
        const items = append
          ? [...this.view.posts, ...result.items]
          : result.items;
        this.update({
          posts: [...new Map(items.map((item) => [item.id, item])).values()],
          continuation: result.continuation,
          canLoadMore: !!result.nextCursor,
          loaded: true,
          status:
            result.items.length || append ? '已加载' : '此分类暂无可查看的帖子',
        });
      },
      () => {
        this.nextCursor = null;
        this.update({ posts: [], loaded: false, canLoadMore: false });
      },
    );
  }
}
