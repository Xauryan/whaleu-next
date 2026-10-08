import type { CommunityRuntime } from '../community/runtime';
import {
  ProfileController,
  type ProfileView,
} from '../pages/profile/controller';
export interface ActivityPreferenceView {
  readonly loaded: boolean;
  readonly busy: boolean;
  readonly checked: boolean;
  readonly dirty: boolean;
  readonly needsReload: boolean;
  readonly status: string;
  readonly error: string;
}
export const initialActivityPreferenceView = (): ActivityPreferenceView => ({
  loaded: false,
  busy: false,
  checked: false,
  dirty: false,
  needsReload: false,
  status: '',
  error: '',
});
/** Adapts the existing Profile owner; no duplicate preference or delivery permission exists. */
export class ActivityPreferenceController {
  private readonly profile: ProfileController;
  private view: ProfileView | undefined;
  private disposed = false;
  private readonly unsubscribeHide: () => void;
  constructor(
    runtime: CommunityRuntime,
    private readonly render: (view: ActivityPreferenceView) => void,
  ) {
    this.profile = new ProfileController(
      runtime.sessions,
      runtime.profiles,
      (view) => {
        this.view = view;
        this.render({
          loaded: view.loaded,
          busy: view.loading || view.saving,
          checked: view.loaded
            ? (view.preferences.find(
                (item) => item.key === 'activitySubscribed',
              )?.checked ?? false)
            : false,
          dirty: view.preferencesDirty,
          needsReload: view.needsReload,
          status: view.status,
          error: view.error,
        });
      },
    );
    this.unsubscribeHide =
      runtime.privateViews?.subscribe((accountId) => {
        if (accountId === undefined) this.dispose();
      }) ?? (() => undefined);
  }
  async load(): Promise<void> {
    if (!this.disposed && !this.view?.loading && !this.view?.saving)
      await this.profile.load();
  }
  choose(value: unknown): void {
    if (!this.disposed && typeof value === 'boolean')
      this.profile.setPreference('activitySubscribed', value);
  }
  async save(): Promise<void> {
    if (this.disposed) return;
    await this.profile.savePreferences();
    if (
      !this.disposed &&
      this.view?.needsReload &&
      this.view.status === '存在更新冲突'
    ) {
      await this.profile.load();
      if (!this.disposed && this.view?.loaded && !this.view.needsReload)
        this.render({
          loaded: true,
          busy: false,
          checked:
            this.view.preferences.find(
              (item) => item.key === 'activitySubscribed',
            )?.checked ?? false,
          dirty: false,
          needsReload: false,
          status: '已重新加载最新偏好，请核对后重新选择',
          error: '',
        });
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeHide();
    this.profile.dispose();
  }
}
