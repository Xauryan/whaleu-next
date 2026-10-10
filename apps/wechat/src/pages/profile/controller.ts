import type { SessionStore, SessionTicket } from '../../auth/session';
import {
  bioError,
  nicknameError,
  preferenceKeys,
  type OwnProfile,
  type PreferenceKey,
  type Preferences,
} from '../../profile/contract';
import type { ProfileGateway } from '../../profile/gateway';
import {
  initialAccountView,
  OwnedController,
  type AccountView,
} from '../../profile/owned-controller';

export interface PreferenceRow {
  readonly key: PreferenceKey;
  readonly label: string;
  readonly hint: string;
  readonly checked: boolean;
}
const labels: Record<PreferenceKey, readonly [string, string]> = {
  showOfficialAccountTip: ['公众号提示', '显示校园公众号入口提示'],
  showHotTopic: ['每日热榜', '显示每日热门话题'],
  showGroupNotice: ['校园群提示', '显示校园交流群提示'],
  showTradingGroupNotice: ['交易群提示', '显示二手物品快速交易群提示'],
  showErrandGroupNotice: ['跑腿群提示', '显示跑腿接单群提示'],
  defaultAnonymousEnabled: ['默认分身发布', '新建内容时默认使用分身'],
  defaultCommentAnonymousEnabled: [
    '评论默认使用分身',
    '与「评论默认不使用分身」互斥',
  ],
  defaultCommentNonAnonymousEnabled: [
    '评论默认不使用分身',
    '两项均关闭时不强制评论身份',
  ],
  defaultAllowAnonymousDm: ['默认允许分身私信', '作为后续发布功能的默认偏好'],
  hideProfilePosts: [
    '隐藏个人主页帖子',
    '对其他人隐藏主页帖子、交易与对应数量；不会删除内容',
  ],
  activitySubscribed: ['活动提醒', '保存活动提醒偏好，消息投递待接入'],
};
const rows = (preferences: Preferences): readonly PreferenceRow[] =>
  preferenceKeys.map((key) => ({
    key,
    label: labels[key][0],
    hint: labels[key][1],
    checked: preferences[key],
  }));
