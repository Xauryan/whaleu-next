import { ClientError } from '../../api/errors';
import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../../community/controller';
import type { CommunityRuntime } from '../../community/runtime';
import { isUuid } from '../../profile/contract';
import {
  decodePublicProfileDetails,
  type PublicProfileDetails,
} from '../../profile/details-contract';
import type { ProfileDetailsGateway } from '../../profile/details-gateway';
import type { PublicProfile } from '../../profile/discovery-contract';

export interface PublicDetailsView extends CommunityView {
  readonly details: Extract<
    PublicProfileDetails,
    { status: 'available' }
  > | null;
}
export const initialPublicDetailsView = (): PublicDetailsView => ({
  ...initialCommunityView(),
  details: null,
});

/** Optional public fields never come from private identity or the own-details endpoint. */
export class PublicDetailsController extends CommunityController<PublicDetailsView> {
  private profileId = '';
  constructor(
    runtime: CommunityRuntime,
    private readonly details: Pick<ProfileDetailsGateway, 'public'> | undefined,
    render: (view: PublicDetailsView) => void,
  ) {
    super(runtime, initialPublicDetailsView, render);
  }
  protected override resetPrivate(): void {
    this.profileId = '';
  }
  clear(): void {
    this.stop();
    this.resetPrivate();
    this.update({
      details: null,
      busy: false,
      error: '',
      status: '',
    });
  }
  override cancel(): void {
    this.clear();
  }
  async setProfile(profile: PublicProfile | null): Promise<void> {
    const id =
      profile?.status === 'available' && isUuid(profile.profileId)
        ? profile.profileId
        : '';
    if (!id) {
      this.clear();
      return;
    }
    if (this.profileId === id) return;
    this.clear();
    if (!this.available(false) || !this.details) return;
    this.profileId = id;
    await this.run(
      (cancel) => this.details!.public(id, cancel),
      (raw) => {
        const result = decodePublicProfileDetails(raw);
        if (result.profileId !== id || this.profileId !== id)
          throw new ClientError('protocol', 'Public profile details mismatch');
        this.update({
          details: result.status === 'available' ? result : null,
        });
      },
    );
  }
}
