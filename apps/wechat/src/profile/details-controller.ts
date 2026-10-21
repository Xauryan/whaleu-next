import { ClientError } from '../api/errors';
import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import {
  decodeOwnProfileDetails,
  profileDetailDefaults,
  profileRegionError,
  type OwnProfileDetails,
  type ProfileDetailFields,
  type ProfileGender,
} from './details-contract';
import type { ProfileDetailsGateway } from './details-gateway';

export interface ProfileDetailsView extends CommunityView, ProfileDetailFields {
  readonly loaded: boolean;
  readonly saving: boolean;
  readonly dirty: boolean;
  readonly needsReload: boolean;
  readonly regionInput: string;
  readonly ageInput: string;
  readonly validationError: string;
}
export const initialProfileDetailsView = (): ProfileDetailsView => ({
  ...initialCommunityView(),
  ...profileDetailDefaults(),
  loaded: false,
  saving: false,
  dirty: false,
  needsReload: false,
  regionInput: '',
  ageInput: '',
  validationError: '',
});
const editableFields = (value: OwnProfileDetails): ProfileDetailFields => ({
  region: value.region,
  gender: value.gender,
  age: value.age,
  showRegion: value.showRegion,
  showGender: value.showGender,
  showAge: value.showAge,
});
/** Separate revision boundary; nothing is copied from school, age verification or other private identity. */
export class ProfileDetailsController extends CommunityController<ProfileDetailsView> {
  private baseline: OwnProfileDetails | null = null;
  constructor(
    runtime: CommunityRuntime,
    private readonly details: ProfileDetailsGateway | undefined,
    render: (view: ProfileDetailsView) => void,
  ) {
    super(runtime, initialProfileDetailsView, render);
  }
  protected override resetPrivate(): void {
    this.baseline = null;
  }
  protected override onSafetyInvalidated(): void {
    void this.load();
  }
  async load(): Promise<void> {
    if (this.view.saving) return;
    this.stop();
    this.baseline = null;
    this.update({
      ...initialProfileDetailsView(),
      hasSession: !!this.accountId(),
      configured: !!this.details,
    });
    if (!this.available()) return;
    if (!this.details) {
      this.update({ error: '个人展示信息服务暂不可用' });
      return;
    }
    await this.run(
      (cancel) => this.details!.own(cancel),
      (raw) => this.apply(raw),
    );
  }
  private apply(raw: OwnProfileDetails, expectedRevision?: number): void {
    const value = decodeOwnProfileDetails(raw);
    if (
      value.accountId !== this.accountId() ||
      (expectedRevision !== undefined &&
        value.revision !== expectedRevision + 1)
    )
      throw new ClientError('protocol', 'Own profile details mismatch');
    this.baseline = value;
    this.update({
      ...editableFields(value),
      loaded: true,
      dirty: false,
      needsReload: false,
      regionInput: value.region ?? '',
      ageInput: value.age === null ? '' : String(value.age),
      validationError: '',
      status: '展示信息已读取；未公开的字段仅自己可见',
    });
  }
  private editable(): boolean {
    return (
      !!this.baseline &&
      !!this.accountId() &&
      this.view.loaded &&
      !this.view.busy &&
      !this.view.needsReload
    );
  }
  private draft(patch: Partial<ProfileDetailsView>): void {
    if (!this.editable()) return;
    this.update({ ...patch, dirty: true, validationError: '' });
  }
  setRegion(value: string): void {
    this.draft({ regionInput: value });
  }
  setAge(value: string): void {
    this.draft({ ageInput: value });
  }
  setGender(value: string): void {
    if (!['', 'female', 'male'].includes(value)) return;
    this.draft({
      gender: (value || null) as ProfileGender | null,
      ...(value ? {} : { showGender: false }),
    });
  }
  setVisibility(field: string, value: boolean): void {
    if (
      !['showRegion', 'showGender', 'showAge'].includes(field) ||
      typeof value !== 'boolean'
    )
      return;
    this.draft({ [field]: value });
  }
  cancelEdits(): void {
    if (this.editable() && this.baseline) this.apply(this.baseline);
  }
  async save(): Promise<void> {
    if (!this.editable() || !this.view.dirty || !this.baseline || !this.details)
      return;
    const region = this.view.regionInput.trim() || null;
    const rawAge = this.view.ageInput.trim();
    if (region !== null && profileRegionError(region)) {
      this.update({
        validationError: profileRegionError(region),
      });
      return;
    }
    if (
      rawAge &&
      (!/^(0|[1-9][0-9]{0,2})$/.test(rawAge) || Number(rawAge) > 120)
    ) {
      this.update({ validationError: '年龄请填写 0–120 的整数，或留空不填写' });
      return;
    }
    const age = rawAge ? Number(rawAge) : null;
    const expectedRevision = this.baseline.revision;
    const patch = {
      expectedRevision,
      region,
      gender: this.view.gender,
      age,
      showRegion: region !== null && this.view.showRegion,
      showGender: this.view.gender !== null && this.view.showGender,
      showAge: age !== null && this.view.showAge,
    };
    this.update({ saving: true });
    await this.run(
      (cancel) => this.details!.update(patch, cancel),
      (raw) => {
        this.apply(raw, expectedRevision);
        this.update({
          status: '展示信息已保存；只有你开启的字段会出现在公开主页',
        });
      },
      (error) => {
        const conflict =
          error.details.serverCode === 'PROFILE_DETAILS_REVISION_CONFLICT';
        const uncertain = [
          'network',
          'timeout',
          'cancelled',
          'protocol',
          'http',
          'auth-expired',
        ].includes(error.kind);
        if (conflict || uncertain)
          this.update({
            needsReload: true,
            error: conflict
              ? '展示信息已在其他地方更新，请重新加载后再编辑'
              : '保存结果暂未确认，请重新加载核对；不会自动重复保存',
          });
      },
    );
    this.update({ saving: false });
  }
}