export interface ProfileView extends AccountView {
  readonly nickname: string;
  readonly bio: string;
  readonly bioLength: number;
  readonly selectedCampusName: string;
  readonly profileDirty: boolean;
  readonly preferencesDirty: boolean;
  readonly preferences: readonly PreferenceRow[];
  readonly validationError: string;
}
export function initialProfileView(): ProfileView {
  return {
    ...initialAccountView(),
    nickname: '',
    bio: '',
    bioLength: 0,
    selectedCampusName: '尚未选择校园',
    profileDirty: false,
    preferencesDirty: false,
    preferences: [],
    validationError: '',
  };
}
export class ProfileController extends OwnedController<ProfileView> {
  private baseline: OwnProfile | undefined;
  private basicsAvailable = false;
  private preferenceDraft: Preferences | undefined;
  constructor(
    sessions: SessionStore,
    gateway: ProfileGateway | undefined,
    render: (view: ProfileView) => void,
  ) {
    super(sessions, gateway, initialProfileView, render);
  }
  protected resetPrivate(): void {
    this.basicsAvailable = false;
    this.baseline = undefined;
    this.preferenceDraft = undefined;
  }
  /** Only a completed, actor-current basics read may activate dependent media.
   * A cancelled/failed refresh cannot reuse a previous loaded view as permission. */
  avatarBasicsTicket(): SessionTicket | null {
    if (
      !this.basicsAvailable ||
      !this.baseline ||
      !this.view.loaded ||
      this.view.loading ||
      this.view.saving ||
      this.view.needsReload ||
      this.view.error
    )
      return null;
    try {
      this.sessions.assertCurrent(this.owner);
      const ticket = this.sessions.snapshot();
      return ticket.credentials?.accountId === this.baseline.accountId
        ? ticket
        : null;
    } catch {
      return null;
    }
  }
  async load(): Promise<void> {
    this.basicsAvailable = false;
    await this.perform(
      'read',
      (gateway, cancel) => gateway.profile(cancel),
      (profile) => {
        this.checkProfile(profile);
        this.basicsAvailable = true;
        this.baseline = profile;
        this.preferenceDraft = profile.preferences;
        this.update({
          ...this.form(profile),
          preferences: rows(profile.preferences),
          profileDirty: false,
          preferencesDirty: false,
          validationError: '',
        });
      },
    );
  }
  setNickname(value: string): void {
    if (!this.editable()) return;
    this.update({
      nickname: value,
      validationError: '',
      profileDirty:
        value !== (this.baseline?.nickname ?? '') ||
        this.view.bio !== this.baseline?.bio,
    });
  }
  setBio(value: string): void {
    if (!this.editable()) return;
    const bio = value.replace(/\r\n/g, '\n');
    this.update({
      bio,
      bioLength: [...bio].length,
      validationError: '',
      profileDirty:
        this.view.nickname !== (this.baseline?.nickname ?? '') ||
        bio !== this.baseline?.bio,
    });
  }
  setPreference(key: PreferenceKey, value: boolean): void {
    if (
      !this.editable() ||
      !this.preferenceDraft ||
      !preferenceKeys.includes(key) ||
      typeof value !== 'boolean'
    )
      return;
    const draft = { ...this.preferenceDraft, [key]: value };
    if (key === 'defaultCommentAnonymousEnabled' && value)
      draft.defaultCommentNonAnonymousEnabled = false;
    if (key === 'defaultCommentNonAnonymousEnabled' && value)
      draft.defaultCommentAnonymousEnabled = false;
    this.preferenceDraft = draft;
    this.update({
      preferences: rows(draft),
      preferencesDirty: preferenceKeys.some(
        (item) => draft[item] !== this.baseline?.preferences[item],
      ),
      validationError: '',
    });
  }
  cancelEdits(): void {
    if (!this.baseline || this.view.loading || this.view.saving) return;
    this.preferenceDraft = this.baseline.preferences;
    this.update({
      ...this.form(this.baseline),
      preferences: rows(this.baseline.preferences),
      profileDirty: false,
      preferencesDirty: false,
      validationError: '',
      status: this.view.needsReload
        ? '需要重新加载最新资料'
        : '已撤销未保存的修改',
    });
  }
  async saveProfile(): Promise<void> {
    if (!this.editable() || !this.baseline || !this.view.profileDirty) return;
    const nickname = this.view.nickname.trim();
    const bio = this.view.bio.trim();
    const nicknameChanged = nickname !== (this.baseline.nickname ?? '');
    const validationError =
      (nicknameChanged ? nicknameError(nickname) : '') || bioError(bio);
    if (validationError) {
      this.update({ validationError });
      return;
    }
    if (!nicknameChanged && bio === this.baseline.bio) {
      this.update({
        nickname,
        bio,
        bioLength: [...bio].length,
        profileDirty: false,
      });
      return;
    }
    const revision = this.baseline.revision;
    const patch = {
      expectedRevision: revision,
      ...(nicknameChanged ? { nickname } : {}),
      ...(bio !== this.baseline.bio ? { bio } : {}),
    };
    await this.perform(
      'save',
      (gateway, cancel) => gateway.updateProfile(patch, cancel),
      (profile) => {
        this.checkProfile(profile, revision);
        this.baseline = profile;
        this.update({
          ...this.form(profile),
          profileDirty: false,
          validationError: '',
        });
        // Saving one section never destroys the other section's unsaved edits.
        if (!this.view.preferencesDirty) {
          this.preferenceDraft = profile.preferences;
          this.update({ preferences: rows(profile.preferences) });
        }
      },
    );
  }
  async savePreferences(): Promise<void> {
    if (
      !this.editable() ||
      !this.baseline ||
      !this.preferenceDraft ||
      !this.view.preferencesDirty
    )
      return;
    const revision = this.baseline.revision;
    const preferences = { ...this.preferenceDraft };
    await this.perform(
      'save',
      (gateway, cancel) =>
        gateway.updatePreferences(
          { expectedRevision: revision, preferences },
          cancel,
        ),
      (profile) => {
        this.checkProfile(profile, revision);
        this.baseline = profile;
        this.preferenceDraft = profile.preferences;
        this.update({
          preferences: rows(profile.preferences),
          preferencesDirty: false,
          selectedCampusName:
            profile.selectedCampus?.fullName ?? '尚未选择校园',
          validationError: '',
        });
        if (!this.view.profileDirty) this.update(this.form(profile));
      },
    );
  }
  private form(
    profile: OwnProfile,
  ): Pick<
    ProfileView,
    'nickname' | 'bio' | 'bioLength' | 'selectedCampusName'
  > {
    return {
      nickname: profile.nickname ?? '',
      bio: profile.bio,
      bioLength: [...profile.bio].length,
      selectedCampusName: profile.selectedCampus?.fullName ?? '尚未选择校园',
    };
  }
}
