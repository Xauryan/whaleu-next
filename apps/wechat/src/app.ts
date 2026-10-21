import { createInstitutionalRuntime } from './verification/institutional-runtime';
import type { InstitutionalRuntime } from './verification/institutional-controller';
import {
  createCampusToolsRuntime,
  type CampusToolsRuntime,
} from './campus-tools/runtime';
import { createMajorDiscussionImageRuntime } from './major-discussion/image-runtime';
import { createWindowDiscussionImageRuntime } from './window-discussion/image-runtime';
import { connectPrivateMessageImages } from './messaging/image-runtime';
import {
  createErrandMediaRuntime,
  type ErrandMediaRuntime,
} from './errands/media-runtime';
import { createErrandPublicationRuntime } from './errands/publication-runtime';
import { createVerificationEvidenceRuntime } from './verification/evidence-runtime';
import {
  createAnnouncementMediaRuntime,
  type AnnouncementMediaRuntime,
} from './media/announcement-runtime';
import {
  createActivityMediaRuntime,
  type ActivityMediaRuntime,
} from './activities/media-runtime';
import {
  createOrganizationMediaRuntime,
  type OrganizationMediaRuntime,
} from './organizations/media-runtime';
import {
  createSchoolQrRuntime,
  type SchoolQrRuntime,
} from './school-configuration/qr-runtime';
import { connectCategoryIconNative } from './ratings/category-icon-runtime';
import { MediaLocalFiles } from './media/local-files';
import { WechatNativeMediaFiles } from './media/native-files';
import { connectRatingDiscussionNative } from './ratings/discussion-media-runtime';
import {
  createProfileAvatarRuntime,
  type ProfileAvatarRuntime,
} from './profile/avatar-runtime';
import {
  createNativeProfileCoverRuntime,
  type NativeProfileCoverRuntime,
} from './profile/cover-native-runtime';
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
  institutionalSso?: InstitutionalRuntime;
  campusTools?: CampusToolsRuntime;
  errandMedia?: ErrandMediaRuntime;
  errandPublication?: ReturnType<typeof createErrandPublicationRuntime>;
  studentEvidence?: ReturnType<typeof createVerificationEvidenceRuntime>;
  schoolQr?: SchoolQrRuntime;
  organizationMedia?: OrganizationMediaRuntime;
  activityMedia?: ActivityMediaRuntime;
  announcementMedia?: AnnouncementMediaRuntime;
  mediaLocalFiles?: MediaLocalFiles;
  mediaRead?: MediaReadRuntime;
  profileAvatar?: ProfileAvatarRuntime;
  profileCover?: NativeProfileCoverRuntime;
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
    this.campusTools?.hide();
    this.community?.windowDiscussionImages?.hide();
    this.community?.majorDiscussionImages?.hide();
    this.errandMedia?.hide();
    this.studentEvidence?.clear();
    this.schoolQr?.hide();
    this.organizationMedia?.hide();
    this.activityMedia?.hide();
    this.announcementMedia?.hide();
    this.experience?.hide();
    this.profileAvatar?.hide();
    this.profileCover?.hide();
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
    const institutionalSso = createInstitutionalRuntime(
      this.identity,
      this.community,
      this.verification,
      new WechatStorage(wx),
      clientConfiguration.apiOrigin,
    );
    if (institutionalSso) this.institutionalSso = institutionalSso;
    // One process-wide ledger for Ratings uploads/gallery and every other
    // admitted media owner. Never allocate a new budget for each page/account.
    const nativeFiles = new WechatNativeMediaFiles(wx, systemClock);
    const registry = new MediaLocalFiles(nativeFiles);
    this.mediaLocalFiles = registry;
    if (this.identity.api && this.identity.auth)
      this.campusTools = createCampusToolsRuntime({
        authRecoveryRequired: Boolean(this.identity.startupError),
        api: this.identity.api,
        sessions: this.identity.sessions,
        origin: clientConfiguration.apiOrigin,
        clock: systemClock,
        wx,
        files: nativeFiles,
        registry,
        auth: this.identity.auth,
      });
    if (this.identity.api && this.identity.auth && this.community.messaging)
      connectPrivateMessageImages(this.community.messaging, {
        api: this.identity.api,
        sessions: this.identity.sessions,
        storage: new WechatStorage(wx),
        origin: clientConfiguration.apiOrigin,
        clock: systemClock,
        newRequestId: this.community.newRequestId,
        wx,
        files: nativeFiles,
        registry,
        auth: this.identity.auth,
      });
    if (this.identity.api && this.identity.auth)
      this.studentEvidence = createVerificationEvidenceRuntime({
        api: this.identity.api,
        sessions: this.identity.sessions,
        storage: new WechatStorage(wx),
        origin: clientConfiguration.apiOrigin,
        clock: systemClock,
        newRequestId: this.community.newRequestId,
        wx,
        files: nativeFiles,
        registry,
        auth: this.identity.auth,
      });
    if (this.identity.api && this.identity.auth)
      this.schoolQr = createSchoolQrRuntime({
        api: this.identity.api,
        sessions: this.identity.sessions,
        storage: new WechatStorage(wx),
        origin: clientConfiguration.apiOrigin,
        clock: systemClock,
        newRequestId: this.community.newRequestId,
        wx,
        files: nativeFiles,
        registry,
        auth: this.identity.auth,
      });
    if (this.identity.api && this.identity.auth)
      this.organizationMedia = createOrganizationMediaRuntime({
        api: this.identity.api,
        sessions: this.identity.sessions,
        storage: new WechatStorage(wx),
        origin: clientConfiguration.apiOrigin,
        clock: systemClock,
        newRequestId: this.community.newRequestId,
        wx,
        files: nativeFiles,
        registry,
        auth: this.identity.auth,
      });
    if (this.identity.api && this.identity.auth) {
      this.errandMedia = createErrandMediaRuntime({
        api: this.identity.api,
        sessions: this.identity.sessions,
        storage: new WechatStorage(wx),
        origin: clientConfiguration.apiOrigin,
        clock: systemClock,
        newRequestId: this.community.newRequestId,
        wx,
        files: nativeFiles,
        registry,
        auth: this.identity.auth,
      });
      this.errandPublication = createErrandPublicationRuntime({
        api: this.identity.api,
        sessions: this.identity.sessions,
        media: this.errandMedia,
        storage: new WechatStorage(wx),
        origin: clientConfiguration.apiOrigin,
        newRequestId: this.community.newRequestId,
      });
    }
    if (this.identity.api && this.identity.auth)
      this.activityMedia = createActivityMediaRuntime({
        api: this.identity.api,
        sessions: this.identity.sessions,
        storage: new WechatStorage(wx),
        origin: clientConfiguration.apiOrigin,
        clock: systemClock,
        newRequestId: this.community.newRequestId,
        wx,
        files: nativeFiles,
        registry,
        auth: this.identity.auth,
      });
    if (this.identity.api && this.identity.auth)
      this.announcementMedia = createAnnouncementMediaRuntime({
        api: this.identity.api,
        sessions: this.identity.sessions,
        storage: new WechatStorage(wx),
        origin: clientConfiguration.apiOrigin,
        clock: systemClock,
        newRequestId: this.community.newRequestId,
        wx,
        files: nativeFiles,
        registry,
        auth: this.identity.auth,
      });
    if (this.identity.api && this.identity.auth) {
      const images = createWindowDiscussionImageRuntime({
        api: this.identity.api,
        sessions: this.identity.sessions,
        storage: new WechatStorage(wx),
        origin: clientConfiguration.apiOrigin,
        clock: systemClock,
        newRequestId: this.community.newRequestId,
        wx,
        files: nativeFiles,
        registry,
        auth: this.identity.auth,
      });
      this.community = {
        ...this.community,
        windowDiscussionV2: images.publication,
        windowDiscussionImages: images,
      };
    }
    if (this.identity.api && this.identity.auth) {
      const images = createMajorDiscussionImageRuntime({
        api: this.identity.api,
        ...(this.community.pendingMajorDiscussion
          ? { legacy: this.community.pendingMajorDiscussion }
          : {}),
        sessions: this.identity.sessions,
        storage: new WechatStorage(wx),
        origin: clientConfiguration.apiOrigin,
        clock: systemClock,
        newRequestId: this.community.newRequestId,
        wx,
        files: nativeFiles,
        registry,
        auth: this.identity.auth,
      });
      this.community = {
        ...this.community,
        majorDiscussionV2: images.publication,
        majorDiscussionImages: images,
      };
    }
    this.community = connectRatingDiscussionNative(
      this.community,
      this.identity,
      wx,
      clientConfiguration.apiOrigin,
      nativeFiles,
      registry,
      systemClock,
    );
    this.community = connectCategoryIconNative(
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
    if (this.identity.api && this.identity.auth)
      this.profileCover = createNativeProfileCoverRuntime({
        api: this.identity.api,
        auth: this.identity.auth,
        sessions: this.identity.sessions,
        storage: new WechatStorage(wx),
        origin: clientConfiguration.apiOrigin,
        clock: systemClock,
        newRequestId: this.community.newRequestId,
        wx,
        files: nativeFiles,
        registry,
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
