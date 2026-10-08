import {
  createExperienceRuntime,
  type ExperienceRuntime,
} from './experience/runtime';
import {
  createIdentityCampusRuntime,
  type IdentityCampusRuntime,
} from './identity-campus/runtime';
import { WechatStorage } from './platform/wechat';
import { clientConfiguration } from './config';
import { createIdentityRuntime, type IdentityRuntime } from './auth/runtime';
import {
  createCommunityRuntime,
  type CommunityRuntime,
} from './community/runtime';
import { systemClock } from './platform/clock';
import {
  createVerificationRuntime,
  type VerificationRuntime,
} from './verification/runtime';

export interface WhaleuApp {
  identity: IdentityRuntime | undefined;
  community: CommunityRuntime | undefined;
  verification: VerificationRuntime | undefined;
  identityCampus: IdentityCampusRuntime | undefined;
  experience: ExperienceRuntime | undefined;
  globalData: { implementationStage: string; featureParityVerified: boolean };
}
App<WhaleuApp>({
  identity: undefined,
  community: undefined,
  verification: undefined,
  identityCampus: undefined,
  experience: undefined,
  globalData: {
    implementationStage: 'native-community-c2b-discussion-partial',
    featureParityVerified: false,
  },
  onShow() {
    void this.experience?.foreground();
    void this.community?.views?.foreground();
  },
  onHide() {
    this.experience?.hide();
    this.community?.views?.hide();
    this.community?.privateViews?.clear();
    this.verification?.privateViews.clear();
    this.identityCampus?.privateViews.clear();
  },
  onLaunch() {
    this.identity = createIdentityRuntime(clientConfiguration, wx, systemClock);
    this.verification = createVerificationRuntime(this.identity);
    this.community = createCommunityRuntime(
      this.identity,
      wx,
      clientConfiguration.apiOrigin,
    );
    this.identityCampus = createIdentityCampusRuntime(
      this.identity,
      new WechatStorage(wx),
      clientConfiguration.apiOrigin,
      this.community.newRequestId,
    );
    this.experience = createExperienceRuntime(
      this.identity,
      new WechatStorage(wx),
      clientConfiguration.apiOrigin,
      this.community.newRequestId,
    );
  },
});
