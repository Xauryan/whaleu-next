import { ClientError } from '../api/errors';
import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import {
  decodeOwnProfileStats,
  unavailableProfileCount,
  type ProfileCount,
  type UnavailableProfileCount,
} from './stats-contract';
import type { ProfileStatsGateway } from './stats-gateway';

export interface ProfileStatsView extends CommunityView {
  readonly loaded: boolean;
  readonly following: ProfileCount;
  readonly followers: ProfileCount;
  readonly receivedInteractions: UnavailableProfileCount;
}
export const initialProfileStatsView = (): ProfileStatsView => ({
  ...initialCommunityView(),
  loaded: false,
  following: unavailableProfileCount(),
  followers: unavailableProfileCount(),
  receivedInteractions: unavailableProfileCount(),
});
/** Own-only volatile reads; no count is inferred from paginated lists or local activity. */
export class ProfileStatsController extends CommunityController<ProfileStatsView> {
  private readonly unsubscribeVisibility: () => void;
  constructor(
    runtime: CommunityRuntime,
    private readonly stats: ProfileStatsGateway | undefined,
    render: (view: ProfileStatsView) => void,
  ) {
    super(runtime, initialProfileStatsView, render);
    this.unsubscribeVisibility =
      runtime.privateViews?.subscribe((accountId) => {
        if (accountId !== undefined && accountId === this.accountId())
          this.clear();
      }) ?? (() => undefined);
  }
  private clear(): void {
    this.stop();
    this.update({
      ...initialProfileStatsView(),
      hasSession: !!this.accountId(),
      configured: !!this.stats,
    });
  }
  protected override onSafetyInvalidated(): void {
    void this.load();
  }
  override cancel(): void {
    this.clear();
  }
  override dispose(): void {
    this.unsubscribeVisibility();
    super.dispose();
  }
  async load(): Promise<void> {
    this.clear();
    if (!this.available()) return;
    if (!this.stats) {
      this.update({ error: '主页统计服务暂不可用' });
      return;
    }
    await this.run(
      (cancel) => this.stats!.own(cancel),
      (raw) => {
        const value = decodeOwnProfileStats(raw);
        if (value.accountId !== this.accountId())
          throw new ClientError('protocol', 'Own profile statistics mismatch');
        this.update({
          loaded: true,
          following: value.following,
          followers: value.followers,
          receivedInteractions: value.receivedInteractions,
          status: '关注与粉丝仅统计当前可见关系；获赞与收藏暂不可用',
        });
      },
    );
  }
}
