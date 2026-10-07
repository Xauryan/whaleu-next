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
  globalData: { implementationStage: string; featureParityVerified: boolean };
}
App<WhaleuApp>({
  identity: undefined,
  community: undefined,
  verification: undefined,
  identityCampus: undefined,
  globalData: {
    implementationStage: 'native-community-c2b-discussion-partial',
    featureParityVerified: false,
  },
  onHide() {
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
  },
});
