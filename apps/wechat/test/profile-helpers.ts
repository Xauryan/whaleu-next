import type { Campus, OwnProfile } from '../src/profile/contract';
import type { ProfileGateway } from '../src/profile/gateway';
import type { Cancellation } from '../src/platform/contracts';
import { wireCredentials } from './identity-helpers';
export const campusId = '33333333-3333-4333-8333-333333333333';
export function campus(overrides: Partial<Campus> = {}): Campus {
  return {
    id: campusId,
    institutionId: '44444444-4444-4444-8444-444444444444',
    institutionName: '测试大学',
    fullName: '测试大学主校区',
    shortName: null,
    district: '测试区',
    isActive: true,
    ...overrides,
  };
}
export function ownProfile(overrides: Partial<OwnProfile> = {}): OwnProfile {
  return {
    accountId: wireCredentials().accountId,
    nickname: null,
    bio: '',
    selectedCampus: null,
    revision: 0,
    preferences: {
      showOfficialAccountTip: true,
      showHotTopic: true,
      showGroupNotice: true,
      showTradingGroupNotice: true,
      showErrandGroupNotice: true,
      defaultAnonymousEnabled: false,
      defaultCommentAnonymousEnabled: false,
      defaultCommentNonAnonymousEnabled: false,
      defaultAllowAnonymousDm: false,
      hideProfilePosts: false,
      activitySubscribed: true,
    },
    ...overrides,
  };
}
export class FakeProfileGateway implements ProfileGateway {
  readonly calls: Array<{
    method: string;
    body: unknown;
    cancellation: Cancellation;
  }> = [];
  current = ownProfile();
  profileImpl: ProfileGateway['profile'] = async () => this.current;
  campusesImpl: ProfileGateway['campuses'] = async (query) => ({
    items: [campus()],
    page: query.page,
    pageSize: query.pageSize,
    total: 1,
  });
  updateProfileImpl: ProfileGateway['updateProfile'] = async (patch) => {
    this.current = {
      ...this.current,
      ...(patch.nickname !== undefined ? { nickname: patch.nickname } : {}),
      ...(patch.bio !== undefined ? { bio: patch.bio } : {}),
      revision: patch.expectedRevision + 1,
    };
    return this.current;
  };
  preferencesImpl: ProfileGateway['updatePreferences'] = async (patch) => {
    this.current = {
      ...this.current,
      preferences: { ...this.current.preferences, ...patch.preferences },
      revision: patch.expectedRevision + 1,
    };
    return this.current;
  };
  selectImpl: ProfileGateway['selectCampus'] = async (patch) => {
    this.current = {
      ...this.current,
      selectedCampus: campus({ id: patch.campusId }),
      revision: patch.expectedRevision + 1,
    };
    return this.current;
  };
  profile(cancel: Cancellation) {
    this.calls.push({
      method: 'profile',
      body: undefined,
      cancellation: cancel,
    });
    return this.profileImpl(cancel);
  }
  campuses(
    query: Parameters<ProfileGateway['campuses']>[0],
    cancel: Cancellation,
  ) {
    this.calls.push({ method: 'campuses', body: query, cancellation: cancel });
    return this.campusesImpl(query, cancel);
  }
  updateProfile(
    patch: Parameters<ProfileGateway['updateProfile']>[0],
    cancel: Cancellation,
  ) {
    this.calls.push({
      method: 'updateProfile',
      body: patch,
      cancellation: cancel,
    });
    return this.updateProfileImpl(patch, cancel);
  }
  updatePreferences(
    patch: Parameters<ProfileGateway['updatePreferences']>[0],
    cancel: Cancellation,
  ) {
    this.calls.push({
      method: 'preferences',
      body: patch,
      cancellation: cancel,
    });
    return this.preferencesImpl(patch, cancel);
  }
  selectCampus(
    patch: Parameters<ProfileGateway['selectCampus']>[0],
    cancel: Cancellation,
  ) {
    this.calls.push({ method: 'select', body: patch, cancellation: cancel });
    return this.selectImpl(patch, cancel);
  }
}
