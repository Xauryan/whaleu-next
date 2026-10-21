import { ClientError } from '../../api/errors';
import type { SessionTicket } from '../../auth/session';
import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../../community/controller';
import type { CommunityRuntime } from '../../community/runtime';
import { isUuid } from '../../profile/contract';
import {
  decodePublicProfile,
  type AvailableProfile,
} from '../../profile/discovery-contract';

export interface MeIdentityView extends CommunityView {
  readonly loaded: boolean;
  readonly profile: AvailableProfile | null;
}
export const initialMeIdentityView = (): MeIdentityView => ({
  ...initialCommunityView(),
  loaded: false,
  profile: null,
});

/** Public identity is independent of the currently selected private content tab. */
export class MeIdentityController extends CommunityController<MeIdentityView> {
  private profileTicket: SessionTicket | null = null;
  constructor(
    runtime: CommunityRuntime,
    render: (view: MeIdentityView) => void,
  ) {
    super(runtime, initialMeIdentityView, render);
  }
  protected override onSafetyInvalidated(): void {
    void this.load();
  }
  protected override resetPrivate(): void {
    this.profileTicket = null;
  }
  shareTicket(): SessionTicket | null {
    if (
      !this.view.loaded ||
      this.view.busy ||
      this.view.error ||
      !this.view.profile?.isOwn ||
      !this.accountId() ||
      !this.profileTicket
    )
      return null;
    return this.profileTicket;
  }
  async load(): Promise<void> {
    this.stop();
    this.profileTicket = null;
    this.update({ busy: false, loaded: false, profile: null });
    if (!this.available()) return;
    if (!this.runtime.discovery) {
      this.update({ error: '公开主页服务暂不可用' });
      return;
    }
    await this.run(
      async (cancel) => {
        const { profileId } =
          await this.runtime.discovery!.ownProfileRef(cancel);
        if (profileId === null) return null;
        if (!isUuid(profileId))
          throw new ClientError('protocol', 'Invalid own public profile');
        const profile = decodePublicProfile(
          await this.runtime.discovery!.profile(profileId, cancel),
        );
        if (
          profile.profileId !== profileId ||
          (profile.status === 'available' && !profile.isOwn)
        )
          throw new ClientError('protocol', 'Own public profile mismatch');
        return profile.status === 'available' ? profile : null;
      },
      (profile) => {
        this.profileTicket = profile ? this.runtime.sessions.snapshot() : null;
        this.update({
          profile,
          loaded: true,
          status: profile ? '公开主页已核验' : '当前没有可分享的公开主页',
        });
      },
      () => {
        this.profileTicket = null;
        this.update({ profile: null, loaded: false });
      },
    );
  }
}
