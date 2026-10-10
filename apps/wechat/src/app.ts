import { MediaLocalFiles } from './media/local-files';
import { WechatNativeMediaFiles } from './media/native-files';
import { connectRatingDiscussionNative } from './ratings/discussion-media-runtime';
import {
  createProfileAvatarRuntime,
  type ProfileAvatarRuntime,
} from './profile/avatar-runtime';
import { createMediaReadRuntime, type MediaReadRuntime } from './media/runtime';
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
  mediaLocalFiles?: MediaLocalFiles;
  mediaRead?: MediaReadRuntime;
  profileAvatar?: ProfileAvatarRuntime;
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
    this.profileAvatar?.hide();
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
    // One process-wide ledger for Ratings uploads/gallery and every other
    // admitted media owner. Never allocate a new budget for each page/account.
    const nativeFiles = new WechatNativeMediaFiles(wx, systemClock);
    const registry = new MediaLocalFiles(nativeFiles);
    this.mediaLocalFiles = registry;
    this.community = connectRatingDiscussionNative(
      this.community,
      this.identity,
      wx,
      clientConfiguration.apiOrigin,
      nativeFiles,
      registry,
      systemClock,
    );
    this.mediaRead = createMediaReadRuntime(
      this.identity,
      wx,
      clientConfiguration.apiOrigin,
      systemClock,
      this.community.privateViews,
      false,
      { files: nativeFiles, registry },
    );
    if (this.identity.api)
      this.profileAvatar = createProfileAvatarRuntime({
        sessions: this.identity.sessions,
        storage: new WechatStorage(wx),
        origin: clientConfiguration.apiOrigin,
        clock: systemClock,
        newRequestId: this.community.newRequestId,
        ...(this.community.privateViews
          ? { privateViews: this.community.privateViews }
          : {}),
      });
    this.identityCampus = createIdentityCampusRuntime(
      this.identity,
      new WechatStorage(wx),
      clientConfiguration.apiOrigin,
      this.community.newRequestId,
      (accountId) => this.community?.directoryScopeChanges?.clear(accountId),
    );
    this.experience = createExperienceRuntime(
      this.identity,
      new WechatStorage(wx),
      clientConfiguration.apiOrigin,
      this.community.newRequestId,
    );
  },
});
